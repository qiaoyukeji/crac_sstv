/*
 * UI 巡检工具（非回归测试，不会失败退出）。
 *
 * 目的：在**手机视口**下把两种形态（浏览器版 / 壳 App 版）× 三个标签页各截一张图，
 * 供人工核对"像不像原生 App"。
 *
 * 之所以要单独一份：其它 E2E 用的是 fullPage 截图，而底部导航栏是 position:fixed，
 * fullPage 会把导航栏画在整页的中间（视口底部的位置），看起来像布局错乱 —— 那是
 * 截图方式的产物，不是真问题。这里固定视口、不 fullPage，看到的才是真机观感。
 *
 * 用法：node web/test/shot_ui.cjs   （需先起 http://127.0.0.1:8000 的静态服务）
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.SSTV_URL || 'http://127.0.0.1:8000/';
const EXECUTABLE = process.env.CHROME_BIN ||
  'C:/Users/kavin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const SHOTS = path.join(__dirname, 'shots');
const TABS = ['tx', 'rx', 'help'];

/** 假装壳 App：注入原生桥，index.html 的 <head> 脚本据此打上 html.app-shell */
const APP_BRIDGE = () => {
  window.__saved = [];
  window.SSTVNative = {
    saveFile: function (name, mime, b64) {
      window.__saved.push({ name: name, mime: mime, len: b64.length });
      if (window.__sstvOnSaved) {
        window.__sstvOnSaved(name, true, '已保存到 相册/SSTV/' + name);
      }
    }
  };
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: EXECUTABLE });

  try {
    for (const mode of ['web', 'app']) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },     // 典型安卓手机的逻辑分辨率
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        colorScheme: 'dark'
      });
      if (mode === 'app') await context.addInitScript(APP_BRIDGE);

      const page = await context.newPage();
      await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(300);

      for (const tab of TABS) {
        await page.click('[data-tab="' + tab + '"]');
        await page.waitForTimeout(260);
        // 接收页切到"麦克风"，才看得到两个开关行与录音按钮
        if (tab === 'rx') {
          await page.click('.seg-btn[data-src="mic"]');
          await page.waitForTimeout(200);
        }
        const file = path.join(SHOTS, 'ui_' + mode + '_' + tab + '.png');
        await page.screenshot({ path: file });
        console.log('  ' + path.relative(process.cwd(), file) +
          '  (' + await page.evaluate(() => document.documentElement.className) + ')');
      }
      await context.close();
    }
    console.log('\n截图目录: ' + SHOTS);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('截图失败: ' + e.message); process.exit(1); });
