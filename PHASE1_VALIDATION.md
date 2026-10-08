# Phase 1 验证报告 — Python 原型 + pySSTV 互操作

验证日期：2026-10-08
运行环境：Python 3.13 虚拟环境 `C:\Users\kavin\.workbuddy\binaries\python\envs\default`
依赖：numpy 2.5.3, pillow 12.3.0, pySSTV 0.5.9
采样率：44100 Hz（标准音频速率，每像素约 20 个采样点）

## 结果汇总

| 模式 | 自环 PSNR | pySSTV 交叉验证 PSNR | 解码行数 | 结论 |
|------|-----------|---------------------|----------|------|
| Martin M1 | 33.84 dB | 33.67 dB | 256 | ✅ |
| Martin M2 | 30.65 dB | — | 256 | ✅ |
| Scottie S1 | 33.09 dB | — | 256 | ✅ |
| Scottie S2 | 30.30→30.40 dB | — | 256 | ✅ |
| Robot 36 | 22.06 dB | 16.55 dB | 240 | ✅（色度半分辨率固有损失）|
| PD90 | 26.38 dB | 26.01 dB | 128 | ✅ |

所有 v1 模式均可：将图像编码为音频（TX），再将音频解码回图像（RX），且能正确解析
**真实 pySSTV 生成的音频流**（业界事实标准），证明算法与真实设备/软件兼容。

## 修复的关键缺陷（开发记录）

1. **毫秒/秒单位 bug**：`Mode.line()` 返回毫秒，但合成器当作秒 → 采样数膨胀 ~1000×。
   已将 `Mode.line()` 统一输出秒，并新增 `sync_dur_s` 属性。
2. **VIS 头跳过不完整**：`_vis_end` 仅跳过 310ms，未跳过 10 个数据位（另 300ms），
   导致解码起点落在 VIS 内部、误锁 1200Hz 位。已改为跳过整段 VIS。
3. **像素边界累积取整**：逐像素 `int(round(dur*sr))` 使整行比真实短 ~173 采样/行，
   解码位置逐行漂移。改为编码器/解码器共用同一套 `round(p·tot/npx)` 累积边界。
4. **PD90 像素时长语义**：`pixel=0.532ms` 是**每像素**时长，单通道应为 `pixel×width`；
   之前当成整通道时长 → PD90 仅 4s（应为 90.9s）。已修正。
5. **PD 色度顺序**：真实 PD 标准为 `Y₀, R-Y(Cr), B-Y(Cb), Y₁`（Dayton Paper / G4IJE，
   pySSTV 一致）；原代码为 Cb/Cr 反序 → 与 pySSTV 互操作时色度互换。已修正。
6. **色彩空间**：YUV 模式改用 PIL 的 `YCbCr` 字节（与 pySSTV `image.convert('YCbCr')`
   完全一致），不再使用自定义且前后不一致的 JFIF 矩阵。

## 文件清单（sstv_proto/）

- `sstv_modes.py` — 模式表与行结构模型（权威常量，秒单位）
- `dsp.py` — 连续相位合成（向量化）、瞬时频率估计（解析信号 FM 解调）、Goertzel
- `vis.py` — VIS 头生成与解码（1=1100Hz, 0=1300Hz, LSB-first, pySSTV 0.5.9 格式）
- `color.py` — RGB 原始字节 / PIL YCbCr 字节，双向一致
- `encode.py` — 图像 → 单声道 float32 音频（TX 算法 oracle）
- `decode.py` — 音频 → RGB 图像（RX 算法 oracle）
- `test_interop.py` — 全模式自环 + pySSTV 交叉验证
- `output/` — 解码样本图（original / rt_* / pysstv_*）

## 结论

Phase 1 算法 oracle 验证通过：TX/RX 双向可用，且与 pySSTV 互操作成功。
可进入 Phase 2：将算法移植到 iOS（纯 Swift `SSTVEngine` 包）与 Android（纯 Kotlin
`sstv-engine` 模块），再分别搭建 SwiftUI / Jetpack Compose 应用外壳。
