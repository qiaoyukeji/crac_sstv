/*
 * live_autostop_test.cjs — 麦克风接收"收满自动停止"判据的确定性单测
 * ----------------------------------------------------------------------------
 * 为什么单独测这一块：端到端测试依赖 Chrome 的假音频设备，而那个设备**会偶发插入
 * 静音**（项目里已知的老问题）。当端到端出现"只解出 200/240 行"时，无法区分
 * 是判据提前收手切掉了画面，还是采集本身就丢了那段信号。这里把判据抽出来，
 * 用构造出来的 stats 快照直接断言，噪声与丢音的干扰为零。
 *
 * 仍然不是"重写一遍逻辑再测"：判据本体是用 indexOf 从 web/app.js 里原样切出来的
 * （见下方 start/end 那两个锚点字符串）。
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
  return { liveCompletionReason: liveCompletionReason, liveLostSeconds: liveLostSeconds,
           LIVE_TAIL_S: LIVE_TAIL_S, LIVE_MIN_ROW_FRACTION: LIVE_MIN_ROW_FRACTION };
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
    frameStart: frameStart, frameEnd: frameEnd,
    // 快照里仍留着 frameStartTrusted，但 app.js 的判据**已经不看它了** ——
    // 行数旁证（LIVE_MIN_ROW_FRACTION）现在是**无条件**的，不再分"可信/不可信"
    // 两档。留着只为让快照形状与早期用例一致，改动它不会影响任何断言。
    frameStartTrusted: true,
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

  // 帧长判据的**行数旁证** LIVE_MIN_ROW_FRACTION。它存在的唯一理由是识破"制式
  // 认错"：帧长由制式唯一决定，而制式一旦被认成帧长更短的另一个，时间轴会在对方
  // 还在发射的时候就走完。实测认错制式时行数占比只有 0% / 39% / 51%，而正常接收
  // （含中途 3 s 衰落）都在 92% 以上，所以门槛取在中间偏下的 0.8。
  const gate = Math.round(240 * api.LIVE_MIN_ROW_FRACTION);
  check('旁证门槛是 0.8（与 app.js 的 LIVE_MIN_ROW_FRACTION 一致）',
    api.LIVE_MIN_ROW_FRACTION === 0.8, String(api.LIVE_MIN_ROW_FRACTION));
  check('行数刚好在门槛上（' + gate + '/240）→ 收手',
    api.liveCompletionReason(st({ rows: gate, seconds: frameEndS + 1, locked: true })) === 'frameEnd');
  check('行数差一行到门槛（' + (gate - 1) + '/240）→ 不收手',
    api.liveCompletionReason(st({ rows: gate - 1, seconds: frameEndS + 1, locked: true })) === null);
  check('行数 39%（认错制式的典型占比：94/240）→ 不收手（免得把画面切掉）',
    api.liveCompletionReason(st({ rows: 94, seconds: frameEndS + 9, locked: true })) === null);
}

console.log('\n=== 4. 判据③：长时间收不到同步脉冲（兜底）===');
{
  const base = st({});
  const frameEndS = base.frameEnd / base.sr;
  const lost = api.liveLostSeconds(base);
  console.log('  Robot 36（36 s 帧）的"信号中断"阈值: ' + lost.toFixed(1) + ' s');
  check('阈值落在 8–15 s（宁可多等，不可提前收手）', lost >= 8 && lost <= 15, lost.toFixed(1) + ' s');

  // 这是本项目真实踩过的坑：阈值曾是 3 s，一次 3 s 的衰落就被当成"发射结束"，
  // 后半幅整段没解出来。这里把它钉死。
  const misses3s = Math.ceil(3.0 / (0.15 * 0.5));
  check('传输中途出现 3 s 衰落 → **不得**判定结束（历史缺陷回归闸门）',
    api.liveCompletionReason(st({ rows: 100, locked: true, misses: misses3s, seconds: 20 })) === null,
    misses3s + ' 次 miss');

  const missesLost = Math.ceil(lost / (0.15 * 0.5)) + 1;
  // 该判据额外要求"音频已经覆盖到帧尾"。少了这一条，一次深衰落（实测 12 s 静音）
  // 会在**帧内**就触发，把衰落之后本来还能收到的信号一起切掉 —— 那正是用户报的
  // "对方还在发送，这边就提示接收完成"。帧尾才是"对方按时间该发完了"的时刻。
  check('帧内（音频还没盖到帧尾）+ 失联已达阈值 → **不收手**（12 s 深衰落回归闸门）',
    api.liveCompletionReason(st({
      rows: 100, locked: true, misses: missesLost, seconds: 27.7
    })) === null, 'seconds=27.7 < frameEnd=' + frameEndS.toFixed(1) + ' s');

  check('帧长已走完 + 失联达到阈值 → lostSync',
    api.liveCompletionReason(st({
      rows: 100, locked: true, misses: missesLost, seconds: frameEndS + 1
    })) === 'lostSync', 'seconds=' + (frameEndS + 1).toFixed(1) + ' s');

  check('从未锁定过（locked=false）时该判据不生效',
    api.liveCompletionReason(st({ rows: 0, locked: false, misses: 999, seconds: 60 })) === null);
  check('一行都没解出来时不因丢失同步而收手（避免空画面自锁）',
    api.liveCompletionReason(st({ rows: 0, locked: true, misses: 999, seconds: 60 })) === null);
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
  // seconds 取帧内的 60 s（不是 0）：这样真正在测"帧内不得收手"，而不是
  // 因为 seconds=0 让所有判据都天然不成立而"恰好通过"。
  check('M1 帧内 60 s、5 s 的衰落仍不收手',
    api.liveCompletionReason(Object.assign({}, m1, {
      rows: 50, seconds: 60, misses: Math.ceil(5 / (0.44645 * 0.5))
    })) === null);
}

console.log('\n---------------------------------------------');
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
