/**
 * RX 解码路径的真实浏览器端到端测试
 * ----------------------------------------------------------------------------
 * 为什么单独写这个：
 * 之前的 E2E 只覆盖了 TX（画面适配 + 发送进度），**没有覆盖 RX 解码**，
 * 于是漏掉了一个必然暴露的缺陷 —— 引擎输出的 RGB（3 字节/像素）被直接交给
 * 只接受 RGBA（4 字节/像素）的 `new ImageData()`，浏览器抛
 *   "Failed to construct 'ImageData': The input data length is not equal to
 *    (4 * width * height)"
 * 而这个错误还会被笼统地显示成"解码失败"，把渲染问题误报成信号问题。
 *
 * 本测试完整走一遍用户路径：
 *   生成 WAV → 通过 <input type=file> 导入 → 点「解码」→ 校验预览画布像素
 *   → 导出 PNG
 *
 * 用法：
 *   node web/test/e2e_rx_decode.cjs
 *   SSTV_URL=https://xxx.trycloudflare.com/ node web/test/e2e_rx_decode.cjs
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const SSTV = require('../sstv-engine.js');

const BASE = process.env.SSTV_URL || 'http://localhost:8000/';
const SR = 22050;
const EXECUTABLE = 'C:/Users/kavin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const SHOTS = path.join(__dirname, 'shots');
const TMP = path.join(__dirname, 'tmp');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
}

/**
 * 参考图：R 沿 x 线性渐变、G 沿 y 线性渐变、B 恒定 128。
 * 平滑渐变 + 明确的"方向性"，既能拿到高 PSNR，又能断言解码没有上下/左右颠倒。
 */
