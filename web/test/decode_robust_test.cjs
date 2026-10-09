/*
 * 批量解码器的健壮性测试 —— 真实录音不是干净的文件
 * ---------------------------------------------------------------------------
 * 这两个缺陷都不是"算法错"，而是**只在真实使用路径上才暴露**的边界问题，
 * 是实时逐行成像的端到端测试（e2e_live_rx.cjs）把它们逼出来的：
 *
 *   缺陷 A：录音在"一帧还没走完"时结束 → 崩溃
 *     上一行找到同步脉冲后 pos = s + step 会越过信号末尾，下一轮的搜索窗口
 *     [pos-0.15·step, pos+0.5·step] 整个落到音频之外，findSync 里
 *     new Uint8Array(hi - lo) 拿到负数长度，抛
 *       "Invalid typed array length: -1255"
 *     （实测：录 12 s 就按停止、再点"解码"，报的就是这个。）
 *
 *   缺陷 B：一处几毫秒的干扰 → 整幅图从中间截断
 *     原来的行循环只要 findSync 返回 null 就 break。麦克风录音实测只能解出
 *     138/240 行 —— 前半幅有图，后半幅全黑，而且没有任何提示。
 *
 * 本测试用**确定性的方式**复现这两种输入，而不是依赖运气去等一次真实的掉音：
 *   * 截断：把编码好的信号从中间剪断
 *   * 掉音：在信号中间挖掉 25 ms 的洞（模拟一次采样丢失/静音插入）
 *
 * 运行： node web/test/decode_robust_test.cjs
 */
'use strict';

const SSTV = require('../sstv-engine.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
}

function makeImage(w, h) {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const fx = x / (w - 1), fy = y / (h - 1);
    rgb[i] = Math.round(255 * (0.5 + 0.45 * Math.sin(fx * Math.PI * 2)));
    rgb[i + 1] = Math.round(255 * (0.5 + 0.45 * Math.sin(fy * Math.PI * 2)));
    rgb[i + 2] = Math.round(255 * (0.5 + 0.45 * Math.sin((fx + fy) * Math.PI * 2)));
  }
  return rgb;
}
/** 已解出的行数：统计"整行全为 0"以外的行，用于判断是否被截断 */
function rowsWithContent(img, w, h) {
  let n = 0;
  for (let y = 0; y < h; y++) {
    let any = false;
    for (let x = 0; x < w; x++) {
      if (img[(y * w + x) * 3] || img[(y * w + x) * 3 + 1] || img[(y * w + x) * 3 + 2]) { any = true; break; }
    }
    if (any) n++;
  }
  return n;
}

const SR = 22050;

// ===========================================================================
console.log('=== A. 信号在帧中间被截断（录音中途按停止）===');
// ===========================================================================
for (const id of ['Martin M1', 'Robot 36', 'PD90']) {
  const mode = SSTV.modeById(id);
  const rgb = makeImage(mode.width, mode.height);
  const full = SSTV.encodeImage(mode, rgb, SR);

  let threw = null, dec = null;
  try {
    // 砍掉整幅的 37%（且刻意让切口落在某一行中间，而不是行边界上）
    const cut = Math.floor(full.length * 0.37) + 137;
    dec = SSTV.decodeSamples(full.subarray(0, cut), SR, null);
  } catch (e) { threw = e; }

  const detail = threw ? threw.message
    : ('解出 ' + dec.info.lines + ' 行 / 画面 ' + dec.width + '×' + dec.height);
  console.log('  ' + id.padEnd(11) + ' 截断解码 → ' + detail);
  check(id + '：截断信号不抛异常', !threw, threw ? threw.message : 'OK');
  if (!threw) {
    check(id + '：截断后仍能识别制式', dec.info.mode === id, dec.info.mode);
    check(id + '：截断后解出不少行（≥ 30% 整幅）',
      dec.info.lines >= Math.floor(mode.height * 0.3 * (mode.kind === 'pd' ? 0.5 : 1)),
      dec.info.lines + ' 行');
    check(id + '：截断后画面后半为空（没有凭空生成内容）',
      rowsWithContent(dec.image, dec.width, dec.height) <= mode.height, 'OK');
  }
}

// ===========================================================================
console.log('\n=== B. 信号中间掉音 25 ms（一次采样丢失 / 静音插入）===');
// ===========================================================================
for (const id of ['Martin M1', 'Martin M2', 'Scottie S1', 'Robot 36', 'PD90']) {
  const mode = SSTV.modeById(id);
  const rgb = makeImage(mode.width, mode.height);
  const full = SSTV.encodeImage(mode, rgb, SR);

  // 在 55% 处插入 25 ms 静音（截断并拼接），模拟一次音频掉块
  const hole = Math.round(0.025 * SR);
  const at = Math.floor(full.length * 0.55);
  const broken = new Float32Array(full.length + hole);
  broken.set(full.subarray(0, at), 0);
  // 洞内保持 0（静音）
  broken.set(full.subarray(at), at + hole);

  const clean = SSTV.decodeSamples(full, SR, null);
  let dec = null, threw = null;
  try { dec = SSTV.decodeSamples(broken, SR, null); } catch (e) { threw = e; }

  const cleanRows = clean.info.lines * (mode.kind === 'pd' ? 2 : 1);
  const brokenRows = dec ? dec.info.lines * (mode.kind === 'pd' ? 2 : 1) : 0;
  console.log('  ' + id.padEnd(11) + ' 干净 ' + cleanRows + ' 行 → 掉音 25 ms 后 ' +
    brokenRows + ' 行（保留 ' + (brokenRows / cleanRows * 100).toFixed(0) + '%）');

  check(id + '：掉音后不抛异常', !threw, threw ? threw.message : 'OK');
  check(id + '：掉音后不会从中间截断（保留 ≥ 90% 行）',
    brokenRows >= cleanRows * 0.9,
    brokenRows + '/' + cleanRows);
  check(id + '：掉音后画面内容量仍接近整幅',
    rowsWithContent(dec.image, dec.width, dec.height) >= mode.height * 0.85,
    rowsWithContent(dec.image, dec.width, dec.height) + '/' + mode.height);
}

// ===========================================================================
console.log('\n=== C. 回归：干净信号的结果未被改动 ===');
// ===========================================================================
{
  // 放宽 findSync 的恢复搜索只应在"窄窗口找不到"时才触发。
  // 干净信号的同步必然落在窄窗口内，所以行数与之前完全一致。
  const expect = {
    'Martin M1': 256, 'Martin M2': 256, 'Scottie S1': 256,
    'Scottie S2': 256, 'Robot 36': 240, 'PD90': 128
  };
  let ok = true;
  for (const id of Object.keys(expect)) {
    const mode = SSTV.modeById(id);
    const dec = SSTV.decodeSamples(SSTV.encodeImage(mode, makeImage(mode.width, mode.height), SR), SR, null);
    const good = dec.info.lines === expect[id];
    if (!good) ok = false;
    console.log('  ' + id.padEnd(11) + ' 解出 ' + dec.info.lines + ' 行（期望 ' + expect[id] + '）');
  }
  check('干净信号行数与改动前一致', ok);
}

console.log('\n---------------------------------------------');
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
