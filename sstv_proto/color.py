"""Color-space handling.

Two pipelines, matching the de-facto `pySSTV` reference exactly:

* RGB SSTV modes (Martin / Scottie): the encoder emits the raw 0-255 RGB bytes
  directly (`image.convert('RGB')`), so the decoder recovers raw RGB bytes.
* YUV SSTV modes (Robot36, PD family): pySSTV does `image.convert('YCbCr')` and
  emits those YCbCr *bytes* (Y in 16-235, Cb/Cr in 16-240) through `byte_to_freq`.
  We therefore (a) encode those same PIL YCbCr bytes and (b) on decode recover
  the YCbCr bytes and convert back with PIL (`YCbCr` -> `RGB`). Using PIL's
  conversion on both ends guarantees we are bit-for-bit compatible with pySSTV.

Frequency mapping is handled separately by `freq_of_value`/`value_of_freq`, which
mirror pySSTV's `byte_to_freq` (1500 + byte/255*800).
"""

import numpy as np
from PIL import Image


def image_to_arrays(img: Image.Image, width: int, height: int):
    """Return (rgb HxWx3 uint8, yuv HxWx3 float64 of PIL-YCbCr bytes).

    Both are resampled to the mode size with bilinear interpolation, matching the
    way SSTV tools resample before transmission.
    """
    im = img.convert("RGB").resize((width, height), Image.BILINEAR)
    rgb = np.asarray(im, dtype=np.uint8)
    yuv = np.asarray(im.convert("YCbCr"), dtype=np.float64)
    return rgb, yuv


def yuv_bytes_to_rgb(yuv: np.ndarray) -> np.ndarray:
    """yuv: HxWx3 (Y, Cb, Cr) bytes in 0-255 -> RGB uint8, via PIL conversion."""
    arr = np.clip(np.round(yuv), 0, 255).astype(np.uint8)
    return np.asarray(Image.fromarray(arr, "YCbCr").convert("RGB"))
