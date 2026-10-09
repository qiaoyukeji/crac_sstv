/*
 * diag_autostop_real.cjs — "对方还在发送，这边就提示接收完成"的复现实验 + 回归闸门
 * ----------------------------------------------------------------------------
 * 用户报障：麦克风接收时，经常在对方还在发送的过程中就提示"整幅已接收完成"，
 * 而且实时渲染的图看不出来是什么。
 *
 * 为什么不能只靠浏览器端到端测这个：那个测试走 Chrome 的假音频设备，而该设备本身
 * 会丢信号，于是"判据提前收手"和"信号压根没收到"在观测上混在一起，分不清。所以
 * 这里绕开浏览器，用引擎造出**已知时长**的信号，按麦克风的分块方式喂给流式解码器，
 * 再用**从 app.js 原样抽出来的真实判据**判定"什么时候会收手"，与信号真实结束时刻
 * 逐场景对比。判据本体不是重写的 —— 重写一份再测，测的是影子实现。
 *
 * 本文件既是诊断表（人看），也是回归闸门（断言 + 退出码）：
 *   · 任何场景都**不得提前收手**（提前 = 画面被切掉，就是用户报的那个现象）
 *   · 正常场景**必须**能收手（否则用户得永远手点停止）
 *
 * 运行： node web/test/diag_autostop_real.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SSTV = require('../sstv-engine.js');

// ------------------------------------------------- 抽出 app.js 里的真实判据 --
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const s0 = appSrc.indexOf('var LIVE_TAIL_S');
const s1 = appSrc.indexOf('function liveReasonText(');
if (s0 < 0 || s1 < 0) {
  console.error('FATAL: 无法定位自动停止判据代码块，app.js 结构可能已变更');
  process.exit(1);
}
const api = vm.runInContext(
  '(function(){' + appSrc.slice(s0, s1) +
  'return { liveCompletionReason: liveCompletionReason, liveLostSeconds: liveLostSeconds,' +
  ' LIVE_TAIL_S: LIVE_TAIL_S, LIVE_MIN_ROW_FRACTION: LIVE_MIN_ROW_FRACTION };})()',
  vm.createContext({}));

const SR = 48000;              // 与手机麦克风一致
const CH = 4096;               // 与 app.js 的 { block: 4096 } 一致
const VIS_S = 0.910;           // VIS 头：300+10+300 引导 + 30 起始 + 7×30 数据 + 30 校验 + 30 停止

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
}

// ------------------------------------------------------------------ 素材 --
function makeImage(w, h) {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3, fx = x / (w - 1), fy = y / (h - 1);
    rgb[i] = Math.round(255 * (0.5 + 0.45 * Math.sin(fx * Math.PI * 2)));
    rgb[i + 1] = Math.round(255 * (0.5 + 0.45 * Math.sin(fy * Math.PI * 2)));
    rgb[i + 2] = Math.round(255 * (0.5 + 0.45 * Math.sin((fx + fy) * Math.PI * 2)));
  }
  return rgb;
}
/** 确定性伪随机噪声（LCG）：跑两次结果一致，便于对照 */
function makeNoise(n, amp, seed) {
  const a = new Float32Array(n);
  let s = (seed >>> 0) || 1;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    a[i] = ((s / 4294967296) * 2 - 1) * amp;
  }
  return a;
}
function concat(list) {
  let n = 0; for (const a of list) n += a.length;
  const out = new Float32Array(n);
  let o = 0; for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}
function silence(sec) { return new Float32Array(Math.round(sec * SR)); }

/** 手工拼一个 VIS 头：可指定引导音长度、校验位对错 —— 用来复现真实的误码/错位 */
function buildVis(code, opts) {
  opts = opts || {};
  const segs = [];
  segs.push([1900, opts.leader1Ms != null ? opts.leader1Ms : 300]);
  segs.push([1200, 10]);
  segs.push([1900, 300]);
  segs.push([1200, 30]);
  let ones = 0;
  for (let i = 0; i < 7; i++) {
    const b = (code >> i) & 1;
    ones += b;
    segs.push([b ? 1100 : 1300, 30]);
  }
  let par = (ones % 2 === 1) ? 1 : 0;
  if (opts.breakParity) par = 1 - par;
  segs.push([par ? 1100 : 1300, 30]);
  segs.push([1200, 30]);
  return SSTV.synthTones(segs.map(s => [s[0], s[1] / 1000]), SR);
}

