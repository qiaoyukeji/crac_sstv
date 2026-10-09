/*
 * 流式（边收边解）解码器验证 —— web/sstv-engine.js → createStreamDecoder
 * ---------------------------------------------------------------------------
 * 用户要求"通过麦克风解码时，像发送时一样在界面上逐行显示"。这要求解调器
 * 能在音频**还在到达的过程中**工作，而这与原本的 decodeSamples（对整段信号
 * 做一次全域 FFT，O(N log N)）是两种完全不同的调用方式。
 *
 * 于是新增了 createStreamDecoder：分块 + 重叠的增量解调。本测试回答三个问题：
 *
 *   1) 正确性 —— 流式结果与批量结果是否一致？（PSNR，逐模式逐采样率）
 *   2) 完整性 —— 行数是否解全？VIS / 制式是否识别正确？
 *   3) 渐进性 —— 是否**真的**边收边出，而不是攒到最后一次性吐出来？
 *
 * 第 3 点是本测试存在的核心理由：一个"能出正确画面"的实现完全可能是
 * 内部把小块攒成大块、到 finish() 才一次性解码 —— 那样界面上永远不会
 * 逐行移动。所以这里在喂数据的过程中采样 rows 变化曲线，并断言：
 *   * rows 单调不减；
 *   * 喂到一半音频时，rows 明显还没到顶；
 *   * 喂到 90% 时，rows 已经接近顶部（说明是在跟随，而不是停在某个值）。
 *
 * 运行： node web/test/stream_decode_test.cjs
 */
'use strict';

const SSTV = require('../sstv-engine.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
}
function psnr(a, b) {
  let mse = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; mse += d * d; }
  mse /= a.length;
  return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
}

/** 平滑低梯度参考图（与 node-parity.cjs 同源，保证 FM 估计器容易跟踪） */
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

/**
 * 按给定的分块大小序列把 samples 喂给流式解码器，过程中记录 rows 曲线。
 * chunkPlan 用来模拟真实麦克风的"每次回调整齐 4096"以及不规则的抖动。
 */
function feed(samples, sr, modeHint, chunkPlan, onPush) {
  const dec = SSTV.createStreamDecoder(sr, modeHint);
  const trace = [];
  let off = 0, k = 0;
  while (off < samples.length) {
    const n = Math.min(chunkPlan[k % chunkPlan.length], samples.length - off);
    dec.push(samples.subarray(off, off + n));
    off += n; k++;
    const st = dec.stats();
    trace.push({ fed: off / samples.length, rows: st.rows, phase: st.phase });
    if (onPush) onPush(st, off / samples.length);
  }
  dec.finish();
  return { dec, trace, stats: dec.stats() };
}

const CHUNKS = [4096, 4096, 512, 3000, 7000, 1500, 8192, 2048];

// ===========================================================================
console.log('=== 1. 全制式 / 22050 Hz / 自动 VIS：流式 vs 批量 一致性 ===');
// ===========================================================================
const SR_APP = 22050;
const summary = [];

for (const id of ['Martin M1', 'Martin M2', 'Scottie S1', 'Scottie S2', 'Robot 36', 'PD90']) {
  const mode = SSTV.modeById(id);
  const ref = makeImage(mode.width, mode.height);
  const samples = SSTV.encodeImage(mode, ref, SR_APP);

  const batch = SSTV.decodeSamples(samples, SR_APP, null);
  const { dec, trace, stats } = feed(samples, SR_APP, null, CHUNKS);
  const img = dec.image();

  const pRefBatch = psnr(ref, batch.image);
  const pRefStream = psnr(ref, img);
  const pBatchStream = psnr(batch.image, img);

  const mid = trace.filter(t => t.fed <= 0.5).pop();
  const late = trace.filter(t => t.fed <= 0.9).pop();

  console.log('  ' + id.padEnd(11) +
    ' | PSNR(参考) 批量 ' + pRefBatch.toFixed(2) + ' 流式 ' + pRefStream.toFixed(2) +
    ' dB | PSNR(批量 vs 流式) ' + pBatchStream.toFixed(2) + ' dB' +
    ' | 行 ' + stats.rows + '/' + mode.height +
    ' | 50% 时 ' + (mid ? mid.rows : '?') + ' 行, 90% 时 ' + (late ? late.rows : '?') + ' 行');

  check(id + '：VIS 识别正确 (' + mode.vis + ')', stats.vis === mode.vis, String(stats.vis));
  check(id + '：制式识别正确', stats.mode === id, String(stats.mode));
  check(id + '：整幅解全（' + mode.height + ' 行）', stats.rows === mode.height,
    stats.rows + '/' + mode.height);
  check(id + '：流式与批量几乎一致（PSNR ≥ 32 dB）', pBatchStream >= 32,
    pBatchStream.toFixed(2) + ' dB');
  check(id + '：画质未因分块而下降（与批量差 ≤ 1.5 dB）',
    pRefBatch - pRefStream <= 1.5,
    '批量 ' + pRefBatch.toFixed(2) + ' → 流式 ' + pRefStream.toFixed(2));

  // ---- 渐进性 ----
  let mono = true;
  for (let i = 1; i < trace.length; i++) if (trace[i].rows < trace[i - 1].rows) mono = false;
  check(id + '：rows 单调不减（不会回退重画）', mono);
  check(id + '：确实边收边出（喂到 50% 时已有画面且未到顶）',
    !!mid && mid.rows > 0 && mid.rows < mode.height * 0.75,
    mid ? (mid.rows + ' 行 @50%') : '无样本');
  check(id + '：持续跟随信号（喂到 90% 时接近顶部）',
    !!late && late.rows >= mode.height * 0.7,
    late ? (late.rows + ' 行 @90%') : '无样本');

  summary.push({ id, stats, pBatchStream });
}

