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

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
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

  /** "cover" fit: fill the frame, crop the overflow. */
  function drawCover(ctx, img, w, h) {
    var ir = img.width / img.height, tr = w / h, sw, sh, sx, sy;
    if (ir > tr) { sh = img.height; sw = img.height * tr; sx = (img.width - sw) / 2; sy = 0; }
    else { sw = img.width; sh = img.width / tr; sx = 0; sy = (img.height - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  }

  /** Render the source image at exactly the mode resolution. */
  function renderSource() {
    txMode = currentMode();
    txCanvas.width = txMode.width;
    txCanvas.height = txMode.height;
    var g = txCanvas.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, txMode.width, txMode.height);
    drawCover(g, txImage, txMode.width, txMode.height);

    var data = g.getImageData(0, 0, txMode.width, txMode.height).data;
    var n = txMode.width * txMode.height;
    txRGB = new Uint8Array(n * 3);
    for (var i = 0; i < n; i++) {
      txRGB[i * 3]     = data[i * 4];
      txRGB[i * 3 + 1] = data[i * 4 + 1];
      txRGB[i * 3 + 2] = data[i * 4 + 2];
    }

    // preview
    var pv = $('#tx-preview');
    pv.width = txMode.width;
    pv.height = txMode.height;
    pv.style.aspectRatio = txMode.width + ' / ' + txMode.height;
    var pg = pv.getContext('2d');
    pg.imageSmoothingEnabled = false;
    pg.drawImage(txCanvas, 0, 0);

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
    b.textContent = '▶ 试听';
    b.classList.remove('danger');
    playSrc = null;
  }

  $('#tx-play').addEventListener('click', function () {
    var btn = $('#tx-play');
    if (playSrc) {                                   // stop
      try { playSrc.stop(); } catch (e) { /* already stopped */ }
      resetPlayButton();
      if (playCtx) { playCtx.close(); playCtx = null; }
      return;
    }
    if (!txAudio) return;
    try {
      playCtx = newAudioCtx();
      var buf = playCtx.createBuffer(1, txAudio.length, SR);
      buf.copyToChannel(txAudio, 0);
      playSrc = playCtx.createBufferSource();
      playSrc.buffer = buf;
      playSrc.connect(playCtx.destination);
      playSrc.onended = function () {
        resetPlayButton();
        if (playCtx) { playCtx.close(); playCtx = null; }
      };
      playSrc.start(0);
      btn.textContent = '■ 停止';
      btn.classList.add('danger');
    } catch (err) {
      setStatus($('#tx-status'), '播放失败：' + err.message, 'err');
      if (playCtx) { playCtx.close(); playCtx = null; }
    }
  });

  // ----------------------------------------------------------- WAV export --
  $('#tx-wav').addEventListener('click', function () {
    if (!txAudio) return;
    try {
      var wav = SSTV.encodeWAV(txAudio, SR);
      var name = 'sstv_' + txMode.id.replace(/\s+/g, '') + '_' + SR + '.wav';
      download(new Blob([wav], { type: 'audio/wav' }), name);
      setStatus($('#tx-status'), '已导出 ' + name, 'ok');
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
    });
  });

  function armRxDecode(samples, label) {
    rxSamples = samples;
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

  $('#rx-rec').addEventListener('click', async function () {
    var btn = $('#rx-rec');
    if (recProc) { finishRecording(); return; }

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('浏览器不支持麦克风采集。请使用 http(s) 本地服务器打开，而非双击 file:// 打开。');
      }
      btn.disabled = true;
      setStatus($('#rx-status'), '正在请求麦克风权限…');
      recStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
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
      }, 250);

      btn.disabled = false;
      btn.textContent = '■ 停止录音';
      setStatus($('#rx-status'), '录音中…请对准电台音频源', 'ok');
    } catch (err) {
      btn.disabled = false;
      setStatus($('#rx-status'), '无法开始录音：' + err.message, 'err');
    }
  });

  function finishRecording() {
    clearInterval(recTimer); recTimer = null;
    try { recProc && recProc.disconnect(); } catch (e) { /* noop */ }
    try { recSink && recSink.disconnect(); } catch (e) { /* noop */ }
    if (recStream) { recStream.getTracks().forEach(function (t) { t.stop(); }); recStream = null; }
    $('#rx-rec').textContent = '● 开始录音';
    $('#rx-meter').style.width = '0%';

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
    }).catch(function (err) {
      setStatus($('#rx-status'), '录音处理失败：' + err.message, 'err');
      if (recCtx) { recCtx.close(); recCtx = null; }
    });
  }

  // ------------------------------------------------------------- decoding --
  $('#rx-decode').addEventListener('click', function () {
    if (!rxSamples) return;
    busyJob('正在解调 SSTV 信号（长制式需数秒）…', function () {
      var t0 = performance.now();
      rxDecoded = SSTV.decodeSamples(rxSamples, SR, rxModeHint());
      var ms = Math.round(performance.now() - t0);

      var pv = $('#rx-preview');
      pv.width = rxDecoded.width;
      pv.height = rxDecoded.height;
      pv.style.aspectRatio = rxDecoded.width + ' / ' + rxDecoded.height;
      var g = pv.getContext('2d');
      var img = new ImageData(new Uint8ClampedArray(rxDecoded.image), rxDecoded.width, rxDecoded.height);
      g.imageSmoothingEnabled = false;
      g.putImageData(img, 0, 0);

      $('#rx-png').disabled = false;
      var visText = rxDecoded.info && rxDecoded.info.vis != null ? ('VIS ' + rxDecoded.info.vis) : 'VIS 未识别';
      setStatus($('#rx-status'),
        '解码完成：' + rxDecoded.info.mode + ' · ' + rxDecoded.width + '×' + rxDecoded.height +
        ' · ' + rxDecoded.info.lines + ' 行 · ' + visText + '（' + ms + ' ms）', 'ok');
    }).catch(function (err) {
      setStatus($('#rx-status'), '解码失败：' + err.message + '（可尝试手动指定模式）', 'err');
    });
  });

  $('#rx-png').addEventListener('click', function () {
    if (!rxDecoded) return;
    $('#rx-preview').toBlob(function (blob) {
      if (!blob) { setStatus($('#rx-status'), 'PNG 导出失败', 'err'); return; }
      var name = 'sstv_' + rxDecoded.info.mode.replace(/\s+/g, '') + '_' + Date.now() + '.png';
      download(blob, name);
      setStatus($('#rx-status'), '已导出 ' + name, 'ok');
    }, 'image/png');
  });

  // ---------------------------------------------------------------- init --
  refreshModeInfo();
})();
