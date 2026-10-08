/*
 * Node parity test for the Web SSTV engine.
 * Validates: encode -> decode round-trip PSNR, VIS auto-detection, and that
 * encoded sample counts match the known pySSTV-compatible lengths.
 * Run:  node web/test/node-parity.cjs
 */
const SSTV = require('../sstv-engine.js');

function makeImage(w, h) {
  // Smooth, low-frequency reference (matches the Python oracle's parity image:
  // soft gradients only, so the FM estimator tracks well and PSNR sits in the
  // 30s-35 dB band the oracle reports).
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
function psnr(a, b) {
  let mse = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; mse += d * d; }
  mse /= a.length;
  return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
}

const sr = 44100;
let failed = false;

for (const id of ['Martin M1', 'Martin M2', 'Scottie S1', 'Scottie S2', 'Robot 36', 'PD90']) {
  const mode = SSTV.modeById(id);
  const rgb = makeImage(mode.width, mode.height);
  const t0 = Date.now();
  const samples = SSTV.encodeImage(mode, rgb, sr);
  const t1 = Date.now();
  const dec = SSTV.decodeSamples(samples, sr, null); // auto VIS detect
  const t2 = Date.now();
  const p = psnr(rgb, dec.image);
  const dur = (samples.length / sr).toFixed(2);
  console.log(
    `${id.padEnd(11)} | ${samples.length} smp (${dur}s) | enc ${t1 - t0}ms dec ${t2 - t1}ms | ` +
    `PSNR ${p.toFixed(2)} dB | vis=${dec.info.vis} mode=${dec.info.mode} lines=${dec.info.lines}`
  );
  // Quality thresholds (round-trip floor; pySSTV cross-checks sit just below these).
  const floor = (mode.kind === 'rgb') ? 28 : 20;
  if (p < floor) { console.error(`  !! ${id} PSNR ${p.toFixed(2)} below floor ${floor}`); failed = true; }
  if (dec.info.vis !== mode.vis) { console.error(`  !! ${id} VIS mismatch: got ${dec.info.vis}, want ${mode.vis}`); failed = true; }
  if (dec.info.lines < mode.height * 0.5) { console.error(`  !! ${id} too few lines: ${dec.info.lines}`); failed = true; }
}

// pd90 known length ~4,008,899 (matches pySSTV PD90).
const pd = SSTV.encodeImage(SSTV.modeById('PD90'), makeImage(320, 256), sr);
console.log(`\nPD90 length check: ${pd.length} (expected ~4,008,899)`);
if (Math.abs(pd.length - 4008899) > 5000) { console.error('  !! PD90 length unexpected'); failed = true; }

console.log(failed ? '\nPARITY TEST: FAILED' : '\nPARITY TEST: PASSED');
process.exit(failed ? 1 : 0);