// ===========================================================================
console.log('\n=== 2. 麦克风原生采样率（44100 / 48000 Hz） ===');
// ===========================================================================
for (const sr of [44100, 48000]) {
  for (const id of ['Martin M1', 'PD90']) {
    const mode = SSTV.modeById(id);
    const ref = makeImage(mode.width, mode.height);
    const samples = SSTV.encodeImage(mode, ref, sr);
    const batch = SSTV.decodeSamples(samples, sr, null);
    const { dec, stats } = feed(samples, sr, null, CHUNKS);
    const p = psnr(batch.image, dec.image());
    console.log('  ' + String(sr).padEnd(6) + ' ' + id.padEnd(11) +
      ' | PSNR(批量 vs 流式) ' + p.toFixed(2) + ' dB | 行 ' + stats.rows + '/' + mode.height +
      ' | vis ' + stats.vis);
    check(sr + ' Hz ' + id + '：解全且与批量一致', stats.rows === mode.height && p >= 32,
      p.toFixed(2) + ' dB, ' + stats.rows + ' 行');
  }
}

// ===========================================================================
console.log('\n=== 3. 手动指定制式（跳过 VIS 自动识别） ===');
// ===========================================================================
{
  const mode = SSTV.modeById('Robot 36');
  const ref = makeImage(mode.width, mode.height);
  const samples = SSTV.encodeImage(mode, ref, SR_APP);
  const batch = SSTV.decodeSamples(samples, SR_APP, mode);
  const { dec, stats } = feed(samples, SR_APP, mode, CHUNKS);
  const p = psnr(batch.image, dec.image());
  console.log('  Robot 36 手动指定 | PSNR ' + p.toFixed(2) + ' dB | 行 ' +
    stats.rows + '/' + mode.height + ' | 报告 vis=' + stats.vis + '（未自动识别，应为 null）');
  check('手动制式：解全', stats.rows === mode.height, stats.rows + '/' + mode.height);
  check('手动制式：与批量一致', p >= 32, p.toFixed(2) + ' dB');
  check('手动制式：vis 保持 null（没有虚假识别）', stats.vis === null, String(stats.vis));
}

// ===========================================================================
console.log('\n=== 4. 录音早于发射：前面 2 s 底噪，后面才是 SSTV ===');
// ===========================================================================
{
  const sr = SR_APP;
  const mode = SSTV.modeById('Martin M2');
  const ref = makeImage(mode.width, mode.height);
  const body = SSTV.encodeImage(mode, ref, sr);

  const noise = new Float32Array(Math.round(2.0 * sr));
  let seed = 12345;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.004;   // 极低电平底噪
  }
  const all = new Float32Array(noise.length + body.length);
  all.set(noise, 0); all.set(body, noise.length);

  const batch = SSTV.decodeSamples(all, sr, null);
  const { dec, stats } = feed(all, sr, null, CHUNKS);
  const p = psnr(batch.image, dec.image());
  console.log('  前置 2 s 底噪 | 识别 ' + stats.mode + ' vis=' + stats.vis +
    ' | 行 ' + stats.rows + '/' + mode.height + ' | PSNR(批量 vs 流式) ' + p.toFixed(2) + ' dB');
  check('前置底噪下仍能识别 VIS 与制式', stats.mode === 'Martin M2' && stats.vis === 40,
    stats.mode + ' vis=' + stats.vis);
  check('前置底噪下仍解全整幅', stats.rows === mode.height, stats.rows + '/' + mode.height);
  check('前置底噪下与批量一致', p >= 32, p.toFixed(2) + ' dB');
}

// ===========================================================================
console.log('\n=== 5. 边界：一次性整段喂入 / 空推送 / 重复 finish ===');
// ===========================================================================
{
  const sr = SR_APP;
  const mode = SSTV.modeById('Scottie S2');
  const ref = makeImage(mode.width, mode.height);
  const samples = SSTV.encodeImage(mode, ref, sr);
  const batch = SSTV.decodeSamples(samples, sr, null);

  const dec = SSTV.createStreamDecoder(sr, null);
  dec.push(new Float32Array(0));                 // 空块
  dec.finish();                                  // 提前收尾（此时什么都没解出）
  const empty = dec.stats();
  check('未收到任何有效音频时：不崩、行数为 0 且无画面',
    empty.rows === 0 && empty.width === 0, JSON.stringify({ rows: empty.rows, w: empty.width }));

  const dec2 = SSTV.createStreamDecoder(sr, null);
  dec2.push(samples);                            // 一次性全给
  dec2.finish();
  const st2 = dec2.stats();
  const p = psnr(batch.image, dec2.image());
  console.log('  一次性整段喂入 | 行 ' + st2.rows + '/' + mode.height +
    ' | PSNR(批量 vs 流式) ' + p.toFixed(2) + ' dB');
  check('一次性整段喂入：解全且一致', st2.rows === mode.height && p >= 32,
    st2.rows + ' 行, ' + p.toFixed(2) + ' dB');
  dec2.finish();                                 // 重复 finish 不应改变结果
  check('重复 finish 幂等', dec2.stats().rows === st2.rows, String(dec2.stats().rows));
}

// ===========================================================================
console.log('\n---------------------------------------------');
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
