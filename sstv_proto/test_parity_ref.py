"""Parity baseline: build the SAME procedural reference image the Swift XCTest
uses, run it through the validated Python oracle (encode -> decode), and print the
round-trip PSNR. These numbers become the 'oracle' baselines the Swift test
asserts parity against.

The image formula is mirrored byte-for-byte in SSTVEngineTests.makeRefImage.
"""

import numpy as np
from PIL import Image

from encode import encode_image
from decode import decode_samples
from sstv_modes import MARTIN_M1, PD90


def make_ref(w, h):
    rgb = np.zeros((h, w, 3), dtype=np.float64)
    for y in range(h):
        for x in range(w):
            rgb[y, x, 0] = round(min(255, max(0, x * 255 / (w - 1))))
            rgb[y, x, 1] = round(min(255, max(0, y * 255 / (h - 1))))
            rgb[y, x, 2] = round(min(255, max(0, (x + y) * 255 / ((w - 1) + (h - 1)))))
    return rgb.astype(np.uint8)


def psnr(a, b):
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    mse = ((a - b) ** 2).mean()
    if mse <= 0:
        return 100.0
    return 10.0 * np.log10(255.0 * 255.0 / mse)


def run(mode, name, sr=44100):
    w, h = mode.width, mode.height
    rgb = make_ref(w, h)
    img = Image.fromarray(rgb, "RGB")
    samples = encode_image(mode, img, sr)
    dec, info = decode_samples(samples, sr, mode_hint=mode)
    p = psnr(rgb, dec)
    print(f"{name:10s} W={w} H={h} samples={len(samples)} psnr={p:.2f} dB lines={info['lines']}")


if __name__ == "__main__":
    run(MARTIN_M1, "Martin M1")
    run(PD90, "PD90")
