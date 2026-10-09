package com.example.sstv.engine

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.round
import kotlin.math.sin

/**
 * DSP primitives shared by the encoder (continuous-phase synthesis) and decoder
 * (analytic-signal FM demodulation). The decoder mirrors the validated Python
 * `estimate_frequency` so the Swift/Kotlin/Python engines agree. Internal math uses
 * Double to match the Python (float64) oracle; only the audio buffer is Float.
 */
object SSTVDSP {

    fun appendTone(out: MutableList<Float>, freq: Float, duration: Float, sr: Int, state: DoubleArray) {
        val n = round(duration * sr).toInt()
        val step = 2.0 * PI * freq / sr
        for (i in 0 until n) {
            out.add(sin(state[0]).toFloat())
            state[0] += step
        }
    }

    /** Synthesize (freqHz, durationSec) segments into a mono Float buffer with a 2ms fade. */
    fun synthTones(segments: List<Pair<Float, Float>>, sr: Int): FloatArray {
        val freqs = mutableListOf<Double>()
        val counts = mutableListOf<Int>()
        var total = 0
        for ((freq, dur) in segments) {
            val n = round(dur * sr.toDouble()).toInt()
            if (n > 0) { freqs.add(freq.toDouble()); counts.add(n); total += n }
        }
        if (total == 0) return floatArrayOf()
        val f = DoubleArray(total)
        var idx = 0
        for (k in counts.indices) repeat(counts[k]) { f[idx++] = freqs[k] }
        var phase = 0.0
        val out = FloatArray(total)
        val k = 2.0 * PI / sr.toDouble()
        for (i in 0 until total) {
            phase += k * f[i]
            out[i] = sin(phase).toFloat()
        }
        val fade = maxOf(1, round(0.002 * sr.toDouble()).toInt())
        if (total > 2 * fade) {
            for (i in 0 until fade) {
                val w = sin(i.toDouble() / (fade - 1) * PI / 2)
                out[i] *= w.toFloat()
                out[total - 1 - i] *= w.toFloat()
            }
        }
        return out
    }

    fun nextPow2(n: Int): Int {
        var p = 1
        while (p < n) p = p shl 1
        return p
    }

    /** In-place iterative radix-2 Cooley-Tukey FFT (power-of-two length). */
    fun fftInPlace(re: DoubleArray, im: DoubleArray) {
        val n = re.size
        if (n <= 1 || n != im.size || (n and (n - 1)) != 0) return
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while ((j and bit) != 0) { j -= bit; bit = bit shr 1 }
            j = j or bit
            if (i < j) {
                val tr = re[i]; re[i] = re[j]; re[j] = tr
                val ti = im[i]; im[i] = im[j]; im[j] = ti
            }
        }
        var len = 2
        while (len <= n) {
            val ang = -2.0 * PI / len
            val wRe = cos(ang); val wIm = sin(ang)
            var i = 0
            while (i < n) {
                var wR = 1.0; var wI = 0.0
                val half = len / 2
                for (kk in 0 until half) {
                    val a = i + kk
                    val b = i + kk + half
                    val tRe = wR * re[b] - wI * im[b]
                    val tIm = wR * im[b] + wI * re[b]
                    re[b] = re[a] - tRe
                    im[b] = im[a] - tIm
                    re[a] = re[a] + tRe
                    im[a] = im[a] + tIm
                    val nwR = wR * wRe - wI * wIm
                    wI = wR * wIm + wI * wRe
                    wR = nwR
                }
                i += len
            }
            len = len shl 1
        }
    }

    /** Instantaneous frequency (Hz) per sample via analytic-signal phase (mirrors Python). */
    fun estimateFrequency(samples: FloatArray, sr: Int): FloatArray {
        val n0 = samples.size
        if (n0 <= 1) return FloatArray(n0)
        val n = nextPow2(n0)
        var mean = 0.0
        for (s in samples) mean += s.toDouble()
        mean /= n0
        val re = DoubleArray(n)
        val im = DoubleArray(n)
        for (i in 0 until n0) re[i] = samples[i].toDouble() - mean
        fftInPlace(re, im)
        if (n % 2 == 0) {
            im[0] = 0.0
            for (k in 1 until n / 2) { re[k] *= 2.0; im[k] *= 2.0 }
            im[n / 2] = 0.0
            for (k in (n / 2 + 1) until n) { re[k] = 0.0; im[k] = 0.0 }
        } else {
            im[0] = 0.0
            for (k in 1..(n - 1) / 2) { re[k] *= 2.0; im[k] *= 2.0 }
            for (k in (n + 1) / 2 until n) { re[k] = 0.0; im[k] = 0.0 }
        }
        for (k in 0 until n) {
            val f = k.toDouble() * sr.toDouble() / n.toDouble()
            if (f < 700 || f > 2700) { re[k] = 0.0; im[k] = 0.0 }
        }
        for (k in 0 until n) im[k] = -im[k]
        fftInPlace(re, im)
        for (k in 0 until n) { re[k] /= n.toDouble(); im[k] = -im[k] / n.toDouble() }
        val phase = DoubleArray(n)
        for (k in 0 until n) phase[k] = atan2(im[k], re[k])
        unwrap(phase)
        val df = DoubleArray(n)
        val scale = sr.toDouble() / (2.0 * PI)
        if (n > 1) {
            df[0] = (phase[1] - phase[0]) * scale
            for (i in 1 until n - 1) df[i] = (phase[i + 1] - phase[i - 1]) / 2.0 * scale
            df[n - 1] = (phase[n - 1] - phase[n - 2]) * scale
        }
        for (i in 0 until n) df[i] = df[i].coerceIn(700.0, 2700.0)
        val smoothed = movingAverage(df, 8)
        val out = FloatArray(n0)
        for (i in 0 until n0) out[i] = smoothed[i].toFloat()
        return out
    }

    private fun unwrap(phase: DoubleArray) {
        val twoPi = 2.0 * PI
        for (i in 1 until phase.size) {
            var diff = phase[i] - phase[i - 1]
            diff -= twoPi * round(diff / twoPi)
            phase[i] = phase[i - 1] + diff
        }
    }

    /** Centered moving average of width w (numpy convolve mode='same'). */
    private fun movingAverage(x: DoubleArray, width: Int): DoubleArray {
        if (width <= 1 || x.size < width) return x.copyOf()
        val half = width / 2
        val out = DoubleArray(x.size)
        val inv = 1.0 / width
        for (i in x.indices) {
            var acc = 0.0
            for (j in 0 until width) {
                val s = i + j - half
                if (s in x.indices) acc += x[s]
            }
            out[i] = acc * inv
        }
        return out
    }

    /** Magnitude^2 of `freq` Hz within samples[start .. start+length). */
    fun goertzelEnergy(samples: FloatArray, sr: Int, freq: Float, start: Int, length: Int): Float {
        val n = minOf(maxOf(length, 0), samples.size - start)
        if (n <= 0) return 0f
        val k = n.toDouble() * freq / sr
        val w = 2.0 * PI * k / n
        val cosw = cos(w); val coeff = 2 * cosw
        var s0 = 0.0; var s1 = 0.0; var s2 = 0.0
        val end = start + n
        for (i in start until end) {
            s0 = samples[i].toDouble() + coeff * s1 - s2
            s2 = s1; s1 = s0
        }
        return (s1 * s1 + s2 * s2 - coeff * s1 * s2).toFloat()
    }
}
