/*
 * SSTV Studio — application controller.
 *
 * Wires the DOM (index.html) to the pure engine (sstv-engine.js).
 * No network access: every byte is produced and consumed locally.
 *
 * Internal sample rate rationale: SSTV occupies 700..2700 Hz, so sampling at
 * 22050 Hz leaves ample headroom while halving the FFT cost of the full-signal
 * FM demodulator (~2.2x faster) at a cost of <0.1 dB PSNR (see test/bench_sr.cjs).
 */
(function () {
  'use strict';

  var SR = 22050;                    // internal processing rate
  var $ = function (sel) { return document.querySelector(sel); };

  // ------------------------------------------------------------- helpers --
  function nextPaint() {
    return new Promise(function (r) {
      requestAnimationFrame(function () { requestAnimationFrame(r); });
    });
  }

  function showBusy(msg) {
    $('#overlay-msg').textContent = msg;
    $('#overlay').classList.remove('hidden');
  }
  function hideBusy() { $('#overlay').classList.add('hidden'); }

  /** Run a possibly-blocking job, letting the overlay paint first. */
  async function busyJob(msg, fn) {
    showBusy(msg);
    await nextPaint();
    try {
      return await fn();
    } finally {
      hideBusy();
    }
  }

  function setStatus(el, msg, kind) {
    el.textContent = msg || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  /**
   * 设置"有状态的按钮"的文案与图标。
   *
   * 按钮里放的是「两枚图标 + 一个 .lbl」，靠 .playing 类切换（CSS 负责显隐）：
   * 这样图标是矢量描边、跟文字同色，而不像 ▶ / ■ 那样各系统字形不一。
   * 文案只写进 .lbl，不碰按钮的 textContent —— 按钮里还有 <svg>，整块覆盖会把
   * 图标一起抹掉。
   */
  function setBtn(btn, label, playing) {
    if (!btn) return;
    var l = btn.querySelector('.lbl');
    if (l) l.textContent = label; else btn.textContent = label;
    btn.classList.toggle('playing', !!playing);
  }

  /**
   * 触感反馈。安卓 WebView 与部分浏览器支持 navigator.vibrate，
   * 桌面浏览器上是空实现（不报错）。之所以要做：点按有轻微震动是"原生控件"
   * 的体感特征之一，纯视觉反馈在手机上总觉得"隔了一层"。
   */
  function haptic(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (e) { /* noop */ }
  }
  document.addEventListener('pointerdown', function (e) {
    var t = e.target;
    while (t && t.nodeType === 1) {
      if (t.tagName === 'BUTTON' && !t.disabled) { haptic(8); return; }
      t = t.parentNode;
    }
  }, { passive: true });

  // ------------------------------------------------------ 原生桥 / 浮动提示 --
  // 浏览器版与安卓壳 App 版跑的是同一份前端。唯一判据是 window.SSTVNative 在不在 ——
  // 那是 MainActivity 用 addJavascriptInterface 注入的桥对象，只有壳 App 里有。
  // index.html 的 <head> 已经据此打好了 html.app-shell / html.web-shell（同步执行，
  // 避免闪一下网页版文案），这里只是把结论接过来用。
  var IS_APP = window.__SSTV_IS_APP === true;

  // 安卓 WebView 里没有"下载"这回事：WebView 不会为 <a download> + blob: 落地文件，
  // 也不会触发 DownloadListener（那个只认 http/https）。所以走 JS 桥，把内容转成
  // base64 交给原生写进相册 / 下载目录。
  var nativeBridge = (window.SSTVNative && typeof window.SSTVNative.saveFile === 'function')
    ? window.SSTVNative
    : null;

  var toastTimer = null;
  function toast(msg, kind) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 3600);
  }

  /** 正在等待原生回报结果的导出（同一时刻只会有一笔，串行操作） */
  var pendingExport = null;   // { name, el }

  // 原生写完文件后回调这里。两条反馈各司其职：系统 Toast 会被折叠、也可能被
  // 用户忽略；页面内再给一条、并把状态行改成最终结论，用户才知道"到底存哪了"。
  window.__sstvOnSaved = function (name, ok, message) {
    var text = message || (ok ? '已保存 ' + name : '导出失败');
    if (pendingExport && (!name || pendingExport.name === name)) {
      setStatus(pendingExport.el, text, ok ? 'ok' : 'err');
      pendingExport = null;
    }
    toast(text, ok ? 'ok' : 'err');
  };

  /**
   * 导出。浏览器走 <a download>；壳 App 走原生桥。
   *
   * 返回 Promise 而不是 void：原生桥是异步的（写文件 → Toast → 回调），调用方
   * 必须等真实结果再决定提示什么。此前是"先报成功、再去保存"，一旦原生存盘
   * 失败，用户看到的是"已导出"却找不到文件 —— 比直接报错更难查。
   *
   * resolve 值：
   *   { ok: true, pending: true }  已交给原生，最终结果由 __sstvOnSaved 回报
   *   { ok: true }                 浏览器路径已触发下载
   *   { ok: false, message }       当场失败（读不出数据 / 桥抛异常）
   */
  function download(blob, filename, statusEl) {
    if (nativeBridge) {
      pendingExport = { name: filename, el: statusEl || $('#tx-status') };
      return new Promise(function (resolve) {
        var fr = new FileReader();
        fr.onload = function () {
          var s = String(fr.result || '');
          var comma = s.indexOf(',');
          try {
            nativeBridge.saveFile(
              filename,
              blob.type || 'application/octet-stream',
              comma >= 0 ? s.slice(comma + 1) : s
            );
            resolve({ ok: true, pending: true });
          } catch (e) {
            pendingExport = null;
            resolve({ ok: false, message: String((e && e.message) || e) });
          }
        };
        fr.onerror = function () {
          pendingExport = null;
          resolve({ ok: false, message: '无法读取待导出的数据' });
        };
        fr.readAsDataURL(blob);
      });
    }

    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
    return Promise.resolve({ ok: true });
  }

  /**
   * 导出 + 状态反馈的统一出口（TX 的 WAV 与 RX 的 PNG 共用）。
   * 三种结局分别落到状态行上，不再出现"嘴上说成功、文件没落地"。
   */
  function exportBlob(blob, filename, statusElId) {
    var el = $(statusElId);
    setStatus(el, '正在导出 ' + filename + ' …');
    return download(blob, filename, el).then(function (r) {
      if (!r.ok) {
        setStatus(el, '导出失败：' + (r.message || '未知原因'), 'err');
        toast('导出失败：' + (r.message || '未知原因'), 'err');
      } else if (!r.pending) {
        setStatus(el, '已导出 ' + filename, 'ok');           // 浏览器路径
      }
      // pending：状态由原生回调 __sstvOnSaved 收尾，这里不抢着报"成功"
      return r;
    });
  }

  function kindLabel(mode) {
    if (mode.kind === 'rgb') return 'RGB 逐行扫描';
    if (mode.kind === 'robot') return 'Robot YUV（色度隔行）';
    if (mode.kind === 'pd') return 'PD YUV（色度隔行）';
    return mode.kind;
  }

  function modeSummary(mode) {
    return mode.width + '×' + mode.height + ' · ' + kindLabel(mode) +
      ' · 约 ' + mode.frameDuration.toFixed(1) + ' s · VIS ' + mode.vis;
  }

  // --------------------------------------------------------------- tabs ---
  var tabs = document.querySelectorAll('.tab');
  Array.prototype.forEach.call(tabs, function (tab) {
    tab.addEventListener('click', function () {
      var target = tab.getAttribute('data-tab');
      Array.prototype.forEach.call(tabs, function (t) {
        var on = t === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      ['tx', 'rx', 'help'].forEach(function (name) {
        $('#' + name).classList.toggle('active', name === target);
      });
      // 切页回到顶部：原生 App 换标签是新开一屏，不会"继承"上一屏的滚动位置
      window.scrollTo(0, 0);
    });
  });

  // ------------------------------------------------------------ sharing --
  /** Chrome/Safari still need the callback form in older builds. */
  function decodeAudioData(ctx, arrayBuffer) {
    // Older Safari only supports the callback form; modern browsers return a
    // promise. Using both is safe because Promise settle is idempotent.
    return new Promise(function (resolve, reject) {
      var maybePromise = null;
      try {
        maybePromise = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      } catch (err) {
        reject(err);
        return;
      }
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve, reject);
      }
    });
  }

  function newAudioCtx() {
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) throw new Error('当前浏览器不支持 Web Audio API');
    return new C();
  }

  /** Downmix to mono and resample to SR using an offline render. */
  function toInternalRate(audioBuffer) {
    var OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OC) throw new Error('当前浏览器不支持 OfflineAudioContext');
    var frames = Math.max(1, Math.ceil(audioBuffer.duration * SR));
    var octx = new OC(1, frames, SR);
    var src = octx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(octx.destination);
    src.start(0);
    return octx.startRendering().then(function (rendered) {
      return rendered.getChannelData(0);
    });
  }

  // ======================================================================
  //  TX — image to audio
  // ======================================================================
  var txCanvas = document.createElement('canvas');   // mode-sized work canvas
  var txImage = null;                                // loaded source image
  var txRGB = null;                                  // mode-sized RGB bytes
  var txMode = null;
  var txAudio = null;                                // Float32Array
  var playCtx = null, playSrc = null;

  // ------------------------------------------------- 发送进度遮罩（TX） ----
  // 播放音频就是"发射"。单靠一个按钮变红，发送者无法知道进行到哪了，尤其是
  // Martin M1 要 115 s、PD90 要 91 s。这里在图片上叠一层遮罩：
  //   已发送的部分保持清晰 / 未发送的部分压暗 / 中间一条扫描线 + 百分比和计时。
  // 选择"从上往下推进"而不是普通进度条，是因为它与接收端逐行成像的过程一致 ——
  // 发送者看到的画面正是对端正在收到的画面。
  var txStage = $('#tx-stage');
  var txSend = $('#tx-send');
  var txSendMask = $('#tx-send-mask');
  var txSendLine = $('#tx-send-line');
  var txSendChip = $('#tx-send-chip');
  var txRaf = 0;

  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    return String(Math.floor(sec / 60)).padStart(2, '0') + ':' +
           String(sec % 60).padStart(2, '0');
  }

  function setSendProgress(pct, chip) {
    pct = Math.max(0, Math.min(100, pct));
    txSendMask.style.height = (100 - pct) + '%';
    txSendLine.style.top = pct + '%';
    if (chip != null) txSendChip.textContent = chip;
    txSend.setAttribute('aria-valuenow', String(Math.round(pct)));
  }

  function beginSendOverlay() {
    txSend.classList.remove('hidden');
    txStage.classList.add('sending');
    setSendProgress(0, '准备发送…');
  }

  function endSendOverlay() {
    if (txRaf) { cancelAnimationFrame(txRaf); txRaf = 0; }
    txSend.classList.add('hidden');
    txStage.classList.remove('sending');
    setSendProgress(0, '');
  }

  function tickSend() {
    if (!playSrc || !playCtx || !txAudio) { txRaf = 0; return; }
    var dur = txAudio.length / SR;
    var t = playCtx.currentTime;
    var pct = dur > 0 ? (t / dur) * 100 : 0;
    setSendProgress(pct, '● 正在发送 ' + Math.round(Math.min(100, Math.max(0, pct))) + '%  ·  ' +
                          fmtClock(t) + ' / ' + fmtClock(dur));
    txRaf = requestAnimationFrame(tickSend);
  }

  /** 停止播放并收起遮罩。可重复调用。 */
  function stopPlayback() {
    if (playSrc) { try { playSrc.stop(); } catch (e) { /* already stopped */ } }
    if (playCtx) { try { playCtx.close(); } catch (e) { /* already closed */ } }
    playSrc = null;
    playCtx = null;
    endSendOverlay();
    resetPlayButton();
  }

  // populate mode selector
  var txModeSel = $('#tx-mode');
  SSTV.V1_MODES.forEach(function (m, i) {
    var opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = m.id + '（' + m.width + '×' + m.height + '，' + m.frameDuration.toFixed(0) + ' s）';
    txModeSel.appendChild(opt);
  });
  txModeSel.selectedIndex = 0;

  function currentMode() { return SSTV.V1_MODES[parseInt(txModeSel.value, 10) || 0]; }

  function refreshModeInfo() {
    txMode = currentMode();
    $('#tx-mode-info').textContent = modeSummary(txMode);
    if (txImage) renderSource();
  }
  txModeSel.addEventListener('change', refreshModeInfo);

  // ------------------------------------------------------- 画面适配 fit ----
  // 为什么需要这块：SSTV 每种制式的画布尺寸是**固定**的（如 Martin M1 = 320×256，
  // 即 5:4），而手机照片多为 4:3 / 3:4。两者比例不一致时，把原图"塞进去"必然要
  // 做取舍 —— 要么补黑边、要么裁掉一部分、要么拉伸变形。原实现固定用 CSS `cover`
  // 语义（填满画布 + 裁掉溢出），于是竖构图照片就被切掉了上下。现在把选择权交给
  // 用户，并且明确写出"会发生什么"。
  //
  //   contain —— 完整保留，比例不足处补黑边（默认，不丢内容）
  //   cover   —— 填满画布，裁掉溢出部分（会丢内容）
  //   stretch —— 直接铺满，比例不一致时画面变形
  function fmtRatio(r) {
    var common = [[1, 1], [4, 3], [3, 4], [3, 2], [2, 3], [16, 9], [9, 16],
                  [5, 4], [4, 5], [7, 5], [5, 7], [16, 10], [10, 16]];
    for (var i = 0; i < common.length; i++) {
      if (Math.abs(common[i][0] / common[i][1] - r) < 0.013) {
        return common[i][0] + ':' + common[i][1];
      }
    }
    return (Math.round(r * 100) / 100) + ':1';
  }

  /** iw×ih 的图放进 w×h 画布的落点（直接喂给 drawImage）。 */
  function fitRect(iw, ih, w, h, mode) {
    if (mode === 'stretch') return { dx: 0, dy: 0, dw: w, dh: h };
    var s = (mode === 'cover') ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
    var dw = iw * s, dh = ih * s;
    return { dx: (w - dw) / 2, dy: (h - dh) / 2, dw: dw, dh: dh };
  }

  function pctStr(x) { return (Math.round(x * 1000) / 10) + '%'; }

  /** 一句话说清"这张图放进这个制式会怎样"。 */
  function describeFit(iw, ih, w, h, mode) {
    var ir = iw / ih, tr = w / h;
    var same = Math.abs(ir - tr) < 0.013;
    var head = '原图 ' + iw + '×' + ih + '（' + fmtRatio(ir) + '）→ 画布 ' +
               w + '×' + h + '（' + fmtRatio(tr) + '）：';
    if (same) return head + '比例一致，完整铺满' +
      (mode === 'cover' ? '，无裁剪' : (mode === 'stretch' ? '，不变形' : '，无黑边'));

    if (mode === 'stretch') {
      var k = (w / iw) / (h / ih);          // 相对横向拉伸系数
      return head + (k > 1
        ? '水平拉伸 ' + (Math.round(k * 100) / 100) + '×，画面会变形'
        : '垂直拉伸 ' + (Math.round(100 / k) / 100) + '×，画面会变形');
    }
    if (mode === 'cover') {
      return head + (ir > tr
        ? '原图更宽 → 裁掉左右共 ' + pctStr(1 - tr / ir)
        : '原图更高 → 裁掉上下共 ' + pctStr(1 - ir / tr));
    }
    return head + (ir > tr
      ? '完整保留 → 上下补黑边共占 ' + pctStr(1 - tr / ir)
      : '完整保留 → 左右补黑边共占 ' + pctStr(1 - ir / tr));
  }

  /** 是否"有代价"：cover 会丢内容，stretch 会变形。contain 补黑边不算代价。 */
  function fitHasCost(iw, ih, w, h, mode) {
    if (Math.abs(iw / ih - w / h) < 0.013) return false;
    return mode === 'cover' || mode === 'stretch';
  }

  /** 按适配方式绘制到画布（contain 先铺黑底形成信箱式黑边）。 */
  function drawFitted(ctx, img, w, h, mode) {
    var r = fitRect(img.width, img.height, w, h, mode);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, img.width, img.height, r.dx, r.dy, r.dw, r.dh);
  }

  var txFitSel = $('#tx-fit');

  function refreshFitNote() {
    var note = $('#tx-fit-note');
    if (!txImage) { note.textContent = ''; note.classList.remove('warn'); return; }
    var mode = txFitSel.value;
    note.textContent = describeFit(txImage.width, txImage.height,
                                   txMode.width, txMode.height, mode);
    note.classList.toggle('warn', fitHasCost(txImage.width, txImage.height,
                                             txMode.width, txMode.height, mode));
  }

  txFitSel.addEventListener('change', function () {
    if (txImage) renderSource(); else refreshFitNote();
  });

  /** Render the source image at exactly the mode resolution. */
  function renderSource() {
    txMode = currentMode();
    stopPlayback();                                  // 源图变了，旧音频作废

    txCanvas.width = txMode.width;
    txCanvas.height = txMode.height;
    var g = txCanvas.getContext('2d');
    drawFitted(g, txImage, txMode.width, txMode.height, txFitSel.value);

    var data = g.getImageData(0, 0, txMode.width, txMode.height).data;
    var n = txMode.width * txMode.height;
    txRGB = new Uint8Array(n * 3);
    for (var i = 0; i < n; i++) {
      txRGB[i * 3]     = data[i * 4];
      txRGB[i * 3 + 1] = data[i * 4 + 1];
      txRGB[i * 3 + 2] = data[i * 4 + 2];
    }

    // preview（显示的就是真正会被编码的那张位图，黑边/裁剪一目了然）
    var pv = $('#tx-preview');
    $('#tx-stage').classList.remove('empty');   // 有图了，换掉"空槽"底纹
    pv.width = txMode.width;
    pv.height = txMode.height;
    pv.style.aspectRatio = txMode.width + ' / ' + txMode.height;
    var pg = pv.getContext('2d');
    pg.imageSmoothingEnabled = false;
    pg.drawImage(txCanvas, 0, 0);

    refreshFitNote();

    txAudio = null;
    $('#tx-play').disabled = true;
    $('#tx-wav').disabled = true;
  }

  function loadImageFromFile(file) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      txImage = img;
      renderSource();
      setStatus($('#tx-status'), '已载入 ' + file.name + '（' + img.width + '×' + img.height + '），目标 ' +
        txMode.width + '×' + txMode.height, 'ok');
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      setStatus($('#tx-status'), '图片读取失败：' + file.name, 'err');
    };
    img.src = url;
  }

  // file picker + drag & drop
  $('#tx-pick').addEventListener('click', function () { $('#tx-file').click(); });
  $('#tx-file').addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) loadImageFromFile(e.target.files[0]);
    e.target.value = '';
  });

  var drop = $('#tx-drop');
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('drag'); });
  });
  drop.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadImageFromFile(f);
  });

  // ---------------------------------------------------------- test card --
  /** Procedural colour chart, useful for verifying the whole chain offline. */
  function buildTestCard(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    var bars = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff', '#000000'];
    var barH = Math.round(h * 0.55);
    for (var i = 0; i < bars.length; i++) {
      g.fillStyle = bars[i];
      g.fillRect(Math.round(i * w / bars.length), 0, Math.ceil(w / bars.length) + 1, barH);
    }
    // grey step wedge
    var steps = 8, sw = w / steps;
    for (var s = 0; s < steps; s++) {
      var v = Math.round(255 * s / (steps - 1));
      g.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
      g.fillRect(Math.round(s * sw), barH, Math.ceil(sw) + 1, Math.round(h * 0.15));
    }
    // colour gradient strip
    var gradY = Math.round(h * 0.70), gradH = Math.round(h * 0.10);
    var grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#2dd4bf');
    grad.addColorStop(0.5, '#38bdf8');
    grad.addColorStop(1, '#fbbf24');
    g.fillStyle = grad;
    g.fillRect(0, gradY, w, gradH);
    // greyscale ramp
    var rampY = gradY + gradH, rampH = h - rampY;
    var ramp = g.createLinearGradient(0, 0, w, 0);
    ramp.addColorStop(0, '#000');
    ramp.addColorStop(1, '#fff');
    g.fillStyle = ramp;
    g.fillRect(0, rampY, w, rampH);
    return c;
  }

  $('#tx-test').addEventListener('click', function () {
    txMode = currentMode();
    txImage = buildTestCard(txMode.width, txMode.height);
    renderSource();
    setStatus($('#tx-status'), '已生成测试卡 ' + txMode.width + '×' + txMode.height, 'ok');
  });

  // ------------------------------------------------------------- encode --
  $('#tx-gen').addEventListener('click', function () {
    if (!txRGB) { setStatus($('#tx-status'), '请先载入或生成一张图片', 'err'); return; }
    stopPlayback();                                  // 旧音频即将作废，先停掉
    busyJob('正在合成 SSTV 音频…', function () {
      var t0 = performance.now();
      txAudio = SSTV.encodeImage(txMode, txRGB, SR);
      var ms = Math.round(performance.now() - t0);
      $('#tx-play').disabled = false;
      $('#tx-wav').disabled = false;
      setStatus($('#tx-status'),
        '已生成 ' + txMode.id + '：' + (txAudio.length / SR).toFixed(1) + ' s / ' +
        txAudio.length.toLocaleString() + ' 采样 @' + SR + ' Hz（' + ms + ' ms）', 'ok');
    }).catch(function (err) {
      setStatus($('#tx-status'), '生成失败：' + err.message, 'err');
    });
  });

  // ------------------------------------------------------------ playback --
  function resetPlayButton() {
    var b = $('#tx-play');
    setBtn(b, '发送', false);
    b.classList.remove('danger');
  }

  $('#tx-play').addEventListener('click', function () {
    var btn = $('#tx-play');
    if (playSrc) { stopPlayback(); return; }         // stop
    if (!txAudio) return;
    try {
      playCtx = newAudioCtx();
      var buf = playCtx.createBuffer(1, txAudio.length, SR);
      buf.copyToChannel(txAudio, 0);
      playSrc = playCtx.createBufferSource();
      playSrc.buffer = buf;
      playSrc.connect(playCtx.destination);
      playSrc.onended = function () { stopPlayback(); };
      playSrc.start(0);
      setBtn(btn, '停止发送', true);
      btn.classList.add('danger');
      beginSendOverlay();
      txRaf = requestAnimationFrame(tickSend);
    } catch (err) {
      setStatus($('#tx-status'), '播放失败：' + err.message, 'err');
      stopPlayback();
    }
  });

  // ----------------------------------------------------------- WAV export --
  $('#tx-wav').addEventListener('click', function () {
    if (!txAudio) return;
    try {
      var wav = SSTV.encodeWAV(txAudio, SR);
      var name = 'sstv_' + txMode.id.replace(/\s+/g, '') + '_' + SR + '.wav';
      exportBlob(new Blob([wav], { type: 'audio/wav' }), name, '#tx-status');
    } catch (err) {
      setStatus($('#tx-status'), '导出失败：' + err.message, 'err');
    }
  });

  // ======================================================================
  //  RX — audio to image
  // ======================================================================
  var rxSamples = null;      // Float32Array at SR
  var rxDecoded = null;      // { image, width, height, info }
  var rxSource = 'file';

  // mode selector (auto + explicit)
  var rxModeSel = $('#rx-mode');
  SSTV.V1_MODES.forEach(function (m, i) {
    var opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = m.id + '（' + m.width + '×' + m.height + '）';
    rxModeSel.appendChild(opt);
  });
  rxModeSel.value = 'auto';

  function rxModeHint() {
    return rxModeSel.value === 'auto' ? null : SSTV.V1_MODES[parseInt(rxModeSel.value, 10)];
  }

  // source switching
  Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (btn) {
    btn.addEventListener('click', function () {
      rxSource = btn.getAttribute('data-src');
      Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (b) {
        var on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      $('#rx-file').classList.toggle('hidden', rxSource !== 'file');
      $('#rx-mic').classList.toggle('hidden', rxSource !== 'mic');
      if (rxSource === 'mic') refreshMicDiag();     // 切进来就立刻告知能否录音
    });
  });

  function armRxDecode(samples, label) {
    rxSamples = samples;
    liveImg = null; liveRgb = null; liveRows = 0; liveW = 0; liveH = 0;  // 旧画布作废
    $('#rx-decode').disabled = !samples || samples.length < SR * 0.5;
    $('#rx-png').disabled = true;
    if (samples) {
      setStatus($('#rx-status'),
        label + '：' + (samples.length / SR).toFixed(1) + ' s / ' +
        samples.length.toLocaleString() + ' 采样 @' + SR + ' Hz', 'ok');
    }
  }

  // --------------------------------------------------------- RX from file --
  $('#rx-pick').addEventListener('click', function () { $('#rx-file-input').click(); });
  $('#rx-file-input').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    busyJob('正在读取并转换音频…', async function () {
      var buf = await file.arrayBuffer();
      var ctx = newAudioCtx();
      try {
        var audioBuf = await decodeAudioData(ctx, buf);
        var mono = await toInternalRate(audioBuf);
        if (mono.length > 0x7fffffff) throw new Error('音频过长');
        armRxDecode(mono, '已载入 ' + file.name);
      } finally {
        if (ctx.close) ctx.close();
      }
    }).catch(function (err) {
      setStatus($('#rx-status'), '音频读取失败：' + err.message, 'err');
    });
  });

  // ----------------------------------------------------------- RX from mic --
  var recCtx = null, recStream = null, recProc = null, recSink = null;
  var recChunks = null, recLen = 0, recTimer = null, recStart = 0;

  // ---- microphone environment probing -------------------------------------
  // 关键事实：getUserMedia 只在"安全上下文（secure context）"下被暴露。
  // http:// + 局域网 IP 属于非安全来源，浏览器会直接把 navigator.mediaDevices
  // 置为 undefined —— 这极易被误读成"浏览器不支持麦克风"。下面把这几种情形
  // 严格区分开，并给出针对当前平台的可执行修复路径。
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isLoopbackHost(h) {
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  }

  function platformKind() {
    var ua = navigator.userAgent || '';
    var iOS = /iPad|iPhone|iPod/.test(ua) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (iOS) return 'ios';
    if (/Android/.test(ua)) return 'android';
    return 'desktop';
  }

  // 返回 null 表示"应当可以录音"，否则返回结构化诊断。
  // 纯同步、无副作用，页面加载时即可安全调用。
  function probeMic() {
    var proto = location.protocol, host = location.hostname, origin = location.origin;
    var secure = window.isSecureContext === true || proto === 'https:' || isLoopbackHost(host);

    if (!secure) {
      // 壳 App 走的是 WebViewAssetLoader 挂在 https://appassets.androidplatform.net
      // 下的资源，永远是安全上下文，理论上到不了这里。但真到了也绝不能把
      // 「装根证书 / 换 https 访问」这类网页版步骤甩给 App 用户。
      if (IS_APP) {
        return {
          kind: 'insecure',
          msg: '页面未处于安全上下文，系统已隐藏麦克风接口',
          detail: '这是异常状态：本应用应始终以 https 加载自己的本地资源。' +
                  '普通使用不会遇到，若你在调试，请检查 WebViewAssetLoader 是否生效。',
          fixes: ['重启应用后重试',
                  '暂时可用「文件」标签页导入对讲机录音来解码']
        };
      }
      var fixes = [], plat = platformKind();
      if (plat === 'android') {
        fixes.push('免装证书：在手机 Chrome 中把 ' + origin +
                   ' 加入「将不安全来源视为安全」白名单后重启浏览器（见指南）');
        fixes.push('推荐做法：安装本项目自签根证书，改用 https 访问（见 web/HTTPS_MIC_GUIDE.md）');
      } else if (plat === 'ios') {
        fixes.push('安装本项目根证书描述文件，并在「设置 → 通用 → 关于本机 → 证书信任设置」' +
                   '中对该根证书开启完全信任，再用 https 访问（见 web/HTTPS_MIC_GUIDE.md）');
      } else {
        fixes.push('改用 https 访问，或在本机用 localhost 打开（file:// 同样不可用）');
      }
      fixes.push('通用兜底：用手机自带录音机录下电台音频，回到「文件」标签导入解码');
      return {
        kind: 'insecure',
        msg: '当前页面不是安全上下文，浏览器已主动隐藏麦克风接口',
        detail: '访问地址为 ' + esc(origin) + '（' + esc(proto) + '）。Web 规范要求 ' +
                'getUserMedia 仅在 https:// 或 localhost 下暴露，因此此处 navigator.mediaDevices ' +
                '为 undefined。这并不代表浏览器没有录音能力，而是安全策略的强制限制。',
        fixes: fixes
      };
    }

    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      return {
        kind: 'no-api',
        msg: '浏览器未提供麦克风接口（安全上下文正常）',
        detail: '当前已是安全上下文，但 navigator.mediaDevices.getUserMedia 仍不存在，' +
                '通常意味着浏览器内核过旧，或页面被嵌套在不允许麦克风的 iframe 中。',
        fixes: ['升级浏览器到较新的版本',
                '若页面被 iframe 嵌套，需为该 iframe 添加 allow="microphone"']
      };
    }
    return null;
  }

  // getUserMedia 的标准错误名 → 人话。移动端最容易踩 NotAllowedError / NotReadableError。
  function describeGumError(err) {
    var n = (err && err.name) || '';
    var table = {
      NotAllowedError: ['麦克风权限被拒绝',
        '用户或浏览器策略拒绝了本次请求。若此前误点了「阻止」，需在站点权限中改回「允许」并刷新页面。',
        ['点击地址栏左侧的站点信息，把「麦克风」权限改为允许，然后刷新页面',
         'iOS：设置 → Safari浏览器 → 麦克风 → 允许',
         '确认系统隐私设置没有全局禁止浏览器访问麦克风']],
      NotFoundError: ['未检测到可用的麦克风设备',
        '系统没有报告任何音频输入设备。',
        ['确认设备自带麦克风或已连接外接麦克风',
         '检查系统声音设置中是否禁用了输入设备']],
      NotReadableError: ['麦克风被其它程序占用',
        '设备存在但无法打开，通常已被其它应用或标签页独占（移动端最常见）。',
        ['关闭其它正在录音的应用或标签页后重试',
         '若正在进行通话/语音会议，请先挂断']],
      OverconstrainedError: ['设备不接受所请求的音频参数',
        '请求中要求关闭回声消除／降噪／自动增益，当前设备不予支持。重试时会自动放宽约束。',
        ['直接再点一次「开始录音」即可，会自动以宽松参数重试']],
      SecurityError: ['安全策略阻止了麦克风访问',
        '当前页面来源被浏览器判定为不可信。',
        ['改用 https 或 localhost 访问']],
      AbortError: ['录音启动被中断',
        '系统或硬件在启动过程中中止了请求。',
        ['稍后重试；必要时重启浏览器']]
    };

    // 壳 App 与浏览器的"下一步"完全不同：浏览器要去改站点权限、刷新页面；App 要
    // 去系统设置里给应用开权限、重启应用。同一句建议放错地方就是误导用户。
    if (IS_APP) {
      table.NotAllowedError = ['麦克风权限被拒绝',
        '本应用需要麦克风权限才能接收电台音频。若此前误点了「拒绝」，' +
        '请在系统设置里重新允许，然后回到应用重试。',
        ['打开「设置 → 应用 → SSTV Studio → 权限」，把「麦克风」改为「允许」',
         '回到应用后重新点「开始录音」',
         '确认系统级的隐私/权限开关没有禁止本应用访问麦克风']];
      table.NotReadableError = ['麦克风被其它程序占用',
        '设备存在但无法打开，通常已被其它应用（通话、录音机、语音会议）独占。',
        ['关闭其它正在录音或通话的应用后重试',
         '若正在进行通话 / 语音会议，请先挂断',
         '仍失败可重启应用再试']];
      table.SecurityError = ['安全策略阻止了麦克风访问',
        '系统拒绝把麦克风交给本应用。',
        ['重启应用后重试',
         '确认系统没有对本应用启用「权限单次授权 / 隐私保护」之类的限制']];
    }

    // 历史别名
    table.PermissionDeniedError = table.NotAllowedError;
    table.DevicesNotFoundError = table.NotFoundError;
    table.TrackStartError = table.NotReadableError;

    var e = table[n];
    if (e) return { kind: n, msg: e[0], detail: e[1], fixes: e[2] };
    return {
      kind: n || 'unknown',
      // 未归档的错误名要原样带到标题里，否则用户无法检索
      msg: '录音启动失败（' + (n || '未归类错误') + '）',
      detail: '浏览器返回：' + esc((err && err.message) || '(无描述)') +
              '。该错误名不在本工具的知识库中，建议在浏览器控制台查看完整堆栈。',
      fixes: ['重试一次；若持续失败，请在浏览器控制台查看详细堆栈']
    };
  }

  // -------------------------------------------- 实时逐行成像（Live RX） ----
  // 用户诉求：用麦克风接收时，要能像发送时那样，看着画面一行一行长出来。
  //
  // 关键取舍：不做"先整段解完、再按时间轴播放逐行动画"——那是纯装饰，还要求
  // 用户先等完整段信号；这里真的**边收边解**，录音回调每来一块音频就喂进
  // SSTV.createStreamDecoder，解调器增量更新频率轨迹，某一行所需的样本一到齐
  // 就立刻解码并把这若干行增量画上画布。所以屏幕正在出现的那一行，就是电台
  // 此刻正在发的那一行。
  //
  // SSTV 之所以能这样增量：每一行都由「同步脉冲 + 若干色带」自包含组成，行与
  // 行之间不互相依赖（唯 Robot 36 的色度要借相邻行，引擎里已处理）。
  var liveDec = null;       // 流式解码器实例
  var liveRgb = null;       // 引擎输出的 RGB 缓冲（与解码器共用同一块内存）
  var liveImg = null;       // 持久化的 ImageData，只更新新增行
  var liveRows = 0;         // 已经画上画布的行数
  var liveW = 0, liveH = 0;
  var liveT0 = 0;

  // ---- 收满自动停止（Auto stop on complete） -------------------------------
  // 为什么需要：一次 SSTV 传输的长度是确定的（Robot 36 恰好 36 s，Martin M1 115 s）。
  // 整幅收完之后继续录，只会把静音灌进缓冲区 —— 既拉长后面那次批量重解的耗时，
  // 又逼用户盯着屏幕手点"停止"，稍微走神就多录几十秒噪声。
  //
  // 判据不靠计时器猜，而是解码器自己给的事实：stats() 里 rows 是"已确定的行数"、
  // totalRows 是制式高度，收满即整幅到手。这个信号比"按已知时长定时"稳得多 ——
  // 后者一旦遇到信号中断就会在不完整的时候停下。
  //
  // 为什么不在音频回调里直接停：onaudioprocess 跑在音频线程上，在里面拆节点、
  // 关 AudioContext 很容易把自己正在执行的那次回调搞坏。这里只置标志，由已有的
  // 250 ms 计时器在主线程上执行停止 —— 代价是几十毫秒延迟，换来的是确定性。
  var liveStats = null;      // 最近一次 stats() 快照
  var liveCompleteAt = 0;    // 首次发现"收满"的墙钟时间；0 = 尚未收满
  var liveCompleteReason = null;  // 'rowCount' | 'frameEnd' | 'lostSync'
  var livePaintOn = true;    // 是否把解出的行画到画布上（对应「实时逐行成像」开关）
  var LIVE_SETTLE_MS = 350;  // 收满后再等一小会儿，让最后一行画完再停

  function liveCapable() { return typeof SSTV.createStreamDecoder === 'function'; }

  function autoStopEnabled() {
    var cb = $('#rx-auto-stop');
    return !cb || cb.checked;
  }

  /** 新一幅画面开始时铺"待机底"：暗底 + 细横线。 */
  function liveInitCanvas(w, h) {
    var pv = $('#rx-preview');
    $('#rx-stage').classList.remove('empty');
    pv.width = w; pv.height = h;
    pv.style.aspectRatio = w + ' / ' + h;
    var g = pv.getContext('2d');
    g.imageSmoothingEnabled = false;
    // 未收到的区域必须和非黑的像素有区别 —— 否则收到黑色像素与"还没收到"
    // 在屏幕上完全一样，逐行生长的过程就看不出来了。
    g.fillStyle = '#0a0f15';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(56, 189, 248, .09)';
    g.lineWidth = 1;
    for (var y = 16; y < h; y += 16) {
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(w, y + 0.5); g.stroke();
    }
    liveImg = g.getImageData(0, 0, w, h);
    liveRgb = liveDec.image();          // 引擎的 RGB 缓冲（3 字节/像素）
    liveW = w; liveH = h; liveRows = 0;
  }

  /** 只把 [from, to) 行涂进画布：O(新增像素)，与总进度无关。 */
  function livePaintRows(from, to) {
    if (!liveImg || !liveRgb) return;
    if (from < 0) from = 0;
    if (to > liveH) to = liveH;
    if (to <= from) return;
    var d = liveImg.data, s = liveRgb, W = liveW;
    for (var y = from; y < to; y++) {
      var a = y * W * 3, o = y * W * 4;
      for (var x = 0; x < W; x++) {
        d[o] = s[a]; d[o + 1] = s[a + 1]; d[o + 2] = s[a + 2]; d[o + 3] = 255;
        a += 3; o += 4;
      }
    }
    $('#rx-preview').getContext('2d')
      .putImageData(liveImg, 0, 0, 0, from, W, to - from);
  }

  function liveShowProgress(st) {
    var chip = $('#rx-live-chip'), note = $('#rx-live-note');
    var t = (Date.now() - liveT0) / 1000;
    if (!st.width) {
      chip.textContent = '等待 VIS 头…  ' + fmtClock(t);
      note.textContent = '实时解调 @ ' + st.sr + ' Hz · 已接收 ' +
        (st.seconds || 0).toFixed(1) + ' s，正在等待制式识别';
      return;
    }
    if (liveCompleteReason) {                       // 收满之后不再来回跳数字
      chip.textContent = '✓ 接收完成  ·  ' + st.rows + ' / ' + st.totalRows + ' 行';
      chip.classList.add('complete');
      $('#rx-live-line').style.top = '100%';
      note.textContent = '整幅已收满（' + st.mode + ' ' + st.width + '×' + st.height +
        '）· ' + liveReasonText(liveCompleteReason, st) + ' · 正在收尾…';
      return;
    }
    var pct = st.totalRows ? Math.round(st.rows / st.totalRows * 100) : 0;
    chip.textContent = '● 接收中 ' + pct + '%  ·  ' + st.rows + ' / ' + st.totalRows + ' 行';
    $('#rx-live-line').style.top =
      Math.min(100, st.totalRows ? st.rows / st.totalRows * 100 : 0) + '%';
    note.textContent = 'VIS ' + (st.vis != null ? st.vis : '—') + ' · ' + st.mode +
      ' · ' + st.width + '×' + st.height +
      (st.locked ? ' · 已锁定行同步' : ' · 正在搜索同步脉冲') +
      ' · ' + st.sr + ' Hz · 已接收 ' + fmtClock(t);
  }

  /**
   * 判断整幅是否已经收满；收满则返回**原因**（供 UI 显示），否则返回 null。
   *
   * 只看"行数收满"是不够的，这是这里最容易踩的坑：实时路径每解一行都要求该行
   * 起始位置之后还有约 1.5 个行周期的数据（否则解出来的尾巴是空的），而发射方
   * 在最后一行之后就静音了 —— 于是 rows 会稳稳停在 H-2 左右，永远等不到 H。
   *
   * 三条判据互为兜底，覆盖不同接收场景：
   *
   *   rowCount 已确认行数收满 —— 最确定。信号结束前若还有一小段尾音（真实电台常见），
   *            这条会先成立。
   *   frameEnd 音频已覆盖整帧时长 —— 主力判据。帧起点来自**真正解出的 VIS 导引音
   *            位置**，不是"录音开始时刻"（用户完全可能先按录音、对方几秒后才发射）。
   *            关键好处：它只取决于"收到了多长的音频"，与解调成功与否无关 —— 就算
   *            信号中途有衰落漏掉若干行，时间一到照样能干净收手。
   *   lostSync 曾锁定过、之后长时间找不到同步脉冲 —— 用于"接收方在发射中途才开始
   *            录音"：此时帧起点只能是兜底估计、frameEnd 会把帧尾算晚，
   *            "再也找不到同步"才是信号结束的直接证据。
   */
  var LIVE_TAIL_S = 0.5;    // 整帧之后再多收一点，确保最后一行数据完整

  /**
   * 帧长判据要求的最低"行数占比"。这是**旁证**，用来识破"制式认错了"。
   *
   * 为什么非要它：帧长由制式唯一决定，而制式来自 VIS。VIS 一旦被认成另一个帧长更短
   * 的制式，时间轴就会在对方还在发射的时候走完 —— 实测能提前 19~78 s 收手，画面
   * 只剩零头，用户看到的正是"提示接收完成、但图看不出来"。
   *
   * 0.8 取自实测的两簇数据：认错制式时行数占比是 0%（240 行里一行没解出）、
   * 39%、51%；而正常接收（含中途 3 s 衰落）都在 92% 以上。中间留了很宽的间隔。
   */
  var LIVE_MIN_ROW_FRACTION = 0.8;

  /** 连续丢失行同步多久算"发射已结束"。取帧长的 25%，并夹在 8–15 s：
   *  这是**兜底**判据，宁可多等几秒都不要提前收手 —— 提前收手的代价是画面被切掉，
   *  而多等的代价只是用户多等一会儿（随时可以手动停止）。
   *  实测教训：曾用 3 s 阈值，结果一次 3 s 的衰落就被当成"发射结束"，
   *  后半幅整段没解出来。 */
  function liveLostSeconds(st) {
    var byFrame = (st.frameEnd - st.frameStart) / st.sr * 0.25;
    if (!(byFrame > 0)) return 10.0;
    return Math.max(8.0, Math.min(15.0, byFrame));
  }

  function liveCompletionReason(st) {
    if (!st || !st.width) return null;

    // ① 行数收满 —— 最确定，自己就够，不需要旁证。
    if (st.totalRows > 0 && st.rows >= st.totalRows) return 'rowCount';

    // ② 音频已覆盖整帧 —— 主力判据，但需要两个前提：
    //    · frameEnd > 0：帧起点必须**真的有锚点**（校验过的 VIS 头，或第一次锁定的
    //      同步脉冲）。猜出来的位置不算 —— 拿它算帧尾等于赌，赌输就是把画面截断。
    //    · 行数接近收满：见 LIVE_MIN_ROW_FRACTION 的说明。
    if (st.frameEnd > 0 && st.seconds >= st.frameEnd / st.sr + LIVE_TAIL_S) {
      if (st.rows >= st.totalRows * LIVE_MIN_ROW_FRACTION) return 'frameEnd';
    }

    // ③ 长时间收不到同步脉冲 —— 兜底。用于"接收方在发射中途才开始录音"，以及
    //    对方突然停发。额外要求"音频已经覆盖到帧尾"：否则一次深衰落（实测 12 s
    //    静音）会在帧内就触发，把衰落之后本来还能收到的信号一起切掉 —— 帧尾才是
    //    "对方按时间该发完了"的时刻，过了它还没同步，才谈得上"发射已结束"。
    if (st.locked && st.rows > 0 && st.stepS > 0 &&
        (st.frameEnd <= 0 || st.seconds >= st.frameEnd / st.sr) &&
        st.misses * st.stepS * 0.5 >= liveLostSeconds(st)) return 'lostSync';
    return null;
  }

  /** 停止原因 → 一句人话（写进接收遮罩下方的说明行，用户看得到"为什么停了"）。 */
  function liveReasonText(reason, st) {
    if (reason === 'lostSync') {
      return '信号已中断 ' + liveLostSeconds(st).toFixed(0) +
             ' s 以上，按发射结束处理（画面为此前收到的部分）';
    }
    if (reason === 'rowCount') return '整幅行数已全部收满';
    var src = st.frameStartSource === 'sync' ? '帧起点取自首个同步脉冲'
                                           : '帧起点取自 VIS 头';
    return '整帧信号已收完（' + (st.frameEnd / st.sr).toFixed(1) + ' s，' + src + '）';
  }

  function liveFlush() {
    if (!liveDec) return;
    var st = liveDec.stats();
    liveStats = st;
    if (livePaintOn) {
      if (st.width && (!liveImg || liveW !== st.width || liveH !== st.height)) {
        liveInitCanvas(st.width, st.height);
      }
      if (liveImg && st.rows > liveRows) { livePaintRows(liveRows, st.rows); liveRows = st.rows; }
    }
    liveShowProgress(st);
    // 收满的那一刻只做一件事：记下时间与原因。真正的停止交给主线程的计时器
    // （见 liveCompleteAt 处的注释）。
    if (!liveCompleteAt) {
      var reason = liveCompletionReason(st);
      if (reason) {
        liveCompleteAt = Date.now();
        liveCompleteReason = reason;
        toast(autoStopEnabled()
          ? '整幅已接收完成，正在自动停止录音…'
          : '整幅已接收完成（「自动停止」已关闭，请手动停止）', 'ok');
      }
    }
  }

  function liveStart(rate, hint, paint) {
    liveDec = null;
    if (!liveCapable()) return false;
    liveDec = SSTV.createStreamDecoder(rate, hint, { block: 4096 });
    liveImg = null; liveRgb = null; liveRows = 0; liveW = 0; liveH = 0;
    liveT0 = Date.now();
    liveStats = null; liveCompleteAt = 0; liveCompleteReason = null;
    livePaintOn = (paint !== false);
    $('#rx-png').disabled = true;
    $('#rx-stage').classList.add('receiving');
    $('#rx-live').classList.remove('hidden');
    $('#rx-live-chip').classList.remove('complete');
    $('#rx-live-chip').textContent = '等待 VIS 头…';
    $('#rx-live-note').textContent = '实时解调 @ ' + rate + ' Hz · 正在等待信号';
    return true;
  }

  function liveHide() {
    $('#rx-stage').classList.remove('receiving');
    $('#rx-live').classList.add('hidden');
    $('#rx-live-chip').classList.remove('complete');
  }

  /**
   * 由 250 ms 计时器（主线程）调用：收满并静置片刻后结束录音。
   * 返回 true 表示本次已经触发了停止。
   */
  function liveMaybeAutoStop() {
    if (!liveCompleteAt) return false;
    if (!autoStopEnabled()) return false;
    if (Date.now() - liveCompleteAt < LIVE_SETTLE_MS) return false;
    return true;
  }

  /** 录音进行中：喂入新到的一块音频，并把新增行画出来。 */
  function livePush(chunk) {
    if (!liveDec) return;
    try {
      liveDec.push(chunk);        // 引擎内部立刻复制，chunk 可被浏览器复用
      liveFlush();
    } catch (err) {
      liveDec = null;
      liveHide();
      setStatus($('#rx-status'), '实时成像中断：' + err.message +
        '（可停止录音后用「解码」重新解一次）', 'err');
    }
  }

  /**
   * 停止录音：收尾流式解码器，返回可直接上屏的结果。
   * 返回 null 表示本次没有启用实时成像；返回 { empty: true } 表示启用了但没解出画面。
   */
  function liveFinalize() {
    var dec = liveDec;
    liveDec = null;
    liveHide();
    liveStats = null; liveCompleteAt = 0; liveCompleteReason = null; livePaintOn = true;
    if (!dec) return null;
    try { dec.finish(); } catch (e) { /* 收尾失败就当作没有实时结果 */ }
    var st = dec.stats();
    if (!st.width || st.rows <= 0) return { empty: true, stats: st };
    if (liveImg && st.rows > liveRows) { livePaintRows(liveRows, st.rows); liveRows = st.rows; }
    var img = dec.image();
    var copy = new Uint8Array(img.length);
    copy.set(img);
    return {
      image: copy, width: st.width, height: st.height, rows: st.rows,
      info: { vis: st.vis, mode: st.mode, lines: st.lines, live: true }
    };
  }

  function renderMicDiag(probe) {
    var box = $('#rx-mic-diag'), btn = $('#rx-rec');
    if (!box || !btn) return;
    if (!probe) {
      box.classList.add('hidden');
      box.innerHTML = '';
      btn.disabled = false;
      btn.removeAttribute('title');
      return;
    }
    var html = '<strong>⚠ ' + esc(probe.msg) + '</strong>';
    if (probe.detail) html += '<p>' + esc(probe.detail) + '</p>';
    if (probe.fixes && probe.fixes.length) {
      html += '<ol>' + probe.fixes.map(function (f) {
        return '<li>' + esc(f) + '</li>';
      }).join('') + '</ol>';
    }
    box.innerHTML = html;
    box.classList.remove('hidden');
    // 非安全上下文下按钮根本不可能成功：直接禁用，避免用户反复点击却只见失败
    var blocked = (probe.kind === 'insecure' || probe.kind === 'no-api');
    btn.disabled = blocked;
    if (blocked) btn.setAttribute('title', probe.msg);
  }

  // 页面加载 / 切到麦克风标签时都刷新一次环境诊断（录音进行中不打扰）
  function refreshMicDiag() { if (!recProc) renderMicDiag(probeMic()); }
  refreshMicDiag();

  // ---- 「实时逐行成像」与「接收完成自动停止」的联动提示 --------------------
  // 两个开关都能独立决定要不要启动解码器（见录音启动处），但只有一个开了另一个
  // 关着时，用户很容易以为自己关掉的那个还在生效，所以用一行小字把当前的实际
  // 行为说清楚 —— 比事后解释"为什么没自动停"便宜得多。
  function refreshAutoHint() {
    var hint = $('#rx-auto-hint');
    if (!hint) return;
    var liveOn = $('#rx-live-on') && $('#rx-live-on').checked;
    var autoOn = autoStopEnabled();
    var text = '';
    if (autoOn && liveOn) {
      text = '收满整幅会自动停止录音；确认行数来自解码器，不靠时长估算。';
    } else if (autoOn && !liveOn) {
      text = '已开启自动停止：仍会实时解调以判断是否收满，只是不逐行上屏，停止后再出图。';
    } else if (!autoOn && liveOn) {
      text = '自动停止已关闭：画面照常逐行生长，但需要你手动点「停止录音」。';
    } else {
      text = '两个开关都关闭：只录音，不解调；停止后点「解码」再出图。';
    }
    hint.textContent = text;
  }
  ['#rx-live-on', '#rx-auto-stop'].forEach(function (sel) {
    var el = $(sel);
    if (el) el.addEventListener('change', refreshAutoHint);
  });
  refreshAutoHint();

  $('#rx-rec').addEventListener('click', async function () {
    var btn = $('#rx-rec');
    if (recProc) { finishRecording(); return; }

    // 环境级拦截：原因明确时不再假装是"浏览器不支持"，也不去弹系统授权框
    var env = probeMic();
    if (env) {
      renderMicDiag(env);
      setStatus($('#rx-status'), env.msg, 'err');
      return;
    }

    try {
      btn.disabled = true;
      setStatus($('#rx-status'), '正在请求麦克风权限…');
      // 先按"适合 SSTV 解调"的理想参数请求（关闭 AGC / 回声消除 / 降噪）；
      // 部分移动设备不接受这些约束，失败则回退到设备默认音频参数。
      var wantAudio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      try {
        recStream = await navigator.mediaDevices.getUserMedia({ audio: wantAudio });
      } catch (e1) {
        if (e1 && (e1.name === 'OverconstrainedError' || e1.name === 'TypeError')) {
          recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw e1;
        }
      }
      recCtx = newAudioCtx();
      var srcNode = recCtx.createMediaStreamSource(recStream);
      recProc = recCtx.createScriptProcessor(4096, 1, 1);
      recSink = recCtx.createGain();
      recSink.gain.value = 0;                       // silent sink; keeps events flowing
      recChunks = [];
      recLen = 0;

      recProc.onaudioprocess = function (e) {
        var ch = e.inputBuffer.getChannelData(0);
        recChunks.push(new Float32Array(ch));
        recLen += ch.length;
        // level meter
        var peak = 0;
        for (var i = 0; i < ch.length; i += 8) { var a = Math.abs(ch[i]); if (a > peak) peak = a; }
        var pct = Math.min(100, Math.round(peak * 140));
        $('#rx-meter').style.width = pct + '%';
        // 边收边解：直接把这一块（原地引用）交给流式解码器，它内部立即复制，
        // 因此不需要在这里再拷一份。解调 + 增量绘制都是 O(新增样本)。
        if (liveDec) livePush(ch);
      };

      srcNode.connect(recProc);
      recProc.connect(recSink);
      recSink.connect(recCtx.destination);

      recStart = Date.now();
      recTimer = setInterval(function () {
        var t = Math.floor((Date.now() - recStart) / 1000);
        var mm = String(Math.floor(t / 60)).padStart(2, '0');
        var ss = String(t % 60).padStart(2, '0');
        $('#rx-rec-time').textContent = mm + ':' + ss;
        // 收满自动停止：真正的"停"放在这里做（主线程），而不是 liveFlush 里
        // （音频线程）。见 liveCompleteAt 处的注释。
        if (liveMaybeAutoStop()) {
          setStatus($('#rx-status'), '整幅已接收完成，正在自动停止并精确重解…', 'ok');
          finishRecording();
        }
      }, 250);

      // 实时成像必须在拿到上下文之后立刻启动：解码器要用**麦克风的原生采样率**
      // 工作，这样既不必先重采样（省一次转换、少一层误差），也能把解调器与
      // 音频回调对齐到同一时间轴。
      //
      // 「自动停止」也需要解码器：只有它知道"整幅收满了没有"。所以两个开关只要
      // 开了一个就启动解码器，区别只在要不要把解出的行画到画布上 —— 不画的时候
      // 用户看不到逐行生长，但收满照样会停，停止后照样出图。
      var liveOn = $('#rx-live-on') && $('#rx-live-on').checked;
      var autoOn = autoStopEnabled();
      if (!liveOn && !autoOn) liveDec = null;
      else if (!liveStart(recCtx.sampleRate, rxModeHint(), liveOn)) liveDec = null;
      livePaintOn = !!liveOn;

      btn.disabled = false;
      // 录起来之后按钮才转红："红"在这里表示"正在进行、可以停"，而不是"危险"。
      // 常态用主色（和"生成音频""解码"一致），否则一个整宽的红色按钮会读成警告。
      btn.classList.remove('primary');
      btn.classList.add('danger');
      setBtn(btn, '停止录音', true);
      renderMicDiag(null);                          // 已成功，清掉诊断提示
      setStatus($('#rx-status'), liveDec
        ? (liveOn
            ? '录音中…画面会随信号逐行出现（' + recCtx.sampleRate + ' Hz）'
            : '录音中…' + (autoOn ? '整幅收满后自动停止' : '') + '（' + recCtx.sampleRate + ' Hz）')
        : '录音中…请对准电台音频源', 'ok');
    } catch (err) {
      // 运行时错误：要让按钮恢复可用以便重试，同时给出精确归因
      btn.disabled = false;
      var diag = describeGumError(err);
      renderMicDiag(diag);
      setStatus($('#rx-status'), '无法开始录音：' + diag.msg, 'err');
    }
  });

  function finishRecording() {
    clearInterval(recTimer); recTimer = null;
    try { recProc && recProc.disconnect(); } catch (e) { /* noop */ }
    try { recSink && recSink.disconnect(); } catch (e) { /* noop */ }
    if (recStream) { recStream.getTracks().forEach(function (t) { t.stop(); }); recStream = null; }
    var recBtn = $('#rx-rec');
    recBtn.classList.remove('danger');
    recBtn.classList.add('primary');
    setBtn(recBtn, '开始录音', false);
    $('#rx-meter').style.width = '0%';

    // 先收尾实时解码器（此后不会再有音频块进来），再去做重采样等耗时工作
    var liveRes = liveFinalize();

    var nativeRate = recCtx ? recCtx.sampleRate : SR;
    busyJob('正在转换录音…', async function () {
      var flat = new Float32Array(recLen);
      var off = 0;
      for (var i = 0; i < recChunks.length; i++) { flat.set(recChunks[i], off); off += recChunks[i].length; }
      recChunks = null; recProc = null;

      if (nativeRate === SR) {
        armRxDecode(flat, '已录制');
      } else {
        var tmp = recCtx.createBuffer(1, flat.length, nativeRate);
        tmp.copyToChannel(flat, 0);
        var mono = await toInternalRate(tmp);
        armRxDecode(mono, '已录制');
      }
      if (recCtx) { recCtx.close(); recCtx = null; }
    }).then(function () {
      adoptLiveAndRefine(liveRes);
    }).catch(function (err) {
      setStatus($('#rx-status'), '录音处理失败：' + err.message, 'err');
      if (recCtx) { recCtx.close(); recCtx = null; }
    });
  }

  /**
   * 停止录音后的收尾。
   *
   * 实时路径为了控制单次开销做了分块解调，实测与批量结果一致到 50 dB 以上
   * （见 test/stream_decode_test.cjs），但"留档/导出"这种要拿去和参考实现比对
   * 的场合，还是走与批量完全同一条代码路径最稳妥。所以这里：先采用实时画面
   * （立即可见，用户不用等），再静默跑一次批量精确重解并替换。
   */
  function adoptLiveAndRefine(liveRes) {
    if (!liveRes) return;

    if (liveRes.empty) {
      var st = liveRes.stats || {};
      setStatus($('#rx-status'),
        (st.mode
          ? '实时成像没能解出完整的一行'
          : '实时接收未能识别出 VIS 头（已收到 ' + (st.seconds || 0).toFixed(1) + ' s）') +
        '；可在上方手动指定制式后点「解码」重试', 'err');
      return;
    }

    try {
      renderDecoded(liveRes);
    } catch (e) {
      setStatus($('#rx-status'), '实时画面显示失败：' + e.message, 'err');
      return;
    }
    var head = '实时成像完成：' + liveRes.width + '×' + liveRes.height +
      ' · 逐行收到 ' + liveRes.rows + ' 行';
    // 行数明显不足整幅时，最可能的原因不是"信号差"而是**制式被认错**（帧长不对，
    // 时间轴提前走完）。此时"自动识别"往往也不可靠，所以直接给出可操作的出路。
    if (liveRes.rows < liveRes.height * LIVE_MIN_ROW_FRACTION) {
      head += '（不足整幅 —— 制式可能识别有误，可在上方手动指定制式后点「解码」重试）';
    }
    setStatus($('#rx-status'), head + '（正在精确重解校验…）', 'ok');

    try {
      var t0 = performance.now();
      var dec = SSTV.decodeSamples(rxSamples, SR, rxModeHint());
      var ms = Math.round(performance.now() - t0);
      var bmode = SSTV.modeById(dec.info.mode);
      // 批量路径按"行号"计数，PD 制式一个同步脉冲带两行
      var batchRows = dec.info.lines * (bmode && bmode.kind === 'pd' ? 2 : 1);

      if (batchRows < liveRes.rows) {
        // 批量路径一旦在某一行的窗口里找不到同步脉冲就会停下来，而实时路径会
        // 向前搜索并重新锁定。所以批量偶尔覆盖得更少（实测 138/240 vs 238/240）。
        // 这时保留实时结果 —— 它覆盖得更全，且与批量共用同一份逐行数学。
        setStatus($('#rx-status'), head + ' → 精确重解只覆盖 ' + batchRows +
          ' 行（少于实时的 ' + liveRes.rows + ' 行），已保留实时结果', 'ok');
      } else {
        renderDecoded(dec);
        setStatus($('#rx-status'), head + ' → 精确重解校验通过：' + dec.info.mode +
          ' · ' + dec.info.lines + ' 行 · VIS ' +
          (dec.info.vis != null ? dec.info.vis : '未识别') + '（' + ms + ' ms）', 'ok');
      }
    } catch (e) {
      setStatus($('#rx-status'), head +
        '；批量精确重解未成功（' + e.message + '），当前显示的是实时结果。' +
        '可手动指定制式后再点「解码」', 'ok');
    }
  }

  // ------------------------------------------------------------- decoding --

  /**
   * 把引擎输出的图像缓冲区包装成 ImageData。
   *
   * 引擎返回的是 **RGB**（每像素 3 字节），而 `new ImageData()` 的规范要求
   * **RGBA**（每像素 4 字节）。直接把 3 字节缓冲区传进去，浏览器会抛：
   *   Failed to construct 'ImageData': The input data length is not equal
   *   to (4 * width * height)
   * 这不是"解码失败"，而是**渲染阶段的类型不匹配** —— 解码本身已经成功了，
   * 所以错误信息会误导人往"信号不好"的方向排查。此处显式展开为 RGBA，
   * alpha 固定 255（不透明）。
   */
  function rgbToImageData(src, w, h) {
    var n = w * h;
    if (src.length === n * 4) {                      // 已经是 RGBA，直接用
      return new ImageData(new Uint8ClampedArray(src), w, h);
    }
    if (src.length !== n * 3) {
      throw new Error('图像数据长度异常：期望 ' + (n * 3) + '（RGB）或 ' +
        (n * 4) + '（RGBA）字节，实际 ' + src.length + ' 字节（' + w + '×' + h + '）');
    }
    var out = new Uint8ClampedArray(n * 4);
    for (var i = 0; i < n; i++) {
      var s = i * 3, d = i * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = 255;
    }
    return new ImageData(out, w, h);
  }

  /**
   * 把一次解码结果画到预览画布上，并认定它为"当前结果"（解锁 PNG 导出）。
   * 实时路径与批量路径共用这一个出口，避免两处渲染逻辑分叉。
   */
  function renderDecoded(decoded) {
    var pv = $('#rx-preview');
    $('#rx-stage').classList.remove('empty');
    pv.width = decoded.width;
    pv.height = decoded.height;
    pv.style.aspectRatio = decoded.width + ' / ' + decoded.height;
    var g = pv.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.putImageData(rgbToImageData(decoded.image, decoded.width, decoded.height), 0, 0);
    rxDecoded = decoded;
    // 画布已被完整体接管，实时路径的分块缓冲作废（否则下一次 livePaintRows 会
    // 拿旧行覆盖回来）
    liveImg = null; liveRgb = null; liveRows = 0;
    $('#rx-png').disabled = false;
  }

  $('#rx-decode').addEventListener('click', function () {
    if (!rxSamples) return;
    busyJob('正在解调 SSTV 信号（长制式需数秒）…', function () {
      var t0 = performance.now();
      var decoded = SSTV.decodeSamples(rxSamples, SR, rxModeHint());
      var ms = Math.round(performance.now() - t0);

      // 「解调」与「显示」是两个阶段。渲染出错时绝不能报成"解码失败" ——
      // 那会把一个纯前端的数据类型问题，误导成"信号不好/模式不对"，
      // 让人白白去调天线和模式。这里用 RENDER: 前缀把两者区分开。
      try {
        renderDecoded(decoded);
      } catch (e) {
        rxDecoded = null;                             // 画布不可信，禁用导出
        $('#rx-png').disabled = true;
        throw new Error('RENDER:' + e.message);
      }
      liveHide();

      var visText = decoded.info && decoded.info.vis != null ? ('VIS ' + decoded.info.vis) : 'VIS 未识别';
      setStatus($('#rx-status'),
        '解码完成：' + decoded.info.mode + ' · ' + decoded.width + '×' + decoded.height +
        ' · ' + decoded.info.lines + ' 行 · ' + visText + '（' + ms + ' ms）', 'ok');
    }).catch(function (err) {
      var msg = String((err && err.message) || err);
      if (msg.indexOf('RENDER:') === 0) {
        setStatus($('#rx-status'),
          '显示失败：' + msg.slice(7) + '（信号本身已正确解出，属渲染问题，非信号问题）', 'err');
      } else {
        setStatus($('#rx-status'), '解码失败：' + msg + '（可尝试手动指定模式）', 'err');
      }
    });
  });

  $('#rx-png').addEventListener('click', function () {
    if (!rxDecoded) return;
    var name = 'sstv_' + rxDecoded.info.mode.replace(/\s+/g, '') + '_' + Date.now() + '.png';
    try {
      $('#rx-preview').toBlob(function (blob) {
        if (!blob) { setStatus($('#rx-status'), '导出失败：画布无法生成 PNG', 'err'); return; }
        exportBlob(blob, name, '#rx-status');
      }, 'image/png');
    } catch (e) {
      setStatus($('#rx-status'), '导出失败：' + e.message, 'err');
    }
  });

  // ---------------------------------------------------------------- init --
  refreshModeInfo();
})();
