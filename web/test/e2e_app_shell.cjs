/**
 * 安卓壳 App 模式（app-shell）端到端测试
 * ----------------------------------------------------------------------------
 * 壳 App 里跑的其实是同一份 web/ 前端，所以"像不像原生 App"和"导出能不能落盘"
 * 这两件事只能在这里验 —— 用 Playwright 假装 window.SSTVNative 存在，页面就会
 * 走进 App 分支，与真机 WebView 的代码路径一致（差异只在原生实现那一侧）。
 *
 * 本测试回答三件事：
 *   1. App 模式是否把"网页相关介绍"全部藏起来了？（含全部三个标签页）
 *   2. 整幅收完后是否**自动停止**录音（用户不再需要手点停止）？
 *   3. 收完后点「导出 PNG」，是否真的把 base64 交给了原生桥？
 *
 * 用法：
 *   node web/test/e2e_app_shell.cjs
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const SSTV = require('../sstv-engine.js');

const BASE = process.env.SSTV_URL || 'http://127.0.0.1:8000/';
const EXECUTABLE = 'C:/Users/kavin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const SHOTS = path.join(__dirname, 'shots');
const TMP = path.join(__dirname, 'tmp');

const MODE_ID = 'Robot 36';
const FULL_MS = 44000;            // 整幅 36.9 s + 锁定与缓冲余量

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

/** 收集当前**可见**文本（跳过 display:none / visibility:hidden 的整棵子树）。 */
const VISIBLE_TEXT = `(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const t = (n.nodeValue || '').trim();
    if (!t) continue;
    let p = n.parentElement, hidden = false;
    while (p && p !== document.documentElement) {
      const s = getComputedStyle(p);
      if (s.display === 'none' || s.visibility === 'hidden') { hidden = true; break; }
      p = p.parentElement;
    }
    if (!hidden) out.push(t);
  }
  return out.join('\\n');
})()`;

