"""
SSTV mode table + line-structure model (authoritative reference: pySSTV 0.5.9).

Each mode emits, per scan line, a sequence of *segments*:
    ('tone', freq_hz, dur_sec)          -> fixed marker tone (porch / chroma id / etc.)
    ('px',   Ch,    npx,    dur_sec)    -> npx pixel tones (freq = 1500 + value/255*800)

A line begins with a 1200 Hz horizontal sync pulse of `sync_dur` seconds.

IMPORTANT: the pySSTV constants (sync_dur, porch, scan, ...) are natively expressed
in MILLISECONDS. To avoid the classic ms/seconds unit bug, `Mode.line()` converts
them to SECONDS before returning, so every consumer (encode, decode) works purely
in seconds.

Calibration:
    freq(v) = 1500 + (v/255) * (2300 - 1500) = 1500 + v/255 * 800
    v(f)    = clamp((f - 1500) / 800 * 255, 0, 255)

VIS (per pySSTV): 1900 Hz x300ms, 1200 Hz x10ms, 1900 Hz x300ms,
    1200 Hz x30ms (start), 7 data bits LSB-first (1=1100 Hz, 0=1300 Hz) x30ms each,
    even-parity bit x30ms, 1200 Hz x30ms (stop).
"""

from enum import Enum
from typing import List, Tuple, Optional

SYNC_HZ = 1200.0
BLACK_HZ = 1500.0
WHITE_HZ = 2300.0

_MS = 1.0 / 1000.0


class Ch(Enum):
    R = "R"
    G = "G"
    B = "B"
    Y = "Y"
    CB = "CB"
    CR = "CR"


def freq_of_value(v: float) -> float:
    return BLACK_HZ + (v / 255.0) * (WHITE_HZ - BLACK_HZ)


def value_of_freq(f: float) -> int:
    return int(round(min(255, max(0, (f - BLACK_HZ) / (WHITE_HZ - BLACK_HZ) * 255))))


class Mode:
    """SSTV mode description.

    `line(line_index)` returns either None (this line is not independently
    emitted, e.g. odd line of a PD pair) or a tuple
    (sync_dur_sec, segments, lines_consumed).

    All durations returned are in SECONDS.
    """

    def __init__(self, id: str, vis: int, width: int, height: int, kind: str,
                 sync_dur: float, **params):
        self.id = id
        self.vis = vis
        self.width = width
        self.height = height
        self.kind = kind                # 'rgb' | 'robot' | 'pd'
        self.sync_dur = sync_dur        # milliseconds (pySSTV native unit)
        self.p = params

    @property
    def sync_dur_s(self) -> float:
        """Horizontal sync duration in seconds (raw sync_dur is milliseconds)."""
        return self.sync_dur * _MS

    def line(self, line_index: int):
        if self.kind == "rgb":
            porch = self.p["porch"] * _MS
            scan = self.p["scan"] * _MS
            npx = self.width
            segs = [
                ("tone", BLACK_HZ, porch),
                ("px", Ch.G, npx, scan),
                ("tone", BLACK_HZ, porch),
                ("px", Ch.B, npx, scan),
                ("tone", BLACK_HZ, porch),
                ("px", Ch.R, npx, scan),
                ("tone", BLACK_HZ, porch),
            ]
            return self.sync_dur_s, segs, 1

        if self.kind == "robot":
            porch = self.p["porch"] * _MS           # SYNC_PORCH (3 ms)
            y_scan = self.p["y_scan"] * _MS         # 88 ms
            c_scan = self.p["c_scan"] * _MS         # 44 ms
            chroma = Ch.CR if (line_index % 2 == 0) else Ch.CB
            # Match pySSTV/Robot36 convention: even line carries Cr (id tone 2300 Hz),
            # odd line carries Cb (id tone 1500 Hz).
            idtone = 2300.0 if (line_index % 2 == 0) else 1500.0
            segs = [
                ("tone", BLACK_HZ, porch),
                ("px", Ch.Y, self.width, y_scan),
                ("tone", idtone, 4.5 * _MS),
                ("tone", 1900.0, 1.5 * _MS),
                ("px", chroma, self.width, c_scan),
            ]
            return self.sync_dur_s, segs, 1

        if self.kind == "pd":
            if line_index % 2 != 0:
                return None
            porch = self.p["porch"] * _MS           # 2.08 ms
            # IMPORTANT: `pixel` (0.532 ms) is the PER-PIXEL duration in PD modes.
            # Each segment below carries `width` pixels, so its total duration is
            # pixel * width. (rgb/robot `scan` values are already per-channel totals.)
            pixel = self.p["pixel"] * _MS * self.width
            # Real PD standard (Dayton Paper / G4IJE, and pySSTV): scan sequence is
            # Y(odd line), R-Y (Cr), B-Y (Cb), Y(even line) for each line pair.
            segs = [
                ("tone", BLACK_HZ, porch),
                ("px", Ch.Y, self.width, pixel),    # line 0 Y
                ("px", Ch.CR, self.width, pixel),   # averaged Cr (R-Y)
                ("px", Ch.CB, self.width, pixel),   # averaged Cb (B-Y)
                ("px", Ch.Y, self.width, pixel),    # line 1 Y
            ]
            return self.sync_dur_s, segs, 2

        raise ValueError("unknown kind")

    def line_duration(self, line_index: int = 0) -> float:
        r = self.line(line_index)
        if r is None:
            return 0.0
        sync_dur, segs, _ = r
        return sync_dur + sum(s[2] for s in segs if s[0] == "tone") + \
               sum(s[3] for s in segs if s[0] == "px")

    @property
    def frame_duration(self) -> float:
        # number of emitted syncs * line duration
        n = self.height // 2 if self.kind == "pd" else self.height
        return self.line_duration(0) * n


