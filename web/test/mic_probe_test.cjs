/*
 * mic_probe_test.cjs — 真实执行 app.js 中的麦克风环境探测逻辑。
 *
 * 不是"重写一遍逻辑再测"，而是用正则把生产代码里的三个函数
 * (esc / isLoopbackHost / platformKind / probeMic / describeGumError)
 * 原样抽出，放进 vm 沙箱，注入不同的 location / navigator / UA 组合来断言行为。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appPath = path.join(__dirname, '..', 'app.js');
const src = fs.readFileSync(appPath, 'utf8');

const start = src.indexOf('function esc(');
const end = src.indexOf('function renderMicDiag(');
if (start < 0 || end < 0) {
  console.error('FATAL: 无法定位探测代码块，app.js 结构可能已变更');
  process.exit(1);
}
const block = src.slice(start, end);

function makeSandbox(opts) {
  const els = {};
  const mkEl = () => ({
    innerHTML: '', disabled: false, textContent: '', title: '',
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    setAttribute(k, v) { this[k] = v; }, removeAttribute(k) { delete this[k]; }
  });
  const sandbox = {
    console,
    window: { isSecureContext: opts.secureContext },
    location: { protocol: opts.protocol, hostname: opts.hostname, origin: opts.origin },
    navigator: { userAgent: opts.ua, platform: opts.platform || '', maxTouchPoints: opts.maxTouchPoints || 0 },
    document: {},
    setTimeout, clearTimeout
  };
  if (opts.mediaDevices) sandbox.navigator.mediaDevices = { getUserMedia() {} };
  sandbox.__els = els;
  sandbox.__mkEl = mkEl;
  return sandbox;
}

// 把代码块包进一个 IIFE 里，暴露需要断言的函数
const wrapper = `(function(){ ${block}
  return { probeMic: probeMic, describeGumError: describeGumError, esc: esc };
})()`;

function load(opts) {
  const sandbox = makeSandbox(opts);
  const ctx = vm.createContext(sandbox);
  return { api: vm.runInContext(wrapper, ctx), sandbox };
}

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}

console.log('=== 1. 局域网 http://192.168.3.185:8000 （Android Chrome，本次报障场景）===');
{
  const { api } = load({
    secureContext: false, protocol: 'http:', hostname: '192.168.3.185',
    origin: 'http://192.168.3.185:8000', ua: ANDROID_UA, mediaDevices: false
  });
  const d = api.probeMic();
  check('判定为 insecure（不再是"浏览器不支持"）', d && d.kind === 'insecure', JSON.stringify(d && d.kind));
  check('提示词不再出现"浏览器不支持麦克风采集"', !/不支持麦克风采集/.test((d && d.msg) || ''));
  check('说明中给出真实原因（safe context 规则）', /安全上下文/.test(d.msg) && /getUserMedia/.test(d.detail));
  check('Android 方案包含 insecure-origin 白名单', d.fixes.some(f => /不安全来源|insecure-origin/.test(f)));
  check('Android 方案包含自签证书路径', d.fixes.some(f => /证书/.test(f)));
  check('提供"录音机录制后导入"兜底', d.fixes.some(f => /录音机/.test(f)));
  check('回显了实际访问地址', /192\.168\.3\.185:8000/.test(d.detail));
}

console.log('\n=== 2. 同一地址，iPhone Safari ===');
{
  const { api } = load({
    secureContext: false, protocol: 'http:', hostname: '192.168.3.185',
    origin: 'http://192.168.3.185:8000', ua: IOS_UA, mediaDevices: false
  });
  const d = api.probeMic();
  check('判定为 insecure', d.kind === 'insecure');
  check('iOS 方案指向「证书信任设置」', d.fixes.some(f => /证书信任设置/.test(f)));
  check('iOS 方案不误报 Android 专有做法', !d.fixes.some(f => /insecure-origin/.test(f)));
}

console.log('\n=== 3. https 且接口可用 → 应当放行（返回 null）===');
{
  const { api } = load({
    secureContext: true, protocol: 'https:', hostname: '192.168.3.185',
    origin: 'https://192.168.3.185:8443', ua: ANDROID_UA, mediaDevices: true
  });
  check('probeMic() === null', api.probeMic() === null, JSON.stringify(api.probeMic()));
}

console.log('\n=== 4. localhost（本机）→ 应当放行 ===');
{
  const { api } = load({
    secureContext: true, protocol: 'http:', hostname: 'localhost',
    origin: 'http://localhost:8000', ua: ANDROID_UA, mediaDevices: true
  });
  check('probeMic() === null', api.probeMic() === null);
}

console.log('\n=== 5. 安全上下文但缺 mediaDevices → no-api（与 insecure 区分开）===');
{
  const { api } = load({
    secureContext: true, protocol: 'https:', hostname: 'example.test',
    origin: 'https://example.test', ua: 'OldBrowser/1.0', mediaDevices: false
  });
  const d = api.probeMic();
  check('判定为 no-api', d && d.kind === 'no-api', JSON.stringify(d && d.kind));
  check('提示包含 iframe allow 的可能', d.fixes.some(f => /iframe/.test(f)));
}

console.log('\n=== 6. getUserMedia 错误名 → 人话映射 ===');
{
  const { api } = load({
    secureContext: true, protocol: 'https:', hostname: 'a.b', origin: 'https://a.b',
    ua: ANDROID_UA, mediaDevices: true
  });
  const cases = [
    ['NotAllowedError', /权限被拒绝/],
    ['PermissionDeniedError', /权限被拒绝/],   // 历史别名
    ['NotFoundError', /没有|未检测到/],
    ['NotReadableError', /占用/],
    ['TrackStartError', /占用/],               // 历史别名
    ['OverconstrainedError', /参数/],
    ['SecurityError', /安全策略/],
    ['AbortError', /中断/],
    ['SomethingNewError', /SomethingNewError/] // 未知名要原样带出
  ];
  for (const [name, re] of cases) {
    const d = api.describeGumError(Object.assign(new Error('boom'), { name }));
    check(name + ' -> ' + d.msg, re.test(d.msg) && d.fixes.length > 0, d.msg);
  }
}

console.log('\n=== 7. esc() 转义（诊断文案注入 DOM，必须防 XSS）===');
{
  const { api } = load({
    secureContext: true, protocol: 'https:', hostname: 'a.b', origin: 'https://a.b',
    ua: ANDROID_UA, mediaDevices: true
  });
  check('<script> 被转义', api.esc('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;');
  check('引号被转义', api.esc('a"b\'c') === 'a&quot;b&#39;c');
  check('& 被转义', api.esc('a&b') === 'a&amp;b');
}

console.log('\n---------------------------------------------');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
