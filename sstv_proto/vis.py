"""VIS header generation and decoding (authoritative pySSTV 0.5.9 format).

Header layout (freq, ms):
  1900 x300  (leader)
  1200 x10   (break)
  1900 x300  (leader 2)
  1200 x30   (start bit)
  7 data bits, LSB-first: bit==1 -> 1100 Hz, bit==0 -> 1300 Hz, each 30 ms
  parity bit: even parity, 1 -> 1100, 0 -> 1300, 30 ms
  1200 x30   (stop bit)
"""

import numpy as np
from dsp import synth_tones

FREQ_LEADER = 1900.0
FREQ_START = 1200.0
FREQ_BIT1 = 1100.0
FREQ_BIT0 = 1300.0
FREQ_SYNC = 1200.0

MSEC_LEADER = 300
MSEC_BREAK = 10
MSEC_BIT = 30


def vis_segments(vis_code: int):
    """Return list of (freq, ms) describing the full VIS header."""
    segs = [
        (FREQ_LEADER, MSEC_LEADER),
        (FREQ_START, MSEC_BREAK),
        (FREQ_LEADER, MSEC_LEADER),
        (FREQ_SYNC, MSEC_BIT),            # start bit
    ]
    v = vis_code & 0x7F
    num_ones = 0
    for _ in range(7):
        bit = v & 1
        num_ones += bit
        segs.append((FREQ_BIT1 if bit else FREQ_BIT0, MSEC_BIT))
        v >>= 1
    parity = 1 if (num_ones % 2 == 1) else 0
    segs.append((FREQ_BIT1 if parity else FREQ_BIT0, MSEC_BIT))
    segs.append((FREQ_SYNC, MSEC_BIT))   # stop bit
    return segs


def vis_samples(vis_code: int, sr: int) -> np.ndarray:
    segs = [(f, m / 1000.0) for f, m in vis_segments(vis_code)]
    return synth_tones(segs, sr)


def decode_vis(freq: np.ndarray, sr: int):
    """Detect and decode the VIS header from an instantaneous-frequency array.

    Returns (vis_code, bits_list) or (None, None) if not found.
    """
    ms = 0.001 * sr
    near1900 = np.abs(freq - FREQ_LEADER) < 150
    # find first sustained ~300 ms 1900 Hz run
    runs = _runs(near1900)
    if not runs:
        return None, None
    leader_end = runs[0][1]
    # skip break (10ms) + second leader (300ms) to reach start bit
    start_bit_pos = leader_end + int((MSEC_BREAK + MSEC_LEADER) / 1000.0 * sr)
    cell = int(MSEC_BIT / 1000.0 * sr)
    end = start_bit_pos + 10 * cell
    if end > len(freq):
        return None, None
    cells = [float(np.median(freq[start_bit_pos + k * cell:
                                    start_bit_pos + (k + 1) * cell]))
             for k in range(10)]
    bits = []
    for k in range(1, 8):  # data bits 1..7 (LSB-first order)
        bits.append(1 if abs(cells[k] - FREQ_BIT1) < abs(cells[k] - FREQ_BIT0) else 0)
    vis = 0
    for k in range(7):
        if bits[k]:
            vis |= (1 << k)
    return vis, bits


def _runs(mask: np.ndarray):
    """Return list of (start, stop) index ranges where mask is True, length>=250ms*?? .
    Here we just return runs of length >= 200 ms."""
    runs = []
    i = 0
    n = len(mask)
    min_len = int(0.2 * 44100)  # ~200 ms in samples (sr-independent caller sets this loosely)
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
