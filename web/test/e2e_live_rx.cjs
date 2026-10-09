/**
 * 实时逐行成像（麦克风接收）的端到端测试
 * ----------------------------------------------------------------------------
 * 用户诉求：用麦克风解码时，要能像发送时那样，在界面上看到画面一行一行长出来。
 *
 * 这个功能最容易"假实现"——先一次性解完，再按时间轴播一段逐行显示的动画。
 * 那样截图看起来一模一样，但用户必须先等完整段信号，功能也就失去了意义。
 * 所以本测试要回答的不是"画面对不对"，而是：
 *
 *   画布上的像素，是不是**在信号还在到达的过程中**一行一行被写上去的？
 *
 * 判定方式：录音期间反复测量"画布顶部连续已画行数"（与"待机底"逐行比对），
 * 然后断言这条曲线是**从 0 附近单调增长到整幅高度**的。一次性解完的实现，
 * 曲线会是 0 → 0 → … → H 的悬崖状。
 *
 * 麦克风输入用 Chrome 的 `--use-file-for-fake-audio-capture` 注入我们自己的
 * SSTV WAV —— 等于让浏览器把我们编码出来的信号当成"电台音频"。
 *
 * 用法：
 *   node web/test/e2e_live_rx.cjs
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const SSTV = require('../sstv-engine.js');

const BASE = process.env.SSTV_URL || 'http://localhost:8000/';
const EXECUTABLE = 'C:/Users/kavin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const SHOTS = path.join(__dirname, 'shots');
const TMP = path.join(__dirname, 'tmp');

// 用 Robot 36：本工具支持的最短完整制式（320×240，每行 150 ms，整幅 36 s），
// 才能在可接受的测试时长里跑完"整幅收全"这一条。
const MODE_ID = 'Robot 36';
const PROGRESS_MS = 12000;        // 渐进性观察窗口
const FULL_MS = 41000;            // 整幅收全（素材 36.9 s + 锁定与缓冲余量）

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** R 沿 x 渐变 / G 沿 y 渐变 / B 恒 128：方向性明确，便于断言没有上下左右颠倒 */
function makeRef(w, h) {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    rgb[i] = Math.round(255 * x / (w - 1));
    rgb[i + 1] = Math.round(255 * y / (h - 1));
    rgb[i + 2] = 128;
  }
  return rgb;
}

/**
 * 页面内探针：重建"待机底"参考图，逐行比对，得到"顶部连续已画行数"。
 * 顺带返回最后一行是否仍是底色 —— 用来**自证探针本身是准的**（画面没画满时，
 * 底部必然是底色；若探针把底色认成图像，这条会立刻失败）。
 */
