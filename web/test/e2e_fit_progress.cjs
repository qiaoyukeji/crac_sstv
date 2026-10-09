/*
 * e2e_fit_progress.cjs — 用真实浏览器（Playwright/Chromium）验证两件事：
 *
 *   1. 画面适配：竖构图图片在 contain 下**不再被切掉上下**，在 cover 下才裁。
 *      做法：在页面里现造一张「顶部纯红 / 中部绿渐变 / 底部纯蓝」的 1200×1600 竖图，
 *      拖进 dropzone，然后直接读 #tx-preview 画布（它就是待编码的那张位图）的像素，
 *      用「上下两条色带还在不在」作为可证伪的判据。
 *   2. 发送进度遮罩：点发送后遮罩出现、百分比单调递增、未发送区域高度单调递减，
 *      结束后自动收起。
 *
 * 运行： node web/test/e2e_fit_progress.cjs
 * 需要： 本地服务在 http://localhost:8000 运行（python web/serve.py）
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const BASE = process.env.SSTV_URL || 'http://localhost:8000/';
const SHOTS = path.join(__dirname, 'shots');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};

/** 在页面内构造竖构图测试图并通过 drag&drop 交给应用 */
async function dropPortrait(page) {
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 1600;
    const g = c.getContext('2d');
    g.fillStyle = '#ff0000'; g.fillRect(0, 0, 1200, 200);                 // 顶部红带
    const grad = g.createLinearGradient(0, 200, 0, 1400);
    grad.addColorStop(0, '#00ff00'); grad.addColorStop(1, '#008000');     // 中部绿渐变
    g.fillStyle = grad; g.fillRect(0, 200, 1200, 1200);
    g.fillStyle = '#0000ff'; g.fillRect(0, 1400, 1200, 200);              // 底部蓝带
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'portrait.png', { type: 'image/png' }));
    document.querySelector('#tx-drop').dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  // 等图片解码完成（fit-note 出现内容即说明 renderSource 跑过了）
  await page.waitForFunction(() => {
    const n = document.querySelector('#tx-fit-note');
    return n && n.textContent.trim().length > 0;
  }, null, { timeout: 10000 });
}

/** 读取 #tx-preview 上某些像素的 RGB（即待编码位图的实际内容） */
async function samplePixels(page, points) {
  return page.evaluate((pts) => {
    const cv = document.querySelector('#tx-preview');
    const g = cv.getContext('2d');
    return pts.map(([x, y]) => {
      const d = g.getImageData(x, y, 1, 1).data;
      return { x, y, r: d[0], g: d[1], b: d[2] };
    });
  }, points);
}

