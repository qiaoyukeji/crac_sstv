import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sstv_proto"))
import numpy as np
from PIL import Image
from sstv_modes import mode_by_id
from encode import encode_image
from decode import decode_samples

def make_image(w, h):
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    yy, xx = np.mgrid[0:h, 0:w]
    fx = xx / (w - 1); fy = yy / (h - 1)
    rgb[..., 0] = (255 * (0.5 + 0.45 * np.sin(fx * np.pi * 2))).astype(np.uint8)
    rgb[..., 1] = (255 * (0.5 + 0.45 * np.sin(fy * np.pi * 2))).astype(np.uint8)
    rgb[..., 2] = (255 * (0.5 + 0.45 * np.sin((fx + fy) * np.pi * 2))).astype(np.uint8)
    return Image.fromarray(rgb, "RGB")

def psnr(a, b):
    mse = np.mean((a.astype(float) - b.astype(float)) ** 2)
    return 10 * np.log10(255 * 255 / mse)

sr = 44100
for mid in ["Martin M1", "Martin M2", "Scottie S1", "Scottie S2", "Robot 36", "PD90"]:
    m = mode_by_id(mid)
    img = make_image(m.width, m.height)
    samples = encode_image(m, img, sr)
    dec, info = decode_samples(samples, sr, m)
    p = psnr(np.asarray(img), dec)
    print(f"{mid:11s} py-oracle self round-trip PSNR = {p:6.2f} dB  (samples={len(samples)})")