// ------------------------------------------------------------------ 实验 --
/** 完全复刻 app.js 的调用方式：push → stats → liveCompletionReason */
function observe(stream, modeHint) {
  const dec = SSTV.createStreamDecoder(SR, modeHint || null, { block: CH });
  let fire = null;
  for (let off = 0; off < stream.length; off += CH) {
    dec.push(stream.subarray(off, Math.min(stream.length, off + CH)));
    const st = dec.stats();
    if (!fire) {
      const r = api.liveCompletionReason(st);
      if (r) {
        fire = {
          reason: r, sec: st.seconds, rows: st.rows, totalRows: st.totalRows,
          frameStartS: st.frameStart / st.sr, frameEndS: st.frameEnd / st.sr,
          source: st.frameStartSource, mode: st.mode
        };
      }
    }
  }
  return { fire, end: dec.stats(), image: dec.image() };
}

const cases = [];
/**
 * @param expect  'mustStop' | 'mustNotStopEarly'（默认后者，且必须不提前）
 */
function scenario(title, build, expect) {
  // 注意：必须先把 build() 的**返回值**接住再取 hint。早先写成 build.hint 取的是
  // 箭头函数自己的属性（undefined），于是"手动指定制式"的场景其实一直在走自动
  // 识别 —— 断言看着在跑，实际测的不是那条路径。
  const b = build();
  const { stream, sigEndS, trueMode } = b;
  const r = observe(stream, b.hint);
  const f = r.fire;
  const lead = f ? sigEndS - f.sec : null;          // >0 = 提前收手（危险）
  const early = f && lead > 0.15;

  console.log('--- ' + title);
  console.log('    信号真实结束 ' + sigEndS.toFixed(2) + ' s  |  判据 ' +
    (f ? f.reason + ' @ ' + f.sec.toFixed(2) + ' s' : '未触发') +
    (f ? (early ? '  ⚠ 提前 ' + lead.toFixed(2) + ' s' : '  （滞后 ' + (-lead).toFixed(2) + ' s）') : ''));
  console.log('    最终 ' + r.end.rows + '/' + r.end.totalRows + ' 行 · 制式 ' +
    (r.end.mode || '—') + '（真实 ' + trueMode + '）· 帧起点来源 ' +
    r.end.frameStartSource + ' @ ' + (r.end.frameStart / r.end.sr).toFixed(2) + 's' +
    (f ? ' · 触发时 ' + f.rows + '/' + f.totalRows + ' 行' : ''));

  cases.push({ title, expect, early, fire: f, end: r.end, sigEndS });
  check('不得提前收手', !early,
    early ? '提前 ' + lead.toFixed(2) + ' s（' + f.reason + '，触发时 ' + f.rows + '/' + f.totalRows + ' 行）'
          : (f ? f.reason + ' @ ' + f.sec.toFixed(2) + ' s' : '未触发'));
  if (expect === 'mustStop') {
    check('必须能自动收手（否则要用户手点停）', !!f,
      f ? f.reason + ' @ ' + f.sec.toFixed(2) + ' s' : '未触发');
  }
  return r;
}

