import Foundation

/// SSTV decoder: mono Float32 audio samples -> `SSTVImage` (RGB bytes).
///
/// Faithful Swift port of the validated Python `decode_samples`. If `modeHint` is nil
/// the VIS header is detected and the mode resolved from it; otherwise the given mode
/// is assumed.
public enum SSTVDecode {

    public static func decode(samples: [Float], sampleRate sr: Int = 44100,
                             modeHint: SSTVMode? = nil) -> (image: SSTVImage, info: [String: Any]) {
        let freq = SSTVDSP.estimateFrequency(samples: samples, sampleRate: sr)

        var vis: Int?
        let mode: SSTVMode
        if let hint = modeHint {
            mode = hint
            vis = nil
        } else {
            let (v, _) = SSTVVIS.decode(freq: freq, sampleRate: sr)
            vis = v
            guard let m = (v != nil ? SSTVMode.byVis(v!) : nil) else {
                return (SSTVImage(width: 0, height: 0, rgb: []), ["vis": NSNull(), "mode": "", "lines": 0])
            }
            mode = m
        }

        let w = mode.width
        let h = mode.height
        let searchStart = visEnd(freq: freq, sampleRate: sr)
        let step = Int(Double(mode.lineDuration(0)) * Double(sr))
        let nLines = (mode.kind == "pd") ? h / 2 : h

        var syncStarts: [Int] = []
        var pos = searchStart
        for _ in 0..<nLines {
            let lo = max(0, Int(Double(pos) - 0.15 * Double(step)))
            let hi = min(freq.count, Int(Double(pos) + 0.5 * Double(step)))
            if let s = findSync(freq: freq, lo: lo, hi: hi, sr: sr, syncDur: mode.syncDurS) {
                syncStarts.append(s)
                pos = s + step
            } else {
                break
            }
        }

        var rgb = [[Float]](repeating: [Float](repeating: 0, count: w * 3), count: h)
        var ycbcr = [[Float]](repeating: [Float](repeating: 0, count: w * 3), count: h)

        for (idx, s) in syncStarts.enumerated() {
            let lineIndex = (mode.kind == "pd") ? 2 * idx : idx
            guard let r = mode.line(lineIndex) else { continue }
            let (_, segs, _) = r
            var p = s + Int((Double(mode.syncDurS) * Double(sr)).rounded())
            var pxIdx = 0
            for seg in segs {
                switch seg {
                case .tone(_, let d):
                    p += Int((Double(d) * Double(sr)).rounded())
                case .pixels(let ch, let npx, let dur):
                    let (vals, newPos) = readPx(freq: freq, pos: p, npx: npx, dur: dur, sr: sr)
                    p = newPos
                    if mode.kind == "rgb" {
                        let c = rgbChannelIndex(ch)
                        for x in 0..<npx { rgb[lineIndex][x * 3 + c] = vals[x] }
                    } else if mode.kind == "robot" {
                        for x in 0..<npx {
                            if ch == .Y { ycbcr[lineIndex][x * 3 + 0] = vals[x] }
                            else if ch == .CR { ycbcr[lineIndex][x * 3 + 2] = vals[x] }
                            else if ch == .CB { ycbcr[lineIndex][x * 3 + 1] = vals[x] }
                        }
                    } else if mode.kind == "pd" {
                        if ch == .Y {
                            let target = (pxIdx % 2 == 0) ? lineIndex : lineIndex + 1
                            for x in 0..<npx { ycbcr[target][x * 3 + 0] = vals[x] }
                        } else if ch == .CB {
                            for x in 0..<npx {
                                ycbcr[lineIndex][x * 3 + 1] = vals[x]
                                ycbcr[lineIndex + 1][x * 3 + 1] = vals[x]
                            }
                        } else if ch == .CR {
                            for x in 0..<npx {
                                ycbcr[lineIndex][x * 3 + 2] = vals[x]
                                ycbcr[lineIndex + 1][x * 3 + 2] = vals[x]
                            }
                        }
                    }
                    pxIdx += 1
                }
            }
        }

        var outRGB: [UInt8]
        if mode.kind != "rgb" {
            // Fill any line still missing its chroma plane from a neighbour.
            for i in 0..<h {
                if i % 2 == 0 && allZero(ycbcr[i], plane: 1) {
                    let nb = (i + 1 < h) ? ycbcr[i + 1] : ycbcr[max(i - 1, 0)]
                    for x in 0..<w { ycbcr[i][x * 3 + 1] = nb[x * 3 + 1] }
                }
                if i % 2 == 1 && allZero(ycbcr[i], plane: 2) {
                    let nb = (i - 1 >= 0) ? ycbcr[i - 1] : ycbcr[min(i + 1, h - 1)]
                    for x in 0..<w { ycbcr[i][x * 3 + 2] = nb[x * 3 + 2] }
                }
            }
            // Flatten ycbcr back to a flat Float array for the color conversion.
            var flat = [Float](repeating: 0, count: h * w * 3)
            for i in 0..<h {
                for j in 0..<(w * 3) { flat[i * w * 3 + j] = ycbcr[i][j] }
            }
            outRGB = SSTVColor.ycbcrToRGB(flat, w, h)
        } else {
            outRGB = [UInt8](repeating: 0, count: h * w * 3)
            for i in 0..<h {
                for j in 0..<(w * 3) {
                    outRGB[i * w * 3 + j] = UInt8(clamp(round(rgb[i][j]), 0, 255))
                }
            }
        }

        let image = SSTVImage(width: w, height: h, rgb: outRGB)
        var info: [String: Any] = ["mode": mode.id, "lines": syncStarts.count]
        info["vis"] = vis.map { $0 } as Any?
        return (image, info)
    }

