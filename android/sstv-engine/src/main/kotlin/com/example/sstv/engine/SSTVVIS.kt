package com.example.sstv.engine

import kotlin.math.PI
import kotlin.math.sin
import kotlin.math.round

/**
 * VIS header generation and decoding (authoritative pySSTV 0.5.9 format).
 *
 * Header layout (freq, ms):
 *   1900 x300 (leader), 1200 x10 (break), 1900 x300 (leader 2), 1200 x30 (start bit),
 *   7 data bits LSB-first (1=1100 Hz, 0=1300 Hz) x30ms, even-parity bit x30ms, 1200 x30 (stop bit).
 */
object SSTVVIS {
    const val FREQ_LEADER = 1900.0f
    const val FREQ_START = 1200.0f
    const val FREQ_BIT1 = 1100.0f
    const val FREQ_BIT0 = 1300.0f
    const val FREQ_SYNC = 1200.0f

    private const val MSEC_LEADER = 300
    private const val MSEC_BREAK = 10
    private const val MSEC_BIT = 30

    fun segments(visCode: Int): List<Pair<Float, Float>> {
        val segs = mutableListOf<Pair<Float, Float>>(
            FREQ_LEADER to MSEC_LEADER / 1000f,
            FREQ_START to MSEC_BREAK / 1000f,
            FREQ_LEADER to MSEC_LEADER / 1000f,
            FREQ_SYNC to MSEC_BIT / 1000f
        )
        var v = visCode and 0x7F
        var numOnes = 0
        repeat(7) {
            val bit = v and 1
            numOnes += bit
            segs.add((if (bit == 1) FREQ_BIT1 else FREQ_BIT0) to MSEC_BIT / 1000f)
            v = v shr 1
        }
        val parity = if (numOnes % 2 == 1) 1 else 0
        segs.add((if (parity == 1) FREQ_BIT1 else FREQ_BIT0) to MSEC_BIT / 1000f)
        segs.add(FREQ_SYNC to MSEC_BIT / 1000f)
        return segs
    }

    fun samples(visCode: Int, sr: Int): FloatArray = SSTVDSP.synthTones(segments(visCode), sr)

    /** Detect and decode the VIS header. Returns (visCode, bits) or (null, null). */
    fun decode(freq: FloatArray, sr: Int): Pair<Int?, List<Int>?> {
        val near1900 = BooleanArray(freq.size) { kotlin.math.abs(freq[it] - FREQ_LEADER) < 150 }
        val runs = findRuns(near1900, (0.2 * sr).toInt())
        val first = runs.firstOrNull() ?: return null to null
        val leaderEndIdx = first.second
        val startBitPos = leaderEndIdx + ((MSEC_BREAK + MSEC_LEADER) / 1000.0 * sr).toInt()
        val cell = (MSEC_BIT / 1000.0 * sr).toInt()
        val end = startBitPos + 10 * cell
        if (end > freq.size) return null to null
        val cells = FloatArray(10)
        for (k in 0 until 10) {
            val a = startBitPos + k * cell
            val b = (startBitPos + (k + 1) * cell).coerceAtMost(freq.size)
            val seg = freq.copyOfRange(a, b)
            cells[k] = sstvMedian(seg)
        }
        val bits = mutableListOf<Int>()
        for (k in 1..7) {
            val d1 = kotlin.math.abs(cells[k] - FREQ_BIT1)
            val d0 = kotlin.math.abs(cells[k] - FREQ_BIT0)
            bits.add(if (d1 < d0) 1 else 0)
        }
        var vis = 0
        for (k in 0..6) if (bits[k] == 1) vis = vis or (1 shl k)
        return vis to bits
    }

    private fun findRuns(mask: BooleanArray, minLen: Int): List<Pair<Int, Int>> {
        val runs = mutableListOf<Pair<Int, Int>>()
        var i = 0
        val n = mask.size
        while (i < n) {
            if (mask[i]) {
                var j = i
                while (j < n && mask[j]) j++
                if (j - i >= minLen) runs.add(i to j)
                i = j
            } else i++
        }
        return runs
    }
}
