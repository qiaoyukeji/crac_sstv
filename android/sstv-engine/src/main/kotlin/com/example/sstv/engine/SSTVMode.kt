package com.example.sstv.engine

/** Color channel identifiers used by SSTV line segments. */
enum class SSTVChannel { R, G, B, Y, CB, CR }

/** A single segment of a scan line. */
sealed class SSTVSegment {
    /** Fixed calibration tone (porch / chroma id / etc.). */
    data class Tone(val freq: Float, val duration: Float) : SSTVSegment()
    /** `count` pixel tones of `duration` total seconds (each pixel lasts duration/count). */
    data class Pixels(val channel: SSTVChannel, val count: Int, val duration: Float) : SSTVSegment()
}

data class SSTVLine(val sync: Float, val segments: List<SSTVSegment>, val consumed: Int)

/**
 * SSTV transmission mode. Constants are in milliseconds (pySSTV native units);
 * [line] converts them to seconds so all downstream code is unit-consistent.
 */
class SSTVMode(
    val id: String,
    val vis: Int,
    val width: Int,
    val height: Int,
    val kind: String,            // "rgb" | "robot" | "pd"
    syncDurMs: Float,
    params: Map<String, Float>
) {
    private val syncDurMs = syncDurMs
    private val params = params

    /** Horizontal sync duration in seconds. */
    val syncDurS: Float get() = syncDurMs / 1000.0f

    /** Returns the segments for [lineIndex], or null if this line is not emitted
     * (e.g. odd line of a PD pair). `consumed` = source image lines this line represents. */
    fun line(lineIndex: Int): SSTVLine? {
        val ms = 1.0f / 1000.0f
        return when (kind) {
            "rgb" -> {
                val porch = (params["porch"] ?: 0f) * ms
                val scan = (params["scan"] ?: 0f) * ms
                val n = width
                val segs = listOf(
                    SSTVSegment.Tone(1500f, porch),
                    SSTVSegment.Pixels(SSTVChannel.G, n, scan),
                    SSTVSegment.Tone(1500f, porch),
                    SSTVSegment.Pixels(SSTVChannel.B, n, scan),
                    SSTVSegment.Tone(1500f, porch),
                    SSTVSegment.Pixels(SSTVChannel.R, n, scan),
                    SSTVSegment.Tone(1500f, porch)
                )
                SSTVLine(syncDurS, segs, 1)
            }
            "robot" -> {
                val porch = (params["porch"] ?: 0f) * ms
                val yScan = (params["y_scan"] ?: 0f) * ms
                val cScan = (params["c_scan"] ?: 0f) * ms
                val chroma: SSTVChannel = if (lineIndex % 2 == 0) SSTVChannel.CR else SSTVChannel.CB
                // Robot36: even line carries Cr (id tone 2300 Hz), odd carries Cb (1500 Hz).
                val idTone = if (lineIndex % 2 == 0) 2300.0f else 1500.0f
                val segs = listOf(
                    SSTVSegment.Tone(1500f, porch),
                    SSTVSegment.Pixels(SSTVChannel.Y, width, yScan),
                    SSTVSegment.Tone(idTone, 4.5f * ms),
                    SSTVSegment.Tone(1900f, 1.5f * ms),
                    SSTVSegment.Pixels(chroma, width, cScan)
                )
                SSTVLine(syncDurS, segs, 1)
            }
            "pd" -> {
                if (lineIndex % 2 != 0) return null
                val porch = (params["porch"] ?: 0f) * ms
                // `pixel` is PER-PIXEL duration; each channel carries `width` pixels.
                val pixel = (params["pixel"] ?: 0f) * ms * width
                // PD standard (Dayton Paper / G4IJE = pySSTV): Y0, Cr, Cb, Y1.
                val segs = listOf(
                    SSTVSegment.Tone(1500f, porch),
                    SSTVSegment.Pixels(SSTVChannel.Y, width, pixel),
                    SSTVSegment.Pixels(SSTVChannel.CR, width, pixel),
                    SSTVSegment.Pixels(SSTVChannel.CB, width, pixel),
                    SSTVSegment.Pixels(SSTVChannel.Y, width, pixel)
                )
                SSTVLine(syncDurS, segs, 2)
            }
            else -> null
        }
    }

    fun lineDuration(lineIndex: Int = 0): Float {
        val r = line(lineIndex) ?: return 0f
        var total = r.sync
        for (seg in r.segments) {
            total += when (seg) {
                is SSTVSegment.Tone -> seg.duration
                is SSTVSegment.Pixels -> seg.duration
            }
        }
        return total
    }

    val frameDuration: Float
        get() {
            val n = if (kind == "pd") height / 2 else height
            return lineDuration(0) * n
        }

    companion object {
        val MARTIN_M1 = SSTVMode("Martin M1", 44, 320, 256, "rgb", 4.862f,
            mapOf("porch" to 0.572f, "scan" to 146.432f))
        val MARTIN_M2 = SSTVMode("Martin M2", 40, 320, 256, "rgb", 4.862f,
            mapOf("porch" to 0.572f, "scan" to 73.216f))
        val SCOTTIE_S1 = SSTVMode("Scottie S1", 60, 320, 256, "rgb", 9.0f,
            mapOf("porch" to 1.5f, "scan" to 136.74f))
        val SCOTTIE_S2 = SSTVMode("Scottie S2", 56, 320, 256, "rgb", 9.0f,
            mapOf("porch" to 1.5f, "scan" to 86.564f))
        val ROBOT_36 = SSTVMode("Robot 36", 8, 320, 240, "robot", 9.0f,
            mapOf("porch" to 3.0f, "y_scan" to 88.0f, "c_scan" to 44.0f))
        val PD90 = SSTVMode("PD90", 99, 320, 256, "pd", 20.0f,
            mapOf("porch" to 2.08f, "pixel" to 0.532f))

        val V1_MODES = listOf(MARTIN_M1, MARTIN_M2, SCOTTIE_S1, SCOTTIE_S2, ROBOT_36, PD90)

        fun byVis(vis: Int): SSTVMode? = V1_MODES.firstOrNull { it.vis == vis }
        fun byId(id: String): SSTVMode? = V1_MODES.firstOrNull { it.id == id }
    }
}
