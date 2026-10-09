package com.example.sstv.engine

import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Round-trip parity tests. The Kotlin engine must reproduce the same image quality the
 * validated Python oracle achieves on the identical procedural reference image.
 * Baseline numbers come from `sstv_proto/test_parity_ref.py` (run on this exact
 * `makeRefImage` formula): Martin M1 = 35.73 dB, PD90 = 26.76 dB.
 */
class SSTVEngineTest {

    companion object {
        const val SR = 44100
        const val ORACLE_M1 = 35.73
        const val ORACLE_PD90 = 26.76
    }

    private fun makeRefImage(w: Int, h: Int): SSTVImage {
        val rgb = IntArray(w * h * 3)
        for (y in 0 until h) for (x in 0 until w) {
            val i = (y * w + x) * 3
            rgb[i] = round(min(255.0, max(0.0, x * 255.0 / (w - 1)))).toInt()
            rgb[i + 1] = round(min(255.0, max(0.0, y * 255.0 / (h - 1)))).toInt()
            rgb[i + 2] = round(min(255.0, max(0.0, (x + y) * 255.0 / ((w - 1) + (h - 1))))).toInt()
        }
        return SSTVImage(w, h, rgb)
    }

    private fun psnr(a: IntArray, b: IntArray): Double {
        require(a.size == b.size)
        var mse = 0.0
        for (i in a.indices) {
            val d = a[i] - b[i]
            mse += d * d
        }
        mse /= a.size
        if (mse <= 0) return 100.0
        return 10 * log10(255.0 * 255.0 / mse)
    }

    @Test
    fun martinM1RoundTrip() {
        val mode = SSTVMode.MARTIN_M1
        val img = makeRefImage(mode.width, mode.height)
        val samples = SSTVEngine.encode(img, mode, SR)
        val (decoded, _) = SSTVEngine.decode(samples, SR, mode)
        val p = psnr(img.rgb, decoded.rgb)
        println("M1  round-trip PSNR = $p dB (oracle $ORACLE_M1)")
        assertTrue(p > 32.0, "M1 round-trip too low: $p")
        assertTrue(p > ORACLE_M1 - 3.0, "M1 diverges from Python oracle: $p vs $ORACLE_M1")
    }

    @Test
    fun pd90RoundTrip() {
        val mode = SSTVMode.PD90
        val img = makeRefImage(mode.width, mode.height)
        val samples = SSTVEngine.encode(img, mode, SR)
        val (decoded, _) = SSTVEngine.decode(samples, SR, mode)
        val p = psnr(img.rgb, decoded.rgb)
        println("PD90 round-trip PSNR = $p dB (oracle $ORACLE_PD90)")
        assertTrue(p > 23.0, "PD90 round-trip too low: $p")
        assertTrue(p > ORACLE_PD90 - 3.0, "PD90 diverges from Python oracle: $p vs $ORACLE_PD90")
    }

    @Test
    fun visAutoDetect() {
        val mode = SSTVMode.SCOTTIE_S1
        val img = makeRefImage(mode.width, mode.height)
        val samples = SSTVEngine.encode(img, mode, SR)
        val (_, info) = SSTVEngine.decode(samples, SR)
        assertTrue(info["vis"] as? Int == mode.vis, "VIS auto-detection failed: ${info["vis"]}")
        assertTrue(info["mode"] as? String == mode.id)
    }

    // =======================================================================
    // VIS 头的结构校验。这几条不是"锦上添花"：VIS 是**帧长**的唯一来源，而帧长决定
    // 了"对方发完了没有"。识别不出 VIS 只是解不出图；**认错** VIS 却会让时间轴在对
    // 方还在发射时就走完 —— 参考实现里实测提前 19~78 s 收手，画面只剩零头，用户看到
    // 的就是"提示接收完成、但图看不出来"。所以宁可不解，也不能认成别的制式。
    // =======================================================================

