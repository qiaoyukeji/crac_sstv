/*
 * fit_test.cjs — 画面适配（contain / cover / stretch）数学的单元测试。
 *
 * 与 mic_probe_test.cjs 同样的思路：把生产代码里的纯函数原样抽出来放进 vm 沙箱执行，
 * 而不是"重写一遍再测"。核心要守护的是本次的回归：
 *   竖构图手机照片放进 5:4 的 SSTV 画布时，**contain 必须一像素都不裁**。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = src.indexOf('function fmtRatio(');
const end = src.indexOf('function drawFitted(');
if (start < 0 || end < 0) {
  console.error('FATAL: 无法定位适配数学代码块，app.js 结构可能已变更');
  process.exit(1);
}

const api = vm.runInContext(
  `(function(){ ${src.slice(start, end)}
    return { fmtRatio, fitRect, describeFit, fitHasCost, pctStr };
  })()`,
  vm.createContext({ Math })
);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps); }

// 真实制式画布
const M1 = { w: 320, h: 256 };   // Martin M1，5:4

console.log('=== 1. 比例显示 fmtRatio ===');
check('320/256 -> 5:4', api.fmtRatio(320 / 256) === '5:4', api.fmtRatio(320 / 256));
check('1200/1600 -> 3:4', api.fmtRatio(1200 / 1600) === '3:4', api.fmtRatio(1200 / 1600));
check('1600/1200 -> 4:3', api.fmtRatio(1600 / 1200) === '4:3', api.fmtRatio(1600 / 1200));
check('1:1 识别', api.fmtRatio(1) === '1:1');
check('1920/1080 -> 16:9', api.fmtRatio(1920 / 1080) === '16:9', api.fmtRatio(1920 / 1080));
check('非常规比例退化为小数', api.fmtRatio(1.9) === '1.9:1', api.fmtRatio(1.9));

console.log('\n=== 2. 本次报障场景：竖构图手机照片 1200×1600 -> 320×256 ===');
{
  const contain = api.fitRect(1200, 1600, M1.w, M1.h, 'contain');
  check('contain 高度方向铺满 (dh=256)', near(contain.dh, 256, 1e-9), contain.dh);
  check('contain 宽度等比缩放 (dw=192)', near(contain.dw, 192, 1e-9), contain.dw);
  check('contain 左右居中补黑边 (dx=64)', near(contain.dx, 64, 1e-9), contain.dx);
  check('contain 垂直方向无偏移 (dy=0)', near(contain.dy, 0, 1e-9), contain.dy);
  check('contain 未超出画布（不裁任何内容）', contain.dw <= M1.w + 1e-9 && contain.dh <= M1.h + 1e-9);

  const cover = api.fitRect(1200, 1600, M1.w, M1.h, 'cover');
  check('cover 宽度铺满 (dw=320)', near(cover.dw, 320, 1e-9), cover.dw);
  check('cover 高度溢出被裁 (dh>256)', cover.dh > M1.h, cover.dh);
  check('cover 上下对称溢出 (dy<0)', near(cover.dy, (256 - cover.dh) / 2, 1e-9), cover.dy);
  // 这正是用户看到的"上下被切掉"
  const lost = 1 - M1.h / cover.dh;
  check('cover 会丢掉约 40% 的画面高度（即所报现象）', near(lost, 0.4, 1e-6), lost);

  const stretch = api.fitRect(1200, 1600, M1.w, M1.h, 'stretch');
  check('stretch 直接铺满 320×256', stretch.dw === 320 && stretch.dh === 256 &&
        stretch.dx === 0 && stretch.dy === 0, stretch);
}

console.log('\n=== 3. 适配说明文案 describeFit ===');
{
  const d1 = api.describeFit(1200, 1600, M1.w, M1.h, 'contain');
  check('contain 文案含"完整保留"', /完整保留/.test(d1), d1);
  check('contain 文案指出左右补黑边 40%', /左右补黑边共占 40%/.test(d1), d1);
  check('contain 文案回显原图与画布尺寸', /1200×1600/.test(d1) && /320×256/.test(d1), d1);

  const d2 = api.describeFit(1200, 1600, M1.w, M1.h, 'cover');
  check('cover 文案指出裁掉上下 40%', /裁掉上下共 40%/.test(d2), d2);

  const d3 = api.describeFit(1600, 1200, M1.w, M1.h, 'contain');
  check('4:3 横图 -> contain 上下补黑边 6.3%', /上下补黑边共占 6\.3%/.test(d3), d3);

  const d4 = api.describeFit(640, 512, M1.w, M1.h, 'contain');
  check('比例一致时说明无需处理', /比例一致/.test(d4), d4);

  const d5 = api.describeFit(1200, 1600, M1.w, M1.h, 'stretch');
  check('stretch 文案提示会变形', /变形/.test(d5), d5);
  // 相对横向拉伸系数 k=(w/iw)/(h/ih)：竖图 k>1 → 水平拉伸；横图 k<1 → 垂直拉伸
  // 用法从定义推导期望值，避免把猜测写死在断言里
  const kPortrait = (M1.w / 1200) / (M1.h / 1600);
  check('竖图 stretch 正确地报水平拉伸 ' + (Math.round(kPortrait * 100) / 100) + '×',
    kPortrait > 1 && new RegExp('水平拉伸 ' + (Math.round(kPortrait * 100) / 100).toFixed(2).replace('.', '\\.') + '×').test(d5),
    d5);
  const d5b = api.describeFit(1600, 1200, M1.w, M1.h, 'stretch');
  const kLandscape = (M1.w / 1600) / (M1.h / 1200);        // = 0.9375，即纵向相对拉伸 1/k
  const vScale = Math.round((1 / kLandscape) * 100) / 100; // = 1.07
  check('横图 stretch 正确地报垂直拉伸 ' + vScale + '×',
    kLandscape < 1 && new RegExp('垂直拉伸 ' + String(vScale).replace('.', '\\.') + '×').test(d5b),
    d5b);
}

console.log('\n=== 4. 代价标记 fitHasCost（决定文案是否高亮告警）===');
{
  check('contain + 比例不符 -> 不告警（只是黑边）', api.fitHasCost(1200, 1600, 320, 256, 'contain') === false);
  check('cover   + 比例不符 -> 告警（丢内容）', api.fitHasCost(1200, 1600, 320, 256, 'cover') === true);
  check('stretch + 比例不符 -> 告警（会变形）', api.fitHasCost(1200, 1600, 320, 256, 'stretch') === true);
  check('三者比例相符时一律不告警',
    !api.fitHasCost(640, 512, 320, 256, 'contain') &&
    !api.fitHasCost(640, 512, 320, 256, 'cover') &&
    !api.fitHasCost(640, 512, 320, 256, 'stretch'));
}

console.log('\n=== 5. 不变量（跨多种尺寸的通用性质）===');
{
  const sizes = [[100, 100], [1200, 1600], [1600, 1200], [4000, 3000], [300, 1000],
                 [1000, 300], [640, 512], [1, 1], [3840, 2160], [1080, 3840]];
  const canvases = [[320, 256], [320, 256], [160, 120], [320, 256]];
  let okContain = true, okCover = true, okCentered = true, okStretch = true;
  for (const [iw, ih] of sizes) {
    for (const [cw, ch] of canvases) {
      const c = api.fitRect(iw, ih, cw, ch, 'contain');
      if (c.dw > cw + 1e-6 || c.dh > ch + 1e-6) okContain = false;
      if (near(c.dw, cw, 1e-6) || near(c.dh, ch, 1e-6)) {
        // contain 至少一边贴合画布
      } else { okContain = false; }
      if (Math.abs(c.dx * 2 + c.dw - cw) > 1e-6) okCentered = false;
      if (Math.abs(c.dy * 2 + c.dh - ch) > 1e-6) okCentered = false;

      const v = api.fitRect(iw, ih, cw, ch, 'cover');
      if (v.dw < cw - 1e-6 || v.dh < ch - 1e-6) okCover = false;

      const s = api.fitRect(iw, ih, cw, ch, 'stretch');
      if (s.dw !== cw || s.dh !== ch) okStretch = false;
    }
  }
  check('contain 永不超出画布（绝不裁剪）', okContain);
  check('contain 至少一边与画布完全贴合（无多余黑边）', okContain);
  check('contain 结果始终居中', okCentered);
  check('cover 永不小于画布（始终填满）', okCover);
  check('stretch 恒等于画布尺寸', okStretch);
}

console.log('\n=== 6. 各制式画布比例盘点（确认默认 contain 的实际效果）===');
{
  const modes = [['Martin M1', 320, 256], ['Martin M2', 320, 256], ['Scottie S1', 320, 256],
                 ['Scottie S2', 320, 256], ['Robot 36', 320, 240], ['PD90', 320, 256]];
  for (const [name, w, h] of modes) {
    const d = api.describeFit(1200, 1600, w, h, 'contain');   // 典型竖构图手机照片
    console.log('  · ' + name.padEnd(11) + ' ' + w + '×' + h + '  ' + d.replace(/^[^：]*：/, ''));
  }
  check('Robot36 (4:3) 与 5:4 制式处理方式不同，说明文案会随之变化',
    api.describeFit(1200, 1600, 320, 240, 'contain') !== api.describeFit(1200, 1600, 320, 256, 'contain'));
}

console.log('\n---------------------------------------------');
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
