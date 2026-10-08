import Foundation

/// Shared SSTV calibration constants and value<->frequency mapping.
///
/// SSTV encodes each pixel's brightness as an FM tone:
///   freq(v) = 1500 + (v / 255) * (2300 - 1500) = 1500 + v/255 * 800  (Hz)
///   v(f)    = clamp((f - 1500) / 800 * 255, 0, 255)
/// Black = 1500 Hz, white = 2300 Hz, horizontal sync = 1200 Hz.
public enum SSTVCalibration {
    public static let syncHz: Float = 1200.0
    public static let blackHz: Float = 1500.0
    public static let whiteHz: Float = 2300.0

    /// Map a brightness value [0,255] to its SSTV tone frequency (Hz).
    public static func frequency(of value: Float) -> Float {
        blackHz + (value / 255.0) * (whiteHz - blackHz)
    }

    /// Map an SSTV tone frequency (Hz) back to a brightness value [0,255].
    public static func value(of freq: Float) -> Int {
        let v = (freq - blackHz) / (whiteHz - blackHz) * 255.0
        let c = min(max(v, 0), 255)
        return Int(c.rounded())
    }
}

/// Median of an array of values (mirrors numpy.median).
public func sstvMedian(_ values: [Float]) -> Float {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    let n = sorted.count
    if n % 2 == 1 {
        return sorted[n / 2]
    }
    return (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
}