/** App 模式下**不应该**再出现的"网页味"词表。 */
const WEB_WORDS = [
  'python', 'serve.py', 'localhost', '127.0.0.1', 'HTTPS_MIC_GUIDE',
  '浏览器', '网址', '地址栏', '标签页', '双击', 'file://', 'http://', 'https://',
  'Chrome', 'Safari', '安装根证书', '自签', 'iframe', 'index.html', 'Web Audio'
];

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  const mode = SSTV.modeById(MODE_ID);
  const ref = makeRef(mode.width, mode.height);

  // ---------------------------------------------------- 0. 探测采样率并造素材
  console.log('=== 0. 准备假麦克风素材 ===');
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
  console.log('  AudioContext 采样率: ' + nativeRate + ' Hz');
  const samples = SSTV.encodeImage(mode, ref, nativeRate);
  const wavPath = path.join(TMP, 'app_shell_robot36.wav');
  fs.writeFileSync(wavPath, Buffer.from(SSTV.encodeWAV(samples, nativeRate)));
  console.log('  素材: ' + path.basename(wavPath) + '  (' +
    (samples.length / nativeRate).toFixed(1) + ' s)');

  // ---------------------------------------------------------- 1. 启动浏览器
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

  try {
    const context = await browser.newContext({ permissions: ['microphone'] });
    // 假装自己是安卓壳 App：注入 window.SSTVNative（与真机 addJavascriptInterface 同名同形）
    await context.addInitScript(() => {
      window.__saved = [];
      window.SSTVNative = {
        saveFile: function (name, mime, base64) {
          window.__saved.push({
            name: name, mime: mime, len: base64.length, head: String(base64).slice(0, 16)
          });
          // 真机上这里是异步回填，这里同步回调即可
          if (window.__sstvOnSaved) {
            window.__sstvOnSaved(name, true, '已保存到 相册/SSTV/' + name);
          }
        },
        platform: function () { return 'android-webview'; }
      };
    });
    const page = await context.newPage();
    page.on('pageerror', e => pageErrors.push(e.message));

    async function openTab(tab) {
      await page.click('[data-tab="' + tab + '"]');
      await sleep(120);
    }

    /**
     * 开始录音并等制式锁定（= 画布切到制式尺寸）。
     * Chrome 的假音频设备**偶发拿不到音频**（进程级状态，上一次运行残留的浏览器
     * 就会污染下一次）。重开页面会新建一条采集流、文件从头播，所以重试即可。
     */
    async function recordAndWaitLock(maxAttempts) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await page.click('#rx-rec');
        await page.waitForFunction(
          () => /停止录音/.test(document.querySelector('#rx-rec').textContent || ''),
          null, { timeout: 30000 });
        try {
          await page.waitForFunction((want) => {
            const c = document.querySelector('#rx-preview');
            return c.width === want.w && c.height === want.h;
          }, { w: mode.width, h: mode.height }, { timeout: 15000 });
          return true;
        } catch (e) {
          console.log('  ! 第 ' + attempt + ' 次未拿到假麦克风信号，重试…');
          await page.click('#rx-rec').catch(() => {});
          await sleep(1500);
          await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
          await openTab('rx');
          await page.click('.seg-btn[data-src="mic"]');
        }
      }
      return false;
    }

    // ================================================== A. 隐藏"网页味"
    console.log('\n=== 1. App 模式：网页相关介绍是否已隐藏 ===');
    await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
    check('html 已标记为 app-shell',
      await page.evaluate(() => document.documentElement.classList.contains('app-shell')));
    check('window.__SSTV_IS_APP === true',
      await page.evaluate(() => window.__SSTV_IS_APP === true));

    for (const tab of ['tx', 'rx', 'help']) {
      await openTab(tab);
      const text = await page.evaluate(VISIBLE_TEXT);
      const hit = WEB_WORDS.filter(w => text.indexOf(w) >= 0);
      check('「' + tab + '」标签页可见文本无网页痕迹', hit.length === 0,
        hit.length ? '残留: ' + hit.join(', ') : '干净');
      if (tab === 'help') {
        check('「说明」页是 App 版文案（提到"相册/下载"或"应用设置"）',
          /相册|下载|应用设置|系统设置/.test(text), '见截图');
      }
    }

    await openTab('help');
    await page.screenshot({ path: path.join(SHOTS, 'app_shell_help.png'), fullPage: true });
    await openTab('tx');
    await page.screenshot({ path: path.join(SHOTS, 'app_shell_tx.png'), fullPage: true });

    // ================================================== B. 自动停止 + 导出
    console.log('\n=== 2. 麦克风接收：收满自动停止 + 导出落盘 ===');
    await openTab('rx');
    await page.click('.seg-btn[data-src="mic"]');
    const hasAutoStop = await page.evaluate(() => !!document.querySelector('#rx-auto-stop'));
    check('存在「接收完成自动停止」开关且默认开启',
      hasAutoStop && await page.isChecked('#rx-auto-stop'), '存在=' + hasAutoStop);

    const locked = await recordAndWaitLock(3);
    check('成功拿到假麦克风信号并锁定制式', locked,
      locked ? mode.width + '×' + mode.height : '3 次均失败');
    if (!locked) throw new Error('假音频设备始终没有喂上信号，无法继续');
    // ---- 关键：不再手点停止，等它自己停 ----
    const t0 = Date.now();
    let autoStopped = false;
    try {
      await page.waitForFunction(
        () => /开始录音/.test(document.querySelector('#rx-rec').textContent || ''),
        null, { timeout: FULL_MS });
      autoStopped = true;
    } catch (e) { /* 超时 = 没自动停 */ }
    const autoMs = Date.now() - t0;
    check('整幅收完后**自动停止**录音（未手点停止）', autoStopped,
      autoStopped ? (autoMs / 1000).toFixed(1) + ' s 后自动停止' : FULL_MS + ' ms 内未自动停止');

    // 自动停止后还有批量重解，等状态收敛
    await sleep(3000);
    const status = (await page.textContent('#rx-status')).trim();
    console.log('  状态: ' + status);
    check('停止后自动做了批量精确重解', /精确重解|实时成像/.test(status), status);

    await page.screenshot({ path: path.join(SHOTS, 'app_shell_rx_done.png'), fullPage: true });

    check('导出 PNG 按钮已可用（收完后自动解锁）',
      !(await page.isDisabled('#rx-png')));
    check('解码按钮已可用', !(await page.isDisabled('#rx-decode')));

    // ---- 导出走原生桥 ----
    const before = await page.evaluate(() => window.__saved.length);
    let clickErr = null;
    await page.click('#rx-png', { timeout: 8000 }).catch(e => { clickErr = e.message; });
    await sleep(1500);
    if (clickErr) check('点「导出 PNG」按钮可点', false, clickErr.split('\n')[0]);
    const saved = await page.evaluate(() => window.__saved);
    check('点「导出 PNG」把数据交给了原生桥', saved.length === before + 1,
      '桥调用 ' + (saved.length - before) + ' 次');
    if (saved.length > before) {
      const s = saved[saved.length - 1];
      check('文件名是 .png', /\.png$/.test(s.name), s.name);
      check('MIME 是 image/png', s.mime === 'image/png', s.mime);
      check('内容是 base64 PNG（iVBORw0KGgo 魔数）',
        s.head.indexOf('iVBORw0KGgo') === 0, s.head.slice(0, 12) + '… (' + s.len + ' 字符)');
    }
    const toastText = (await page.textContent('#toast')) || '';
    check('页面内给出保存结果提示', /保存|导出/.test(toastText), toastText.trim());
    const finalStatus = (await page.textContent('#rx-status')).trim();
    check('状态行落到"已保存…"而不是空的乐观提示',
      /已保存|已导出|保存失败|导出失败/.test(finalStatus), finalStatus);

    // ================================================== C. 手动停止也要能存
    console.log('\n=== 3. 手动停止（信号只收一半）后仍可导出 ===');
    await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
    await openTab('rx');
    await page.click('.seg-btn[data-src="mic"]');
    const locked2 = await recordAndWaitLock(3);
    check('第二次录音同样锁定制式', locked2);
    if (!locked2) throw new Error('第二次也没拿到假音频信号');
    await sleep(12000);                       // 收一会儿再手停，此时整幅远没收满
    const midText = (await page.textContent('#rx-live-chip')).trim();
    await page.click('#rx-rec');              // ← 手动停止
    await page.waitForFunction(() => {
      const t = document.querySelector('#rx-status').textContent || '';
      return /实时成像|实时接收|录音处理失败/.test(t);
    }, null, { timeout: 60000 });
    const manualStatus = (await page.textContent('#rx-status')).trim();
    console.log('  中途停止时徽标: ' + midText);
    console.log('  停止后状态: ' + manualStatus);
    check('手动停止生效（按钮复位）',
      /开始录音/.test(await page.textContent('#rx-rec')));
    check('半幅画面也被渲染并解锁导出（这就是"看图存不下"的那个坑）',
      !(await page.isDisabled('#rx-png')), manualStatus);
    const saved2 = await page.evaluate(() => window.__saved);
    await page.click('#rx-png', { timeout: 8000 }).catch(() => {});
    await sleep(1200);
    const saved3 = await page.evaluate(() => window.__saved);
    check('半幅结果也能交给原生桥落盘', saved3.length === saved2.length + 1,
      '桥调用 ' + (saved3.length - saved2.length) + ' 次');

    check('全程无未捕获 JS 异常', pageErrors.length === 0,
      pageErrors.length ? pageErrors.join(' | ') : '无');
  } finally {
    await browser.close().catch(() => {});
  }

  console.log('\n---------------------------------------------');
  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('截图: ' + SHOTS);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('运行异常: ' + (e && e.stack || e)); process.exit(2); });
