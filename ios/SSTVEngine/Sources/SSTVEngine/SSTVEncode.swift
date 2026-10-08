import Foundation

/// SSTV encoder: `SSTVImage` -> mono Float32 audio samples.
///
/// Faithful Swift port of the validated Python `encode_image`:
///   * VIS header first, then per scan line: horizontal sync + segments.
///   * Per-pixel durations use cumulative rounding boundaries
///     `a = round(p*tot/npx)`, `b = round((p+1)*tot/npx)` so the decoder (which uses
///     the SAME boundaries) stays aligned and never drifts.
public enum SSTVEncode {

    /// Encode `image` in `mode` into mono Float samples at `sampleRate`.
    public static func encode(image: SSTVImage, mode: SSTVMode, sampleRate sr: Int = 44100) -> [Float] {
        let w = image.width
        let h = image.height
        let ycbcr = SSTVColor.rgbToYCbCr(image.rgb, w, h)

        var segs: [(Float, Float)] = SSTVVIS.segments(mode.vis)
        for lineIndex in 0..<h {
            guard let r = mode.line(lineIndex) else { continue }
            let (sync, segments, _) = r
            segs.append((SSTVCalibration.syncHz, sync))
            for (segIdx, seg) in segments.enumerated() {
                switch seg {
                case .tone(let freq, let dur):
                    segs.append((freq, dur))
                case .pixels(let ch, let npx, let dur):
                    let vals = channelArray(mode: mode, rgb: image.rgb, ycbcr: ycbcr,
                                            lineIndex: lineIndex, ch: ch, segIdx: segIdx, w: w)
                    let tot = Int((Double(dur) * Double(sr)).rounded())
                    for p in 0..<npx {
                        let a = Int((Double(p) * Double(tot) / Double(npx)).rounded())
                        let b = Int((Double(p + 1) * Double(tot) / Double(npx)).rounded())
                        let v = min(max(vals[p], 0), 255)
                        segs.append((SSTVCalibration.frequency(of: v), Float(b - a) / Float(sr)))
                    }
                }
            }
        }
        return SSTVDSP.synthTones(segs, sampleRate: sr)
    }

    // MARK: - channel extraction (mirrors Python _channel_array)

    private static func channelArray(mode: SSTVMode, rgb: [UInt8], ycbcr: [Float],
                                     lineIndex: Int, ch: SSTVChannel, segIdx: Int, w: Int) -> [Float] {
        let n = w
        var vals = [Float](repeating: 0, count: n)
        if mode.kind == "rgb" {
            let c = rgbChannelIndex(ch)
            for x in 0..<n { vals[x] = Float(rgb[(lineIndex * n + x) * 3 + c]) }
        } else if mode.kind == "robot" {
            for x in 0..<n {
                let base = (lineIndex * n + x) * 3
                if ch == .Y { vals[x] = ycbcr[base + 0] }
                else if ch == .CR { vals[x] = ycbcr[base + 2] }
                else if ch == .CB { vals[x] = ycbcr[base + 1] }
            }
        } else if mode.kind == "pd" {
            if ch == .Y {
                // First Y segment (segIdx==1) -> this line; second Y (segIdx==4) -> next line.
                let li = (segIdx == 1) ? lineIndex : lineIndex + 1
                for x in 0..<n { vals[x] = ycbcr[(li * n + x) * 3 + 0] }
            } else if ch == .CB {
                for x in 0..<n {
                    let a = ycbcr[((lineIndex) * n + x) * 3 + 1]
                    let b = ycbcr[((lineIndex + 1) * n + x) * 3 + 1]
                    vals[x] = (a + b) / 2.0
                }
            } else if ch == .CR {
                for x in 0..<n {
                    let a = ycbcr[((lineIndex) * n + x) * 3 + 2]
                    let b = ycbcr[((lineIndex + 1) * n + x) * 3 + 2]
                    vals[x] = (a + b) / 2.0
                }
            }
        }
        return vals
    }

    private static func rgbChannelIndex(_ ch: SSTVChannel) -> Int {
        switch ch { case .R: return 0; case .G: return 1; case .B: return 2; default: return 0 }
    }
}
