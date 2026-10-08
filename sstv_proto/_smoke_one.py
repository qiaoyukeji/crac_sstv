import time, numpy as np
from PIL import Image
import encode, decode, color, sstv_modes

t = time.time()
img = Image.fromarray(np.random.randint(0, 256, (64, 80, 3), dtype=np.uint8))
print("img made", time.time() - t, flush=True)

mode = sstv_modes.MARTIN_M1
t = time.time()
s = encode.encode_image(mode, img, 2000)
print("encoded len", len(s), time.time() - t, flush=True)

t = time.time()
d, info = decode.decode_samples(s, 2000, mode_hint=mode)
print("decoded", info, time.time() - t, flush=True)
print("DONE", flush=True)
