package com.example.sstv.engine

import kotlin.math.round

/** Shared SSTV calibration constants and value<->frequency mapping. */
object SSTVCalibration {
    const val SYNC_HZ = 1200.0f
    const val BLACK_HZ = 1500.0f
    const val WHITE_HZ = 2300.0f

    /** freq(v) = 1500 + (v/255) * 800 (Hz). */
    fun frequencyOf(value: Float): Float = BLACK_HZ + (value / 255.0f) * (WHITE_HZ - BLACK_HZ)

    /** v(f) = clamp((f - 1500)/800 * 255, 0, 255). */
    fun valueOf(freq: Float): Int {
        val v = (freq - BLACK_HZ) / (WHITE_HZ - BLACK_HZ) * 255.0f
        return round(v.coerceIn(0.0f, 255.0f)).toInt()
    }
}

/** Median of a FloatArray (mirrors numpy.median). */
fun sstvMedian(values: FloatArray): Float {
    if (values.isEmpty()) return 0.0f
    val sorted = values.sorted()
    val n = sorted.size
    return if (n % 2 == 1) sorted[n / 2] else (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0f
}
