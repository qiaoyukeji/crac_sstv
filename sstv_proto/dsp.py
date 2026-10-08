"""DSP helpers: continuous-phase tone synthesis, instantaneous frequency
estimation (analytic-signal FM demodulation) and Goertzel tone detection.

These are pure-Python/NumPy implementations used as the validation oracle.
The Swift (Accelerate vDSP) and Kotlin ports must reproduce identical numbers.
"""

import numpy as np

TWO_PI = 2.0 * np.pi


def append_tone(out: list, freq: float, dur: float, sr: int, state) -> None:
    """Append a sine tone of `freq` Hz for `dur` SECONDS to `out` (list of float),
    keeping phase continuous through `state` (a mutable [phase] list)."""
    n = int(round(dur * sr))
    ph = state[0]
    for _ in range(n):
        out.append(np.sin(ph))
        ph += TWO_PI * freq / sr
    state[0] = ph


def synth_tones(segments, sr: int) -> np.ndarray:
    """segments: list of (freq_hz, dur_sec). Returns float32 mono samples in [-1,1].

    Fully vectorised: builds a per-sample frequency array, integrates phase via
    cumsum, and takes the sine. Phase stays continuous across segment boundaries.
    """
    freqs = []
    counts = []
    total = 0
    for freq, dur in segments:
        n = int(round(dur * sr))
        if n > 0:
            freqs.append(freq)
            counts.append(n)
            total += n
    if total == 0:
        return np.zeros(0, dtype=np.float32)

    f_arr = np.array(freqs, dtype=np.float64)
    c_arr = np.array(counts, dtype=np.int64)
    idx = np.repeat(np.arange(len(c_arr), dtype=np.int64), c_arr)
    f = f_arr[idx]
    phase = np.cumsum(TWO_PI * f / sr)
    arr = np.sin(phase).astype(np.float32)

    # 2 ms cosine fade in/out to avoid clicks
    fade = max(1, int(0.002 * sr))
    if len(arr) > 2 * fade:
        w = np.sin(np.linspace(0, np.pi / 2, fade)).astype(np.float32)
        arr[:fade] *= w
        arr[-fade:] *= w[::-1]
    return arr


def estimate_frequency(samples: np.ndarray, sr: int) -> np.ndarray:
    """Instantaneous frequency (Hz) per input sample via analytic-signal phase.

    Returns a float64 array the same length as `samples`.
    """
    x = np.asarray(samples, dtype=np.float64)
    x = x - x.mean()
    N = len(x)
    if N < 2:
        return np.zeros(N)
    X = np.fft.fft(x)
    h = np.zeros(N, dtype=complex)
    h[0] = 1.0
    if N % 2 == 0:
        h[1:N // 2] = 2.0
        h[N // 2] = 1.0
    else:
        h[1:(N + 1) // 2] = 2.0
    Xa = X * h
    # mild band-limit to SSTV band (suppress out-of-band noise)
    freqs = np.fft.fftfreq(N, 1.0 / sr)
    band = (np.abs(freqs) < 700) | (np.abs(freqs) > 2700)
    Xa[band] = 0
    ana = np.fft.ifft(Xa)
    phase = np.unwrap(np.angle(ana))
    df = np.gradient(phase) * (sr / TWO_PI)
    df = np.clip(df, 700, 2700)
    # smoothing
    k = 8
    kernel = np.ones(k) / k
    df = np.convolve(df, kernel, mode="same")
    return df


def goertzel_energy(samples: np.ndarray, sr: int, freq: float) -> float:
    """Magnitude^2 of a single frequency component (real input)."""
    n = len(samples)
    if n == 0:
        return 0.0
    k = int(0.5 + (n * freq) / sr)
    if k < 0 or k > n // 2:
        # fall back to direct projection
        t = np.arange(n)
        proj = np.abs(np.sum(samples * np.exp(-2j * np.pi * freq * t / sr)))
        return float(proj)
    spectrum = np.abs(np.fft.rfft(samples))
    return float(spectrum[k] ** 2)