# ---------------------------------------------------------------------------
# v1 mode table (exact pySSTV constants)
# ---------------------------------------------------------------------------

MARTIN_M1 = Mode("Martin M1", 44, 320, 256, "rgb",
                 sync_dur=4.862, porch=0.572, scan=146.432)
MARTIN_M2 = Mode("Martin M2", 40, 320, 256, "rgb",
                 sync_dur=4.862, porch=0.572, scan=73.216)
SCOTTIE_S1 = Mode("Scottie S1", 60, 320, 256, "rgb",
                  sync_dur=9.0, porch=1.5, scan=136.74)
SCOTTIE_S2 = Mode("Scottie S2", 56, 320, 256, "rgb",
                  sync_dur=9.0, porch=1.5, scan=86.564)
ROBOT_36 = Mode("Robot 36", 8, 320, 240, "robot",
                sync_dur=9.0, porch=3.0, y_scan=88.0, c_scan=44.0)
PD90 = Mode("PD90", 99, 320, 256, "pd",
            sync_dur=20.0, porch=2.08, pixel=0.532)

V1_MODES = [MARTIN_M1, MARTIN_M2, SCOTTIE_S1, SCOTTIE_S2, ROBOT_36, PD90]
ALL_MODES = V1_MODES

_MODE_BY_VIS = {m.vis: m for m in ALL_MODES}
_MODE_BY_ID = {m.id: m for m in ALL_MODES}


def mode_by_vis(vis: int) -> Optional[Mode]:
    return _MODE_BY_VIS.get(vis)


def mode_by_id(mode_id: str) -> Optional[Mode]:
    return _MODE_BY_ID.get(mode_id)


if __name__ == "__main__":
    for m in V1_MODES:
        n = m.height // 2 if m.kind == "pd" else m.height
        print(f"{m.id:10s} VIS={m.vis:3d} {m.width}x{m.height} sync={m.sync_dur_s*1000:6.3f}ms "
              f"line={m.line_duration(0)*1000:7.2f}ms frame={m.frame_duration:6.1f}s")
