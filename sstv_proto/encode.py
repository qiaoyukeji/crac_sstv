"""SSTV encoder: image -> mono float32 audio samples (the validation oracle)."""

import numpy as np
from PIL import Image

from sstv_modes import Mode, Ch, SYNC_HZ, freq_of_value
from dsp import synth_tones
from vis import vis_segments
from color import image_to_arrays


def _channel_array(mode: Mode, rgb, ycbcr, line_index, seg, seg_idx):
    ch = seg[1]
    if mode.kind == "rgb":
        idx = {"R": 0, "G": 1, "B": 2}[ch.value]
        return rgb[line_index, :, idx].astype(np.float64)
    if mode.kind == "robot":
        if ch == Ch.Y:
            return ycbcr[line_index, :, 0]
        if ch == Ch.CR:
            return ycbcr[line_index, :, 2]
        if ch == Ch.CB:
            return ycbcr[line_index, :, 1]
    if mode.kind == "pd":
        if ch == Ch.Y:
            li = line_index if seg_idx == 1 else line_index + 1
            return ycbcr[li, :, 0]
        if ch == Ch.CB:
            return (ycbcr[line_index, :, 1] + ycbcr[line_index + 1, :, 1]) / 2.0
        if ch == Ch.CR:
            return (ycbcr[line_index, :, 2] + ycbcr[line_index + 1, :, 2]) / 2.0
    raise ValueError(f"cannot map channel {ch} for kind {mode.kind}")


def encode_image(mode: Mode, image: Image.Image, sr: int = 44100) -> np.ndarray:
    rgb, ycbcr = image_to_arrays(image, mode.width, mode.height)

    segs = [(f, m / 1000.0) for f, m in vis_segments(mode.vis)]
    for line_index in range(mode.height):
        r = mode.line(line_index)
        if r is None:
            continue
        sync_dur, line_segs, consumed = r
        segs.append((SYNC_HZ, sync_dur))
        for seg_idx, seg in enumerate(line_segs):
            if seg[0] == "tone":
                segs.append((seg[1], seg[2]))
            else:  # ('px', Ch, npx, dur_seconds)
                _, ch, npx, dur = seg
                vals = _channel_array(mode, rgb, ycbcr, line_index, seg, seg_idx)
                vals = np.clip(vals, 0, 255)
                # Tile exactly `tot` samples across `npx` pixels using cumulative
                # rounding so the decoder (which uses the SAME boundaries) aligns.
                tot = int(round(dur * sr))
                for p in range(npx):
                    a = int(round(p * tot / npx))
                    b = int(round((p + 1) * tot / npx))
                    segs.append((freq_of_value(float(vals[p])), (b - a) / sr))
    return synth_tones(segs, sr)
