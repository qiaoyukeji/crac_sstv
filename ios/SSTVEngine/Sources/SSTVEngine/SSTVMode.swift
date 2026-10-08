import Foundation

/// Color channel identifiers used by SSTV line segments.
public enum SSTVChannel: Sendable {
    case R, G, B, Y, CB, CR
}

/// A single segment of a scan line.
/// - `tone(freqHz, seconds)`           : fixed calibration tone (porch / id / etc.)
/// - `pixels(channel, count, seconds)` : `count` pixel tones of `seconds` total duration
///                                      (i.e. each pixel lasts seconds/count).
public enum SSTVSegment: Sendable {
    case tone(freq: Float, duration: Float)
    case pixels(channel: SSTVChannel, count: Int, duration: Float)

    /// Convenience: the total duration of this segment, in seconds.
    public var duration: Float {
        switch self {
        case .tone(_, let d): return d
        case .pixels(_, _, let d): return d
        }
    }
}

/// SSTV transmission mode. Constants are in milliseconds (pySSTV native units);
/// `line(_:)` converts them to seconds so all downstream code is unit-consistent.
public final class SSTVMode: Sendable {
    public let id: String
    public let vis: Int
    public let width: Int
    public let height: Int
    public let kind: String          // "rgb" | "robot" | "pd"
    let syncDurMs: Float
    let params: [String: Float]

    public init(_ id: String, vis: Int, width: Int, height: Int, kind: String,
                syncDur: Float, _ params: [String: Float]) {
        self.id = id
        self.vis = vis
        self.width = width
        self.height = height
        self.kind = kind
        self.syncDurMs = syncDur
        self.params = params
    }

    /// Horizontal sync duration in seconds.
    public var syncDurS: Float { syncDurMs / 1000.0 }

    /// Returns the segments for `lineIndex`, or nil if this line is not independently
    /// emitted (e.g. odd line of a PD pair). The returned `consumed` is the number
    /// of source image lines this emitted line represents.
    public func line(_ lineIndex: Int) -> (sync: Float, segments: [SSTVSegment], consumed: Int)? {
        let ms = 1.0 / 1000.0
        if kind == "rgb" {
            let porch = (params["porch"] ?? 0) * ms
            let scan = (params["scan"] ?? 0) * ms
            let n = width
            let segs: [SSTVSegment] = [
                .tone(freq: 1500, duration: porch),
                .pixels(channel: .G, count: n, duration: scan),
                .tone(freq: 1500, duration: porch),
                .pixels(channel: .B, count: n, duration: scan),
                .tone(freq: 1500, duration: porch),
                .pixels(channel: .R, count: n, duration: scan),
                .tone(freq: 1500, duration: porch),
            ]
            return (syncDurS, segs, 1)
        }
        if kind == "robot" {
            let porch = (params["porch"] ?? 0) * ms
            let yScan = (params["y_scan"] ?? 0) * ms
            let cScan = (params["c_scan"] ?? 0) * ms
            let chroma: SSTVChannel = (lineIndex % 2 == 0) ? .CR : .CB
            // id tone per Robot36/pySSTV: even line -> Cr (2300 Hz), odd -> Cb (1500 Hz)
            let idTone: Float = (lineIndex % 2 == 0) ? 2300.0 : 1500.0
            let segs: [SSTVSegment] = [
                .tone(freq: 1500, duration: porch),
                .pixels(channel: .Y, count: width, duration: yScan),
                .tone(freq: idTone, duration: 4.5 * ms),
                .tone(freq: 1900, duration: 1.5 * ms),
                .pixels(channel: chroma, count: width, duration: cScan),
            ]
            return (syncDurS, segs, 1)
        }
        if kind == "pd" {
            if lineIndex % 2 != 0 { return nil }
            let porch = (params["porch"] ?? 0) * ms
            // `pixel` is the PER-PIXEL duration in PD modes; each channel carries
            // `width` pixels, so its total duration is pixel * width.
            let pixel = (params["pixel"] ?? 0) * ms * Float(width)
            // Real PD standard (Dayton Paper / G4IJE, and pySSTV):
            // Y(odd line), R-Y (Cr), B-Y (Cb), Y(even line).
            let segs: [SSTVSegment] = [
                .tone(freq: 1500, duration: porch),
                .pixels(channel: .Y, count: width, duration: pixel),
                .pixels(channel: .CR, count: width, duration: pixel),
                .pixels(channel: .CB, count: width, duration: pixel),
                .pixels(channel: .Y, count: width, duration: pixel),
            ]
            return (syncDurS, segs, 2)
        }
        return nil
    }

    /// Duration of a single emitted line, in seconds (first line of the mode).
    public func lineDuration(_ lineIndex: Int = 0) -> Float {
        guard let (sync, segs, _) = line(lineIndex) else { return 0 }
        let tones = segs.compactMap { if case .tone(_, let d) = $0 { d } else { nil } }.reduce(0, +)
        let pix = segs.compactMap { if case .pixels(_, _, let d) = $0 { d } else { nil } }.reduce(0, +)
        return sync + tones + pix
    }

    /// Total frame duration in seconds.
    public var frameDuration: Float {
        let n = (kind == "pd") ? height / 2 : height
        return lineDuration(0) * Float(n)
    }

    // MARK: - v1 mode table (exact pySSTV 0.5.9 constants)

    public static let martinM1 = SSTVMode("Martin M1", vis: 44, width: 320, height: 256, kind: "rgb",
                                         syncDur: 4.862, ["porch": 0.572, "scan": 146.432])
    public static let martinM2 = SSTVMode("Martin M2", vis: 40, width: 320, height: 256, kind: "rgb",
                                         syncDur: 4.862, ["porch": 0.572, "scan": 73.216])
    public static let scottieS1 = SSTVMode("Scottie S1", vis: 60, width: 320, height: 256, kind: "rgb",
                                          syncDur: 9.0, ["porch": 1.5, "scan": 136.74])
    public static let scottieS2 = SSTVMode("Scottie S2", vis: 56, width: 320, height: 256, kind: "rgb",
                                          syncDur: 9.0, ["porch": 1.5, "scan": 86.564])
    public static let robot36 = SSTVMode("Robot 36", vis: 8, width: 320, height: 240, kind: "robot",
                                        syncDur: 9.0, ["porch": 3.0, "y_scan": 88.0, "c_scan": 44.0])
    public static let pd90 = SSTVMode("PD90", vis: 99, width: 320, height: 256, kind: "pd",
                                     syncDur: 20.0, ["porch": 2.08, "pixel": 0.532])

    public static let v1Modes: [SSTVMode] = [martinM1, martinM2, scottieS1, scottieS2, robot36, pd90]

    public static func byVis(_ vis: Int) -> SSTVMode? {
        v1Modes.first { $0.vis == vis }
    }
    public static func byId(_ id: String) -> SSTVMode? {
        v1Modes.first { $0.id == id }
    }
}