const isRed = (p) => p.r > 200 && p.g < 60 && p.b < 60;
const isBlue = (p) => p.b > 200 && p.r < 60 && p.g < 60;
const isBlack = (p) => p.r < 20 && p.g < 20 && p.b < 20;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });

  // Playwright 默认要找 chromium_headless_shell；本机只装了完整版 chromium，
  // 因此显式指定可执行文件（找不到时回退到 Edge）。
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228',
              'chrome-win64', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  const exe = candidates.find((p) => p && fs.existsSync(p));
  if (!exe) { console.error('找不到可用的 Chromium/Edge 可执行文件'); process.exit(2); }
  console.log('使用浏览器: ' + exe + '\n');

  const browser = await chromium.launch({
    headless: true,
    executablePath: exe,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio']
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on('pageerror', (e) => console.log('  [pageerror] ' + e.message));

  await page.goto(BASE, { waitUntil: 'load' });

  // ---------------------------------------------------------------- 1. 适配
  console.log('=== 1. 竖构图 1200×1600 载入 Martin M1（320×256）===');
  await dropPortrait(page);

  const note = await page.textContent('#tx-fit-note');
  console.log('  适配说明: ' + note);
  check('默认适配方式为 contain', await page.inputValue('#tx-fit') === 'contain');
  check('说明文案写明"完整保留"', /完整保留/.test(note), note);

  await page.selectOption('#tx-fit', 'contain');
  await page.waitForTimeout(120);
  let px = await samplePixels(page, [[160, 6], [160, 249], [5, 128], [315, 128], [160, 128]]);
  check('contain: 顶部红带保留（未被切掉）', isRed(px[0]), px[0]);
  check('contain: 底部蓝带保留（未被切掉）', isBlue(px[1]), px[1]);
  check('contain: 左侧为黑边', isBlack(px[2]), px[2]);
  check('contain: 右侧为黑边', isBlack(px[3]), px[3]);
  check('contain: 中部为绿色内容', px[4].g > 100 && px[4].r < 60, px[4]);
  await page.screenshot({ path: path.join(SHOTS, 'tx_fit_contain.png'), clip: { x: 0, y: 0, width: 1100, height: 900 } });

  await page.selectOption('#tx-fit', 'cover');
  await page.waitForTimeout(120);
  px = await samplePixels(page, [[160, 6], [160, 249], [5, 128], [315, 128]]);
  check('cover: 顶部红带已被裁掉（复现原现象）', !isRed(px[0]), px[0]);
  check('cover: 底部蓝带已被裁掉（复现原现象）', !isBlue(px[1]), px[1]);
  check('cover: 左右无黑边（填满画布）', !isBlack(px[2]) && !isBlack(px[3]), [px[2], px[3]]);
  const coverNote = await page.textContent('#tx-fit-note');
  check('cover: 说明文案给出裁剪比例', /裁掉上下共/.test(coverNote), coverNote);
  check('cover: 说明文案高亮告警', await page.evaluate(
    () => document.querySelector('#tx-fit-note').classList.contains('warn')));
  await page.screenshot({ path: path.join(SHOTS, 'tx_fit_cover.png') });

  await page.selectOption('#tx-fit', 'stretch');
  await page.waitForTimeout(120);
  px = await samplePixels(page, [[160, 6], [160, 249], [5, 128]]);
  check('stretch: 上下色带都在且左右无黑边', isRed(px[0]) && isBlue(px[1]) && !isBlack(px[2]), px);

  // 回到 contain 作为默认展示状态
  await page.selectOption('#tx-fit', 'contain');
  await page.waitForTimeout(120);

  // ------------------------------------------------------------ 2. 发送进度
  console.log('\n=== 2. 发送进度遮罩（Robot 36，约 36 s）===');
  await page.selectOption('#tx-mode', '4');                 // Robot 36
  await page.waitForTimeout(150);
  await page.click('#tx-gen');
  await page.waitForFunction(() => !document.querySelector('#tx-play').disabled, null, { timeout: 60000 });
  check('生成后可点发送', !(await page.isDisabled('#tx-play')));

  const hiddenBefore = await page.evaluate(
    () => document.querySelector('#tx-send').classList.contains('hidden'));
  check('发送前遮罩是隐藏的', hiddenBefore === true);

  await page.click('#tx-play');
  await page.waitForTimeout(150);

  const hiddenAfter = await page.evaluate(
    () => document.querySelector('#tx-send').classList.contains('hidden'));
  check('点发送后遮罩出现', hiddenAfter === false);

  const samples = [];
  let halfShot = false;
  for (let i = 0; i < 40; i++) {
    const s = await page.evaluate(() => {
      const el = document.querySelector('#tx-send');
      return {
        valuenow: Number(el.getAttribute('aria-valuenow')),
        maskH: parseFloat(document.querySelector('#tx-send-mask').style.height),
        lineTop: parseFloat(document.querySelector('#tx-send-line').style.top),
        chip: document.querySelector('#tx-send-chip').textContent
      };
    });
    samples.push(s);
    if (i === 3) await page.screenshot({ path: path.join(SHOTS, 'tx_sending_overlay_early.png') });
    // 约进行到一半时再存一张，遮罩与已发送区域的对比最直观
    if (!halfShot && s.valuenow >= 45) {
      halfShot = true;
      await page.screenshot({ path: path.join(SHOTS, 'tx_sending_overlay_half.png') });
    }
    await page.waitForTimeout(500);
  }
  [0, 3, 10, 20, 30, 39].forEach((i) => {
    const s = samples[i];
    console.log('    t+' + (i * 0.5).toFixed(1) + 's  ' + String(s.valuenow).padStart(3) + '%  mask=' +
      s.maskH.toFixed(1) + '%  ' + s.chip);
  });

  const asc = samples.every((s, i) => i === 0 || s.valuenow >= samples[i - 1].valuenow);
  check('进度百分比单调递增', asc, samples.map((s) => s.valuenow));
  check('进度确实在推进（不是卡在 0）', samples[samples.length - 1].valuenow > 0,
    samples[samples.length - 1].valuenow);
  check('未发送区域高度随之递减 (maskH = 100 - pct)',
    samples.every((s) => Math.abs(s.maskH - (100 - s.valuenow)) < 1.05),
    samples.map((s) => [s.valuenow, s.maskH]));
  check('扫描线位置与百分比一致',
    samples.every((s) => Math.abs(s.lineTop - s.valuenow) < 1.05),
    samples.map((s) => [s.valuenow, s.lineTop]));
  check('遮罩文案含百分比与计时 (mm:ss / mm:ss)',
    /正在发送\s*\d+%/.test(samples[2].chip) && /\d{2}:\d{2}\s*\/\s*\d{2}:\d{2}/.test(samples[2].chip),
    samples[2].chip);

  await page.click('#tx-play');                           // 停止
  await page.waitForTimeout(200);
  check('停止后遮罩收起', await page.evaluate(
    () => document.querySelector('#tx-send').classList.contains('hidden')));
  check('停止后按钮回到"▶ 发送"',
    (await page.textContent('#tx-play')).trim() === '▶ 发送',
    await page.textContent('#tx-play'));
  check('停止后进度归零', await page.getAttribute('#tx-send', 'aria-valuenow') === '0');

  // -------------------------------------------------------------- 3. 说明页
  console.log('\n=== 3. 说明页内容与新增能力保持一致 ===');
  await page.click('.tab[data-tab="help"]');
  await page.waitForTimeout(150);
  const helpText = await page.textContent('#help');
  check('说明页提到"画面适配"', /画面适配/.test(helpText));
  check('说明页提到"发送进度"', /发送进度/.test(helpText));
  check('说明页给出 serve.py 启动方式', /web\/serve\.py/.test(helpText));
  check('说明页链接到 HTTPS 麦克风指南', /HTTPS_MIC_GUIDE\.md/.test(helpText));
  check('说明页不再出现过时的 http.server 单命令说法', !/python -m http\.server 8000/.test(helpText));
  await page.screenshot({ path: path.join(SHOTS, 'help_tab.png'), fullPage: true });

  await browser.close();
  console.log('\n---------------------------------------------');
  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('截图目录: ' + SHOTS);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E 崩溃: ' + e.message); process.exit(2); });