    // MARK: - helpers (mirror Python decode.py)

    /// Sample index just *after* the full VIS header = start of the first h-sync.
    private static func visEnd(freq: [Float], sampleRate sr: Int) -> Int {
        let near1900 = freq.map { abs($0 - 1900.0) < 150 }
        let runs = findRuns(near1900, minLen: Int(0.25 * Double(sr)))
        if let first = runs.first {
            let leaderEnd = first.1
            let startBitPos = leaderEnd + Int((0.010 + 0.300) * Double(sr))
            let cell = Int(0.030 * Double(sr))
            return startBitPos + 10 * cell
        }
        return Int(0.95 * Double(sr))
    }

    private static func findSync(freq: [Float], lo: Int, hi: Int, sr: Int, syncDur: Float) -> Int? {
        let lo = max(0, lo)
        let hi = min(freq.count, hi)
        let near = (lo..<hi).map { abs(freq[$0] - SSTVCalibration.syncHz) < 120 }
        let minLen = Int(0.6 * Double(syncDur) * Double(sr))
        let runs = findRuns(near, minLen: minLen)
        guard let best = runs.max(by: { ($0.1 - $0.0) < ($1.1 - $1.0) }) else { return nil }
        return lo + best.0
    }

    private static func readPx(freq: [Float], pos: Int, npx: Int, dur: Float, sr: Int) -> ([Float], Int) {
        let tot = Int((Double(dur) * Double(sr)).rounded())
        var out = [Float](repeating: 0, count: npx)
        var p = pos
        for i in 0..<npx {
            let a = p + Int((Double(i) * Double(tot) / Double(npx)).rounded())
            let b = p + Int((Double(i + 1) * Double(tot) / Double(npx)).rounded())
            var bb = b
            if bb <= a { bb = a + 1 }
            let bb2 = min(bb, freq.count)
            if a >= 0 && a < freq.count && bb2 > a {
                let seg = Array(freq[a..<bb2])
                out[i] = Float(SSTVCalibration.value(of: sstvMedian(seg)))
            } else {
                out[i] = 0
            }
        }
        return (out, p + tot)
    }

    private static func rgbChannelIndex(_ ch: SSTVChannel) -> Int {
        switch ch { case .R: return 0; case .G: return 1; case .B: return 2; default: return 0 }
    }

    private static func allZero(_ row: [Float], plane: Int) -> Bool {
        for x in 0..<(row.count / 3) {
            if row[x * 3 + plane] != 0 { return false }
        }
        return true
    }

    private static func clamp(_ x: Float, _ lo: Float, _ hi: Float) -> Float {
        min(max(x, lo), hi)
    }

    private static func findRuns(_ mask: [Bool], minLen: Int) -> [(Int, Int)] {
        var runs: [(Int, Int)] = []
        var i = 0
        let n = mask.count
        while i < n {
            if mask[i] {
                var j = i
                while j < n && mask[j] { j += 1 }
                if j - i >= minLen { runs.append((i, j)) }
                i = j
            } else {
                i += 1
            }
        }
        return runs
    }
}
