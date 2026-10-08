"""Fast sanity check for the ms/seconds fix and round-trip correctness.

Uses a tiny custom RGB mode so it finishes in milliseconds, plus a sample-count
check on a real mode (Martin M1) to confirm we are no longer 1000x too large.
"""

import numpy as np
from PIL import Image

from sstv_modes import Mode, MARTIN_M1
from encode import encode_image
from decode import decode_samples


def psnr(a, b):
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    mse = np.mean((a - b) ** 2)
    if mse == 0:
        return 99.0
    return 10.0 * np.log10(255.0 ** 2 / mse)


def main():
    # 1) tiny custom mode round-trip
    tiny = Mode("Tiny", 44, 32, 16, "rgb", sync_dur=2.0, porch=1.0, scan=4.0)
    img = Image.new("RGB", (32, 16), (128, 64, 200))
    samples = encode_image(tiny, img, 8000)
    expected = int(tiny.frame_duration * 8000)
    print(f"[tiny] samples={len(samples)} expected~{expected} "
          f"({ 'OK' if abs(len(samples)-expected) < expected*0.05 else 'MISMATCH' })")
    dec, info = decode_samples(samples, 8000, mode_hint=tiny)
    print(f"[tiny] decoded shape={dec.shape} lines={info['lines']} "
          f"mean_rgb={dec.reshape(-1,3).mean(0).round(1)}")

    # 2) real-mode sample-count sanity (no full decode, just length)
    s = encode_image(MARTIN_M1, Image.new("RGB", (320, 256), (10, 20, 30)), 2000)
    expected_m1 = int(MARTIN_M1.frame_duration * 2000)
    ratio = len(s) / max(1, expected_m1)
    print(f"[M1@2k] samples={len(s)} expected~{expected_m1} ratio={ratio:.3f} "
          f"({ 'OK' if 0.95 < ratio < 1.05 else 'BAD' })")

    # 3) full Martin M1 round-trip at 8 kHz for a real PSNR number
    test = Image.fromarray(
        np.stack([
            np.tile(np.linspace(0, 255, 320, dtype=np.uint8), (256, 1)),
            np.tile(np.linspace(0, 255, 256, dtype=np.uint8)[:, None], (1, 320)),
            np.full((256, 320), 128, dtype=np.uint8),
        ], axis=-1).astype(np.uint8), "RGB")
    samples = encode_image(MARTIN_M1, test, 8000)
    dec, info = decode_samples(samples, 8000, mode_hint=MARTIN_M1)
    p = psnr(np.asarray(test), dec)
    print(f"[M1 rt@8k] samples={len(samples)} PSNR={p:.2f} dB lines={info['lines']}")


if __name__ == "__main__":
    main()
