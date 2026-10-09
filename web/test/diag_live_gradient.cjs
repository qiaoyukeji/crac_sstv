/**
 * 诊断：实时路径的 R 水平梯度为什么被压缩？
 *
 * 背景：e2e_live_rx.cjs 里「R 左暗右亮 (>100)」在浏览器实时路径上失败（实测 ~75），
 * 而同一个 WAV 用 Node 直接喂引擎却完美（差 215）。中间隔着一层"浏览器采集"。
 *
 * 这个脚本把两种可能分开：
 *   (a) 实时解码器本身有缺陷   → 它自己的 image() 梯度就低
 *   (b) 采集到的音频被扭曲     → 实时 image() 低，但同一段录音批量重解也低
 *   (c) 渲染/画布问题          → 引擎缓冲梯度正常，画布梯度低
 *
 * 做法：挂钩 window.SSTV 的赋值，包住 createStreamDecoder，把应用创建的每个
 * 解码器实例都记下来；录音结束后，直接在页面内量「每个解码器自己的 RGB 缓冲」
 * 与「画布」的梯度，三者对比即可定位。
 *
 *   node web/test/diag_live_gradient.cjs
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const SSTV = require('../sstv-engine.js');

const BASE = process.env.SSTV_URL || 'http://127.0.0.1:8000/index.html';
const EXECUTABLE = process.env.CHROME_BIN || 'C:/Users/kavin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const TMP = path.join(__dirname, 'tmp');
const MODE_ID = process.env.SSTV_MODE || 'Robot 36';   // 注意制式 id 带空格

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

/** 页面内：在一张 RGB 缓冲上量四角梯度。 */
const MEASURE = `(rgb, w, h) => {
  const band = (y0, y1, x0, x1, c) => {
    let s = 0, k = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += rgb[(y * w + x) * 3 + c]; k++; }
    return k ? s / k : 0;
  };
  const lR = band(0, h, 0, Math.floor(w * 0.1), 0);
  const rR = band(0, h, w - Math.floor(w * 0.1), w, 0);
  const tG = band(0, Math.floor(h * 0.1), 0, w, 1);
  const bG = band(h - Math.floor(h * 0.1), h, 0, w, 1);
  return { lR, rR, dR: rR - lR, tG, bG, dG: bG - tG };
}`;

/** 页面内：量画布。 */
const MEASURE_CANVAS = `() => {
  const cv = document.querySelector('#rx-preview');
  const w = cv.width, h = cv.height;
  const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
  const isBlack = (y) => { for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (d[i] > 6 || d[i + 1] > 6 || d[i + 2] > 6) return false; } return true; };
  const valid = [];
  for (let y = 0; y < h; y++) if (!isBlack(y)) valid.push(y);
  const lc = Math.floor(w * 0.1), rc = w - Math.floor(w * 0.1);
  const band = Math.max(1, Math.floor(valid.length * 0.1));
  const top = new Set(valid.slice(0, band)), bot = new Set(valid.slice(-band));
  let lr = 0, ln = 0, rr = 0, rn = 0, tg = 0, tn = 0, bg = 0, bn = 0;
  for (const y of valid) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (x < lc) { lr += d[i]; ln++; }
    if (x >= rc) { rr += d[i]; rn++; }
    if (top.has(y)) { tg += d[i + 1]; tn++; }
    if (bot.has(y)) { bg += d[i + 1]; bn++; }
  }
  return { w, h, validRows: valid.length, lR: ln ? lr / ln : 0, rR: rn ? rr / rn : 0,
           dR: (rn ? rr / rn : 0) - (ln ? lr / ln : 0),
           tG: tn ? tg / tn : 0, bG: bn ? bg / bn : 0,
           dG: (bn ? bg / bn : 0) - (tn ? tg / tn : 0) };
}`;

/**
 * 页面内：挂钩 window.SSTV 的赋值，把应用创建的每个流式解码器都记下来。
 * 必须用真函数传给 addInitScript —— 传字符串时 Playwright 把它当"表达式"求值，
 * 一个裸的 `() => {...}` 只会被创建、不会被调用，钩子等于没装。
 */
