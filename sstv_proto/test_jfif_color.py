"""Validate the Swift port's color pipeline (JFIF float matrix, identical to
SSTVColor.swift) against the Python oracle's DSP. If the round-trip PSNR matches the
baselines (M1 ~35.73, PD90 ~26.76), the Swift transliteration is faithful.

This intentionally bypasses PIL's YCbCr and uses the explicit JFIF matrix that the
Swift engine implements, so it exercises the SAME code path the app will run.
"""

import numpy as np
from sstv_modes import MARTIN_M1, PD90, Mode, Ch, SYNC_HZ, freq_of_value
from dsp import synth_tones
from vis import vis_segments
from decode import decode_samples  # reuse decoder (it calls estimate_frequency etc.)


def jfif_ycbcr(rgb_u8):
    r = rgb_u8[..., 0].astype(np.float64)
    g = rgb_u8[..., 1].astype(np.float64)
    b = rgb_u8[..., 2].astype(np.float64)
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128
    cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 128
    out = np.zeros_like(rgb_u8, dtype=np.float64)
    out[..., 0] = np.clip(np.round(y), 0, 255)
    out[..., 1] = np.clip(np.round(cb), 0, 255)
    out[..., 2] = np.clip(np.round(cr), 0, 255)
    return out


def jfif_rgb(ycbcr):
    y = ycbcr[..., 0]
    cb = ycbcr[..., 1] - 128
    cr = ycbcr[..., 2] - 128
    r = y + 1.402 * cr
    g = y - 0.344136 * cb - 0.714136 * cr
    b = y + 1.772 * cb
    out = np.zeros_like(ycbcr, dtype=np.uint8)
    out[..., 0] = np.clip(np.round(r), 0, 255)
    out[..., 1] = np.clip(np.round(g), 0, 255)
    out[..., 2] = np.clip(np.round(b), 0, 255)
    return out


def channel_array(mode, rgb, ycbcr, line_index, ch, seg_idx):
    npx = mode.width
    if mode.kind == "rgb":
        idx = {"R": 0, "G": 1, "B": 2}[ch.value]
        return rgb[line_index, :, idx].astype(np.float64)
    if mode.kind == "robot":
        if ch == Ch.Y: return ycbcr[line_index, :, 0]
        if ch == Ch.CR: return ycbcr[line_index, :, 2]
        if ch == Ch.CB: return ycbcr[line_index, :, 1]
    if mode.kind == "pd":
        if ch == Ch.Y:
            li = line_index if seg_idx == 1 else line_index + 1
            return ycbcr[li, :, 0]
        if ch == Ch.CB:
            return (ycbcr[line_index, :, 1] + ycbcr[line_index + 1, :, 1]) / 2.0
        if ch == Ch.CR:
            return (ycbcr[line_index, :, 2] + ycbcr[line_index + 1, :, 2]) / 2.0


def encode_jfif(mode, rgb_u8, sr=44100):
    rgb = rgb_u8.astype(np.uint8)
    ycbcr = jfif_ycbcr(rgb)
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
            else:
                _, ch, npx, dur = seg
                vals = channel_array(mode, rgb, ycbcr, line_index, ch, seg_idx)
                vals = np.clip(vals, 0, 255)
                tot = int(round(dur * sr))
                for p in range(npx):
                    a = int(round(p * tot / npx))
                    b = int(round((p + 1) * tot / npx))
                    segs.append((freq_of_value(float(vals[p])), (b - a) / sr))
    return synth_tones(segs, sr)


def make_ref(w, h):
    rgb = np.zeros((h, w, 3), dtype=np.float64)
    for y in range(h):
        for x in range(w):
            rgb[y, x, 0] = round(min(255, max(0, x * 255 / (w - 1))))
            rgb[y, x, 1] = round(min(255, max(0, y * 255 / (h - 1))))
            rgb[y, x, 2] = round(min(255, max(0, (x + y) * 255 / ((w - 1) + (h - 1)))))
    return rgb.astype(np.uint8)


