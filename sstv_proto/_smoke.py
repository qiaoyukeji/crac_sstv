import sys, time
print("start import", flush=True)
import numpy as np
from PIL import Image
print("imports ok", flush=True)
import sstv_modes, dsp, vis, color, encode, decode
print("module import ok", flush=True)

def psnr(a, b):
    a = a.astype(float); b = b.astype(float)
    mse = np.mean((a - b) ** 2)
    return 99.0 if mse == 0 else 10 * np.log10(255 ** 2 / mse)

img = Image.fromarray(np.random.randint(0, 256, (256, 320, 3), dtype=np.uint8))
for mode in sstv_modes.V1_MODES:
    t = time.time()
    s = encode.encode_image(mode, img, 8000)
    print(f"encoded {mode.id} len={len(s)}", flush=True)
    d, info = decode.decode_samples(s, 8000, mode_hint=mode)
    orig, _ = color.image_to_arrays(img, mode.width, mode.height)
    print(f"{mode.id:11s} PSNR={psnr(orig, d):6.2f} lines={info['lines']:3d} {time.time()-t:5.1f}s", flush=True)
print("DONE", flush=True)
