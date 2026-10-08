import Foundation

/// DSP primitives shared by the encoder (continuous-phase synthesis) and decoder
/// (analytic-signal FM demodulation). The decoder mirrors the validated Python
/// `estimate_frequency` (float64) so the Swift and Python oracles agree.
///
/// Internal math uses `Double` to match the Python reference bit-for-bit; only the
/// final audio buffer is emitted as `Float` (Float32), matching the app's audio layer.
public enum SSTVDSP {

    // MARK: - Tone synthesis

    /// Append a sine tone of `freq` Hz for `duration` seconds onto `out`, keeping
    /// phase continuous through `state` (a single-element array holding the phase).
    public static func appendTone(_ out: inout [Float], freq: Float, duration: Float,
                                  sampleRate sr: Int, state: inout Float) {
        let n = Int((duration * Float(sr)).rounded())
        let step = 2 * Float.pi * freq / Float(sr)
        for _ in 0..<n {
            out.append(sin(state))
            state += step
        }
    }

    /// Synthesize a list of (freqHz, durationSec) segments into a mono Float buffer,
    /// with a 2 ms cosine fade at the very start/end to avoid clicks.
    ///
    /// Mirrors Python `synth_tones`: build a per-sample frequency array, integrate
    /// phase via cumsum (here a running sum in Double), then take sin. Phase stays
    /// continuous across segment boundaries.
    public static func synthTones(_ segments: [(Float, Float)], sampleRate sr: Int) -> [Float] {
        var freqs: [Double] = []
        var counts: [Int] = []
        var total = 0
        for (freq, dur) in segments {
            let n = Int((dur * Double(sr)).rounded())
            if n > 0 { freqs.append(Double(freq)); counts.append(n); total += n }
        }
        guard total > 0 else { return [] }
        let idx = repeatIndices(counts)
        var f = [Double](repeating: 0, count: total)
        for i in 0..<total { f[i] = freqs[idx[i]] }
        // Continuous-phase integration (cumsum 2*pi*f/sr).
        var phase: Double = 0
        var out = [Float](repeating: 0, count: total)
        let k = 2 * Double.pi / Double(sr)
        for i in 0..<total {
            phase += k * f[i]
            out[i] = Float(sin(phase))
        }
        // 2 ms fade (mirrors numpy linspace(0, pi/2, fade)).
        let fade = max(1, Int((0.002 * Double(sr)).rounded()))
        if total > 2 * fade {
            for i in 0..<fade {
                let w = sin(Double(i) / Double(fade - 1) * (Double.pi / 2))
                out[i] *= Float(w)
                out[total - 1 - i] *= Float(w)
            }
        }
        return out
    }

    private static func repeatIndices(_ counts: [Int]) -> [Int] {
        var idx: [Int] = []
        idx.reserveCapacity(counts.reduce(0, +))
        for (i, c) in counts.enumerated() {
            for _ in 0..<c { idx.append(i) }
        }
        return idx
    }

    // MARK: - FFT (iterative radix-2, in-place, Double)

    public static func nextPow2(_ n: Int) -> Int {
        var p = 1
        while p < n { p <<= 1 }
        return p
    }

    /// In-place iterative radix-2 Cooley-Tukey FFT. `re`/`im` must have power-of-two length.
    public static func fftInPlace(re: inout [Double], im: inout [Double]) {
        let n = re.count
        guard n > 1, n == im.count, (n & (n - 1)) == 0 else { return }
        // Bit-reversal permutation.
        var j = 0
        for i in 1..<n {
            var bit = n >> 1
            while j & bit != 0 { j -= bit; bit >>= 1 }
            j |= bit
            if i < j { re.swapAt(i, j); im.swapAt(i, j) }
        }
        var len = 2
        while len <= n {
            let ang = -2 * Double.pi / Double(len)
            let wRe = cos(ang), wIm = sin(ang)
            var i = 0
            while i < n {
                var wR: Double = 1, wI: Double = 0
                let half = len / 2
                for k in 0..<half {
                    let a = i + k
                    let b = i + k + half
                    let tRe = wR * re[b] - wI * im[b]
                    let tIm = wR * im[b] + wI * re[b]
                    re[b] = re[a] - tRe
                    im[b] = im[a] - tIm
                    re[a] = re[a] + tRe
                    im[a] = im[a] + tIm
                    let nwR = wR * wRe - wI * wIm
                    wI = wR * wIm + wI * wRe
                    wR = nwR
                }
                i += len
            }
            len <<= 1
        }
    }

    // MARK: - Instantaneous frequency (analytic signal)

