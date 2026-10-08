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