// ------------------------------------------------------------------ 构造 --
function build(modeId, o) {
  o = o || {};
  const mode = SSTV.modeById(modeId);
  const sig = SSTV.encodeImage(mode, makeImage(mode.width, mode.height), SR);

  const parts = [];
  if (o.fakeToneS) parts.push(SSTV.synthTones([[1900, o.fakeToneS]], SR));
  if (o.fakeGapS) parts.push(silence(o.fakeGapS));
  if (o.preNoise) parts.push(makeNoise(Math.round((o.preS || 1) * SR), o.preNoise, 20261009));
  else if (o.preS) parts.push(silence(o.preS));

  if (o.visBuild) {
    // 手工构造的 VIS 头 + 真实图像数据（去掉信号自带的 VIS）
    parts.push(buildVis(mode.vis, o.visBuild));
    parts.push(sig.subarray(Math.round(VIS_S * SR)));
  } else if (o.visOverride != null) {
    parts.push(SSTV.visSamples(o.visOverride, SR));
    parts.push(sig.subarray(Math.round(VIS_S * SR)));
  } else {
    parts.push(sig);
  }
  if (o.tailS) parts.push(silence(o.tailS));

  let stream = concat(parts);
  if (o.cutS) stream = stream.subarray(Math.round(o.cutS * SR));
  if (o.hole) {
    const c = Math.round(((o.preS || 0) + sig.length / SR * 0.5) * SR);
    const a = Math.max(0, c), b = Math.min(stream.length, c + Math.round(o.hole * SR));
    for (let i = a; i < b; i++) stream[i] = 0;
  }
  if (o.overNoise) {
    const nz = makeNoise(stream.length, o.overNoise, 424242);
    const s2 = new Float32Array(stream.length);
    for (let i = 0; i < stream.length; i++) s2[i] = stream[i] + nz[i];
    stream = s2;
  }
  const head = (o.fakeToneS || 0) + (o.fakeGapS || 0) + (o.preS || 0);
  const b = { stream, sigEndS: head - (o.cutS || 0) + sig.length / SR, trueMode: mode.id };
  b.hint = o.hint || null;
  return b;
}

// ------------------------------------------------------------------- 跑 ---
console.log('★ sr=' + SR + ' Hz, 分块=' + CH + ', LIVE_TAIL_S=' + api.LIVE_TAIL_S +
  ' s, 帧长判据要求行数占比 ≥' + api.LIVE_MIN_ROW_FRACTION);
console.log('  判据来源: web/app.js 原样抽取\n');

console.log('========== 一、正常接收：必须能收手，且不得提前 ==========');
scenario('Robot 36 · 后留 2 s 尾音', () => build('Robot 36', { tailS: 2 }), 'mustStop');
scenario('Robot 36 · 先录 3 s 静音再发射', () => build('Robot 36', { preS: 3, tailS: 2 }), 'mustStop');
scenario('Robot 36 · 全段叠加噪声 0.02', () => build('Robot 36', { overNoise: 0.02, tailS: 2 }), 'mustStop');
scenario('Martin M1 · 后留 3 s 尾音', () => build('Martin M1', { tailS: 3 }), 'mustStop');
scenario('PD90 · 后留 3 s 尾音', () => build('PD90', { tailS: 3 }), 'mustStop');

console.log('\n========== 二、中途衰落：不得在帧内就收手 ==========');
scenario('Robot 36 · 中途静音 1.5 s', () => build('Robot 36', { hole: 1.5, tailS: 3 }), 'mustStop');
scenario('Robot 36 · 中途静音 3 s', () => build('Robot 36', { hole: 3, tailS: 3 }), 'mustStop');
scenario('Robot 36 · 中途静音 8 s', () => build('Robot 36', { hole: 8, tailS: 3 }));
// 这条是本次修复的重点：12 s 衰落曾让 lostSync 在 27.7 s（帧内）就触发，把衰落之后
// 本来还能收到的信号一起切掉。
scenario('Robot 36 · 中途静音 12 s', () => build('Robot 36', { hole: 12, tailS: 3 }));

console.log('\n========== 三、录音开头有同频段干扰（会骗过"第一个 1900 Hz 连段"）==========');
scenario('0.4 s 假 1900 Hz + 1 s 静音 + 真信号',
  () => build('Robot 36', { fakeToneS: 0.4, fakeGapS: 1.0, tailS: 2 }), 'mustStop');
scenario('1.5 s 假 1900 Hz + 0.5 s 静音 + 真信号(M1)',
  () => build('Martin M2', { fakeToneS: 1.5, fakeGapS: 0.5, tailS: 3 }), 'mustStop');

console.log('\n========== 四、VIS 头本身有问题 ==========');
{
  const r = scenario('VIS 校验位写反（模拟一位误码）', () => build('Robot 36', { visBuild: { breakParity: true }, tailS: 2 }));
  check('不得锁定制式（宁可不解，也不能认成别的制式）', r.end.mode === null,
    String(r.end.mode));
}
{
  const r = scenario('第一段引导音只有 100 ms（录音从引导音中间才开始）',
    () => build('Robot 36', { visBuild: { leader1Ms: 100 }, tailS: 2 }), 'mustStop');
  check('仍能正确识别制式', r.end.mode === 'Robot 36', String(r.end.mode));
}