    /// Instantaneous frequency (Hz) per input sample via analytic-signal phase.
    /// Mirrors the Python `estimate_frequency` (float64). Returns a Float array of
    /// length equal to `samples.count`.
    public static func estimateFrequency(samples: [Float], sampleRate sr: Int) -> [Float] {
        let n0 = samples.count
        guard n0 > 1 else { return [Float](repeating: 0, count: n0) }
        let n = nextPow2(n0)
        var mean: Double = 0
        for s in samples { mean += Double(s) }
        mean /= Double(n0)
        var re = [Double](repeating: 0, count: n)
        var im = [Double](repeating: 0, count: n)
        for i in 0..<n0 { re[i] = Double(samples[i]) - mean }
        fftInPlace(re: &re, im: &im)
        // Analytic filter: keep DC, double positive bins, keep Nyquist, zero the rest.
        if n % 2 == 0 {
            re[0] = re[0]; im[0] = 0
            for k in 1..<(n / 2) { re[k] *= 2; im[k] *= 2 }
            re[n / 2] = re[n / 2]; im[n / 2] = 0
            for k in (n / 2 + 1)..<n { re[k] = 0; im[k] = 0 }
        } else {
            re[0] = re[0]; im[0] = 0
            for k in 1...((n - 1) / 2) { re[k] *= 2; im[k] *= 2 }
            for k in ((n + 1) / 2)..<n { re[k] = 0; im[k] = 0 }
        }
        // Band-limit to the SSTV band (700..2700 Hz), mirroring np.fft.fftfreq masking.
        for k in 0..<n {
            let f = Double(k) * Double(sr) / Double(n)
            if f < 700 || f > 2700 { re[k] = 0; im[k] = 0 }
        }
        // Inverse FFT via conjugate trick: ifft(x) = conj(fft(conj(x))) / N.
        for k in 0..<n { im[k] = -im[k] }
        fftInPlace(re: &re, im: &im)
        for k in 0..<n { re[k] /= Double(n); im[k] = -im[k] / Double(n) }
        // Phase -> unwrap -> gradient (matches np.gradient / np.unwrap).
        var phase = [Double](repeating: 0, count: n)
        for k in 0..<n { phase[k] = atan2(im[k], re[k]) }
        phase = unwrap(phase)
        var df = [Double](repeating: 0, count: n)
        let scale = Double(sr) / (2 * Double.pi)
        if n > 1 {
            df[0] = (phase[1] - phase[0]) * scale
            for i in 1..<(n - 1) {
                df[i] = (phase[i + 1] - phase[i - 1]) / 2 * scale
            }
            df[n - 1] = (phase[n - 1] - phase[n - 2]) * scale
        }
        for i in 0..<n { df[i] = min(max(df[i], 700), 2700) }
        // Smoothing: centered 8-tap moving average (numpy convolve mode='same').
        df = movingAverage(df, width: 8)
        var out = [Float](repeating: 0, count: n0)
        for i in 0..<n0 { out[i] = Float(df[i]) }
        return out
    }

    private static func unwrap(_ phase: [Double]) -> [Double] {
        var out = phase
        let twoPi = 2 * Double.pi
        for i in 1..<out.count {
            var diff = out[i] - out[i - 1]
            diff -= twoPi * (diff / twoPi).rounded()
            out[i] = out[i - 1] + diff
        }
        return out
    }

    /// Centered moving average of width `w` with zero padding, mirroring
    /// `np.convolve(x, ones(w)/w, mode='same')` for the SSTV decoder.
    private static func movingAverage(_ x: [Double], width: Int) -> [Double] {
        guard width > 1, x.count >= width else { return x }
        let half = width / 2   // e.g. 8 -> 4, window covers [i-4 .. i+3]
        var out = [Double](repeating: 0, count: x.count)
        let inv = 1.0 / Double(width)
        for i in 0..<x.count {
            var acc: Double = 0
            for j in 0..<width {
                let s = i + j - half
                if s >= 0 && s < x.count { acc += x[s] }
            }
            out[i] = acc * inv
        }
        return out
    }

    // MARK: - Goertzel (single-frequency magnitude^2)

    /// Magnitude^2 of `freq` Hz within `samples[start ..< start+length]`.
    public static func goertzelEnergy(_ samples: [Float], sampleRate sr: Int,
                                     freq: Float, start: Int, length: Int) -> Float {
        let n = min(max(length, 0), samples.count - start)
        guard n > 0 else { return 0 }
        let k = Double(n) * Double(freq) / Double(sr)
        let w = 2 * Double.pi * k / Double(n)
        let cosw = cos(w), coeff = 2 * cosw
        var s0: Double = 0, s1: Double = 0, s2: Double = 0
        let end = start + n
        for i in start..<end {
            s0 = Double(samples[i]) + coeff * s1 - s2
            s2 = s1; s1 = s0
        }
        return Float(s1 * s1 + s2 * s2 - coeff * s1 * s2)
    }
}
