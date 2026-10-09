package com.example.sstv.engine

import kotlin.math.round

data class SSTVDecodeResult(val image: SSTVImage, val info: Map<String, Any?>)

/** SSTV decoder: mono Float32 audio samples -> [SSTVImage]. Mirrors the Python oracle. */
object SSTVDecode {

    fun decode(samples: FloatArray, sr: Int = 44100, modeHint: SSTVMode? = null): SSTVDecodeResult {
        val freq = SSTVDSP.estimateFrequency(samples, sr)

        var vis: Int? = null
        // 帧起点优先取**校验过的 VIS 头结束位置**（与制式来自同一次读取）。手动指定
        // 制式时也先试着读一次 VIS —— 只取位置、制式仍听用户的：用户手动指定是被
        // "制式认错"逼的，与"这一帧从哪开始"无关。取不到才退回独立搜索引导音位置。
        // 这一步不是可有可无：拿"第一个 1900 Hz 连段"的启发式估计当帧起点，录音开头
        // 有一段同频干扰就会明显偏早，整幅画面随之整体错位（参考实现实测帧尾早 0.61 s）。
        val visEndPos: Int
        val mode: SSTVMode
        if (modeHint != null) {
            mode = modeHint
            visEndPos = SSTVVIS.decode(freq, sr) { SSTVMode.byVis(it) != null }.frameStart
        } else {
            val r = SSTVVIS.decode(freq, sr) { SSTVMode.byVis(it) != null }
            vis = r.vis
            visEndPos = r.frameStart
            // 括号不能省：`if (c) a else b ?: return` 会被解析成 `if (c) a else (b ?: return)`，
            // 也就是"else 分支必然返回"，整个 if 的类型就退化成了 `SSTVMode?`，
            // 赋给非空变量直接报错，还会把后续所有 `round()` 级联成"未解析引用"。
            val m = (if (vis != null) SSTVMode.byVis(vis) else null)
                ?: return SSTVDecodeResult(
                    SSTVImage(0, 0, intArrayOf()),
                    mapOf("vis" to (null as Any?), "mode" to "", "lines" to 0)
                )
            mode = m
        }

        val w = mode.width
        val h = mode.height
        val searchStart = if (visEndPos > 0) visEndPos else visEnd(freq, sr)
        val step = (mode.lineDuration(0) * sr.toDouble()).toInt()
        val nLines = if (mode.kind == "pd") h / 2 else h

        val syncStarts = mutableListOf<Int>()
        var pos = searchStart
        for (i in 0 until nLines) {
            val lo = maxOf(0, (pos - 0.15 * step).toInt())
            val hi = minOf(freq.size, (pos + 0.5 * step).toInt())
            var s = findSync(freq, lo, hi, sr, mode.syncDurS)
            if (s == null) {
                // 正常窗口（半个行周期）里没找到同步脉冲：说明这一行被中断/干扰吃掉了。
                // 把窗口放宽到 1.5 个行周期再找一次，跳过这一行继续往下解。
                // 参考实现（web/sstv-engine.js）里加这一步的原因：原来的实现是直接 break，
                // 一处几毫秒的干扰就会让整幅图从中间被截断（麦克风录音实测只能解出 138/240 行）。
                // 放宽搜索只在"本来就找不到"时触发，干净信号的同步必然落在窄窗口内，
                // 因此对已有结果与验证数据没有任何影响。
                s = findSync(freq, lo, minOf(freq.size, (pos + 1.5 * step).toInt()), sr, mode.syncDurS)
            }
            if (s == null) break            // 连续一行都找不到才真的放弃
            syncStarts.add(s)
            pos = s + step
        }

        val rgb = Array(h) { FloatArray(w * 3) }
        val ycbcr = Array(h) { FloatArray(w * 3) }

        for ((idx, s) in syncStarts.withIndex()) {
            val lineIndex = if (mode.kind == "pd") 2 * idx else idx
            val r = mode.line(lineIndex) ?: continue
            var p = s + round(mode.syncDurS * sr.toDouble()).toInt()
            var pxIdx = 0
            for (seg in r.segments) {
                when (seg) {
                    is SSTVSegment.Tone -> p += round(seg.duration * sr.toDouble()).toInt()
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

    private fun findSync(freq: FloatArray, loIn: Int, hiIn: Int, sr: Int, syncDur: Float): Int? {
        val lo = maxOf(0, loIn)
        val hi = minOf(freq.size, hiIn)
        // hi <= lo 是完全可能的：录音在"一帧还没走完"时结束，上一行 sync 之后 pos 会越过
        // 信号末尾，下一轮搜索窗口整个落到音频之外。此时长度为负，BooleanArray(负数) 会抛
        // IllegalArgumentException（参考实现里则是 "Invalid typed array length"，实测 -1255）。
        // 语义上这就是"没有可搜的区间"，直接返回 null。
        if (hi <= lo) return null
        val near = BooleanArray(hi - lo) { kotlin.math.abs(freq[lo + it] - SSTVCalibration.SYNC_HZ) < 120 }
        val minLen = (0.6 * syncDur * sr.toDouble()).toInt()
        val runs = findRuns(near, minLen)
        // 取**长度最接近 syncDur** 的那一段，而不是最长的。
        //
        // 行同步的长度是制式已知的几何量（Robot 36 是 9 ms、PD 是 20 ms）；而 VIS 头里
        // 同样有 1200 Hz 结构位（break 10 ms、起始位/停止位各 30 ms），它们**比行同步
        // 还长**，所以"取最长连段"会在搜索窗口扫过 VIS 头时优先选中结构位。参考实现
        // web/sstv-engine.js 实测：窗口扫过 VIS 头时锚点被锁到 break 上，整幅画面整体错位。
        val want = (syncDur * sr.toDouble()).toInt()
        val best = runs.minByOrNull { kotlin.math.abs((it.second - it.first) - want) } ?: return null
        return lo + best.first
    }

    private fun readPx(freq: FloatArray, pos: Int, npx: Int, dur: Float, sr: Int): Pair<FloatArray, Int> {
        val tot = round(dur * sr.toDouble()).toInt()
        val out = FloatArray(npx)
        val p = pos
        for (i in 0 until npx) {
            val a = p + round(i.toDouble() * tot.toDouble() / npx.toDouble()).toInt()
            val b = p + round((i + 1).toDouble() * tot.toDouble() / npx.toDouble()).toInt()
            var bb = b
            if (bb <= a) bb = a + 1
            val bb2 = minOf(bb, freq.size)
            // 必须把中值**频率**换算回 0..255 的灰度值再交给上层。
            // 参考实现 web/sstv-engine.js 的 readPx 返回的是 valueOfFreq(median)，
            // 不是频率本身；这里曾经直接返回频率（约 1500–2300），上层当灰度用、
            // 最后 coerceIn(0,255) 全被压成 255，整幅图退化为纯白 —— M1 回环 PSNR
            // 掉到 4.9 dB（正常应 ~35.7 dB）就是这么来的。
            out[i] = if (a >= 0 && a < freq.size && bb2 > a) {
                SSTVCalibration.valueOf(sstvMedian(freq.copyOfRange(a, bb2))).toFloat()
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
