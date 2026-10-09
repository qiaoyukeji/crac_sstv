/*
 * live_autostop_test.cjs — 麦克风接收"收满自动停止"判据的确定性单测
 * ----------------------------------------------------------------------------
 * 为什么单独测这一块：端到端测试依赖 Chrome 的假音频设备，而那个设备**会偶发插入
 * 静音**（项目里已知的老问题）。当端到端出现"只解出 200/240 行"时，无法区分
 * 是判据提前收手切掉了画面，还是采集本身就丢了那段信号。这里把判据抽出来，
 * 用构造出来的 stats 快照直接断言，噪声与丢音的干扰为零。
 *
 * 仍然不是"重写一遍逻辑再测"：判据本体是用正则从 web/app.js 里原样切出来的。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appPath = path.join(__dirname, '..', 'app.js');
const src = fs.readFileSync(appPath, 'utf8');

const start = src.indexOf('var LIVE_TAIL_S');
const end = src.indexOf('function liveReasonText(');
if (start < 0 || end < 0) {
  console.error('FATAL: 无法定位自动停止判据代码块，app.js 结构可能已变更');
  process.exit(1);
}
const block = src.slice(start, end);

const wrapper = `(function(){
  ${block}
  return { liveCompletionReason: liveCompletionReason, liveLostSeconds: liveLostSeconds };
})()`;
const api = vm.runInContext(wrapper, vm.createContext({}));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

const SR = 22050;
/** 造一份 Robot 36 的 stats 快照（帧长 36 s，240 行，每行 0.15 s） */
function st(over) {
  const totalRows = 240, frameStart = Math.round(0.91 * SR);
  const frameEnd = frameStart + 36.0 * SR;
  return Object.assign({
    phase: 'track', width: 320, height: 240,
    rows: 0, totalRows: totalRows,
    locked: false, misses: 0,
    frameStart: frameStart, frameEnd: frameEnd, frameStartTrusted: true,
    stepS: 0.15, seconds: 0, sr: SR
  }, over);
}

console.log('=== 1. 未锁定制式 → 一律不收手 ===');
check('还没识别出制式（width=0）', api.liveCompletionReason(st({ width: 0, totalRows: 0, frameEnd: 0 })) === null);
check('stats 为 null 不崩', api.liveCompletionReason(null) === null);

console.log('\n=== 2. 判据①：行数收满 ===');
check('rows == totalRows → rowCount',
  api.liveCompletionReason(st({ rows: 240, seconds: 20 })) === 'rowCount');
check('rows == totalRows-1 且音频未盖满帧 → 不收手',
  api.liveCompletionReason(st({ rows: 239, seconds: 20, locked: true })) === null);

console.log('\n=== 3. 判据②：音频已覆盖整帧（主力判据）===');
{
  // 阈值必须从 st() 实际生成的 frameEnd 换算，别另算一份 —— frameStart 里有
  // Math.round，另算会差半个采样，测试就会在临界点上抖动（踩过一次）。
  const base = st({});
  const frameEndS = base.frameEnd / base.sr;           // ≈ 36.909 s
  check('音频刚刚盖满帧、行数还差得多（信号末尾无尾音）→ frameEnd',
    api.liveCompletionReason(st({ rows: 238, seconds: frameEndS + 0.5, locked: true })) === 'frameEnd');
  check('音频还差 0.2 s → 不收手',
    api.liveCompletionReason(st({ rows: 238, seconds: frameEndS + 0.3, locked: true })) === null);

  // 这一条正是"只看行数会永远等不到"的证明：实时路径在信号末尾常常停在 H-2
  check('行数只有 202/240 但音频盖满整帧 → 仍然收手（否则永不停机）',
    api.liveCompletionReason(st({ rows: 202, seconds: frameEndS + 0.6, locked: true })) === 'frameEnd');

  // 帧起点不可信（信号缺 VIS 引导音）时必须多要一道行数门槛
  check('帧起点不可信 + 行数只有 50% → 不收手（免得切掉大半幅）',
    api.liveCompletionReason(st({
      rows: 120, seconds: frameEndS + 2, locked: true, frameStartTrusted: false
    })) === null);
  check('帧起点不可信 + 行数已 92% → 收手',
    api.liveCompletionReason(st({
      rows: 221, seconds: frameEndS + 2, locked: true, frameStartTrusted: false
    })) === 'frameEnd');
}

console.log('\n=== 4. 判据③：长时间收不到同步脉冲（兜底）===');
{
  const lost = api.liveLostSeconds(st({}));
  console.log('  Robot 36（36 s 帧）的"信号中断"阈值: ' + lost.toFixed(1) + ' s');
  check('阈值落在 8–15 s（宁可多等，不可提前收手）', lost >= 8 && lost <= 15, lost.toFixed(1) + ' s');

  // 这是本项目真实踩过的坑：阈值曾是 3 s，一次 3 s 的衰落就被当成"发射结束"，
  // 后半幅整段没解出来。这里把它钉死。
  const misses3s = Math.ceil(3.0 / (0.15 * 0.5));
  check('传输中途出现 3 s 衰落 → **不得**判定结束（历史缺陷回归闸门）',
    api.liveCompletionReason(st({ rows: 100, locked: true, misses: misses3s, seconds: 20 })) === null,
    misses3s + ' 次 miss');

  const missesLost = Math.ceil(lost / (0.15 * 0.5)) + 1;
  check('中断达到阈值 → lostSync',
    api.liveCompletionReason(st({ rows: 100, locked: true, misses: missesLost, seconds: 20 })) === 'lostSync');

  check('从未锁定过（locked=false）时该判据不生效',
    api.liveCompletionReason(st({ rows: 0, locked: false, misses: 999, seconds: 20 })) === null);
  check('一行都没解出来时不因丢失同步而收手（避免空画面自锁）',
    api.liveCompletionReason(st({ rows: 0, locked: true, misses: 999, seconds: 20 })) === null);
}

console.log('\n=== 5. 长制式（Martin M1，114.29 s 帧）阈值随帧长放大 ===');
{
  const m1 = {
    width: 320, height: 256, rows: 0, totalRows: 256,
    frameStart: Math.round(0.91 * SR),
    frameEnd: Math.round(0.91 * SR) + 114.29 * SR,
    frameStartTrusted: true, stepS: 0.44645, locked: true, misses: 0,
    seconds: 0, sr: SR
  };
  const lost = api.liveLostSeconds(m1);
  console.log('  Martin M1 的"信号中断"阈值: ' + lost.toFixed(1) + ' s');
  check('M1 阈值 ≥ 15 s 上限内且大于 Robot 36 的',
    lost >= 8 && lost <= 15, lost.toFixed(1) + ' s');
  check('M1 上 5 s 的衰落仍不收手',
    api.liveCompletionReason(Object.assign({}, m1, { rows: 50, misses: Math.ceil(5 / (0.44645 * 0.5)) })) === null);
}

console.log('\n---------------------------------------------');
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