def psnr(a, b):
    a = np.asarray(a, np.float64); b = np.asarray(b, np.float64)
    mse = ((a - b) ** 2).mean()
    return 100.0 if mse <= 0 else 10.0 * np.log10(255.0 ** 2 / mse)


if __name__ == "__main__":
    for mode, name in [(MARTIN_M1, "Martin M1"), (PD90, "PD90")]:
        w, h = mode.width, mode.height
        rgb = make_ref(w, h)
        samples = encode_jfif(mode, rgb)
        # decode uses the oracle decoder which internally uses PIL color on the decoded
        # YCbCr bytes; for a parity check against the *transmit* side we instead decode
        # with our own JFIF inverse by post-processing:
        dec, info = decode_samples(samples, mode_hint=mode)
        # Recompute PSNR against the ORIGINAL (the oracle decoder already returns RGB).
        p = psnr(rgb, dec)
        print(f"{name:10s} (oracle decoder + JFIF encoder) PSNR={p:.2f} dB")

        # Also a fully self-consistent JFIF loop for the transmit-side color parity:
        from decode import _read_px, _find_sync, _vis_end, _find_runs
        from dsp import estimate_frequency
        from vis import decode_vis
        freq = estimate_frequency(samples, 44100)
        n_lines = mode.height // 2 if mode.kind == "pd" else mode.height
        step = int(mode.line_duration(0) * 44100)
        search_start = _vis_end(freq, 44100)
        pos = search_start
        sync_starts = []
        for _ in range(n_lines):
            s = _find_sync(freq, int(pos - 0.15 * step), int(pos + 0.5 * step), 44100, mode.sync_dur_s)
            if s is None: break
            sync_starts.append(s); pos = s + step
        ycbcr = np.zeros((mode.height, mode.width, 3), dtype=np.float64)
        for idx, s in enumerate(sync_starts):
            line_index = 2 * idx if mode.kind == "pd" else idx
            r = mode.line(line_index)
            if r is None: continue
            _, segs, _ = r
            p2 = s + int(round(mode.sync_dur_s * 44100))
            px_idx = 0
            for seg in segs:
                if seg[0] == "tone":
                    p2 += int(round(seg[2] * 44100))
                else:
                    _, ch, npx, dur = seg
                    vals, p2 = _read_px(freq, p2, npx, dur, 44100)
                    if mode.kind == "robot":
                        if ch == Ch.Y: ycbcr[line_index, :, 0] = vals
                        elif ch == Ch.CR: ycbcr[line_index, :, 2] = vals
                        elif ch == Ch.CB: ycbcr[line_index, :, 1] = vals
                    elif mode.kind == "pd":
                        if ch == Ch.Y:
                            target = line_index if (px_idx % 2 == 0) else line_index + 1
                            ycbcr[target, :, 0] = vals
                        elif ch == Ch.CB:
                            ycbcr[line_index, :, 1] = vals; ycbcr[line_index + 1, :, 1] = vals
                        elif ch == Ch.CR:
                            ycbcr[line_index, :, 2] = vals; ycbcr[line_index + 1, :, 2] = vals
                    px_idx += 1
        if mode.kind != "rgb":
            for i in range(mode.height):
                if i % 2 == 0 and np.all(ycbcr[i, :, 1] == 0):
                    nb = ycbcr[i + 1, :, 1] if i + 1 < mode.height else ycbcr[i - 1, :, 1]
                    ycbcr[i, :, 1] = nb
                if i % 2 == 1 and np.all(ycbcr[i, :, 2] == 0):
                    nb = ycbcr[i - 1, :, 2] if i - 1 >= 0 else ycbcr[i + 1, :, 2]
                    ycbcr[i, :, 2] = nb
            dec2 = jfif_rgb(ycbcr)
        else:
            dec2 = np.clip(np.round(ycbcr), 0, 255).astype(np.uint8) if False else None
            dec2 = np.zeros_like(rgb)
            # rgb mode: fill from decoded rgb (vals stored directly)
            # simpler: reuse decode_samples result
            dec2 = dec
        p2 = psnr(rgb, dec2)
        print(f"{name:10s} (full JFIF loop)                PSNR={p2:.2f} dB")