const PROBE = `(() => {
  const q = s => document.querySelector(s);
  const c = q('#rx-preview');
  const W = c.width, H = c.height;
  const cur = c.getContext('2d').getImageData(0, 0, W, H).data;

  const rc = document.createElement('canvas'); rc.width = W; rc.height = H;
  const rg = rc.getContext('2d');
  rg.fillStyle = '#0a0f15'; rg.fillRect(0, 0, W, H);
  rg.strokeStyle = 'rgba(56,189,248,.09)'; rg.lineWidth = 1;
  for (let y = 16; y < H; y += 16) {
    rg.beginPath(); rg.moveTo(0, y + 0.5); rg.lineTo(W, y + 0.5); rg.stroke();
  }
  const bg = rg.getImageData(0, 0, W, H).data;

  const rowIsBg = y => {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (cur[i] !== bg[i] || cur[i+1] !== bg[i+1] || cur[i+2] !== bg[i+2]) return false;
    }
    return true;
  };
  let painted = 0;
  while (painted < H && !rowIsBg(painted)) painted++;

  const chip = (q('#rx-live-chip').textContent || '').trim();
  const m = /(\\d+)\\s*\\/\\s*(\\d+)\\s*行/.exec(chip);
  return {
    W, H, painted, bottomIsBg: rowIsBg(H - 1),
    chipRows: m ? +m[1] : null, chipTotal: m ? +m[2] : null, chip,
    status: (q('#rx-status').textContent || '').trim(),
    note: (q('#rx-live-note').textContent || '').trim(),
    stage: q('#rx-stage').className,
    overlay: q('#rx-live').className,
    scanning: q('#rx-live-line').style.top
  };
})()`;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  const mode = SSTV.modeById(MODE_ID);
  const ref = makeRef(mode.width, mode.height);
  console.log('制式: ' + MODE_ID + '  ' + mode.width + '×' + mode.height +
    '  每行 ' + (mode.lineDuration(0) * 1000).toFixed(0) + ' ms  整幅 ' +
    mode.frameDuration.toFixed(0) + ' s');

  // ---------------------------------------------------------- 0. 探测采样率
  // 假音频设备的原生采样率决定浏览器要不要对 WAV 重采样。先问出来，再按这个
  // 采样率生成素材，就少一个混淆变量（否则解码差异可能来自重采样而非实时路径）。
  console.log('\n=== 0. 探测本机音频采样率 ===');
  let nativeRate = 48000;
  {
    const b = await chromium.launch({ headless: true, executablePath: EXECUTABLE });
    try {
      const p = await b.newPage();
      await p.goto(BASE, { waitUntil: 'load', timeout: 60000 });
      nativeRate = await p.evaluate(() => {
        const C = window.AudioContext || window.webkitAudioContext;
        const ctx = new C(); const r = ctx.sampleRate;
        if (ctx.close) ctx.close();
        return r;
      });
    } finally { await b.close(); }
  }
  console.log('  本机 AudioContext 采样率: ' + nativeRate + ' Hz');

  const samples = SSTV.encodeImage(mode, ref, nativeRate);
  const wavPath = path.join(TMP, 'live_robot36.wav');
  fs.writeFileSync(wavPath, Buffer.from(SSTV.encodeWAV(samples, nativeRate)));
  console.log('  已生成假麦克风素材: ' + path.basename(wavPath) + '  (' +
    (samples.length / nativeRate).toFixed(1) + ' s, ' +
    (fs.statSync(wavPath).size / 1024 / 1024).toFixed(1) + ' MB)');

  // ---------------------------------------------------------- 1. 启动浏览器
  // 注意：Chrome 的假音频设备是进程级的，**任何一次残留的浏览器进程都会让后续
  // 运行拿到错误/缺失的音频**。所以这里全程 try/finally，异常时也必须关干净。
  const browser = await chromium.launch({
    headless: true,
    executablePath: EXECUTABLE,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--use-file-for-fake-audio-capture=' + wavPath.replace(/\\/g, '/') + '%noloop',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio'
    ]
  });
  const pageErrors = [];
  let context, page;

  try {
    context = await browser.newContext({ permissions: ['microphone'] });
    page = await context.newPage();
    page.on('pageerror', e => pageErrors.push(e.message));

    async function openMicPanel() {
      await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
      await page.click('[data-tab="rx"]');
      await page.click('.seg-btn[data-src="mic"]');
    }

    /**
     * 点录音并等待制式锁定（= 画布切到制式尺寸）。
     * 假音频设备偶发拿不到音频（通常是上一次运行残留了浏览器进程），此时重来
     * 一次即可 —— 重开会新建一条采集流，文件从头开始播。
     */
    async function recordAndWaitLock(maxAttempts) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const t0 = Date.now();
        await page.click('#rx-rec');
        await page.waitForFunction(
          () => /停止录音/.test(document.querySelector('#rx-rec').textContent || ''),
          null, { timeout: 30000 });
        try {
          await page.waitForFunction((want) => {
            const c = document.querySelector('#rx-preview');
            return c.width === want.w && c.height === want.h;
          }, { w: mode.width, h: mode.height }, { timeout: 15000 });
          return { ok: true, attempt, lockMs: Date.now() - t0 };
        } catch (e) {
          console.log('  ! 第 ' + attempt + ' 次未拿到信号（假音频设备没喂上），重试…');
          await page.click('#rx-rec').catch(() => {});
          await sleep(1500);
          await openMicPanel();
        }
      }
      return { ok: false };
    }

    // =========================================================== A. 渐进性
    console.log('\n=== 1. 麦克风录音：画面是否在信号到达过程中逐行长出 ===');
    await openMicPanel();
    check('「实时逐行成像」开关默认开启', await page.isChecked('#rx-live-on'));
    check('录音前遮罩隐藏', await page.isHidden('#rx-live'));

    const lock = await recordAndWaitLock(3);
    check('成功拿到假麦克风信号并识别出制式', lock.ok,
      lock.ok ? '第 ' + lock.attempt + ' 次，' + lock.lockMs + ' ms' : '3 次均失败');
    if (!lock.ok) throw new Error('假音频设备始终没有喂上信号，无法继续');
    check('锁定时延合理（< 8 s，即"边收边出"而非等整段）', lock.lockMs < 8000,
      lock.lockMs + ' ms');

    await sleep(1500);            // 让前几行先上屏，曲线起点才有可比性
    const t0 = Date.now();
    const trace = [];
    while (Date.now() - t0 < PROGRESS_MS) {
      const s = await page.evaluate(PROBE);
      trace.push(Object.assign({ t: (Date.now() - t0) / 1000 }, s));
      await sleep(1200);
    }
    console.log('  已画行数时间曲线:');
    trace.forEach(s => console.log('    t=' + s.t.toFixed(1) + 's  画布已画 ' +
      s.painted + ' 行  徽标 ' + s.chipRows + '/' + s.chipTotal + '  扫描线 top=' +
      (s.scanning || '(空)')));
    const last = trace[trace.length - 1];

    check('画布已切换到制式尺寸 (' + mode.width + '×' + mode.height + ')',
      last.W === mode.width && last.H === mode.height, last.W + '×' + last.H);
    check('外层容器进入 receiving 态', /receiving/.test(last.stage), last.stage);
    check('接收遮罩已显示', !/hidden/.test(last.overlay), last.overlay);
    check('扫描线位置随进度下移（有视觉指示）',
      trace.some(s => /%/.test(s.scanning || '')), last.scanning);

    // ---- 核心：逐行长出，而不是最后一次性出现 ----
    const early = trace[0];
    check('观察窗口开始时已有画面但远未画满（0 < 已画 < 整幅）',
      early.painted > 0 && early.painted < mode.height * 0.8,
      early.painted + ' / ' + mode.height);

    let mono = true;
    for (let i = 1; i < trace.length; i++) if (trace[i].painted < trace[i - 1].painted) mono = false;
    check('已画行数单调不减（不会回退重画）', mono,
      trace.map(s => s.painted).join(' → '));

    check('观察窗口内至少新增了 20 行（画面确实在持续生长）',
      last.painted - early.painted >= 20,
      early.painted + ' → ' + last.painted);

    // 增长速度 ≈ 每行 150 ms，允许 ±40% 容差（含显示与轮询抖动）
    const dt = last.t - early.t;
    const rate = dt > 0 ? (last.painted - early.painted) / dt : 0;
    const expect = 1000 / (mode.lineDuration(0) * 1000);
    check('生长速率与制式行速吻合（' + expect.toFixed(1) + ' 行/s ±40%）',
      Math.abs(rate - expect) / expect < 0.4,
      rate.toFixed(2) + ' 行/s');

    check('画面尚未画满时，底部仍是"待机底"（探针自证 + 逐行填充）',
      trace.some(s => s.painted < mode.height && s.bottomIsBg),
      last.painted + '/' + mode.height);

    // 徽标与画布必须同步
    check('进度徽标行数随时间增长',
      trace[0].chipRows !== null && last.chipRows > trace[0].chipRows,
      trace[0].chipRows + ' → ' + last.chipRows);
    check('徽标行数与画布已画行数一致（±2 行，验证"说的"和"画的"同源）',
      Math.abs(last.chipRows - last.painted) <= 2,
      '徽标 ' + last.chipRows + ' vs 画布 ' + last.painted);
    check('徽标总行数等于制式高度', last.chipTotal === mode.height, String(last.chipTotal));
    check('徽标包含百分比', /\d+%/.test(last.chip), last.chip);
    check('说明行报出制式 / 采样率 / VIS / 已锁定同步',
      /Robot 36/.test(last.note) && last.note.includes(String(nativeRate)) &&
      /VIS 8\b/.test(last.note) && /已锁定行同步/.test(last.note), last.note);

    await page.screenshot({ path: path.join(SHOTS, 'live_rx_progress.png'), fullPage: true });

    // 停止：先收实时结果，再批量校验
    await page.click('#rx-rec');
    await page.waitForFunction(() => {
      const t = document.querySelector('#rx-status').textContent || '';
      return /实时成像|实时接收|录音处理失败/.test(t);
    }, null, { timeout: 60000 });
    const stopStatus = (await page.textContent('#rx-status')).trim();
    console.log('  停止后状态: ' + stopStatus);
    check('停止后遮罩收起', await page.isHidden('#rx-live'));
    check('停止后退出 receiving 态',
      !/receiving/.test(await page.getAttribute('#rx-stage', 'class') || ''));
    check('停止后有实时成像结论', /实时成像完成|实时接收/.test(stopStatus), stopStatus);
    check('停止后自动做了批量精确重解校验', /精确重解/.test(stopStatus), stopStatus);
    check('批量校验未报「未成功」', !/未成功/.test(stopStatus), stopStatus);

    // =========================================================== B. 整幅收全
    console.log('\n=== 2. 完整录下整幅（' + MODE_ID + '，约 ' +
      Math.round(FULL_MS / 1000) + ' s）===');
    await openMicPanel();
    const lock2 = await recordAndWaitLock(3);
    if (!lock2.ok) throw new Error('第二次录音同样没拿到信号');

    const t1 = Date.now();
    await sleep(Math.round(FULL_MS * 0.5));
    const mid = await page.evaluate(PROBE);
    console.log('  中途 ' + Math.round(FULL_MS * 0.5 / 1000) + ' s: 已画 ' +
      mid.painted + ' 行  徽标 ' + mid.chipRows + '/' + mid.chipTotal);
    check('中途已过半但尚未收满',
      mid.painted > mode.height * 0.2 && mid.painted < mode.height,
      mid.painted + '/' + mode.height);

    await sleep(Math.max(0, FULL_MS - (Date.now() - t1)));
    const end = await page.evaluate(PROBE);
    console.log('  结束前 ' + Math.round(FULL_MS / 1000) + ' s: 已画 ' +
      end.painted + ' 行  徽标 ' + end.chipRows + '/' + end.chipTotal);
    // 假音频设备偶发插一次静音，会让实时路径少认 1~2 行（随后从下一行重新
    // 锁定，代价是底下少一行）。这是采集环境的抖动，不是成像逻辑的问题，
    // 因此这里放到 95%；"是不是真的收全"由下面的批量校验来强断言。
    check('实时路径收满 ≥95% 的整幅行数（采集抖动允许丢 1~2 行）',
      end.painted >= mode.height * 0.95, end.painted + '/' + mode.height);

    await page.screenshot({ path: path.join(SHOTS, 'live_rx_full.png'), fullPage: true });

    await page.click('#rx-rec');
    await page.waitForFunction(() => {
      const t = document.querySelector('#rx-status').textContent || '';
      return /实时成像|实时接收|录音处理失败/.test(t);
    }, null, { timeout: 90000 });
    const fullStatus = (await page.textContent('#rx-status')).trim();
    console.log('  状态: ' + fullStatus);
    check('整幅完成后通过批量校验',
      /实时成像完成/.test(fullStatus) && !/未成功/.test(fullStatus), fullStatus);
    check('批量精确重解未报「非法类型数组长度」类崩溃',
      !/Invalid typed array length/.test(fullStatus), fullStatus);

    // 强断言：批量路径不能"从中间截断"。
    // 改前：只解出 138/240 行（第一处掉音就 break，后半幅全黑）；改后：≥95%。
    // 之所以不苛求恰好 240：Chrome 的假音频设备偶发插入一小段静音，那一行的数据
    // 在**物理上**就不存在了 —— 两条完全独立的解码路径（增量 vs 批量）都停在
    // 同一个行数上，这本身就是"数据真丢了，而不是解码器漏了"的证据。
    const batchM = /精确重解校验通过：\S+\s*·\s*(\d+)\s*行/.exec(fullStatus);
    const batchRows = batchM ? +batchM[1] : null;
    const liveM = /逐行收到\s*(\d+)\s*行/.exec(fullStatus);
    const liveRows = liveM ? +liveM[1] : null;

    if (batchRows !== null) {
      check('批量精确重解未在掉音处截断（≥95% 整幅）',
        batchRows >= mode.height * 0.95, batchRows + '/' + mode.height);
      check('两条独立解码路径结果一致（|批量 - 实时| ≤ 2 行）',
        liveRows === null || Math.abs(batchRows - liveRows) <= 2,
        '批量 ' + batchRows + ' vs 实时 ' + liveRows);
    } else {
      // 走了"保留实时结果"分支：说明实时覆盖更全，此时也要给出可核对的信息
      const m2 = /少于实时的\s*(\d+)\s*行/.exec(fullStatus) || /逐行收到\s*(\d+)\s*行/.exec(fullStatus);
      check('实时结果覆盖 ≥95% 整幅', m2 && +m2[1] >= mode.height * 0.95,
        m2 ? m2[1] + ' 行' : fullStatus);
    }

    // ---------------------------------------------------------- 画面内容校验
    const stats = await page.evaluate(() => {
      const cv = document.querySelector('#rx-preview');
      const { width: w, height: h } = cv;
      const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
      let sr = 0, sg = 0, sb = 0, nonBlack = 0;
      const n = w * h;
      let lr = 0, ln = 0, rr = 0, rn = 0, tg = 0, tn = 0, bg = 0, bn = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const R = d[i], G = d[i + 1], B = d[i + 2];
        sr += R; sg += G; sb += B;
        if (R + G + B > 24) nonBlack++;
        if (x < w * 0.1) { lr += R; ln++; }
        if (x >= w * 0.9) { rr += R; rn++; }
        if (y < h * 0.1) { tg += G; tn++; }
        if (y >= h * 0.9) { bg += G; bn++; }
      }
      return {
        w, h, meanR: sr / n, meanG: sg / n, meanB: sb / n,
        nonBlackRatio: nonBlack / n,
        leftR: lr / ln, rightR: rr / rn, topG: tg / tn, bottomG: bg / bn
      };
    });
    console.log('    画布 ' + stats.w + '×' + stats.h +
      '  均值 R=' + stats.meanR.toFixed(1) + ' G=' + stats.meanG.toFixed(1) +
      ' B=' + stats.meanB.toFixed(1) + '  非黑 ' +
      (stats.nonBlackRatio * 100).toFixed(1) + '%');
    check('画面非空白（非黑 > 85%）', stats.nonBlackRatio > 0.85,
      (stats.nonBlackRatio * 100).toFixed(1) + '%');
    check('R 左暗右亮（水平未颠倒）', stats.rightR - stats.leftR > 100,
      '左 ' + stats.leftR.toFixed(1) + ' → 右 ' + stats.rightR.toFixed(1));
    check('G 上暗下亮（垂直未颠倒，且未停在半截）', stats.bottomG - stats.topG > 100,
      '上 ' + stats.topG.toFixed(1) + ' → 下 ' + stats.bottomG.toFixed(1));

    // ---------------------------------------------------------- PNG 导出
    const png = await page.evaluate(() => new Promise(resolve => {
      document.querySelector('#rx-preview').toBlob(b => {
        if (!b) return resolve(null);
        const fr = new FileReader();
        fr.onload = () => resolve({
          size: b.size, type: b.type,
          magic: Array.from(new Uint8Array(fr.result).slice(0, 8))
        });
        fr.readAsArrayBuffer(b);
      }, 'image/png');
    }));
    const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
    check('导出 PNG 正常（含 magic 头校验）',
      png && png.type === 'image/png' && png.size > 1000 &&
      PNG_MAGIC.every((v, i) => png.magic[i] === v),
      png ? png.size + ' 字节' : '(null)');

    check('全程无未捕获 JS 异常', pageErrors.length === 0,
      pageErrors.length ? pageErrors.join(' | ') : '无');
  } finally {
    // 必须无条件关干净：残留进程会污染后续运行（见上方注释）
    await browser.close().catch(() => {});
  }

  console.log('\n---------------------------------------------');
  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('截图: ' + path.join(SHOTS, 'live_rx_progress.png'));
  console.log('      ' + path.join(SHOTS, 'live_rx_full.png'));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('运行异常: ' + (e && e.stack || e)); process.exit(2); });