    /** 手工拼一个 VIS 头：可指定第一段引导音长度、校验位对错 —— 复现真实的误码/错位。 */
    private fun buildVis(code: Int, leader1Ms: Int = 300, breakParity: Boolean = false): FloatArray {
        val segs = mutableListOf<Pair<Float, Float>>()
        segs.add(1900.0f to leader1Ms / 1000f)
        segs.add(1200.0f to 0.010f)          // break
        segs.add(1900.0f to 0.300f)          // 第二段引导音
        segs.add(1200.0f to 0.030f)          // 起始位
        var ones = 0
        for (i in 0 until 7) {
            val b = (code shr i) and 1
            ones += b
            segs.add((if (b == 1) 1100.0f else 1300.0f) to 0.030f)
        }
        var par = if (ones % 2 == 1) 1 else 0
        if (breakParity) par = 1 - par
        segs.add((if (par == 1) 1100.0f else 1300.0f) to 0.030f)
        segs.add(1200.0f to 0.030f)          // 停止位
        return SSTVDSP.synthTones(segs, SR)
    }

    private fun silence(sec: Double) = FloatArray((sec * SR).toInt())

    private fun detectVis(samples: FloatArray): VisResult =
        SSTVVIS.decode(SSTVDSP.estimateFrequency(samples, SR), SR) { SSTVMode.byVis(it) != null }

    @Test
    fun visRejectsBadParity() {
        // 校验位写反（模拟一位误码）：必须**认不出来**。旧实现不校验起始位/停止位/奇偶，
        // 会把任何 1900 Hz 连段后面的 10 个单元直接当数据位读 —— 于是随机解出一个码，
        // 若恰好落在受支持的制式上就会按错误帧长去解，画面只剩零头。
        val r = detectVis(buildVis(SSTVMode.ROBOT_36.vis, breakParity = true))
        assertTrue(r.vis == null, "校验位写反却解出了 VIS=${r.vis}")
        assertTrue(r.frameStart < 0, "校验位写反却给出了帧起点 ${r.frameStart}")
    }

    @Test
    fun visSurvivesStrayTone() {
        // 录音开头有一段杂散 1900 Hz 音（隔壁电台、啸叫、设备自激都会这样）。
        // 旧实现只认"第一个 1900 Hz 连段"，会被这段杂散音带偏 —— 它后面是静音，
        // 读出来的 10 个单元全是垃圾频率，最终整个录音"识别不出 VIS"。
        // 新实现对每个连段都试，所以能跳到真正的引导音上。
        val mode = SSTVMode.ROBOT_36
        val stream = SSTVDSP.synthTones(listOf(1900.0f to 0.6f), SR) + silence(0.5) + buildVis(mode.vis)
        val r = detectVis(stream)
        assertTrue(r.vis == mode.vis, "有杂散音时 VIS 识别失败：${r.vis}")
        val expectStart = ((0.6 + 0.5 + 0.91) * SR).toInt()
        assertTrue(kotlin.math.abs(r.frameStart - expectStart) < (0.02 * SR),
            "帧起点偏了：${r.frameStart} vs $expectStart（帧起点必须落在真正的 VIS 头之后）")
    }

    @Test
    fun visSurvivesShortFirstLeader() {
        // 录音从引导音中间才开始（第一段只剩 100 ms）：它对不上"连段末尾 + break + leader"
        // 那种对齐，必须靠第二种对齐（直接用连段末尾当起始位）才解得出来。
        val mode = SSTVMode.ROBOT_36
        val r = detectVis(buildVis(mode.vis, leader1Ms = 100))
        assertTrue(r.vis == mode.vis, "引导音只剩 100 ms 时 VIS 识别失败：${r.vis}")
        assertTrue(r.frameStart > 0, "没给出帧起点")
    }

    @Test
    fun allV1ModesEncode() {
        val img = makeRefImage(320, 256)
        for (mode in SSTVMode.V1_MODES) {
            val samples = SSTVEngine.encode(img, mode, SR)
            assertTrue(samples.size > 1000, "${mode.id} produced no audio")
            val visDur = SSTVVIS.segments(mode.vis).sumOf { it.second.toDouble() }
            val nLines = if (mode.kind == "pd") mode.height / 2 else mode.height
            val expected = ((visDur + mode.lineDuration(0) * nLines) * SR).toInt()
            val slack = max(2000, (0.02 * expected).toInt())
            assertTrue(kotlin.math.abs(samples.size - expected) < slack,
                "${mode.id} length ${samples.size} != expected ~$expected")
        }
    }
}
