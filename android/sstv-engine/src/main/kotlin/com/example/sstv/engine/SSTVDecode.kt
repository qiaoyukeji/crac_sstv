package com.example.sstv.engine

import kotlin.math.round

data class SSTVDecodeResult(val image: SSTVImage, val info: Map<String, Any?>)

/** SSTV decoder: mono Float32 audio samples -> [SSTVImage]. Mirrors the Python oracle. */
object SSTVDecode {

    fun decode(samples: FloatArray, sr: Int = 44100, modeHint: SSTVMode? = null): SSTVDecodeResult {
        val freq = SSTVDSP.estimateFrequency(samples, sr)

        var vis: Int? = null
        val mode: SSTVMode
        if (modeHint != null) {
            mode = modeHint
        } else {
            val (v, _) = SSTVVIS.decode(freq, sr)
            vis = v
            val m = if (v != null) SSTVMode.byVis(v) else null
                ?: return SSTVDecodeResult(SSTVImage(0, 0, intArrayOf()), mapOf("vis" to (null as Any?), "mode" to "", "lines" to 0))
            mode = m
        }

        val w = mode.width
        val h = mode.height
        val searchStart = visEnd(freq, sr)
        val step = (mode.lineDuration(0) * sr.toDouble()).toInt()
        val nLines = if (mode.kind == "pd") h / 2 else h

        val syncStarts = mutableListOf<Int>()
        var pos = searchStart
        for (i in 0 until nLines) {
            val lo = maxOf(0, (pos - 0.15 * step).toInt())
            val hi = minOf(freq.size, (pos + 0.5 * step).toInt())
            val s = findSync(freq, lo, hi, sr, mode.syncDurS)
            if (s == null) break
            syncStarts.add(s)
            pos = s + step
        }

        val rgb = Array(h) { FloatArray(w * 3) }
        val ycbcr = Array(h) { FloatArray(w * 3) }

        for ((idx, s) in syncStarts.withIndex()) {
            val lineIndex = if (mode.kind == "pd") 2 * idx else idx
            val r = mode.line(lineIndex) ?: continue
            var p = s + (mode.syncDurS * sr.toDouble()).round().toInt()
            var pxIdx = 0
            for (seg in r.segments) {
                when (seg) {
                    is SSTVSegment.Tone -> p += (seg.duration * sr.toDouble()).round().toInt()
                    is SSTVSegment.Pixels -> {
                        val (vals, newPos) = readPx(freq, p, seg.count, seg.duration, sr)
                        p = newPos
                        when (mode.kind) {
                            "rgb" -> {
                                val c = rgbChannelIndex(seg.channel)
                                for (x in 0 until seg.count) rgb[lineIndex][x * 3 + c] = vals[x]
                            }
                            "robot" -> {
                                for (x in 0 until seg.count) {
                                    when (seg.channel) {
                                        SSTVChannel.Y -> ycbcr[lineIndex][x * 3] = vals[x]
                                        SSTVChannel.CR -> ycbcr[lineIndex][x * 3 + 2] = vals[x]
                                        else -> ycbcr[lineIndex][x * 3 + 1] = vals[x]
                                    }
                                }
                            }
                            "pd" -> {
                                if (seg.channel == SSTVChannel.Y) {
                                    val target = if (pxIdx % 2 == 0) lineIndex else lineIndex + 1
                                    for (x in 0 until seg.count) ycbcr[target][x * 3] = vals[x]
                                } else {
                                    for (x in 0 until seg.count) {
                                        if (seg.channel == SSTVChannel.CB) {
                                            ycbcr[lineIndex][x * 3 + 1] = vals[x]
                                            ycbcr[lineIndex + 1][x * 3 + 1] = vals[x]
                                        } else {
                                            ycbcr[lineIndex][x * 3 + 2] = vals[x]
                                            ycbcr[lineIndex + 1][x * 3 + 2] = vals[x]
                                        }
                                    }
                                }
                            }
                        }
                        pxIdx++
                    }
                }
            }
        }

        val outRGB: IntArray
        if (mode.kind != "rgb") {
            for (i in 0 until h) {
                if (i % 2 == 0 && allZero(ycbcr[i], 1)) {
                    val nb = if (i + 1 < h) ycbcr[i + 1] else ycbcr[maxOf(i - 1, 0)]
                    for (x in 0 until w) ycbcr[i][x * 3 + 1] = nb[x * 3 + 1]
                }
                if (i % 2 == 1 && allZero(ycbcr[i], 2)) {
                    val nb = if (i - 1 >= 0) ycbcr[i - 1] else ycbcr[minOf(i + 1, h - 1)]
                    for (x in 0 until w) ycbcr[i][x * 3 + 2] = nb[x * 3 + 2]
                }
            }
            val flat = FloatArray(h * w * 3)
            for (i in 0 until h) for (j in 0 until w * 3) flat[i * w * 3 + j] = ycbcr[i][j]
            outRGB = SSTVColor.ycbcrToRGB(flat, w, h)
        } else {
            outRGB = IntArray(h * w * 3)
            for (i in 0 until h) for (j in 0 until w * 3) {
                outRGB[i * w * 3 + j] = round(rgb[i][j]).toInt().coerceIn(0, 255)
            }
        }

        val image = SSTVImage(w, h, outRGB)
        val info = mutableMapOf<String, Any?>("mode" to mode.id, "lines" to syncStarts.size)
        info["vis"] = vis
        return SSTVDecodeResult(image, info)
    }

