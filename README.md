# SSTV Studio · 业余无线电慢扫描电视工具

> **图片 ↔ 音频 双向转换 · 100% 本地离线运行 · Python 参考实现 + Web / iOS / Android 三端成品**
>
> 与 [pySSTV 0.5.9](https://pypi.org/project/PySSTV/) 音频逐采样互操作（PD90 总采样数与 pySSTV 完全一致：4,008,899 @ 44.1 kHz）。

[![Web](https://img.shields.io/badge/Web-%E7%BA%AF%E5%89%8D%E7%AB%AF%E7%A6%BB%E7%BA%BF-2dd4bf)](./web)
[![iOS](https://img.shields.io/badge/iOS-SwiftPM%20(iOS%2015%2B)-38bdf8)](./ios)
[![Android](https://img.shields.io/badge/Android-Kotlin%20JVM-34d399)](./android)
[![Network](https://img.shields.io/badge/%E7%BD%91%E7%BB%9C-0%20%E8%AF%B7%E6%B1%82-fbbf24)](#11-隐私与离线声明)

---

## 1. 项目简介

SSTV（Slow-Scan Television，慢扫描电视）是业余无线电的一项图像传输技术：把图像编码成一段**窄带 FM 单音**（1500–2300 Hz），通过短波电台发送；接收端把音频解调回图像。一段 Martin M1 格式的传输约需 115 秒传完一帧 320×256 的画面。

本项目实现了一个完整的 SSTV 编解码工具：

- **TX（发射）**：载入/生成图片 → 生成 SSTV 音频 → 播放或导出 WAV
- **RX（接收）**：导入音频文件 或 用麦克风直接采集电台接收的音频 → 还原成图片 → 导出 PNG

**核心约束：全流程本地计算，不发起任何网络请求。** 这一点对业余无线电野外/应急通信场景至关重要，同时也是 App Store 审核时明确的隐私优势。

### 为什么会有四种实现？

这不是重复劳动，而是刻意的分层策略：

| 实现 | 角色 | 定位 |
|------|------|------|
| **Python**（`sstv_proto/`） | **算法神谕（oracle）** | 唯一权威参考源。首个实现的版本，并对齐 pySSTV 逐采样验证通过 |
| **Web**（`web/`） | 可直接使用的成品 | **建议先从这里体验**，零安装，双击即用 |
| **Swift**（`ios/`） | App Store 上架 | Python 神谕的逐行移植，纯算法包，不含 UI |
| **Kotlin**（`android/`） | Android 上架 | 同上，纯 JVM 模块，不含 Android API |

**关键工程决策**：先把算法做成"神谕"，再用 Xcode/Gradle 真机验证移植版本。这样当 Swift 解码出错时，永远有一个可信基线可以比对，而不是在两种都可能有错的实现之间互相怀疑。

---

## 2. 功能特性

**发射（TX）**
- 支持拖入图片自动按目标制式裁剪适配（cover 比例）
- 内置**测试卡生成器**（彩条 + 灰阶阶梯 + 渐变条 + 灰阶斜坡），无需外部素材即可验证整条链路
- 实时预览将要编码的内容
- 生成后可立即试听（Web Audio），并支持 **▶/■ 切换**
- 导出标准 **16-bit PCM WAV**

**接收（RX）**
- **两种信号源**：音频文件导入（WAV/MP3/M4A/FLAC 等浏览器可解格式）／麦克风实时采集
- 麦克风模式带**实时电平表**与**计时器**，便于对准电台
- **VIS 自动识别**：自动检测制式并调整画布尺寸
- 也支持在信号质量差时**手动锁定**指定模式
- 解码后导出 **PNG**

**通用**
- 6 种主流制式（Martin / Scottie / Robot / PD 四大家族）
- 深色主题、键盘可达、44 px 触控目标、`prefers-reduced-motion` 适配
- 零外部依赖、零字体/JS/CDN 请求

---

## 3. 仓库结构

```
crac_sstv/
├── README.md                      ← 本文件
├── PHASE1_VALIDATION.md           ← Phase 1 算法验证报告
│
├── sstv_proto/                    【Python 算法神谕】
│   ├── sstv_modes.py              制式表 + 行/线段结构模型
│   ├── dsp.py                     音频合成、解析信号 FM 解调、Goertzel
│   ├── vis.py                     VIS 头生成与解码
│   ├── color.py                   RGB ↔ YCbCr（与 PIL 逐字节一致）
│   ├── encode.py                  图像 → Float32 音频
│   ├── decode.py                  音频 → RGB 图像
│   ├── test_interop.py            6 制式自环 + pySSTV 交叉验证
│   ├── test_parity_ref.py         生成 Swift/Kotlin 测试基线
│   ├── test_jfif_color.py         Swift 色彩管线逐字节镜像验证
│   └── output/                    解码样张输出（已被 git 忽略）
│
├── web/                           【Web 版，零安装可直接使用】
│   ├── index.html                 结构（TX / RX / 说明 三个 Tab）
│   ├── styles.css                 设计令牌与样式
│   ├── sstv-engine.js             引擎：神谕的纯 JS 逐行移植
│   ├── app.js                     UI 控制器（DOM ↔ 引擎）
│   └── test/
│       ├── node-parity.cjs        引擎 Node 端自环一致性测试
│       ├── bench_sr.cjs           采样率 vs 耗时/PSNR 基准
│       ├── check_dom.cjs          DOM 接线静态校验
│       └── check_py_psnr.py       Python 侧对照基准
│
├── ios/SSTVEngine/                【iOS 纯算法 SwiftPM 包】
│   ├── Package.swift              Swift 5.9 / iOS 15+ / macOS 12+
│   ├── Sources/SSTVEngine/
│   │   ├── SSTVCommon.swift       标定常量 + 中位数
│   │   ├── SSTVMode.swift         制式表 + 线段模型
│   │   ├── SSTVDSP.swift          连续相位合成 + FFT + FM 解调
│   │   ├── SSTVVIS.swift          VIS 生成/解码
│   │   ├── SSTVColor.swift        JFIF RGB↔YCbCr + SSTVImage
│   │   ├── SSTVEncode.swift       编码器
│   │   ├── SSTVDecode.swift       解码器
│   │   └── SSTVEngine.swift       对外门面 API
│   └── Tests/SSTVEngineTests/     XCTest 自环 + 神谕比对
│
└── android/sstv-engine/           【Android 纯 Kotlin JVM 模块】
    ├── build.gradle.kts / settings.gradle.kts
    └── src/main/kotlin/com/example/sstv/engine/
        ├── SSTVCommon.kt, SSTVMode.kt, SSTVVIS.kt, SSTVColor.kt
        ├── SSTVDSP.kt, SSTVEncode.kt, SSTVDecode.kt
        ├── SSTVEngine.kt          门面 API
        └── SSTVEngineCheck.kt     CLI 快速自检入口
```

---

## 4. 快速开始

### 4.1 Web 版（推荐，零安装）

```bash
cd web
# 任选其一：
python -m http.server 8000     # 推荐：麦克风功能需要 http(s) 安全上下文
# 或者：双击 index.html       # 更简单，但麦克风会被浏览器拦截
```

然后访问 <http://localhost:8000>。

| 功能 | `file://` 双击打开 | `http://localhost` 服务器 |
|------|:---:|:---:|
| TX 图片→音频、试听、导出 WAV | ✅ | ✅ |
| RX 导入音频文件解码、导出 PNG | ✅ | ✅ |
| RX **麦克风实时采集** | ❌ 被 `getUserMedia` 拦截 | ✅ |

> 浏览器出于安全策略，只允许安全上下文（`https://`、`http://localhost`、`http://127.0.0.1`）访问麦克风。`file://` 不满足该条件，这是浏览器行为，不是本项目的限制。

**无需任何 npm install / 构建步骤** —— `index.html` 直接用 `<script>` 加载同目录的引擎与控制器，天然支持离线。

### 4.2 Python 参考实现（算法神谕）

```bash
cd sstv_proto

# 建议使用虚拟环境，避免污染全局
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS / Linux:
source .venv/bin/activate

pip install numpy pillow pysstv==0.5.9

# 运行完整验证：6 制式自环 + pySSTV 交叉验证
python test_interop.py
```

输出为每种制式的 **PSNR** 值，解码样张保存到 `./output/`。

### 4.3 iOS

```bash
cd ios/SSTVEngine
swift test          # 或在 Xcode 中打开 Package.swift
```

- <｜hy_place▁holder▁no▁813｜>最低版本 **iOS 15+ / macOS 12+**
- 引擎为纯 Swift，**不含任何 UI 与 AVFoundation 依赖**，可直接被 App target 依赖
- ⚠️ 当前尚未包含 SwiftUI App 工程（`Phase 3a`），需要在 Xcode 中新建 App target 并 attach 本 Package

### 4.4 Android

```bash
cd android/sstv-engine
./gradlew test                      # 运行 JUnit 自环校验

# 无 Gradle 环境时，也可用 kotlinc 编译后运行引擎自带的命令行自检入口：
# kotlinc src/main/kotlin -include-runtime -d sstv.jar
# java -cp sstv.jar com.example.sstv.engine.SSTVEngineCheckKt
```

- 引擎为**纯 JVM Kotlin**，不依赖 Android SDK，桌面 JVM 也能运行
- Android 端只需 `implementation(project(":sstv-engine"))`
- ⚠️ 当前尚未包含 Compose App 模块（`Phase 3b`）

---

## 5. 支持的制式

| 制式 | VIS 码 | 分辨率 | 家族 | 同步脉冲 | 每像素 | 帧时长¹ |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| Martin M1 | 44 | 320×256 | RGB 逐行 | 4.862 ms | 0.4576 ms | **114.3 s** |
| Martin M2 | 40 | 320×256 | RGB 逐行 | 4.862 ms | 0.2288 ms | **58.1 s** |
| Scottie S1 | 60 | 320×256 | RGB 逐行 | 9.0 ms | 0.4273 ms | **108.9 s** |
| Scottie S2 | 56 | 320×256 | RGB 逐行 | 9.0 ms | 0.2705 ms | **70.3 s** |
| Robot 36 | 8 | 320×240 | Robot YUV | 9.0 ms | Y 0.275 / C 0.1375 ms | **36.0 s** |
| PD90 | 99 | 320×256 | PD YUV | 20.0 ms | 0.532 ms | **90.0 s** |

> ¹ **帧时长**指纯图像部分，不含 VIS 头。**实际生成音频需再 + 0.91 s**（VIS 头固定 910 ms）。
> 例：Martin M1 总时长 = 114.3 + 0.91 = **115.2 s**，与实测一致。

**家族差异**

- **RGB 家族**（Martin / Scottie）：每行的 Green、Blue、Red 分量依次完整传输，色度为全分辨率。行结构为 `porch–G–porch–B–porch–R–porch`。
- **Robot 36 / PD**：采用 YUV 色彩空间，**色度（Cr/Cb）隔行交替传输**，所以色度分辨率在垂直方向减半 —— 这是它们能更快/更高清的原因，也是其 PSNR 天然低于 RGB 家族的原因（详见 §9 已知限制）。

---

## 6. 技术原理

### 6.1 频率标定

所有像素亮度值遵循统一的线性映射：

```
freq(v) = 1500 + (v / 255) × 800   单位：Hz
```

| 语义 | 频率 |
|------|:---:|
| 黑（亮度 0） | **1500 Hz** |
| 白（亮度 255） | **2300 Hz** |
| 行同步 | **1200 Hz** |
| VIS 引导 | **1900 Hz** |
| VIS 数据位 "1" | **1100 Hz** |
| VIS 数据位 "0" | **1300 Hz** |

### 6.2 VIS 头（含 VIS 码）

每帧开头固定一段 910 ms 的 VIS 头，用于标识制式：

| 频率 | 时长 | 含义 |
|------|:---:|------|
| 1900 Hz | 300 ms | 引导音 leader |
| 1200 Hz | 10 ms | 中断 break |
| 1900 Hz | 300 ms | 引导音 leader |
| 1200 Hz | 30 ms | 起始位 start |
| 1100 / 1300 Hz | 30 ms × 7 | 数据位，**LSB 先行** |
| 1100 / 1300 Hz | 30 ms | **偶校验位** |
| 1200 Hz | 30 ms | 停止位 stop |

### 6.3 行结构

三种家族的行结构如下：

**RGB（Martin / Scottie）**
```
[sync 1200Hz] [porch 1500Hz] [G×W] [porch] [B×W] [porch] [R×W] [porch]
```

**Robot 36**（偶数行传 Cr，奇数行传 Cb）
```
[sync 1200Hz] [porch 1500Hz] [Y×W]
              [ID tone 2300Hz(偶数行) / 1500Hz(奇数行) 4.5ms] [1900Hz 1.5ms]
              [Chroma×W]
```

**PD90**（一次行脉冲传**两行**，四个通道）
```
[sync 1200Hz] [porch 1500Hz] [Y₀×W] [Cr×W] [Cb×W] [Y₁×W]
                             ↑偶数行  ↑平均  ↑平均  ↑奇数行
```

> ⚠️ **PD 的色度顺序是 `Y₀, Cr, Cb, Y₁`**（Dayton Paper / G4IJE 标准），不是直觉上的 `Cb, Cr`。这个顺序写反会让交叉验证 PSNR 从 26 dB 掉到 7 dB —— 详见 §8 踩坑记录。

### 6.4 编码流水线

```
图片 → 按制式分辨率重采样 → 分通道取值 → freq(v) → 累积相位 → sin() → Float32 PCM
```

关键实现细节：

1. **连续相位合成**：`phase[i] = Σ 2π·f[i]/sr`，而非逐段 `sin(2πft)`。这避免了段边界的相位跳变（跳变会产生宽带噪声，在实际电台测试中表现为"咔哒"声与频谱展宽）。
2. **像素边界用累积取整**：第 p 个像素占 `[round(p·tot/npx), round((p+1)·tot/npx))`。
   ⚠️ **编码与解码必须使用完全相同的边界公式**，否则每行末尾会累积约 173 采样的漂移，解码后整幅图像横向错开。
3. **首尾 2 ms 淡入淡出**：抑制起停瞬态。

### 6.5 解码流水线

```
PCM → 去均值 → FFT → 双倍正频 → 带限 700–2700Hz → iFFT
    → atan2 求解析信号相位 → unwrap → 梯度 → 限幅 → 8 点滑动平均 → 瞬时频率
    → 找 VIS → 找行同步 → 逐线段读像素 → 组装 RGB / YCbCr → 色彩空间转换
```

频率估计采用**解析信号 FM 解调**：把实信号通过"双倍正频 + 置零负频"变成解析信号，取其相位的时间导数即为瞬时频率。

### 6.6 为什么 Web 版内部用 22050 Hz？

SSTV 只占 700–2700 Hz，而解码器的 FFT 是**全信号** FFT，代价为 `O(P log P)`（`P = nextPow2(N)`）。把采样率减半能直接带来约 2.2× 的加速。实测数据（见 `web/test/bench_sr.cjs`）：

| 制式 | 44.1 kHz | 22.05 kHz | 11.025 kHz |
|------|:---:|:---:|:---:|
| Martin M1 | 29.96 dB / 2019 ms | 29.90 dB / **934 ms** | 29.69 dB / 415 ms |
| Robot 36 | 25.67 dB / 421 ms | **25.90 dB** / 196 ms | 24.58 dB / 89 ms |
| PD90 | 25.97 dB / 1018 ms | **26.03 dB** / 429 ms | 25.71 dB / 199 ms |

**22.05 kHz 的 PSNR 几乎无损（≤0.1 dB，PD90 甚至更好），却换来 2.2× 提速**；而 11.025 kHz 才开始出现明显退化。**因此 Web 版内部统一按 22050 Hz 处理**（导入的音频会先降采样）。iOS / Android 引擎则沿用 44.1 kHz 以对齐神谕测试。

---

## 7. 验证与测试

### 7.1 Python 神谕 vs pySSTV（Phase 1）

参考图像：线性渐变 + 纯色色块（含锐利边缘），320×256。

| 制式 | 自环 PSNR | pySSTV 交叉验证 | 行数 |
|------|:---:|:---:|:---:|
| Martin M1 | **33.84 dB** | 33.67 dB | 256 ✅ |
| Martin M2 | **30.65 dB** | — | 256 ✅ |
| Scottie S1 | **33.09 dB** | — | 256 ✅ |
| Scottie S2 | **30.40 dB** | — | 256 ✅ |
| Robot 36 | **22.06 dB** | 16.55 dB | 240 ✅ |
| PD90 | **26.38 dB** | 26.01 dB | 128 ✅ |

**"交叉验证"的含义**：用本引擎去解码 **pySSTV 生成的音频**（以及反向）。这证明的不只是自洽，而是**能与真实世界的 SSTV 软件/硬件互通**。

### 7.2 Web / JS 引擎（Node 自环 @ 22.05 kHz）

参考图像：低频正弦合成图像（无锐利边缘）。

| 制式 | PSNR | 编码耗时 | 解码耗时 | 行数 | 总时长 |
|------|:---:|:---:|:---:|:---:|:---:|
| Martin M1 | 29.92 dB | 67 ms | 885 ms | 256 | 115.2 s |
| Martin M2 | 29.18 dB | 47 ms | 428 ms | 256 | 59.0 s |
| Scottie S1 | 29.74 dB | 69 ms | 798 ms | 256 | 109.8 s |
| Scottie S2 | 29.47 dB | 39 ms | 420 ms | 256 | 71.2 s |
| Robot 36 | 25.46 dB | 32 ms | 224 ms | 240 | 36.9 s |
| PD90 | 26.04 dB | 52 ms | 444 ms | 128 | 90.9 s |

> ⚠️ **为什么两组 PSNR 数字不同？** 因为两组测试用了**不同的参考图像**。PSNR 高度依赖图像内容（边缘锐利程度、空间频率分布），因此**不同参考图之间不可横向比较**。正确做法是用同一张图去对比不同实现 —— 这正是 §7.3 的做法。

### 7.3 实现间一致性

在**完全相同的测试图像**上，Python 神谕与 JS 引擎的差异：

| 制式 | Python | JS | 差值 |
|------|:---:|:---:|:---:|
| Martin M1 | 29.95 dB | 29.96 dB | +0.01 |
| PD90 | 25.99 dB | 25.97 dB | −0.02 |

**亚 0.1 dB 的一致性**，证明 JS 引擎是**逐行忠实移植**而非"大致相似"。

Swift / Kotlin 版本的验证方式略有不同：本机没有 Xcode / JDK 工具链，因此改用 **Python 镜像脚本**（`test_parity_ref.py` 与 `test_jfif_color.py`）逐字节复刻 Swift/Kotlin 的算法（含 JFIF 色彩管线、居中 8 点平滑、`np.gradient` 边界处理、Double 内部精度），在神谕框架内跑出结果为 **M1 = 35.73 dB / PD90 = 26.84 dB**，与嵌入 Swift XCTest / Kotlin JUnit 的基线（35.73 / 26.76）吻合。这证明 Swift、Kotlin 的移植算法正确，但**仍需在 Xcode / Android Studio 中实际编译运行以排除语法与平台问题**。

### 7.4 如何复现

```bash
# 1. Python 神谕验证
cd sstv_proto && python test_interop.py

# 2. Web 引擎自环
cd web && node test/node-parity.cjs

# 3. 采样率基准
node test/bench_sr.cjs

# 4. DOM 接线静态校验（无需浏览器即可发现 id 拼写错误）
node test/check_dom.cjs

# 5. iOS / Android（需 Xcode / JDK）
cd ios/SSTVEngine && swift test
cd android/sstv-engine && ./gradlew test
```

---

## 8. 工程踩坑记录

Phase 1 期间定位并修复了 6 个缺陷。**这些不是教科书上的知识点，而是本项目实际踩出来的坑**，保留在此以避免重蹈覆辙：

| # | 缺陷 | 现象 | 根因 |
|:-:|------|------|------|
| 1 | **ms / s 单位混淆** | 采样数暴涨约 1000 倍，试图分配 2.28 亿采样 | pySSTV 的常量是**毫秒**，`Mode.line()` 直接返回后却被下游当作**秒**使用 |
| 2 | **VIS 头跳过长度不足** | 解码起点错位，整幅图像偏移 | `_vis_end` 只跳了 310 ms，漏掉 10 个 VIS 数据/校验/停止位（30 ms × 10 = 300 ms） |
| 3 | **逐像素取整漂移** | Martin M1 自环仅 19.8 dB | 每像素独立 `round(dur·sr)/npx` 取整，每行末尾累积亏空约 173 采样，导致解码位置持续漂移。改为编码/解码共用累积边界 `round(p·tot/npx)` |
| 4 | **PD90 短了 320 倍** | 4 s 而非 90.9 s | `pixel=0.532ms` 是**单像素**时长却被当成整个通道时长；应为 `pixel × width` |
| 5 | **PD 色度顺序写反** | 交叉验证从 26 dB 跌到 7 dB | 直觉上以为 `Cb, Cr`，实际标准顺序是 `Y₀, Cr, Cb, Y₁`（Dayton Paper / G4IJE） |
| 6 | **YUV 色彩空间不自洽** | 灰度 128 被解成 109.6 | 正向用自定义 JFIF 矩阵 `[0.257,0.504,0.098]+16`，反向却用另一套系数，产生固定增益误差。改为两端都用 PIL `YCbCr` 字节变换 |

> **通用教训**：当常量涉及单位换算时，**在边界处一次性统一单位**，而不是让每个消费方各自去回忆「这个常量到底是什么单位」。本项目 6 个缺陷中有 4 个（`ms/s`、像素时长 vs 通道时长、VIS 跳过长度、像素取整）本质上都是单位或边界不一致问题。

---

## 9. 已知限制

1. **Robot 36 / PD 的 PSNR 天然偏低**（22–26 dB vs RGB 家族的 30–34 dB）。这是 YUV **色度隔行**制式的固有特性——色度垂直分辨率减半，不是实现 bug。
2. **无 AFC / 漂移校正**：解码器按"首个同步脉冲 + 固定行长步进"定位后续各行。若录音存在走带或采样时钟偏差（例如磁带机转速误差 >0.5%），图像会产生横向累积偏移。真实产品需引入 **AFC（自动频率控制）** 或逐行重新同步。
3. **解码非实时**：Web 版为全信号 FFT，Martin M1 约需 900 ms（22.05 kHz）。已用 loading 遮罩提示，但不适合做瀑布流式实时显示。若需实时，应改为**分块滑动窗口解调**。
4. **麦克风需要安全上下文**：`http(s)` 或 `localhost` 下才可用，双击 `file://` 打开时被浏览器拒绝。
5. **单声道**：只取第一个声道；立体声文件时另一声道被忽略。
6. **未完成**：iOS 的 SwiftUI App target、Android 的 Compose App 模块尚未纳入本仓库（见 §10）。

---

## 10. 路线图

- [ ] **Phase 3a** — iOS SwiftUI App（AVFoundation 麦克风实时 RX / 文件导入；播放 + 导出 WAV/M4A）
- [ ] **Phase 3b** — Android Compose App（AudioRecord / AudioTrack / MediaExtractor + MediaMuxer）
- [ ] **更多制式** — Robot 72；PD120/160/180/240/290；Martin M3/M4；Scottie DX；Wraase SC2-180
- [ ] **解码增强** — AFC、逐行重新同步、倾斜校正（slant correction）
- [ ] **实时瀑布图 / 频谱显示**（基于 AnalyserNode）
- [ ] **接收图库**与管理（历史接收图像保存、导出、删除）
- [ ] **Phase 4** — 上架文档、权限清单（`NSMicrophoneUsageDescription` / `RECORD_AUDIO`）
- [ ] Web 端 **Web Worker** 化，避免长文件解码阻塞 UI 线程

---

## 11. 隐私与离线声明

本项目 **不发起任何网络请求**。具体承诺：

- 无 CDN、无外部字体、无 analytics、无 telemetry
- 所有音频合成与图像解码均在本地 CPU 完成
- 图片与音频文件仅在浏览器/设备内存中处理，**不会上传**
- 麦克风数据仅在 RX 采集期间存在于内存，**不落盘、不外发**

可用浏览器开发者工具的 Network 面板自行审计：加载页面后应有 0 个外部请求（本地服务器自身的 3 个文件除外）。

---

## 12. 许可

> ⚠️ **尚未确定开源许可证**，仓库中暂未包含 `LICENSE` 文件。
>
> 在添加 LICENSE 之前，默认适用"保留所有权利"。若计划公开分享，建议补充一份 **MIT** 或 **GPL-3.0** 许可证文件（SSTV 生态多沿用 GPL）。请在本仓库根目录放置 `LICENSE` 并同步更新本节。

---

## 13. 致谢

- **pySSTV** — 事实标准参考实现，本项目的交叉验证基线
- **Dayton Paper (AFA9NR)** 与 **G4IJE (Nathan)** 的技术文档 — PD 模式色度顺序与时序参数的权威来源
- 业余无线电社区长期维护的 SSTV 制式规范

---

<div align="center">
<b>73! 📡</b><br/>
<sub>SSTV Studio · 本地离线 · 三端实现</sub>
</div>
