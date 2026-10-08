import Foundation

/// Top-level entry point for the offline, network-free SSTV engine.
///
/// The engine is pure algorithm: it consumes/produces raw sample buffers and RGB
/// bytes, so the same package can back both the iOS (SwiftUI + AVFoundation) and the
/// Android (Kotlin) apps, and can be unit-tested on macOS/linux without any UI.
public enum SSTVEngine {

    /// Encode an image into mono Float32 audio samples (one scan per line, VIS header
    /// prepended). `sampleRate` defaults to 44100 Hz.
    public static func encode(image: SSTVImage, mode: SSTVMode, sampleRate sr: Int = 44100) -> [Float] {
        SSTVEncode.encode(image: image, mode: mode, sampleRate: sr)
    }

    /// Decode mono Float32 audio samples into an image. If `modeHint` is omitted the
    /// VIS header is detected to pick the mode automatically.
    public static func decode(samples: [Float], sampleRate sr: Int = 44100,
                             modeHint: SSTVMode? = nil) -> (image: SSTVImage, info: [String: Any]) {
        SSTVDecode.decode(samples: samples, sampleRate: sr, modeHint: modeHint)
    }

    /// Convenience: decode and return just the image (mode auto-detected).
    public static func decodeImage(samples: [Float], sampleRate sr: Int = 44100) -> SSTVImage? {
        let (img, _) = decode(samples: samples, sampleRate: sr)
        return img.width > 0 ? img : nil
    }
}
