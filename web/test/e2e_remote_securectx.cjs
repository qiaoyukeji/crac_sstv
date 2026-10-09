/**
 * 公网 HTTPS 的安全上下文验证
 * ----------------------------------------------------------------------------
 * 目的：证明通过 cloudflared 隧道（受信任证书的 HTTPS）访问时，
 *       浏览器会开放 getUserMedia —— 手机端麦克风无需再安装任何证书。
 *
 * 用法：
 *   SSTV_URL=https://xxx.trycloudflare.com/ node web/test/e2e_remote_securectx.cjs
 */
'use strict';

const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.SSTV_URL || 'http://localhost:8000/';
const EXECUTABLE = 'C:/Users/kavin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
}

(async () => {
  console.log('目标地址: ' + BASE);
  const browser = await chromium.launch({
    headless: true,
    executablePath: EXECUTABLE,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      // 虚拟音频设备：headless 环境下没有真实麦克风，用假的才能验证调用链通
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream'
    ]
  });
  // 授予麦克风权限，这样能验证"接口暴露"而不被权限弹窗挡住
  const ctx = await browser.newContext({
    permissions: ['microphone'],
    ignoreHTTPSErrors: false          // 刻意不忽略：要验证证书确实受信任
  });
  const page = await ctx.newPage();

  let certError = null;
  page.on('requestfailed', r => { if (/ssl|ERR_CERT/i.test(r.failure()?.errorText || '')) certError = r.failure().errorText; });

  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });

  const env = await page.evaluate(() => ({
    isSecureContext: window.isSecureContext,
    hasMediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    protocol: location.protocol,
    host: location.host,
    title: document.title
  }));

  console.log('\n=== 安全上下文探测 ===');
  check('页面正常加载（标题正确）', /SSTV/.test(env.title), env.title);
  check('协议为 https', env.protocol === 'https:', env.protocol);
  check('证书受信任（无 SSL 失败）', certError === null, certError || '无证书错误');
  check('isSecureContext 为 true', env.isSecureContext === true, String(env.isSecureContext));
  check('navigator.mediaDevices.getUserMedia 可用', env.hasMediaDevices === true, String(env.hasMediaDevices));

  // 真正尝试获取麦克风（headless + --use-fake-device 可拿到假设备）
  console.log('\n=== 实际调用 getUserMedia ===');
  const gum = await page.evaluate(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ok = s.getAudioTracks().length > 0;
      s.getTracks().forEach(t => t.stop());
      return { ok, name: 'OK' };
    } catch (e) { return { ok: false, name: e.name, msg: e.message }; }
  });
  check('getUserMedia 调用成功（拿到音轨）', gum.ok === true, gum.ok ? '音轨已获取' : (gum.name + ': ' + gum.msg));

  console.log('\n---------------------------------------------');
  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('运行异常: ' + e.message); process.exit(2); });
