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
/**
 * VIS 解码结果。
 *
 * [frameStart] 是 VIS 头结束位置（= 一帧的起点，采样点）；取不到有效 VIS 时为 -1。
 * 它是**结构校验通过之后**才算出来的，可以放心当作帧起点用 —— 见 [SSTVVIS.decode]。
 */
data class VisResult(val vis: Int?, val bits: List<Int>?, val frameStart: Int)

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

    /**
     * 1200 Hz 是**结构位**（起始位/停止位）的频率，而它正好落在 1100（bit 1）与
     * 1300（bit 0）的**正中间**。所以判"是不是结构位"绝不能沿用数据位那套
     * "离 1100 近还是离 1300 近" —— 那个比较在 1200 上是掷硬币：实测同一段信号里
     * 起始位（1200.4 Hz）被判成 0、停止位（1199.6 Hz）被判成 1，奇偶校验就永远过不了。
     * 正确做法是判"离 1100 / 1200 / 1300 三者中谁最近"。参考实现 web/sstv-engine.js
     * 的 isSyncCell() 与此完全一致。
     */
    private fun isSyncCell(f: Float): Boolean {
        val d = kotlin.math.abs(f - FREQ_SYNC)
        return d < kotlin.math.abs(f - FREQ_BIT1) && d < kotlin.math.abs(f - FREQ_BIT0)
    }

    /** 读 VIS 头里 10 个 30 ms 单元的中值频率（1 起始 + 7 数据 + 1 校验 + 1 停止）。 */
    private fun readCells(freq: FloatArray, startBitPos: Int, cell: Int): FloatArray? {
        val end = startBitPos + 10 * cell
        if (startBitPos < 0 || end > freq.size) return null
        val cells = FloatArray(10)
        for (k in 0 until 10) {
            val a = startBitPos + k * cell
            val b = minOf(startBitPos + (k + 1) * cell, freq.size)
            if (b <= a) return null
            cells[k] = sstvMedian(freq.copyOfRange(a, b))
        }
        return cells
    }

    /**
     * 检测并解码 VIS 头。返回 [VisResult]，只有**结构校验全部通过**才会给出 [VisResult.vis]。
     *
     * 校验项（缺一不可）：
     *   ① 起始位是 1200 Hz 结构位；② 停止位是 1200 Hz 结构位；③ 偶校验位与 7 个数据位一致；
     *   ④ [isSupported] 认可这个制式码。
     *
     * 为什么要这么严：VIS 是"帧长"的唯一来源，而帧长决定了"对方发完了没有"。识别不出
     * VIS 只是解不出图；**认错** VIS 却会让时间轴在对方还在发射时就走完 —— 参考实现里
     * 实测提前 19~78 s 收手，画面只剩零头。宁可不解，也不能认成别的制式。
     *
     * 候选与对齐：对**每一个** 1900 Hz 连段都试两种对齐（连段末尾 + break + leader ，
     * 以及直接连段末尾），因为录音可能从引导音中间才开始（第一段只有几十毫秒）。旧实现
     * 只认"第一个连段 + 唯一一种对齐"，录音开头有一段同频干扰时就彻底认不出来。
     */
    fun decode(freq: FloatArray, sr: Int, isSupported: (Int) -> Boolean = { true }): VisResult {
        val near1900 = BooleanArray(freq.size) { kotlin.math.abs(freq[it] - FREQ_LEADER) < 150 }
        val runs = findRuns(near1900, (0.12 * sr).toInt())
        val cell = (MSEC_BIT / 1000.0 * sr).toInt()
        val gap = ((MSEC_BREAK + MSEC_LEADER) / 1000.0 * sr).toInt()
        for (r in runs) {
            for (h in 0..1) {
                val startBitPos = r.second + if (h == 0) gap else 0
                val cells = readCells(freq, startBitPos, cell)
                // 读不到就换一种对齐再试；两种都读不到说明这个连段不可能是引导音。
                // （参考实现在这里对 h==1 直接放弃整次检测，这里改成继续看后面的连段 ——
                //   更宽松，且不会因此误判，因为后面每一步都还要过结构校验。）
                if (cells == null) continue
                if (!isSyncCell(cells[0])) continue      // 起始位必须 1200 Hz
                if (!isSyncCell(cells[9])) continue      // 停止位必须 1200 Hz
                val bits = mutableListOf<Int>()
                var ones = 0
                for (k in 1..7) {
                    val d1 = kotlin.math.abs(cells[k] - FREQ_BIT1)
                    val d0 = kotlin.math.abs(cells[k] - FREQ_BIT0)
                    val b = if (d1 < d0) 1 else 0
                    bits.add(b); ones += b
                }
                val parExpected = if (ones % 2 == 1) 1 else 0
                val parActual =
                    if (kotlin.math.abs(cells[8] - FREQ_BIT1) < kotlin.math.abs(cells[8] - FREQ_BIT0)) 1 else 0
                if (parActual != parExpected) continue
                var visCode = 0
                for (k in 0..6) if (bits[k] == 1) visCode = visCode or (1 shl k)
                if (!isSupported(visCode)) continue
                return VisResult(visCode, bits, startBitPos + 10 * cell)
            }
        }
        return VisResult(null, null, -1)
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