function HOOK() {
  let _s;
  window.__decs = [];
  Object.defineProperty(window, 'SSTV', {
    configurable: true,
    get() { return _s; },
    set(v) {
      _s = v;
      if (v && typeof v.createStreamDecoder === 'function' && !v.__hooked) {
        const orig = v.createStreamDecoder;
        v.createStreamDecoder = function (sr, hint, opts) {
          const d = orig.apply(this, arguments);
          try { window.__decs.push({ sr, hint, opts: opts || {}, dec: d, t: Date.now() }); } catch (e) { /* noop */ }
          return d;
        };
        v.__hooked = true;
      }
    }
  });
}

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const mode = SSTV.modeById(MODE_ID);
  const ref = makeRef(mode.width, mode.height);
  console.log('制式: ' + MODE_ID + ' ' + mode.width + '×' + mode.height);

  // 探测采样率
  let nativeRate = 48000;
  {
    const b = await chromium.launch({ headless: true, executablePath: EXECUTABLE });
    try {
      const p = await b.newPage();
      await p.goto(BASE, { waitUntil: 'load', timeout: 60000 });
      nativeRate = await p.evaluate(() => {
        const C = window.AudioContext || window.webkitAudioContext;
        const ctx = new C(); const r = ctx.sampleRate; if (ctx.close) ctx.close(); return r;
      });
    } finally { await b.close(); }
  }
  console.log('AudioContext 采样率探测值: ' + nativeRate + ' Hz');

  const samples = SSTV.encodeImage(mode, ref, nativeRate);
  const wavPath = path.join(TMP, 'diag_robot36.wav');
  fs.writeFileSync(wavPath, Buffer.from(SSTV.encodeWAV(samples, nativeRate)));
  console.log('WAV: ' + (samples.length / nativeRate).toFixed(1) + ' s @ ' + nativeRate + ' Hz');

  const browser = await chromium.launch({
    headless: true, executablePath: EXECUTABLE,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--use-file-for-fake-audio-capture=' + wavPath.replace(/\\/g, '/') + '%noloop',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      // 页面长时间没有交互时，Chrome 会把渲染进程降级 / 节流音频回调，
      // 结果是 onaudioprocess 只跑了一小会儿就停（实测只收到 1.4 s）。
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows'
    ]
  });

  try {
    const context = await browser.newContext({ permissions: ['microphone'] });
    await context.addInitScript(HOOK);
    const page = await context.newPage();
    page.on('pageerror', e => console.log('  [pageerror] ' + e.message));

    await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
    console.log('钩子已装: ' + (await page.evaluate(() => Array.isArray(window.__decs))));

    // 页面内 UI 快照。必须用 page.evaluate（真在页面里跑 JS）；page.textContent 走的是
    // 协议层的 DOM 查询，对"保持渲染进程活跃"没帮助。
    const readUi = () => page.evaluate(() => ({
      btn: (document.querySelector('#rx-rec') || {}).textContent || '',
      note: (document.querySelector('#rx-live-note') || {}).textContent || '',
      chip: (document.querySelector('#rx-live-chip') || {}).textContent || '',
      clock: (document.querySelector('#rx-rec-time') || {}).textContent || '',
      cvW: (document.querySelector('#rx-preview') || {}).width,
      cvH: (document.querySelector('#rx-preview') || {}).height
    }));
    const openMic = async () => {
      await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
      await page.click('[data-tab="rx"]');
      await page.click('.seg-btn[data-src="mic"]');
    };

    // 假音频设备第一次常常"没喂上"：只送来 1.4 s 左右就断了，VIS 永远解不出来。
    // e2e_live_rx.cjs 里靠同样的重试兜住；这里也必须有，否则拿到的是设备故障而不是
    // 我们要研究的现象。
    let locked = false;
    for (let attempt = 1; attempt <= 3 && !locked; attempt++) {
      await openMic();
      await page.click('#rx-rec');
      for (let i = 0; i < 30; i++) {                 // 最多等 15 s
        const ui = await readUi();
        if (ui.cvW === mode.width && ui.cvH === mode.height) { locked = true; break; }
        await page.waitForTimeout(500);
      }
      if (!locked) {
        console.log('  ! 第 ' + attempt + ' 次未拿到信号（假音频设备没喂上），重试…');
        await page.click('#rx-rec').catch(() => {});
        await page.waitForTimeout(1500);
      }
    }
    console.log('已锁定制式: ' + locked);
    if (!locked) throw new Error('假音频设备始终没喂上信号，无法测量');

    // 等自动停止（最多 90 s）；每 5 s 打一次实时状态，便于判断"音频是不是很早断了"
    let auto = false;
    for (let i = 0; i < 180; i++) {
      const ui = await readUi();
      if (i % 10 === 0) {
        console.log('  t=' + (i * 0.5).toFixed(0) + 's 时钟=' + ui.clock +
          ' 画布=' + ui.cvW + '×' + ui.cvH + ' 徽标=' + ui.chip + ' | ' + ui.note);
      }
      if (/开始录音/.test(ui.btn)) { auto = true; break; }
      await page.waitForTimeout(500);
    }
    console.log('自动停止: ' + (auto ? '是' : '否（手动停）'));
    if (!auto) await page.click('#rx-rec');

    // 收尾（转码 + 批量重解）可能耗时十几秒，这里轮询状态行，超时也继续
    let status = '';
    for (let i = 0; i < 40; i++) {
      status = (await page.textContent('#rx-status')) || '';
      if (/实时成像|录音处理失败|未能识别|没能解出/.test(status)) break;
      await page.waitForTimeout(1000);
    }
    console.log('状态: ' + status);
    console.log('解码器实例数: ' + (await page.evaluate(() => (window.__decs || []).length)));

    // ---- 各解码器自己的缓冲
    const decs = await page.evaluate(`(${MEASURE}) && (() => {
      const M = ${MEASURE};
      return window.__decs.map((rec, i) => {
        let st = null, m = null;
        try {
          st = rec.dec.stats();
          if (st.width) m = M(rec.dec.image(), st.width, st.height);
        } catch (e) { return { i, err: e.message }; }
        return { i, sr: rec.sr, hint: rec.hint, opts: rec.opts,
                 mode: st.mode, vis: st.vis, rows: st.rows, totalRows: st.totalRows,
                 frameStart: st.frameStart, frameEnd: st.frameEnd,
                 trusted: st.frameStartTrusted, seconds: st.seconds, m };
      });
    })()`);

    console.log('\n--- 应用创建过的解码器（按创建顺序）---');
    for (const d of decs) {
      if (d.err) { console.log('  #' + d.i + ' 构造失败: ' + d.err); continue; }
      const tag = d.i === 0 ? '实时' : (d.hint ? '批量(hint=' + d.hint + ')' : '批量');
      console.log('  #' + d.i + ' [' + tag + '] sr=' + d.sr + ' mode=' + d.mode + ' vis=' + d.vis +
        ' rows=' + d.rows + '/' + d.totalRows + ' sec=' + (d.seconds || 0).toFixed(1) +
        ' frameStart=' + d.frameStart + ' trusted=' + d.trusted);
      if (d.m) console.log('        R 左=' + d.m.lR.toFixed(1) + ' → 右=' + d.m.rR.toFixed(1) +
        '  差=' + d.m.dR.toFixed(1) + '   |   G 上=' + d.m.tG.toFixed(1) +
        ' → 下=' + d.m.bG.toFixed(1) + '  差=' + d.m.dG.toFixed(1));
    }

    // ---- 画布
    const cv = await page.evaluate(`(${MEASURE_CANVAS})()`);
    console.log('\n--- 画布 ---');
    console.log('  ' + cv.w + '×' + cv.h + ' 有效行 ' + cv.validRows +
      '  R 左=' + cv.lR.toFixed(1) + ' → 右=' + cv.rR.toFixed(1) + '  差=' + cv.dR.toFixed(1) +
      '  |  G 上=' + cv.tG.toFixed(1) + ' → 下=' + cv.bG.toFixed(1) + '  差=' + cv.dG.toFixed(1));

    // ---- 参考：同一 WAV 在 Node 端解码的梯度（基准）
    const nodeDec = SSTV.createStreamDecoder(nativeRate, null, {});
    for (let i = 0; i < samples.length; i += 4096) nodeDec.push(samples.subarray(i, Math.min(samples.length, i + 4096)));
    nodeDec.finish();
    const ns = nodeDec.stats();
    const nrgb = nodeDec.image();
    const band = (y0, y1, x0, x1, c) => {
      let s = 0, k = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += nrgb[(y * ns.width + x) * 3 + c]; k++; }
      return s / k;
    };
    const W = ns.width, H = ns.height;
    const nlR = band(0, H, 0, Math.floor(W * 0.1), 0), nrR = band(0, H, W - Math.floor(W * 0.1), W, 0);
    const ntG = band(0, Math.floor(H * 0.1), 0, W, 1), nbG = band(H - Math.floor(H * 0.1), H, 0, W, 1);
    console.log('\n--- 基准：同一 WAV 在 Node 端解码 ---');
    console.log('  rows=' + ns.rows + '/' + ns.totalRows +
      '  R 左=' + nlR.toFixed(1) + ' → 右=' + nrR.toFixed(1) + '  差=' + (nrR - nlR).toFixed(1) +
      '  |  G 上=' + ntG.toFixed(1) + ' → 下=' + nbG.toFixed(1) + '  差=' + (nbG - ntG).toFixed(1));

    console.log('\n--- 判读 ---');
    const live = decs.find(d => d.i === 0 && d.m);
    const batch = decs.find(d => d.i > 0 && d.m);
    if (live && live.m.dR < 100 && cv.dR < 100) {
      if (batch && batch.m.dR < 100) {
        console.log('  实时/批量/画布/都低 → 采集到的音频被扭曲（设备层），引擎与渲染无关。');
      } else if (batch) {
        console.log('  实时低但批量高 → **实时增量路径**有缺陷（同段录音批量能解对）。');
      }
    } else if (live && live.m.dR >= 100 && cv.dR < 100) {
      console.log('  引擎缓冲正常但画布低 → 渲染/画布问题。');
    } else {
      console.log('  本次梯度正常，未复现。');
    }
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
