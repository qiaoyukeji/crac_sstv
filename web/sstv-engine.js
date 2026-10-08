/*
 * SSTVEngine (Web) — faithful port of the validated Python oracle
 * (sstv_proto/{sstv_modes,dsp,vis,color,encode,decode}.py).
 *
 * Pure algorithms only: no DOM, no Web Audio. Works in Node (validation) and
 * in the browser (the app loads this as a classic <script> and reads SSTV.*).
 *
 * Decode math (estimate_frequency) mirrors the oracle exactly:
 *   analytic-signal FM demod via full-signal FFT -> band-limit 700..2700 Hz
 *   -> iFFT -> unwrap phase -> sample-gradient -> clip -> 8-tap moving average.
 */
(function (global) {
  'use strict';

  var SYNC_HZ = 1200.0, BLACK_HZ = 1500.0, WHITE_HZ = 2300.0;
  var MS = 1 / 1000;
  var TWO_PI = 2 * Math.PI;

  function freqOfValue(v) { return BLACK_HZ + (v / 255.0) * (WHITE_HZ - BLACK_HZ); }
  function valueOfFreq(f) {
    var x = (f - BLACK_HZ) / (WHITE_HZ - BLACK_HZ) * 255;
    x = Math.round(x);
    if (x < 0) x = 0; if (x > 255) x = 255;
    return x;
  }

  var Ch = { R: 'R', G: 'G', B: 'B', Y: 'Y', CB: 'CB', CR: 'CR' };

  // ---------------------------------------------------------------- Mode ----
  function Mode(id, vis, width, height, kind, syncDur, params) {
    this.id = id; this.vis = vis; this.width = width; this.height = height;
    this.kind = kind; this.syncDur = syncDur; this.p = params || {};
  }
  Mode.prototype.line = function (lineIndex) {
    if (this.kind === 'rgb') {
      var porch = this.p.porch * MS, scan = this.p.scan * MS, npx = this.width;
      return [this.syncDurS, [
        ['tone', BLACK_HZ, porch],
        ['px', Ch.G, npx, scan],
        ['tone', BLACK_HZ, porch],
        ['px', Ch.B, npx, scan],
        ['tone', BLACK_HZ, porch],
        ['px', Ch.R, npx, scan],
        ['tone', BLACK_HZ, porch]
      ], 1];
    }
    if (this.kind === 'robot') {
      var p2 = this.p.porch * MS, yscan = this.p.yScan * MS, cscan = this.p.cScan * MS;
      var chroma = (lineIndex % 2 === 0) ? Ch.CR : Ch.CB;
      var idtone = (lineIndex % 2 === 0) ? 2300.0 : 1500.0;
      return [this.syncDurS, [
        ['tone', BLACK_HZ, p2],
        ['px', Ch.Y, this.width, yscan],
        ['tone', idtone, 4.5 * MS],
        ['tone', 1900.0, 1.5 * MS],
        ['px', chroma, this.width, cscan]
      ], 1];
    }
    if (this.kind === 'pd') {
      if (lineIndex % 2 !== 0) return null;
      var porch3 = this.p.porch * MS;
      var pixel = this.p.pixel * MS * this.width; // per-pixel dur * width = channel dur
      return [this.syncDurS, [
        ['tone', BLACK_HZ, porch3],
        ['px', Ch.Y, this.width, pixel],
        ['px', Ch.CR, this.width, pixel],
        ['px', Ch.CB, this.width, pixel],
        ['px', Ch.Y, this.width, pixel]
      ], 2];
    }
    throw new Error('unknown kind');
  };
  Object.defineProperty(Mode.prototype, 'syncDurS', {
    get: function () { return this.syncDur * MS; }
  });
  Mode.prototype.lineDuration = function (lineIndex) {
    lineIndex = lineIndex || 0;
    var r = this.line(lineIndex); if (!r) return 0;
    var sd = r[0], segs = r[1], d = sd;
    for (var i = 0; i < segs.length; i++) d += (segs[i][0] === 'tone') ? segs[i][2] : segs[i][3];
    return d;
  };
  Object.defineProperty(Mode.prototype, 'frameDuration', {
    get: function () {
      var n = (this.kind === 'pd') ? this.height / 2 : this.height;
      return this.lineDuration(0) * n;
    }
  });

  var V1_MODES = [
    new Mode('Martin M1', 44, 320, 256, 'rgb', 4.862, { porch: 0.572, scan: 146.432 }),
    new Mode('Martin M2', 40, 320, 256, 'rgb', 4.862, { porch: 0.572, scan: 73.216 }),
    new Mode('Scottie S1', 60, 320, 256, 'rgb', 9.0, { porch: 1.5, scan: 136.74 }),
    new Mode('Scottie S2', 56, 320, 256, 'rgb', 9.0, { porch: 1.5, scan: 86.564 }),
    new Mode('Robot 36', 8, 320, 240, 'robot', 9.0, { porch: 3.0, yScan: 88.0, cScan: 44.0 }),
    new Mode('PD90', 99, 320, 256, 'pd', 20.0, { porch: 2.08, pixel: 0.532 })
  ];
  var MODE_BY_VIS = {}, MODE_BY_ID = {};
  V1_MODES.forEach(function (m) { MODE_BY_VIS[m.vis] = m; MODE_BY_ID[m.id] = m; });
  function modeByVis(v) { return MODE_BY_VIS[v]; }
  function modeById(id) { return MODE_BY_ID[id]; }

  // ----------------------------------------------------------------- DSP ----
  function nextPow2(n) { var p = 1; while (p < n) p <<= 1; return p; }

  function fftInPlace(re, im, inverse) {
    var n = re.length;
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = (inverse ? 2 : -2) * Math.PI / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      var half = len >> 1;
      for (var s = 0; s < n; s += len) {
        var cr = 1, ci = 0;
        for (var k = 0; k < half; k++) {
          var a = s + k, b = s + k + half;
          var xr = re[b] * cr - im[b] * ci;
          var xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          var ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    if (inverse) for (var z = 0; z < n; z++) { re[z] /= n; im[z] /= n; }
  }

  function synthTones(segments, sr) {
    var total = 0, freqs = [], counts = [];
    for (var i = 0; i < segments.length; i++) {
      var n = Math.round(segments[i][1] * sr);
      if (n > 0) { freqs.push(segments[i][0]); counts.push(n); total += n; }
    }
    if (total === 0) return new Float32Array(0);
    var freq = new Float64Array(total), idx = 0;
    for (var s = 0; s < freqs.length; s++)
      for (var c = 0; c < counts[s]; c++) freq[idx++] = freqs[s];
    var phase = new Float64Array(total), acc = 0;
    for (var p = 0; p < total; p++) { acc += TWO_PI * freq[p] / sr; phase[p] = acc; }
    var arr = new Float32Array(total);
    for (var q = 0; q < total; q++) arr[q] = Math.sin(phase[q]);
    var fade = Math.max(1, Math.round(0.002 * sr));
    if (total > 2 * fade)
      for (var f = 0; f < fade; f++) {
        var w = Math.sin((f / fade) * (Math.PI / 2));
        arr[f] *= w; arr[total - 1 - f] *= w;
      }
    return arr;
  }

  function estimateFrequency(samples, sr) {
    var N = samples.length;
    if (N < 2) return new Float64Array(N);
    var mean = 0; for (var i = 0; i < N; i++) mean += samples[i]; mean /= N;
    var P = nextPow2(N);
    var re = new Float64Array(P), im = new Float64Array(P);
    for (var j = 0; j < N; j++) re[j] = samples[j] - mean;
    fftInPlace(re, im, false);
    var half = P >> 1;
    im[0] = 0;
    for (var k = 1; k < half; k++) { re[k] *= 2; im[k] *= 2; }
    im[half] = 0;
    for (var m = half + 1; m < P; m++) { re[m] = 0; im[m] = 0; }
    for (var t = 0; t < P; t++) {
      var f = (t <= half) ? (t * sr / P) : ((t - P) * sr / P);
      if (Math.abs(f) < 700 || Math.abs(f) > 2700) { re[t] = 0; im[t] = 0; }
    }
    fftInPlace(re, im, true);
    var phase = new Float64Array(N);
    for (var a = 0; a < N; a++) phase[a] = Math.atan2(im[a], re[a]);
    for (var b = 1; b < N; b++) {
      var d = phase[b] - phase[b - 1];
      d = d - TWO_PI * Math.round(d / TWO_PI);
      phase[b] = phase[b - 1] + d;
    }
    var df = new Float64Array(N);
    df[0] = (phase[1] - phase[0]) * sr / TWO_PI;
    for (var c = 1; c < N - 1; c++) df[c] = (phase[c + 1] - phase[c - 1]) * 0.5 * sr / TWO_PI;
    df[N - 1] = (phase[N - 1] - phase[N - 2]) * sr / TWO_PI;
    for (var e = 0; e < N; e++) { if (df[e] < 700) df[e] = 700; if (df[e] > 2700) df[e] = 2700; }
    var K = 8, full = new Float64Array(N + K - 1);
    for (var x = 0; x < full.length; x++) {
      var sum = 0;
      for (var mm = 0; mm < K; mm++) { var ix = x - mm; if (ix >= 0 && ix < N) sum += df[ix]; }
      full[x] = sum / K;
    }
    var off = (K - 1) >> 1, out = new Float64Array(N);
    for (var y = 0; y < N; y++) out[y] = full[y + off];
    return out;
  }

  // --------------------------------------------------------------- Color ----
  function clamp0255(x) { x = x | 0; if (x < 0) x = 0; if (x > 255) x = 255; return x; }
  // PIL RGB->YCbCr (ITU-R 601), matches PIL convert('YCbCr').
  function rgbToYCbCr(r, g, b) {
    var y = ((9798 * r + 19235 * g + 3736 * b) >> 15);
    var cb = (((-5539 * r - 10862 * g + 16399 * b) + 4194304) >> 15);
    var cr = (((16399 * r - 13746 * g - 2653 * b) + 4194304) >> 15);
    return [clamp0255(y), clamp0255(cb), clamp0255(cr)];
  }
  // PIL YCbCr->RGB inverse (fromarray 'YCbCr' -> RGB), 32-bit arithmetic.
  function ycbcrToRgb(y, cb, cr) {
    cb -= 128; cr -= 128;
    var r = y + ((91881 * cr) >> 16);
    var g = y - (((22554 * cb + 46802 * cr) >> 16));
    var b = y + ((116130 * cb) >> 16);
    return [clamp0255(r), clamp0255(g), clamp0255(b)];
  }
  function imageToArrays(rgb, w, h) {
    var n = w * h, ycbcr = new Float64Array(n * 3);
    for (var i = 0; i < n; i++) {
      var r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
      var c = rgbToYCbCr(r, g, b);
      ycbcr[i * 3] = c[0]; ycbcr[i * 3 + 1] = c[1]; ycbcr[i * 3 + 2] = c[2];
    }
    return { rgb: rgb, ycbcr: ycbcr };
  }
  function yuvBytesToRgb(ycbcr, w, h) {
    var n = w * h, rgb = new Uint8Array(n * 3);
    for (var i = 0; i < n; i++) {
      var c = ycbcrToRgb(ycbcr[i * 3], ycbcr[i * 3 + 1], ycbcr[i * 3 + 2]);
      rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2];
    }
    return rgb;
  }

  // ----------------------------------------------------------------- VIS ----
  var VIS = { FREQ_LEADER: 1900, FREQ_START: 1200, FREQ_BIT1: 1100, FREQ_BIT0: 1300, FREQ_SYNC: 1200,
    MSEC_LEADER: 300, MSEC_BREAK: 10, MSEC_BIT: 30 };
  function visSegments(visCode) {
    var segs = [
      [VIS.FREQ_LEADER, VIS.MSEC_LEADER],
      [VIS.FREQ_START, VIS.MSEC_BREAK],
      [VIS.FREQ_LEADER, VIS.MSEC_LEADER],
      [VIS.FREQ_SYNC, VIS.MSEC_BIT]
    ];
    var v = visCode & 0x7F, ones = 0;
    for (var i = 0; i < 7; i++) {
      var bit = v & 1; ones += bit;
      segs.push([bit ? VIS.FREQ_BIT1 : VIS.FREQ_BIT0, VIS.MSEC_BIT]);
      v >>= 1;
    }
    var parity = (ones % 2 === 1) ? 1 : 0;
    segs.push([parity ? VIS.FREQ_BIT1 : VIS.FREQ_BIT0, VIS.MSEC_BIT]);
    segs.push([VIS.FREQ_SYNC, VIS.MSEC_BIT]);
    return segs;
  }
  function visSamples(visCode, sr) {
    return synthTones(visSegments(visCode).map(function (s) { return [s[0], s[1] / 1000]; }), sr);
  }
  function _runs(mask, minLen) {
    var runs = [], i = 0, n = mask.length;
    while (i < n) {
      if (mask[i]) {
        var j = i; while (j < n && mask[j]) j++;
        if (j - i >= minLen) runs.push([i, j]);
        i = j;
      } else i++;
    }
    return runs;
  }
  function decodeVis(freq, sr) {
    var near = new Uint8Array(freq.length);
    for (var i = 0; i < freq.length; i++) near[i] = (Math.abs(freq[i] - 1900) < 150) ? 1 : 0;
    var runs = _runs(near, Math.floor(0.2 * sr));
    if (runs.length === 0) return [null, null];
    var leaderEnd = runs[0][1];
    var startBitPos = leaderEnd + Math.floor((VIS.MSEC_BREAK + VIS.MSEC_LEADER) / 1000 * sr);
    var cell = Math.floor(VIS.MSEC_BIT / 1000 * sr);
    var end = startBitPos + 10 * cell;
    if (end > freq.length) return [null, null];
    var cells = [];
    for (var k = 0; k < 10; k++) {
      var a = startBitPos + k * cell, b = startBitPos + (k + 1) * cell;
      var seg = []; for (var x = a; x < b; x++) seg.push(freq[x]);
      seg.sort(function (p, q) { return p - q; });
      cells.push(seg[Math.floor(seg.length / 2)]);
    }
    var bits = [];
    for (var bi = 1; bi < 8; bi++)
      bits.push((Math.abs(cells[bi] - VIS.FREQ_BIT1) < Math.abs(cells[bi] - VIS.FREQ_BIT0)) ? 1 : 0);
    var vis = 0;
    for (var bb = 0; bb < 7; bb++) if (bits[bb]) vis |= (1 << bb);
    return [vis, bits];
  }

  // -------------------------------------------------------------- Encode ----
  function filled(f, n) { var a = new Float64Array(n); for (var i = 0; i < n; i++) a[i] = f; return a; }

  function visFreqArray(visCode, sr) {
    var segs = visSegments(visCode), total = 0;
    for (var i = 0; i < segs.length; i++) total += Math.round(segs[i][1] / 1000 * sr);
    var out = new Float64Array(total), o = 0;
    for (var s = 0; s < segs.length; s++) {
      var f = segs[s][0], n = Math.round(segs[s][1] / 1000 * sr);
      for (var x = 0; x < n; x++) out[o++] = f;
    }
    return out;
  }

  function renderFreq(freqArr, sr) {
    var n = freqArr.length;
    if (n === 0) return new Float32Array(0);
    var phase = new Float64Array(n), acc = 0;
    for (var i = 0; i < n; i++) { acc += TWO_PI * freqArr[i] / sr; phase[i] = acc; }
    var arr = new Float32Array(n);
    for (var j = 0; j < n; j++) arr[j] = Math.sin(phase[j]);
    var fade = Math.max(1, Math.round(0.002 * sr));
    if (n > 2 * fade)
      for (var f = 0; f < fade; f++) {
        var w = Math.sin((f / fade) * (Math.PI / 2));
        arr[f] *= w; arr[n - 1 - f] *= w;
      }
    return arr;
  }

  function channelArray(mode, rgb, ycbcr, lineIndex, seg, segIdx) {
    var ch = seg[1], W = mode.width;
    var out = new Float64Array(W);
    if (mode.kind === 'rgb') {
      var idx = { R: 0, G: 1, B: 2 }[ch];
      for (var x = 0; x < W; x++) out[x] = rgb[lineIndex * W * 3 + x * 3 + idx];
      return out;
    }
    if (mode.kind === 'robot') {
      var cidx = (ch === Ch.Y) ? 0 : (ch === Ch.CR) ? 2 : 1;
      for (var r = 0; r < W; r++) out[r] = ycbcr[lineIndex * W * 3 + r * 3 + cidx];
      return out;
    }
    if (mode.kind === 'pd') {
      if (ch === Ch.Y) {
        var li = (segIdx === 1) ? lineIndex : lineIndex + 1;
        for (var y = 0; y < W; y++) out[y] = ycbcr[li * W * 3 + y * 3];
        return out;
      }
      if (ch === Ch.CB || ch === Ch.CR) {
        var c2 = (ch === Ch.CB) ? 1 : 2;
        for (var c = 0; c < W; c++)
          out[c] = (ycbcr[lineIndex * W * 3 + c * 3 + c2] + ycbcr[(lineIndex + 1) * W * 3 + c * 3 + c2]) / 2.0;
        return out;
      }
    }
    throw new Error('cannot map channel ' + ch + ' for ' + mode.kind);
  }

  function encodeImage(mode, rgb, sr) {
    sr = sr || 44100;
    var arr = imageToArrays(rgb, mode.width, mode.height);
    var ycbcr = arr.ycbcr;
    var parts = [visFreqArray(mode.vis, sr)];
    for (var lineIndex = 0; lineIndex < mode.height; lineIndex++) {
      var r = mode.line(lineIndex); if (!r) continue;
      var syncDur = r[0], lineSegs = r[1];
      parts.push(filled(SYNC_HZ, Math.round(syncDur * sr)));
      for (var segIdx = 0; segIdx < lineSegs.length; segIdx++) {
        var seg = lineSegs[segIdx];
        if (seg[0] === 'tone') {
          parts.push(filled(seg[1], Math.round(seg[2] * sr)));
        } else {
          var ch = seg[1], npx = seg[2], dur = seg[3];
          var vals = channelArray(mode, rgb, ycbcr, lineIndex, seg, segIdx);
          var tot = Math.round(dur * sr);
          var segArr = new Float64Array(tot);
          for (var p = 0; p < npx; p++) {
            var v = vals[p]; if (v < 0) v = 0; if (v > 255) v = 255;
            var a = Math.round(p * tot / npx), b = Math.round((p + 1) * tot / npx);
            var f = freqOfValue(v);
            for (var xx = a; xx < b; xx++) segArr[xx] = f;
          }
          parts.push(segArr);
        }
      }
    }
    var total = 0; for (var pi = 0; pi < parts.length; pi++) total += parts[pi].length;
    var freq = new Float64Array(total), o = 0;
    for (var qi = 0; qi < parts.length; qi++) { freq.set(parts[qi], o); o += parts[qi].length; }
    return renderFreq(freq, sr);
  }

  // -------------------------------------------------------------- Decode ----
  function findRuns(mask, minLen) {
    var runs = [], i = 0, n = mask.length;
    while (i < n) {
      if (mask[i]) {
        var j = i; while (j < n && mask[j]) j++;
        if (j - i >= minLen) runs.push([i, j]);
        i = j;
      } else i++;
    }
    return runs;
  }
  function visEnd(freq, sr) {
    var near = new Uint8Array(freq.length);
    for (var i = 0; i < freq.length; i++) near[i] = (Math.abs(freq[i] - 1900) < 150) ? 1 : 0;
    var runs = findRuns(near, Math.floor(0.25 * sr));
    if (runs.length) {
      var leaderEnd = runs[0][1];
      var startBitPos = leaderEnd + Math.floor((0.010 + 0.300) * sr);
      var cell = Math.floor(0.030 * sr);
      return startBitPos + 10 * cell;
    }
    return Math.floor(0.95 * sr);
  }
  function findSync(freq, lo, hi, sr, syncDur) {
    lo = Math.max(0, lo); hi = Math.min(freq.length, hi);
    var near = new Uint8Array(hi - lo);
    for (var i = lo; i < hi; i++) near[i - lo] = (Math.abs(freq[i] - SYNC_HZ) < 120) ? 1 : 0;
    var minLen = Math.floor(0.6 * syncDur * sr);
    var runs = findRuns(near, minLen);
    if (runs.length === 0) return null;
    var best = null, bestLen = -1;
    for (var k = 0; k < runs.length; k++) {
      var len = runs[k][1] - runs[k][0];
      if (len > bestLen) { bestLen = len; best = runs[k][0] + lo; }
    }
    return best;
  }
  function readPx(freq, pos, npx, dur, sr) {
    var tot = Math.round(dur * sr);
    var out = new Float64Array(npx), newPos = pos + tot;
    for (var p = 0; p < npx; p++) {
      var a = pos + Math.round(p * tot / npx), b = pos + Math.round((p + 1) * tot / npx);
      if (b <= a) b = a + 1;
      var v = 0;
      if (a >= 0 && a < freq.length && b > a && b <= freq.length) {
        var seg = []; for (var x = a; x < b; x++) seg.push(freq[x]);
        seg.sort(function (u, w) { return u - w; });
        v = valueOfFreq(seg[Math.floor(seg.length / 2)]);
      }
      out[p] = v;
    }
    return [out, newPos];
  }
  function decodeSamples(samples, sr, modeHint) {
    sr = sr || 44100;
    var freq = estimateFrequency(samples, sr);
    var vis = null, mode = modeHint || null;
    if (!mode) {
      var dv = decodeVis(freq, sr);
      vis = dv[0];
      mode = vis != null ? modeByVis(vis) : null;
      if (!mode) throw new Error('Could not detect VIS / unknown mode');
    }
    var searchStart = visEnd(freq, sr);
    var step = mode.lineDuration(0) * sr;
    var nLines = (mode.kind === 'pd') ? mode.height / 2 : mode.height;
    var syncStarts = [], pos = searchStart;
    for (var li = 0; li < nLines; li++) {
      var s = findSync(freq, Math.floor(pos - 0.15 * step), Math.floor(pos + 0.5 * step), sr, mode.syncDurS);
      if (s == null) break;
      syncStarts.push(s);
      pos = s + step;
    }
    var W = mode.width, H = mode.height;
    var rgb = new Float64Array(H * W * 3), ycbcr = new Float64Array(H * W * 3);
    for (var idx = 0; idx < syncStarts.length; idx++) {
      var ss = syncStarts[idx];
      var lineIndex = (mode.kind === 'pd') ? 2 * idx : idx;
      var r = mode.line(lineIndex); if (!r) continue;
      var segs = r[1];
      var p = ss + Math.round(mode.syncDurS * sr);
      var pxIdx = 0;
      for (var si = 0; si < segs.length; si++) {
        var seg = segs[si];
        if (seg[0] === 'tone') { p += Math.round(seg[2] * sr); }
        else {
          var ch = seg[1], npx = seg[2], dur = seg[3];
          var rp = readPx(freq, p, npx, dur, sr);
          var vals = rp[0]; p = rp[1];
          if (mode.kind === 'rgb') {
            var cidx = { R: 0, G: 1, B: 2 }[ch];
            for (var x = 0; x < npx; x++) rgb[lineIndex * W * 3 + x * 3 + cidx] = vals[x];
          } else if (mode.kind === 'robot') {
            var c2 = (ch === Ch.Y) ? 0 : (ch === Ch.CR) ? 2 : 1;
            for (var x2 = 0; x2 < npx; x2++) ycbcr[lineIndex * W * 3 + x2 * 3 + c2] = vals[x2];
          } else if (mode.kind === 'pd') {
            if (ch === Ch.Y) {
              var target = (pxIdx % 2 === 0) ? lineIndex : lineIndex + 1;
              for (var x3 = 0; x3 < npx; x3++) ycbcr[target * W * 3 + x3 * 3] = vals[x3];
            } else if (ch === Ch.CB) {
              for (var x4 = 0; x4 < npx; x4++) {
                ycbcr[lineIndex * W * 3 + x4 * 3 + 1] = vals[x4];
                ycbcr[(lineIndex + 1) * W * 3 + x4 * 3 + 1] = vals[x4];
              }
            } else if (ch === Ch.CR) {
              for (var x5 = 0; x5 < npx; x5++) {
                ycbcr[lineIndex * W * 3 + x5 * 3 + 2] = vals[x5];
                ycbcr[(lineIndex + 1) * W * 3 + x5 * 3 + 2] = vals[x5];
              }
            }
          }
          pxIdx++;
        }
      }
    }
    var outRgb;
    if (mode.kind !== 'rgb') {
      for (var i = 0; i < H; i++) {
        if (i % 2 === 0) {
          var z0 = true; for (var x = 0; x < W; x++) { if (ycbcr[i * W * 3 + x * 3 + 1] !== 0) { z0 = false; break; } }
          if (z0) { var nb = (i + 1 < H) ? i + 1 : i - 1; for (var x6 = 0; x6 < W; x6++) ycbcr[i * W * 3 + x6 * 3 + 1] = ycbcr[nb * W * 3 + x6 * 3 + 1]; }
        }
        if (i % 2 === 1) {
          var z1 = true; for (var x7 = 0; x7 < W; x7++) { if (ycbcr[i * W * 3 + x7 * 3 + 2] !== 0) { z1 = false; break; } }
          if (z1) { var nb2 = (i - 1 >= 0) ? i - 1 : i + 1; for (var x8 = 0; x8 < W; x8++) ycbcr[i * W * 3 + x8 * 3 + 2] = ycbcr[nb2 * W * 3 + x8 * 3 + 2]; }
        }
      }
      outRgb = yuvBytesToRgb(ycbcr, W, H);
    } else {
      outRgb = new Uint8Array(H * W * 3);
      for (var ii = 0; ii < rgb.length; ii++) outRgb[ii] = Math.round(rgb[ii]);
    }
    for (var cc = 0; cc < outRgb.length; cc++) { if (outRgb[cc] < 0) outRgb[cc] = 0; if (outRgb[cc] > 255) outRgb[cc] = 255; }
    return { image: outRgb, width: W, height: H, info: { vis: vis, mode: mode.id, lines: syncStarts.length } };
  }

  // --------------------------------------------------------------- WAV ------
  function encodeWAV(samples, sr) {
    sr = sr || 44100;
    var n = samples.length;
    var buffer = new ArrayBuffer(44 + n * 2);
    var view = new DataView(buffer);
    function wstr(off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
    wstr(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    wstr(36, 'data'); view.setUint32(40, n * 2, true);
    var off = 44;
    for (var i = 0; i < n; i++) {
      var s = samples[i]; if (s < -1) s = -1; if (s > 1) s = 1;
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2;
    }
    return buffer;
  }

  var SSTV = {
    SYNC_HZ: SYNC_HZ, BLACK_HZ: BLACK_HZ, WHITE_HZ: WHITE_HZ,
    freqOfValue: freqOfValue, valueOfFreq: valueOfFreq, Ch: Ch,
    Mode: Mode, V1_MODES: V1_MODES, modes: V1_MODES,
    modeByVis: modeByVis, modeById: modeById,
    synthTones: synthTones, estimateFrequency: estimateFrequency,
    rgbToYCbCr: rgbToYCbCr, ycbcrToRgb: ycbcrToRgb,
    imageToArrays: imageToArrays, yuvBytesToRgb: yuvBytesToRgb,
    visSegments: visSegments, visSamples: visSamples, decodeVis: decodeVis,
    encodeImage: encodeImage, decodeSamples: decodeSamples, encodeWAV: encodeWAV
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SSTV;
  if (global) global.SSTV = SSTV;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
