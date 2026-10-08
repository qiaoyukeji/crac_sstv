"""SSTV decoder: mono float32 audio samples -> RGB image (validation oracle)."""

import numpy as np

from sstv_modes import Mode, Ch, SYNC_HZ, value_of_freq, mode_by_vis
from dsp import estimate_frequency
from vis import decode_vis
from color import yuv_bytes_to_rgb


def _find_runs(mask: np.ndarray, min_len: int):
    runs = []
    i, n = 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j < n and mask[j]:
                j += 1
            if j - i >= min_len:
                runs.append((i, j))
            i = j
        else:
            i += 1
    return runs


def _vis_end(freq: np.ndarray, sr: int) -> int:
    """Return the sample index just *after* the full VIS header, i.e. the start
    of the first scan-line horizontal sync.

    Layout after the first leader: break(10ms) + 2nd leader(300ms) + start bit(30ms)
    + 7 data bits(210ms) + parity(30ms) + stop(30ms) = 610 ms beyond the leader end.
    """
    near1900 = np.abs(freq - 1900.0) < 150
    runs = _find_runs(near1900, int(0.25 * sr))
    if runs:
        leader_end = runs[0][1]
        start_bit_pos = leader_end + int((0.010 + 0.300) * sr)
        cell = int(0.030 * sr)
        return start_bit_pos + 10 * cell
    return int(0.95 * sr)


def _find_sync(freq: np.ndarray, lo: int, hi: int, sr: int, sync_dur: float):
    lo = max(0, lo)
    hi = min(len(freq), hi)
    near = np.abs(freq[lo:hi] - SYNC_HZ) < 120
    min_len = int(0.6 * sync_dur * sr)
    runs = _find_runs(near, min_len)
    if not runs:
        return None
    best = max(runs, key=lambda r: r[1] - r[0])
    return lo + best[0]


def _read_px(freq: np.ndarray, pos: int, npx: int, dur: float, sr: int):
    tot = int(round(dur * sr))
    out = np.zeros(npx, dtype=np.float64)
    for p in range(npx):
        a = pos + int(round(p * tot / npx))
        b = pos + int(round((p + 1) * tot / npx))
        if b <= a:
            b = a + 1
        seg = freq[a:b]
        if len(seg) == 0:
            out[p] = 0.0
        else:
            out[p] = value_of_freq(float(np.median(seg)))
    return out, pos + tot


def decode_samples(samples: np.ndarray, sr: int = 44100, mode_hint: Mode = None):
    freq = estimate_frequency(np.asarray(samples, dtype=np.float32), sr)

    vis = None
    if mode_hint is None:
        vis, _ = decode_vis(freq, sr)
        mode = mode_by_vis(vis) if vis is not None else None
        if mode is None:
            raise ValueError("Could not detect VIS / unknown mode")
    else:
        mode = mode_hint

    search_start = _vis_end(freq, sr)
    step = int(mode.line_duration(0) * sr)
    n_lines = mode.height // 2 if mode.kind == "pd" else mode.height

    sync_starts = []
    pos = search_start
    for _ in range(n_lines):
        s = _find_sync(freq, int(pos - 0.15 * step), int(pos + 0.5 * step), sr, mode.sync_dur_s)
        if s is None:
            break
        sync_starts.append(s)
        pos = s + step

    # collect per-line channel arrays
    rgb = np.zeros((mode.height, mode.width, 3), dtype=np.float64)
    ycbcr = np.zeros((mode.height, mode.width, 3), dtype=np.float64)

    for idx, s in enumerate(sync_starts):
        line_index = (2 * idx) if mode.kind == "pd" else idx
        r = mode.line(line_index)
        if r is None:
            continue
        _, segs, consumed = r
        pos = s + int(round(mode.sync_dur_s * sr))
        px_idx = 0
        for seg in segs:
            if seg[0] == "tone":
                pos += int(round(seg[2] * sr))
            else:
                _, ch, npx, dur = seg
                vals, pos = _read_px(freq, pos, npx, dur, sr)
                if mode.kind == "rgb":
                    cidx = {"R": 0, "G": 1, "B": 2}[ch.value]
                    rgb[line_index, :, cidx] = vals
                elif mode.kind == "robot":
                    if ch == Ch.Y:
                        ycbcr[line_index, :, 0] = vals
                    elif ch == Ch.CR:
                        ycbcr[line_index, :, 2] = vals
                    elif ch == Ch.CB:
                        ycbcr[line_index, :, 1] = vals
                elif mode.kind == "pd":
                    if ch == Ch.Y:
                        # First Y segment -> this line; second Y segment -> next line.
                        target = line_index if (px_idx % 2 == 0) else line_index + 1
                        ycbcr[target, :, 0] = vals
                    elif ch == Ch.CB:
                        ycbcr[line_index, :, 1] = vals
                        ycbcr[line_index + 1, :, 1] = vals
                    elif ch == Ch.CR:
                        ycbcr[line_index, :, 2] = vals
                        ycbcr[line_index + 1, :, 2] = vals
                px_idx += 1

    if mode.kind != "rgb":
        # fill missing chroma from neighbours (interlace / pair)
        h = mode.height
        for i in range(h):
            if i % 2 == 0 and np.all(ycbcr[i, :, 1] == 0):
                nb = ycbcr[i + 1, :, 1] if i + 1 < h else ycbcr[i - 1, :, 1]
                ycbcr[i, :, 1] = nb
            if i % 2 == 1 and np.all(ycbcr[i, :, 2] == 0):
                nb = ycbcr[i - 1, :, 2] if i - 1 >= 0 else ycbcr[i + 1, :, 2]
                ycbcr[i, :, 2] = nb
        rgb = yuv_bytes_to_rgb(ycbcr)

    img = np.clip(np.round(rgb), 0, 255).astype(np.uint8)
    return img, {"vis": vis, "mode": mode.id, "lines": len(sync_starts)}