    private fun visEnd(freq: FloatArray, sr: Int): Int {
        val near1900 = BooleanArray(freq.size) { kotlin.math.abs(freq[it] - 1900.0f) < 150 }
        val runs = findRuns(near1900, (0.25 * sr).toInt())
        val first = runs.firstOrNull() ?: return (0.95 * sr).toInt()
        val leaderEnd = first.second
        val startBitPos = leaderEnd + ((0.010 + 0.300) * sr).toInt()
        val cell = (0.030 * sr).toInt()
        return startBitPos + 10 * cell
    }

    private fun findSync(freq: FloatArray, lo: Int, hi: Int, sr: Int, syncDur: Float): Int? {
        val lo = maxOf(0, lo)
        val hi = minOf(freq.size, hi)
        val near = BooleanArray(hi - lo) { kotlin.math.abs(freq[lo + it] - SSTVCalibration.SYNC_HZ) < 120 }
        val minLen = (0.6 * syncDur * sr.toDouble()).toInt()
        val runs = findRuns(near, minLen)
        val best = runs.maxByOrNull { it.second - it.first } ?: return null
        return lo + best.first
    }

    private fun readPx(freq: FloatArray, pos: Int, npx: Int, dur: Float, sr: Int): Pair<FloatArray, Int> {
        val tot = (dur * sr.toDouble()).round().toInt()
        val out = FloatArray(npx)
        var p = pos
        for (i in 0 until npx) {
            val a = p + (i.toDouble() * tot.toDouble() / npx.toDouble()).round().toInt()
            val b = p + ((i + 1).toDouble() * tot.toDouble() / npx.toDouble()).round().toInt()
            var bb = b
            if (bb <= a) bb = a + 1
            val bb2 = minOf(bb, freq.size)
            out[i] = if (a >= 0 && a < freq.size && bb2 > a) {
                sstvMedian(freq.copyOfRange(a, bb2))
            } else 0.0f
        }
        return out to (p + tot)
    }

    private fun rgbChannelIndex(ch: SSTVChannel): Int = when (ch) {
        SSTVChannel.R -> 0; SSTVChannel.G -> 1; SSTVChannel.B -> 2; else -> 0
    }

    private fun allZero(row: FloatArray, plane: Int): Boolean {
        for (x in 0 until row.size / 3) if (row[x * 3 + plane] != 0.0f) return false
        return true
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
