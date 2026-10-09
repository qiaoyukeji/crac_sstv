package com.example.sstv.engine

import kotlin.math.round

/**
 * A decoded/encoded image in raw RGB integer form (row-major, R,G,B per pixel, each 0..255).
 * Keeping the engine platform-independent lets both Android and iOS share the same core.
 */
data class SSTVImage(val width: Int, val height: Int, val rgb: IntArray) {
    init {
        require(rgb.size == width * height * 3) { "rgb length must be width*height*3" }
    }
    override fun equals(other: Any?): Boolean =
        other is SSTVImage && width == other.width && height == other.height && rgb.contentEquals(other.rgb)
    override fun hashCode(): Int = 31 * (31 * width + height) + rgb.contentHashCode()
}

/**
 * Color-space handling mirroring pySSTV:
 *  * RGB modes (Martin/Scottie): emit raw 0..255 RGB bytes.
 *  * YUV modes (Robot36, PD): pySSTV does image.convert('YCbCr') and emits those bytes;
 *    the standard JFIF matrix used by PIL is reproduced here on both ends, keeping the
 *    Swift/Kotlin/Python engines byte-consistent.
 */
object SSTVColor {

    /** RGB -> YCbCr (JFIF), flat FloatArray (length w*h*3) in 0..255. */
    fun rgbToYCbCr(rgb: IntArray, w: Int, h: Int): FloatArray {
        val out = FloatArray(w * h * 3)
        for (i in 0 until w * h) {
            val r = rgb[i * 3].toFloat()
            val g = rgb[i * 3 + 1].toFloat()
            val b = rgb[i * 3 + 2].toFloat()
            // 字面量必须带 f 后缀：Swift 会把 0.299 按操作数类型推断成 Float，
            // Kotlin 不会 —— 不带后缀就是 Double，混算会让 round() 的结果变 Double，
            // 后面的 coerceIn(0f, 255f) 直接类型不符。语义要与 Swift 版保持一致（全程 Float）。
            val y = 0.299f * r + 0.587f * g + 0.114f * b
            val cb = -0.168736f * r - 0.331264f * g + 0.5f * b + 128f
            val cr = 0.5f * r - 0.418688f * g - 0.081312f * b + 128f
            out[i * 3] = round(y).coerceIn(0f, 255f)
            out[i * 3 + 1] = round(cb).coerceIn(0f, 255f)
            out[i * 3 + 2] = round(cr).coerceIn(0f, 255f)
        }
        return out
    }

    /** YCbCr -> RGB (JFIF inverse), returns RGB bytes (length w*h*3). */
    fun ycbcrToRGB(ycbcr: FloatArray, w: Int, h: Int): IntArray {
        val out = IntArray(w * h * 3)
        for (i in 0 until w * h) {
            val y = ycbcr[i * 3]
            val cb = ycbcr[i * 3 + 1] - 128f
            val cr = ycbcr[i * 3 + 2] - 128f
            val r = y + 1.402f * cr
            val g = y - 0.344136f * cb - 0.714136f * cr
            val b = y + 1.772f * cb
            out[i * 3] = round(r).toInt().coerceIn(0, 255)
            out[i * 3 + 1] = round(g).toInt().coerceIn(0, 255)
            out[i * 3 + 2] = round(b).toInt().coerceIn(0, 255)
        }
        return out
    }
}
