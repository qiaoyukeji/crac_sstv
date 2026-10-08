import Foundation

/// A decoded/encoded image in raw RGB byte form (row-major, R,G,B per pixel).
/// The encoder consumes `rgb`; the decoder produces `rgb`. This keeps the engine
/// platform-independent (the app layer converts CGImage <-> [UInt8]).
public struct SSTVImage {
    public let width: Int
    public let height: Int
    /// RGB bytes, length = width * height * 3, row-major (top-left origin).
    public let rgb: [UInt8]

    public init(width: Int, height: Int, rgb: [UInt8]) {
        self.width = width
        self.height = height
        self.rgb = rgb
    }
}

/// Color-space handling, mirroring the de-facto `pySSTV` reference.
///
/// * RGB SSTV modes (Martin / Scottie): the encoder emits the raw 0-255 RGB bytes
///   directly, so the decoder recovers raw RGB bytes.
/// * YUV SSTV modes (Robot36, PD family): pySSTV does `image.convert('YCbCr')` and
///   emits those YCbCr bytes (Y in 16-235, Cb/Cr in 16-240). The standard JFIF
///   matrix used by PIL is reproduced here on both ends so Swift is byte-consistent
///   with pySSTV.
public enum SSTVColor {

    /// RGB -> YCbCr (JFIF), returns a flat [Float] array (length w*h*3) of Y,Cb,Cr in
    /// 0..255 (rounded + clipped), matching `image.convert('YCbCr')`.
    public static func rgbToYCbCr(_ rgb: [UInt8], _ w: Int, _ h: Int) -> [Float] {
        var out = [Float](repeating: 0, count: w * h * 3)
        for i in 0..<(w * h) {
            let r = Float(rgb[i * 3])
            let g = Float(rgb[i * 3 + 1])
            let b = Float(rgb[i * 3 + 2])
            let y  =  0.299 * r + 0.587 * g + 0.114 * b
            let cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128
            let cr =  0.5 * r - 0.418688 * g - 0.081312 * b + 128
            out[i * 3 + 0] = clamp(round(y), 0, 255)
            out[i * 3 + 1] = clamp(round(cb), 0, 255)
            out[i * 3 + 2] = clamp(round(cr), 0, 255)
        }
        return out
    }

    /// YCbCr -> RGB (JFIF inverse), returns RGB bytes (length w*h*3). Mirrors
    /// `Image.fromarray(arr, 'YCbCr').convert('RGB')`.
    public static func ycbcrToRGB(_ ycbcr: [Float], _ w: Int, _ h: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: w * h * 3)
        for i in 0..<(w * h) {
            let y = ycbcr[i * 3 + 0]
            let cb = ycbcr[i * 3 + 1] - 128
            let cr = ycbcr[i * 3 + 2] - 128
            let r = y + 1.402 * cr
            let g = y - 0.344136 * cb - 0.714136 * cr
            let b = y + 1.772 * cb
            out[i * 3 + 0] = UInt8(clamp(round(r), 0, 255))
            out[i * 3 + 1] = UInt8(clamp(round(g), 0, 255))
            out[i * 3 + 2] = UInt8(clamp(round(b), 0, 255))
        }
        return out
    }

    internal static func clamp(_ x: Float, _ lo: Float, _ hi: Float) -> Float {
        min(max(x, lo), hi)
    }
}