function makeRef(w, h) {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      rgb[i]     = Math.round(255 * x / (w - 1));
      rgb[i + 1] = Math.round(255 * y / (h - 1));
      rgb[i + 2] = 128;
    }
  }
  return rgb;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  // ---------------------------------------------------------- 1. 造 WAV 素材
  const mode = SSTV.modeById('Martin M1');
  const ref = makeRef(mode.width, mode.height);
  console.log('参考图: ' + mode.width + '×' + mode.height +
    ' (R 沿 x 渐变 / G 沿 y 渐变 / B 恒 128)');

  const samples = SSTV.encodeImage(mode, ref, SR);
  const wav = SSTV.encodeWAV(samples, SR);
  const wavPath = path.join(TMP, 'rx_martinm1.wav');
  fs.writeFileSync(wavPath, Buffer.from(wav));
  console.log('已生成 WAV: ' + wavPath +
    '  (' + (samples.length / SR).toFixed(1) + ' s, ' + wav.length + ' 字节)\n');

  const browser = await chromium.launch({
    headless: true,
    executablePath: EXECUTABLE,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio']
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });

  // ---------------------------------------------------------- 2. 切到 RX
  console.log('=== 1. 进入接收面板并导入音频 ===');
  await page.click('[data-tab="rx"]');
  check('RX 面板可见', await page.isVisible('#rx-preview'));

  await page.setInputFiles('#rx-file-input', wavPath);
  await page.waitForFunction(
    () => !document.querySelector('#rx-decode').disabled, null, { timeout: 60000 });
  const loadedStatus = await page.textContent('#rx-status');
  check('音频载入成功，解码按钮可用', /已载入/.test(loadedStatus), loadedStatus.trim());
  check('载入时长约 ' + (samples.length / SR).toFixed(1) + ' s',
    new RegExp((samples.length / SR).toFixed(1) + ' s').test(loadedStatus));

  // ---------------------------------------------------------- 3. 解码
  console.log('\n=== 2. 执行解码（这一步曾抛 ImageData 长度错误）===');
  await page.click('#rx-decode');
  await page.waitForFunction(() => {
    const t = document.querySelector('#rx-status').textContent;
    return /解码完成|解码失败|失败/.test(t);
  }, null, { timeout: 120000 });

  const status = (await page.textContent('#rx-status')).trim();
  check('解码**没有**失败', !/解码失败/.test(status), status);
  check('状态显示解码完成', /解码完成/.test(status));
  check('识别出 VIS 与制式', /Martin M1/.test(status), status);

  // ---------------------------------------------------------- 4. 校验画布像素
  console.log('\n=== 3. 校验预览画布像素（渲染结果是否真的画上去了）===');
  const stats = await page.evaluate(() => {
    const cv = document.querySelector('#rx-preview');
    const g = cv.getContext('2d');
    const { width: w, height: h } = cv;
    const d = g.getImageData(0, 0, w, h).data;
    let sr = 0, sg = 0, sb = 0;
    let lr = 0, ln = 0, rr = 0, rn = 0, tg = 0, tn = 0, bg = 0, bn = 0;
    let nonBlack = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const R = d[i], G = d[i + 1], B = d[i + 2];
        sr += R; sg += G; sb += B;
        if (R + G + B > 24) nonBlack++;
        if (x < w * 0.1) { lr += R; ln++; }
        if (x >= w * 0.9) { rr += R; rn++; }
        if (y < h * 0.1) { tg += G; tn++; }
        if (y >= h * 0.9) { bg += G; bn++; }
      }
    }
    const n = w * h;
    return {
      w, h,
      meanR: sr / n, meanG: sg / n, meanB: sb / n,
      leftR: lr / ln, rightR: rr / rn,
      topG: tg / tn, bottomG: bg / bn,
      nonBlackRatio: nonBlack / n
    };
  });

  console.log('    画布 ' + stats.w + '×' + stats.h +
    '  均值 R=' + stats.meanR.toFixed(1) +
    ' G=' + stats.meanG.toFixed(1) +
    ' B=' + stats.meanB.toFixed(1) +
    '  非黑占比=' + (stats.nonBlackRatio * 100).toFixed(1) + '%');

  check('画布尺寸与制式一致 (' + mode.width + '×' + mode.height + ')',
    stats.w === mode.width && stats.h === mode.height,
    stats.w + '×' + stats.h);
  check('画面非空白（非黑像素 > 90%）', stats.nonBlackRatio > 0.9,
    (stats.nonBlackRatio * 100).toFixed(1) + '%');
  check('R 均值 ≈ 127（源图 R 渐变均值）', Math.abs(stats.meanR - 127.5) < 22,
    stats.meanR.toFixed(1));
  check('G 均值 ≈ 127', Math.abs(stats.meanG - 127.5) < 22, stats.meanG.toFixed(1));
  check('B 均值 ≈ 128（源图 B 恒定）', Math.abs(stats.meanB - 128) < 22,
    stats.meanB.toFixed(1));
  check('R 左暗右亮（水平方向未颠倒）', stats.rightR - stats.leftR > 100,
    '左 ' + stats.leftR.toFixed(1) + ' → 右 ' + stats.rightR.toFixed(1));
  check('G 上暗下亮（垂直方向未颠倒）', stats.bottomG - stats.topG > 100,
    '上 ' + stats.topG.toFixed(1) + ' → 下 ' + stats.bottomG.toFixed(1));

  await page.screenshot({ path: path.join(SHOTS, 'rx_decode_result.png'), fullPage: true });

  // ---------------------------------------------------------- 5. PNG 导出
  console.log('\n=== 4. 导出 PNG ===');
  const png = await page.evaluate(() => new Promise(resolve => {
    document.querySelector('#rx-preview').toBlob(b => {
      if (!b) return resolve(null);
      const fr = new FileReader();
      fr.onload = () => {
        const u8 = new Uint8Array(fr.result);
        resolve({ size: b.size, type: b.type, magic: Array.from(u8.slice(0, 8)) });
      };
      fr.readAsArrayBuffer(b);
    }, 'image/png');
  }));
  const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
  check('toBlob 产出 PNG', png && png.type === 'image/png' && png.size > 1000,
    png ? png.type + ' ' + png.size + ' 字节' : '(null)');
  check('PNG magic 头正确', png && PNG_MAGIC.every((v, i) => png.magic[i] === v),
    png ? png.magic.join(',') : '(null)');

  const pngBtnDisabled = await page.getAttribute('#rx-png', 'disabled');
  check('「导出 PNG」按钮已启用', pngBtnDisabled === null);

  // ---------------------------------------------------------- 6. 无 JS 异常
  console.log('\n=== 5. 页面异常检查 ===');
  check('全程无未捕获 JS 异常', pageErrors.length === 0,
    pageErrors.length ? pageErrors.join(' | ') : '无');

  await browser.close();

  console.log('\n---------------------------------------------');
  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('截图: ' + path.join(SHOTS, 'rx_decode_result.png'));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('运行异常: ' + e.message); process.exit(2); });
