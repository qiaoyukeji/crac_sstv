package com.example.sstv.engine

import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round

/**
 * Standalone CLI check (no test framework needed): run with
 *   kotlinc src/main -include-runtime -d sstv.jar && java -jar sstv.jar
 * It reproduces the parity test for Martin M1 and PD90 and prints round-trip PSNR.
 */
fun main() {
    val sr = 44100
    fun makeRefImage(w: Int, h: Int): SSTVImage {
        val rgb = IntArray(w * h * 3)
        for (y in 0 until h) for (x in 0 until w) {
            val i = (y * w + x) * 3
            rgb[i] = round(min(255.0, max(0.0, x * 255.0 / (w - 1)))).toInt()
            rgb[i + 1] = round(min(255.0, max(0.0, y * 255.0 / (h - 1)))).toInt()
            rgb[i + 2] = round(min(255.0, max(0.0, (x + y) * 255.0 / ((w - 1) + (h - 1))))).toInt()
        }
        return SSTVImage(w, h, rgb)
    }

    fun psnr(a: IntArray, b: IntArray): Double {
        require(a.size == b.size)
        var mse = 0.0
        for (i in a.indices) { val d = a[i] - b[i]; mse += d * d }
        mse /= a.size
        return if (mse <= 0) 100.0 else 10 * log10(255.0 * 255.0 / mse)
    }

    for (mode in listOf(SSTVMode.MARTIN_M1, SSTVMode.PD90)) {
        val img = makeRefImage(mode.width, mode.height)
        val samples = SSTVEngine.encode(img, mode, sr)
        val (decoded, _) = SSTVEngine.decode(samples, sr, mode)
        println("${mode.id}: round-trip PSNR = ${"%.2f".format(psnr(img.rgb, decoded.rgb))} dB, ${samples.size} samples")
    }
}
