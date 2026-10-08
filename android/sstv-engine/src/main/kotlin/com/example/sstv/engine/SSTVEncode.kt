package com.example.sstv.engine

import kotlin.math.round

/** SSTV encoder: [SSTVImage] -> mono Float32 audio samples. */
object SSTVEncode {

    fun encode(image: SSTVImage, mode: SSTVMode, sr: Int = 44100): FloatArray {
        val w = image.width
        val h = image.height
        val ycbcr = SSTVColor.rgbToYCbCr(image.rgb, w, h)

        val segs = SSTVVIS.segments(mode.vis).toMutableList()
        for (lineIndex in 0 until h) {
            val r = mode.line(lineIndex) ?: continue
            segs.add(SSTVCalibration.SYNC_HZ to r.sync)
            for ((segIdx, seg) in r.segments.withIndex()) {
                when (seg) {
                    is SSTVSegment.Tone -> segs.add(seg.freq to seg.duration)
                    is SSTVSegment.Pixels -> {
                        val vals = channelArray(mode, image.rgb, ycbcr, lineIndex, seg.channel, segIdx, w)
                        val tot = round(seg.duration * sr.toDouble()).toInt()
                        for (p in 0 until seg.count) {
                            val a = round(p.toDouble() * tot.toDouble() / seg.count.toDouble()).toInt()
                            val b = round((p + 1).toDouble() * tot.toDouble() / seg.count.toDouble()).toInt()
                            val v = vals[p].coerceIn(0.0f, 255.0f)
                            segs.add(SSTVCalibration.frequencyOf(v) to (b - a).toFloat() / sr.toFloat())
                        }
                    }
                }
            }
        }
        return SSTVDSP.synthTones(segs, sr)
    }

    private fun channelArray(
        mode: SSTVMode, rgb: IntArray, ycbcr: FloatArray,
        lineIndex: Int, ch: SSTVChannel, segIdx: Int, w: Int
    ): FloatArray {
        val n = w
        val vals = FloatArray(n)
        when (mode.kind) {
            "rgb" -> {
                val c = rgbChannelIndex(ch)
                for (x in 0 until n) vals[x] = rgb[(lineIndex * n + x) * 3 + c].toFloat()
            }
            "robot" -> {
                for (x in 0 until n) {
                    val base = (lineIndex * n + x) * 3
                    vals[x] = when (ch) {
                        SSTVChannel.Y -> ycbcr[base]
                        SSTVChannel.CR -> ycbcr[base + 2]
                        else -> ycbcr[base + 1]
                    }
                }
            }
            "pd" -> {
                if (ch == SSTVChannel.Y) {
                    val li = if (segIdx == 1) lineIndex else lineIndex + 1
                    for (x in 0 until n) vals[x] = ycbcr[(li * n + x) * 3]
                } else {
                    for (x in 0 until n) {
                        val a = ycbcr[((lineIndex) * n + x) * 3 + if (ch == SSTVChannel.CB) 1 else 2]
                        val b = ycbcr[((lineIndex + 1) * n + x) * 3 + if (ch == SSTVChannel.CB) 1 else 2]
                        vals[x] = (a + b) / 2.0f
                    }
                }
            }
            else -> FloatArray(n)
        }
        return vals
    }

    private fun rgbChannelIndex(ch: SSTVChannel): Int = when (ch) {
        SSTVChannel.R -> 0; SSTVChannel.G -> 1; SSTVChannel.B -> 2; else -> 0
    }
}
