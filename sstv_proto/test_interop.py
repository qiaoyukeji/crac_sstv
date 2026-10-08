"""Phase 1 validation: round-trip every v1 mode and cross-check against pySSTV.

Usage:
    python test_interop.py
Prints PSNR per mode. Decoded images saved to ./output/ for visual inspection.
"""

import os
import numpy as np
from PIL import Image

from sstv_modes import V1_MODES, mode_by_id
from encode import encode_image
from decode import decode_samples
from color import image_to_arrays

OUT = os.path.join(os.path.dirname(__file__), "output")
os.makedirs(OUT, exist_ok=True)
SR = 44100


def make_test_image(w=320, h=256):
    xs = np.linspace(0, 255, w, dtype=np.uint8)
    ys = np.linspace(0, 255, h, dtype=np.uint8)
    gx = np.tile(xs, (h, 1))
    gy = np.tile(ys[:, None], (1, w))
    r = gx
    g = gy
    b = ((gx.astype(int) + gy.astype(int)) // 2).astype(np.uint8)
    # coloured blocks
    img = np.stack([r, g, b], axis=-1)
    img[20:80, 20:80] = [255, 0, 0]
    img[20:80, 100:160] = [0, 255, 0]
    img[20:80, 180:240] = [0, 0, 255]
    img[120:200, 60:260] = [255, 255, 0]
    return Image.fromarray(img.astype(np.uint8), "RGB")


def psnr(a, b):
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    mse = np.mean((a - b) ** 2)
    if mse == 0:
        return 99.0
    return 10.0 * np.log10(255.0 ** 2 / mse)


def roundtrip(mode, img):
    samples = encode_image(mode, img, SR)
    dec, info = decode_samples(samples, SR, mode_hint=mode)
    out = Image.fromarray(dec, "RGB")
    out.save(os.path.join(OUT, f"rt_{mode.id.replace(' ', '')}.png"))
    # compare to original resampled to mode size
    orig, _ = image_to_arrays(img, mode.width, mode.height)
    return psnr(orig, dec), info, len(samples)


def main():
    img = make_test_image()
    img.save(os.path.join(OUT, "original.png"))
    print(f"{'mode':12s} {'PSNR(dB)':>9s}   lines   samples")
    print("-" * 40)
    for mode in V1_MODES:
        p, info, ns = roundtrip(mode, img)
        print(f"{mode.id:12s} {p:9.2f}   {info['lines']:4d}   {ns}")

    # ---- cross-check against pySSTV (modes whose output we can decode) ----
    try:
        from pysstv.color import MartinM1, Robot36, PD90 as PD90py
        from pysstv.sstv import SSTV
        print("\n-- pySSTV encode -> our decode --")
        cross = [("Martin M1", MartinM1), ("Robot 36", Robot36), ("PD90", PD90py)]
        for name, cls in cross:
            mymode = mode_by_id(name)
            enc = cls(img, SR, 16)
            samples = np.fromiter(enc.gen_values(), dtype=np.float32, count=-1)
            dec, info = decode_samples(samples, SR, mode_hint=mymode)
            out = Image.fromarray(dec, "RGB")
            out.save(os.path.join(OUT, f"pysstv_{name.replace(' ', '')}.png"))
            orig, _ = image_to_arrays(img, mymode.width, mymode.height)
            print(f"{name:12s} {psnr(orig, dec):9.2f}   (VIS detected={info['vis']})")
    except ImportError:
        print("\npySSTV not available - skipped cross-check.")


if __name__ == "__main__":
    main()
