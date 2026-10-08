import Foundation

/// VIS header generation and decoding (authoritative pySSTV 0.5.9 format).
///
/// Header layout (freq, ms):
///   1900 Hz x300  (leader)
///   1200 Hz x10   (break)
///   1900 Hz x300  (leader 2)
///   1200 Hz x30   (start bit)
///   7 data bits, LSB-first: bit==1 -> 1100 Hz, bit==0 -> 1300 Hz, each 30 ms
///   parity bit: even parity, 1 -> 1100, 0 -> 1300, 30 ms
///   1200 Hz x30   (stop bit)
public enum SSTVVIS {

    public static let freqLeader: Float = 1900.0
    public static let freqStart: Float = 1200.0
    public static let freqBit1: Float = 1100.0
    public static let freqBit0: Float = 1300.0
    public static let freqSync: Float = 1200.0

    static let msecLeader = 300
    static let msecBreak = 10
    static let msecBit = 30

    /// Return the list of (freqHz, durationSec) describing the full VIS header.
    public static func segments(_ visCode: Int) -> [(Float, Float)] {
        var segs: [(Float, Float)] = [
            (freqLeader, Float(msecLeader) / 1000.0),
            (freqStart, Float(msecBreak) / 1000.0),
            (freqLeader, Float(msecLeader) / 1000.0),
            (freqSync, Float(msecBit) / 1000.0),   // start bit
        ]
        var v = visCode & 0x7F
        var numOnes = 0
        for _ in 0..<7 {
            let bit = v & 1
            numOnes += Int(bit)
            segs.append((bit == 1 ? freqBit1 : freqBit0, Float(msecBit) / 1000.0))
            v >>= 1
        }
        let parity = (numOnes % 2 == 1) ? 1 : 0
        segs.append((parity == 1 ? freqBit1 : freqBit0, Float(msecBit) / 1000.0))
        segs.append((freqSync, Float(msecBit) / 1000.0))   // stop bit
        return segs
    }

    /// Synthesize the VIS header audio samples for `visCode`.
    public static func samples(_ visCode: Int, sampleRate sr: Int) -> [Float] {
        SSTVDSP.synthTones(segments(visCode), sampleRate: sr)
    }

    /// Detect and decode the VIS header from an instantaneous-frequency array.
    /// Returns `(visCode, bits)` or `(nil, nil)` if not found.
    public static func decode(freq: [Float], sampleRate sr: Int) -> (vis: Int?, bits: [Int]?) {
        let near1900 = freq.map { abs($0 - freqLeader) < 150 }
        let runs = findRuns(near1900, minLen: Int(0.2 * Double(sr)))
        guard let first = runs.first else { return (nil, nil) }
        let leaderEnd = first.1
        let startBitPos = leaderEnd + Int(Double(msecBreak + msecLeader) / 1000.0 * Double(sr))
        let cell = Int(Double(msecBit) / 1000.0 * Double(sr))
        let end = startBitPos + 10 * cell
        guard end <= freq.count else { return (nil, nil) }
        var cells = [Float](repeating: 0, count: 10)
        for k in 0..<10 {
            let a = startBitPos + k * cell
            let b = startBitPos + (k + 1) * cell
            let seg = Array(freq[a..<min(b, freq.count)])
            cells[k] = sstvMedian(seg)
        }
        var bits: [Int] = []
        for k in 1..<8 {   // data bits 1..7 (LSB-first order)
            let d1 = abs(cells[k] - freqBit1)
            let d0 = abs(cells[k] - freqBit0)
            bits.append(d1 < d0 ? 1 : 0)
        }
        var vis = 0
        for k in 0..<7 {
            if bits[k] == 1 { vis |= (1 << k) }
        }
        return (vis, bits)
    }

    // MARK: - helpers

    static func findRuns(_ mask: [Bool], minLen: Int) -> [(Int, Int)] {
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
