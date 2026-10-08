package com.example.sstv.engine

/**
 * Top-level entry point for the offline, network-free SSTV engine. The engine is pure
 * algorithm: it consumes/produces raw sample buffers and RGB bytes, so the same module
 * backs the Android (Jetpack Compose + AudioRecord/AudioTrack/MediaMuxer) app and can be
 * unit-tested on the JVM without any device.
 */
object SSTVEngine {

    /** Encode an image into mono Float32 audio samples (VIS header prepended). */
    fun encode(image: SSTVImage, mode: SSTVMode, sampleRate: Int = 44100): FloatArray =
        SSTVEncode.encode(image, mode, sampleRate)

    /** Decode mono Float32 audio samples into an image. If [modeHint] is omitted the
     * VIS header is detected automatically. */
    fun decode(samples: FloatArray, sampleRate: Int = 44100, modeHint: SSTVMode? = null): SSTVDecodeResult =
        SSTVDecode.decode(samples, sampleRate, modeHint)

    /** Convenience: decode and return just the image (mode auto-detected), or null. */
    fun decodeImage(samples: FloatArray, sampleRate: Int = 44100): SSTVImage? {
        val (img, _) = decode(samples, sampleRate)
        return if (img.width > 0) img else null
    }
}
