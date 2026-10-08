/*
 * Decode-rate benchmark + parity check.
 *
 * The web decoder does a full-signal FFT (mirroring the Python oracle), so its
 * cost is O(P log P) with P = nextPow2(N). SSTV bandwidth is only 700..2700 Hz,
 * so we can safely decimate the input to a lower internal rate.
 *
 * This measures: (a) wall-clock decode time, (b) PSNR penalty, so the app can
 * pick an internal rate that is both fast and faithful.
 */
const SSTV = require('../sstv-engine.js');

function refRGB(w, h) {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = x / (w - 1), fy = y / (h - 1), i = (y * w + x) * 3;
      rgb[i]     = Math.round(255 * (0.5 + 0.45 * Math.sin(fx * Math.PI * 2)));
      rgb[i + 1] = Math.round(255 * (0.5 + 0.45 * Math.sin(fy * Math.PI * 2)));
      rgb[i + 2] = Math.round(255 * (0.5 + 0.45 * Math.sin((fx + fy) * Math.PI * 2)));
    }
  }
  return rgb;
}

function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; }
  return 10 * Math.log10((255 * 255) / (se / a.length));
}

// Boxcar (averaging) decimator — cheap anti-alias before throwing away samples.
function decimate(samples, factor) {
  const n = Math.floor(samples.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += samples[i * factor + k];
    out[i] = s / factor;
  }
  return out;
}

const SR0 = 44100;
for (const id of ['Martin M1', 'Robot 36', 'PD90']) {
  const m = SSTV.modeById(id);
  const src = refRGB(m.width, m.height);
  const t0 = Date.now();
  const audio = SSTV.encodeImage(m, src, SR0);
  const encMs = Date.now() - t0;

  for (const factor of [1, 2, 4]) {
    const sr = SR0 / factor;
    const s = factor === 1 ? audio : decimate(audio, factor);
    const t1 = Date.now();
    const dec = SSTV.decodeSamples(s, sr);
    const decMs = Date.now() - t1;
    console.log(
      id.padEnd(10),
      'sr=' + String(sr).padStart(5),
      'PSNR=' + psnr(src, dec.image).toFixed(2).padStart(6) + 'dB',
      'dec=' + String(decMs).padStart(6) + 'ms',
      'lines=' + dec.info.lines,
      '(enc=' + encMs + 'ms)'
    );
  }
  console.log('');
}