console.log('\n========== 五、手动指定制式（跳过 VIS 识别）==========');
{
  // 手动指定制式时解码器不读 VIS（用户就是要覆盖"制式认错"），帧起点只能靠
  // "第一次锁定的同步脉冲"。旧实现在这里退回 0.95 s 的兜底值 —— 用户先按录音、
  // 对方 3 s 后才发射，帧尾就被算早了约 3 s，对方还在发射就判定"接收完成"。
  const r = scenario('手动指定 Robot 36 · 先录 3 s 静音', () => {
    const b = build('Robot 36', { preS: 3, tailS: 2 });
    b.hint = SSTV.modeById('Robot 36');
    return b;
  }, 'mustStop');
  check('帧起点来源应为同步脉冲锚点', r.end.frameStartSource === 'sync',
    String(r.end.frameStartSource) + ' @ ' + (r.end.frameStart / r.end.sr).toFixed(2) + 's');
  check('帧起点锚在真实起点附近（3.91 s ± 0.15 s）',
    Math.abs(r.end.frameStart / r.end.sr - 3.91) < 0.15,
    (r.end.frameStart / r.end.sr).toFixed(2) + 's');
}
{
  // 录音开头有一段杂散 1900 Hz 音（隔壁电台、啸叫、设备自激都会这样）。
  // 旧实现拿 visEndInfo（"第一个 1900 Hz 连段"）当帧起点，于是被这段杂散音带偏：
  // 实测帧尾早 0.61 s，整幅画面随之整体错位。这条盯的就是"别把启发式估计当锚点"。
  const r = scenario('手动指定 Robot 36 · 开头 0.6 s 杂散 1900 Hz 音', () => {
    const b = build('Robot 36', { fakeToneS: 0.6, fakeGapS: 1.5, tailS: 2 });
    b.hint = SSTV.modeById('Robot 36');
    return b;
  }, 'mustStop');
  check('帧起点不落在杂散音上（应锚在 3.01 s ± 0.15 s）',
    Math.abs(r.end.frameStart / r.end.sr - 3.01) < 0.15,
    (r.end.frameStart / r.end.sr).toFixed(2) + 's');
  check('解出整幅行数', r.end.rows >= r.end.totalRows * 0.95,
    r.end.rows + '/' + r.end.totalRows);
}
{
  // VIS 存在但校验不过（无法用它定位）+ 手动指定制式 → 只能靠"相邻同步脉冲配对"
  // 确认锚点。这条盯两件事：① 别把锚点锁在 VIS 的 1200 Hz 结构位上（break 10 ms、
  // 起止位 30 ms 都比行同步长）；② 别因为等待配对而一行都锁不上（实测踩过：
  // VIS 的 break 之后是 1900 Hz 引导音，那里根本没有下一个脉冲，原地等就永远等不到）。
  const r = scenario('手动指定 Robot 36 · VIS 校验位写反（只能靠同步脉冲配对定位）', () => {
    const b = build('Robot 36', { visBuild: { breakParity: true }, tailS: 2 });
    b.hint = SSTV.modeById('Robot 36');
    return b;
  });
  check('仍能锚定帧起点（0.91 s ± 0.15 s）',
    Math.abs(r.end.frameStart / r.end.sr - 0.91) < 0.15,
    (r.end.frameStart / r.end.sr).toFixed(2) + 's' + ' · src=' + r.end.frameStartSource);
  check('仍能解出整幅行数', r.end.rows >= r.end.totalRows * 0.95,
    r.end.rows + '/' + r.end.totalRows);
}

console.log('\n========== 汇总 ==========');
const earlys = cases.filter(c => c.early);
console.log('提前收手的场景: ' + earlys.length + ' / ' + cases.length + '（必须为 0）');
for (const c of earlys) {
  console.log('   ⚠ ' + c.title + ' → ' + c.fire.reason + ' 提前 ' +
    (c.sigEndS - c.fire.sec).toFixed(2) + ' s');
}
const mustStopMissed = cases.filter(c => c.expect === 'mustStop' && !c.fire);
console.log('该收手却没触发: ' + mustStopMissed.length + '（必须为 0）');
for (const c of mustStopMissed) console.log('   ⚠ ' + c.title);

console.log('\n---------------------------------------------');
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
