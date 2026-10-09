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
- 支持拖入图片，**三种画面适配方式可选**：
  - **适应（contain，默认）** —— 完整保留原图，比例不足处补黑边，**不裁任何内容**
  - **填充（cover）** —— 填满画布，裁掉溢出部分
  - **拉伸（stretch）** —— 直接铺满，比例不一致时画面变形

  选择后会实时给出量化说明（例如"原图 1200×1600（3:4）→ 画布 320×256（5:4）：完整保留 → 左右补黑边共占 40%"），有内容损失或变形时以警示色标出
- 内置**测试卡生成器**（彩条 + 灰阶阶梯 + 渐变条 + 灰阶斜坡），无需外部素材即可验证整条链路
- 实时预览**真正待发送的位图**（黑边/裁剪一目了然）
- 发送时在图片上叠加**进度遮罩**：已发送区域保持清晰、未发送区域压暗、扫描线随进度推移，并显示百分比与 `mm:ss / mm:ss` 计时——与实际发送进度同步
- 导出标准 **16-bit PCM WAV**

**接收（RX）**
- **两种信号源**：音频文件导入（WAV/MP3/M4A/FLAC 等浏览器可解格式）／麦克风实时采集
- **实时逐行成像（麦克风）**：画面随着信号到达**一行行长出来**，不是等录音结束才一次性出图——
  - 顶部徽标显示已收行数与百分比，扫描线标出正在写入的那一行
  - 未收到的区域是暗底 + 细横线，因此"正在生长"的过程肉眼可见
  - 停止录音后自动用批量算法**精确重解**一遍校验（两者共用同一份逐行数学，实测一致到 50 dB 以上）
  - 可关闭（`实时逐行成像` 开关），关闭后回到"录完再点解码"的批处理流程
- 麦克风模式带**实时电平表**与**计时器**，便于对准电台
- **VIS 自动识别**：自动检测制式并调整画布尺寸
- 也支持在信号质量差时**手动锁定**指定模式
- 解码后导出 **PNG**

**通用**
- 6 种主流制式（Martin / Scottie / Robot / PD 四大家族）
- 深色主题、键盘可达、44 px 触控目标、`prefers-reduced-motion` 适配
- 零外部依赖、零字体/JS/CDN 请求

**安卓 App**
- **WebView 壳 App**（`android/app/`）：把上面这套界面原样装进安卓，产出可直接安装的 APK
- 复用同一份 JS 引擎，因此功能与 Web 版**完全一致**；构建时从 `web/` 同步，仓库里不存副本
- 补齐了"浏览器有、WebView 没有"的四件事：**安全上下文**（用 `WebViewAssetLoader`
  以 https 提供本地资源，麦克风才可用）、**运行时权限**、**文件导入**、**文件导出**
  （写进系统的 `下载/SSTV/`）
- **不申请 `INTERNET` 权限** —— 把"100% 离线"从代码承诺升级为系统级事实
- **Gitee Go 云打包**：推送到 `main` 自动出 APK，本地不需要装 Android Studio

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
│   ├── sstv-engine.js             引擎：神谕的纯 JS 逐行移植（含流式增量解调器）
│   ├── app.js                     UI 控制器（DOM ↔ 引擎）+ 麦克风环境自检 + 逐行成像
│   ├── serve.py                   HTTP(8000) + HTTPS(8443) 服务，自动签发本地证书
│   ├── HTTPS_MIC_GUIDE.md         手机端启用麦克风的完整指南（含证书安装）
│   ├── tools/
│   │   ├── gen_cert.py            本地 CA + 服务器证书生成（SAN 覆盖全部内网 IP）
│   │   ├── tunnel.sh              跨网段公网访问一键脚本（cloudflared，已固化两个坑）
│   │   └── cloudflared-sstv.yml   隧道独立配置，规避无关的 ~/.cloudflared/config.yml
│   └── test/
│       ├── node-parity.cjs        引擎 Node 端自环一致性测试
│       ├── bench_sr.cjs           采样率 vs 耗时/PSNR 基准
│       ├── check_dom.cjs          DOM 接线静态校验
│       ├── mic_probe_test.cjs     麦克风环境探测逻辑的沙箱化单元测试
│       ├── fit_test.cjs           画面适配（contain/cover/stretch）数学单测
│       ├── e2e_fit_progress.cjs   真实浏览器 E2E：适配不裁剪 + 发送进度遮罩
│       ├── e2e_remote_securectx.cjs  对任意 URL 验证安全上下文与麦克风可用性
│       ├── e2e_rx_decode.cjs      真实浏览器 E2E：WAV 导入 → 解码 → 像素校验 → PNG
│       ├── stream_decode_test.cjs 流式增量解调 vs 批量：一致性 + 渐进性
│       ├── decode_robust_test.cjs 批量解码健壮性：帧中截断 / 中间掉音
│       ├── e2e_live_rx.cjs        真实浏览器 E2E：假麦克风喂 SSTV，验证逐行成像
│       ├── shots/                 E2E 截图输出（已被 git 忽略）
│       └── check_py_psnr.py       Python 侧对照基准
│
├── certs/                         【本地自签证书（不进版本库，自动生成）】
│   ├── ca.crt / ca.der            根证书（供 Android / iOS 安装）
│   ├── ca.key                     根私钥（仅本机，勿外传）
│   ├── server.crt / server.key    服务器证书（820 天，符合 iOS 上限）
│   └── sstv-ca.mobileconfig       iOS 配置描述文件
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
├── .workflow/
│   └── android-apk.yml            Gitee Go 流水线：云打包 APK
│
└── android/                       【Android 端：WebView 壳 App + 纯 Kotlin 引擎】
    ├── README.md                  壳 App 的取舍，以及四个"浏览器有、WebView 没有"的坑
    ├── settings.gradle.kts        多模块根工程（:app + :sstv-engine）
    ├── build.gradle.kts           插件版本统一声明（apply false）
    ├── gradle.properties          内存与并行策略（CI 求稳，不求快）
    ├── gradlew / gradlew.bat      Gradle Wrapper（8.7，distributionUrl 指向腾讯镜像）
    ├── tools/ci-build-apk.sh      云打包入口：装工具链 + 打包（CI 与本地共用同一份）
    ├── keystore.properties.example  正式签名模板（真实文件已被 git 忽略）
    │
    ├── app/                       【WebView 壳 App —— 产出 APK】
    │   ├── build.gradle.kts       含 syncWebAssets：把 web/ 同步进 assets/www
    │   └── src/main/
    │       ├── AndroidManifest.xml        RECORD_AUDIO，刻意不申请 INTERNET
    │       ├── java/com/qiaoyukeji/sstv/MainActivity.kt
    │       │                              WebView + 安全上下文 + 权限 + 文件导入导出桥
    │       └── res/                       矢量图标 + 深色主题（无二进制素材）
    │
    └── sstv-engine/               【纯 Kotlin JVM 引擎，不含 Android API】
        ├── build.gradle.kts
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
# 推荐：一条命令同时启动 HTTP(8000) + HTTPS(8443)，证书缺失时自动生成
python web/serve.py

# 只想要最简静态服务（注意：手机端将无法使用麦克风）
python -m http.server 8000 --bind 0.0.0.0 -d web
```

按用途选择地址：

| 使用场景 | 打开地址 | 麦克风 |
|---------|---------|:---:|
| 本机日常使用（推荐） | `https://localhost:8443` | ✅ |
| 本机使用（免装证书） | `http://localhost:8000` | ✅ |
| **同网段手机 / 平板** | `https://<本机IP>:8443`（需先安装根证书） | ✅ |
| 同网段手机，未装证书 | `http://<本机IP>:8000` | ❌ |
| **不同网段 / 外网远程访问** | `https://<随机词>.trycloudflare.com`（见 §4.1.1） | ✅ 免装证书 |
| 双击 `index.html`（`file://`） | — | ❌ |

| 功能 | `file://` | `http://localhost` | `http://<局域网IP>` | `https://<局域网IP>` |
|------|:---:|:---:|:---:|:---:|
| TX 图片→音频、发送（含进度遮罩）、导出 WAV | ✅ | ✅ | ✅ | ✅ |
| RX 导入音频文件解码、导出 PNG | ✅ | ✅ | ✅ | ✅ |
| RX **麦克风实时采集** | ❌ | ✅ | ❌ | ✅ |

> ⚠️ **`http://` + 局域网 IP 不是「安全上下文」。** 这是手机端「无法录音」的**唯一根因**：浏览器会直接把 `navigator.mediaDevices` 置为 `undefined`，并因此常被误判成"浏览器不支持麦克风"。
> 完整解决步骤（含 Android / iOS 证书安装）见 **[web/HTTPS_MIC_GUIDE.md](web/HTTPS_MIC_GUIDE.md)**。应用自身也内置了环境自检，会在麦克风面板直接告诉你当前处于哪种状态、以及该怎么做。

**无需任何 npm install / 构建步骤** —— `index.html` 直接用 `<script>` 加载同目录的引擎与控制器，天然支持离线。

#### 4.1.1 远程访问（不在同一网段）

局域网 IP 只在同一网段有效。要在外网/异地访问，用 cloudflared 隧道把本机服务暴露成一个公网 HTTPS 域名：

```bash
bash web/tools/tunnel.sh
```

脚本会确保本地服务在跑、建立隧道、并打印形如 `https://xxx-yyy.trycloudflare.com` 的公网地址。因为是**出站连接**，所以**不需要公网 IP、不需要路由器端口映射、也不受运营商 NAT 限制**；域名自带受信任证书，**手机麦克风直接可用，无需安装任何根证书**。

两个必须避开的坑（脚本已固化，手动执行时务必注意）：

| 现象 | 原因 | 做法 |
|------|------|------|
| HTTP **530** / 错误码 **1033** | origin 用 `localhost` 被解析成 IPv6 `::1`，而 Python 服务只监听 IPv4 | origin 写 **`127.0.0.1`** |
| HTTP **404**（日志无回源记录） | cloudflared 默认加载 `~/.cloudflared/config.yml`，其 ingress 兜底是 `http_status:404` | 加 **`--config web/tools/cloudflared-sstv.yml`** |

> 判别技巧：**530/1033 = 连不上回源（网络层）；404 = 连上了但路由规则不匹配（配置层）**。
>
> ⚠️ 隧道开启期间网址**无身份校验**，拿到即可访问；用完请关闭，长期开放建议在 Cloudflare Zero Trust 加 Access 策略。想要固定域名可用 `bash web/tools/tunnel.sh --named`（会新增一条 Cloudflare DNS 记录，详见指南 §3.4）。
>
> 另有一种不依赖本机常驻的做法：用 WorkBuddy 的「发布为应用」把 `web/` 静态发布到在线链接（同样自带 HTTPS），适合只读浏览与长期分享。



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

Android 端是一个 **WebView 壳 App**（`android/app/`）：把 `web/` 那份离线前端装进 WebView，
补齐安全上下文、麦克风权限、文件导入导出这三件事。它复用同一份 JS 引擎，所以功能与 Web 版完全一致；
详细取舍与踩坑见 **[android/README.md](android/README.md)**。

```bash
# 一条命令：自动装 Android SDK 并打包（需要 JDK 17，其余脚本自己搞定）
export JAVA_HOME=/path/to/jdk-17
bash android/tools/ci-build-apk.sh

# 产物
#   android/app/build/outputs/apk/debug/app-debug.apk
#   android/app/build/outputs/apk/release/app-release.apk

# 只跑算法库的 JUnit 自环校验（纯 JVM，不需要 Android SDK）
cd android && ./gradlew :sstv-engine:test
```

**云打包（Gitee Go）**：推送到 Gitee 的 `main` 分支会自动触发
[`.workflow/android-apk.yml`](.workflow/android-apk.yml)，在云构建机上装好工具链并产出 APK；
也可以在仓库页「Gitee Go → 流水线」手动点「运行」。构建机会缓存 `~/.gradle`、`~/.android`
与已装好的 Android SDK，**首次慢、之后快**。首次使用需在 Gitee 仓库页手动开通 Gitee Go。

- 壳 App 的**唯一前端真源仍是 `web/`**：构建时由 `app/build.gradle.kts` 的 `syncWebAssets`
  任务同步进 `assets/www`，仓库里不存副本（存副本一定会漂移）
- `android/sstv-engine/` 是**纯 Kotlin JVM** 算法库，不依赖 Android SDK，桌面 JVM 也能运行；
  壳 App 当前不依赖它，留作将来写原生界面的地基
- ⚠️ 原生 Compose 界面（`Phase 3b`）仍未开始 —— 当前壳 App 走的是 WebView 路线

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

### 6.6 为什么能做到"边收边解"（实时逐行成像）

`decodeSamples()` 对**整段**信号做一次全域 FFT 求解析信号，代价 `O(N log N)`。录音过程中每来一块音频就重跑一遍，总代价是 `O(N²)`——Martin M1 这种两分多钟的制式会直接把主线程拖死。而"逐行显示"真正需要的只是**新到的那一小段音频的频率估计**。

`createStreamDecoder()` 的做法是把信号切成 `BLOCK = 4096` 采样（≈186 ms）的块，每块在左侧多取 `OVERLAP = 512`、右侧多留 `GUARD = 512` 个采样点做上下文，只把中间 4096 个估计**追加**到全局 `freq` 数组：

```
buf:   ...│← OVERLAP →│←───── 提交 BLOCK ─────→│← GUARD →│
freq:          ...已提交...  ┊ 本次追加 4096 个 ┊   （丢弃）
```

- 每次只算一个 8k 点 FFT（~1 ms），与录音同速推进，永不积压
- `freq` 是**追加**的，所以找同步（`findSync`）、读像素（`readPx`）全部复用批量路径的同一份代码——不存在"两套实现悄悄漂移"
- 行与行之间天然独立（每行 = 同步脉冲 + 若干色带，自包含），所以"这一行数据到齐了就立刻解码并上屏"是严格的，不是动画
- 唯一例外是 **Robot 36 的色度隔行**：偶数行只带 Cr、奇数行只带 Cb，缺的那一路要借相邻行，因此偶数行**刻意延迟一行**才上屏（宁可晚一行，也不要先画错色再回头改）

实测一致性（`web/test/stream_decode_test.cjs`，6 制式 × 2 采样率 × 多种分块序列）：

| 制式 | 流式 vs 批量 PSNR | 整幅行数 | 参考图 PSNR（批量 / 流式） |
|------|:---:|:---:|:---:|
| Martin M1 | **59.44 dB** | 256/256 | 29.92 / 29.92 dB |
| Martin M2 | 55.25 dB | 256/256 | 29.18 / 29.18 dB |
| Scottie S1 | 59.51 dB | 256/256 | 29.74 / 29.74 dB |
| Scottie S2 | 57.04 dB | 256/256 | 29.47 / 29.47 dB |
| Robot 36 | 50.61 dB | 240/240 | 25.46 / 25.47 dB |
| PD90 | 52.79 dB | 256/256 | 26.04 / 26.04 dB |

50 dB 意味着逐像素差异 ≤1 个灰阶——**流式结果与批量结果在数值上等价**，分块没有引入任何可见代价。

> 增量解调只在**麦克风**路径启用（原生采样率直入，不做重采样）；文件导入仍走批处理，因为文件不需要"等"，而批处理的 FFT 摊到一整段上更省。

### 6.7 为什么 Web 版内部用 22050 Hz？

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

# 5. 麦克风环境探测逻辑单测（沙箱执行生产代码，覆盖 4 类环境 × 9 种错误名）
node test/mic_probe_test.cjs

# 6. 画面适配数学单测（contain/cover/stretch + 不变量）
node test/fit_test.cjs

# 7. 真实浏览器 E2E（需本机服务已启动；验证竖图不裁剪 + 发送进度遮罩）
node test/e2e_fit_progress.cjs

# 7b. 安全上下文与麦克风可用性验证（可对任意地址跑，含公网隧道域名）
SSTV_URL=https://xxx-yyy.trycloudflare.com/ node test/e2e_remote_securectx.cjs

# 7c. RX 解码 E2E（生成 WAV → 导入 → 解码 → 校验画布像素 → 导出 PNG）
node test/e2e_rx_decode.cjs

# 7d. 流式（边收边解）解码器验证：与批量一致性 + 真的在逐行推进
node test/stream_decode_test.cjs

# 7e. 批量解码健壮性：帧中被截断、中间掉音（这两个缺陷只在真实录音路径上暴露）
node test/decode_robust_test.cjs

# 7f. 实时逐行成像 E2E（用假麦克风把 SSTV WAV 喂给真实 Chrome）
node test/e2e_live_rx.cjs

# 8. iOS / Android（需 Xcode / JDK）
cd ios/SSTVEngine && swift test
cd android/sstv-engine && ./gradlew test
```

### 7.5 界面行为的浏览器端验证

算法之外的界面逻辑同样需要可证伪的验证。`web/test/e2e_fit_progress.cjs` 用 **Playwright + 真实 Chromium** 驱动页面，不依赖人工目视：

- 在页面内现造一张「顶部纯红 / 中部绿渐变 / 底部纯蓝」的竖构图 1200×1600 图片，通过 `drag&drop` 交给应用
- 直接读取 `#tx-preview` 画布像素（它就是待编码的那张位图），以「上下两条色带还在不在」为判据：
  - `contain` → 红带、蓝带**均保留**，左右为黑边，中部为绿色内容 ✅
  - `cover` → 红带、蓝带**均被裁掉**，左右无黑边（复现原缺陷）✅
  - `stretch` → 色带都在且左右无黑边 ✅
- 点发送后连续采样 `aria-valuenow` / 遮罩高度 / 扫描线位置，断言**进度单调递增**、`mask 高度 = 100 − 百分比`、扫描线位置与百分比一致、结束后遮罩自动收起

实测 Robot 36（36 s）发送过程：

| 时刻 | 进度 | 未发送区域高度 | 遮罩文案 |
|:---:|:---:|:---:|---|
| t+0.0 s | 0% | 99.6% | `● 正在发送 0% · 00:00 / 00:36` |
| t+5.0 s | 15% | 85.5% | `● 正在发送 15% · 00:05 / 00:36` |
| t+10.0 s | 28% | 71.6% | `● 正在发送 28% · 00:10 / 00:36` |
| t+15.0 s | 42% | 57.7% | `● 正在发送 42% · 00:15 / 00:36` |
| t+19.5 s | 55% | 45.1% | `● 正在发送 55% · 00:20 / 00:36` |

**29 项断言全部通过**，截图见 `web/test/shots/`。同一套测试也**对公网隧道域名跑过一次（同样 29/29 通过）**，证明远程访问路径上的界面行为与本地一致。

### 7.6 安全上下文与麦克风可用性

`web/test/e2e_remote_securectx.cjs` 用真实浏览器对任意地址探测 `isSecureContext` / `navigator.mediaDevices`，并**实际调用一次 `getUserMedia`**（headless 下用 `--use-fake-device-for-media-stream` 提供虚拟音频设备）。

| 被测地址 | `isSecureContext` | `mediaDevices` | `getUserMedia` | 通过数 |
|---------|:---:|:---:|:---:|:---:|
| `http://<局域网IP>:8000` | `false` | `undefined` | ✗ `TypeError` | 2/6 |
| `https://<隧道域名>`（cloudflared） | `true` | 可用 | ✓ 拿到音轨 | **6/6** |

这组对照直接证明了：**手机端「无法录音」的根因是地址形态，不是浏览器能力**；而公网 HTTPS 隧道天然满足安全上下文，**无需安装任何证书**即可使用麦克风。

### 7.7 RX 解码路径

`web/test/e2e_rx_decode.cjs` 覆盖「音频 → 图片」这条完整链路（此前恰恰是 E2E 的空白区，详见踩坑记录第 11 条）：

1. 用引擎生成一张**方向性明确**的参考图（R 沿 x 渐变 / G 沿 y 渐变 / B 恒 128）并编码为 Martin M1 WAV
2. 通过 `<input type=file>` 真实导入 → 点「解码」
3. **直接读取 `#rx-preview` 画布像素**做量化断言，而不是只看状态文字：

| 断言 | 实测 |
|------|------|
| 画布尺寸 = 320×256、非黑像素 > 90% | 100.0% |
| 三通道均值 ≈ 源图（R/G/B 渐变与常量） | R 127.3 / G 127.5 / B 127.7 |
| R 左暗右亮（水平未颠倒） | 12.8 → 241.8 |
| G 上暗下亮（垂直未颠倒） | 12.5 → 242.9 |
| `toBlob` 产出合法 PNG（magic 头校验） | 23,429 字节 |
| 全程无未捕获 JS 异常 | 无 |

**17 项断言全部通过**，本地与公网隧道域名各跑一次，结果一致；截图见 `web/test/shots/rx_decode_result.png`。

### 7.8 实时逐行成像（麦克风）

这一条最容易被"假实现"蒙混过去——**先一次性解完，再按时间轴播一段逐行显示的动画**。截图看起来一模一样，但用户必须先等完整段信号。所以断言不能是"画面对不对"，而必须是：

> 画布上的像素，是不是**在信号还在到达的过程中**一行一行被写上去的？

`web/test/e2e_live_rx.cjs` 用 Chrome 的 `--use-file-for-fake-audio-capture` 把**我们自己编码的 SSTV WAV 喂成麦克风输入**，等于给浏览器装了一个电台。测试在页面内重建"待机底"参考图并逐行比对，得到"顶部连续已画行数"的时间曲线：

```
t=0.0s  画布已画 8 行   徽标 8/240   扫描线 top=3.3%
t=1.2s  画布已画 16 行  徽标 16/240  扫描线 top=6.7%
...
t=11.1s 画布已画 82 行  徽标 82/240  扫描线 top=34.2%
```

| 断言 | 实测 |
|------|------|
| 画布切到制式尺寸 320×240、遮罩显示、进入 receiving 态 | ✅ |
| 观察窗口开始时 0 < 已画 < 整幅 | 8 / 240 |
| 已画行数单调不减 | 8 → 16 → 24 → 34 → 42 → 50 → 58 → 66 → 74 → 82 |
| 生长速率与制式行速吻合（6.7 行/s ±40%） | **6.68 行/s** |
| 未画满时底部仍是"待机底"（探针自证） | ✅ |
| 徽标行数与画布已画行数一致（±2） | 82 vs 82 |
| 停止后自动批量精确重解，且未报崩溃 | 95/95 行，93 ms |
| 完整录满整幅（36 s） | 实时 239/240，批量 239/240 |
| 两条独立解码路径结果一致（±2 行） | 239 vs 239 |
| R 左暗右亮 / G 上暗下亮 | 34.9 → 202.3 / 16.5 → 231.0 |
| PNG 导出（magic 头校验）、无未捕获异常 | 113 KB ✅ |

**这个测试立刻逼出了批量解码器的两个真实缺陷（踩坑记录第 12、13 条）**——它们只在"录音中途停止""信号中间掉一小块"这类真实使用路径上才会出现，用完整的合成 WAV 永远测不到。截图见 `web/test/shots/live_rx_progress.png`、`live_rx_full.png`。

---

## 8. 工程踩坑记录

Phase 1 期间定位并修复了 6 个算法缺陷，后续修复第 7、8 项（Web 端麦克风诊断、画面适配）、第 9、10 项（远程访问隧道的两个网络/配置陷阱）、第 11 项（RX 解码的 RGB/RGBA 类型错误）、第 12、13 项（批量解码器在真实录音下的两个边界缺陷，由实时逐行成像的 E2E 逼出）。**这些不是教科书上的知识点，而是本项目实际踩出来的坑**，保留在此以避免重蹈覆辙：

| # | 缺陷 | 现象 | 根因 |
|:-:|------|------|------|
| 1 | **ms / s 单位混淆** | 采样数暴涨约 1000 倍，试图分配 2.28 亿采样 | pySSTV 的常量是**毫秒**，`Mode.line()` 直接返回后却被下游当作**秒**使用 |
| 2 | **VIS 头跳过长度不足** | 解码起点错位，整幅图像偏移 | `_vis_end` 只跳了 310 ms，漏掉 10 个 VIS 数据/校验/停止位（30 ms × 10 = 300 ms） |
| 3 | **逐像素取整漂移** | Martin M1 自环仅 19.8 dB | 每像素独立 `round(dur·sr)/npx` 取整，每行末尾累积亏空约 173 采样，导致解码位置持续漂移。改为编码/解码共用累积边界 `round(p·tot/npx)` |
| 4 | **PD90 短了 320 倍** | 4 s 而非 90.9 s | `pixel=0.532ms` 是**单像素**时长却被当成整个通道时长；应为 `pixel × width` |
| 5 | **PD 色度顺序写反** | 交叉验证从 26 dB 跌到 7 dB | 直觉上以为 `Cb, Cr`，实际标准顺序是 `Y₀, Cr, Cb, Y₁`（Dayton Paper / G4IJE） |
| 6 | **YUV 色彩空间不自洽** | 灰度 128 被解成 109.6 | 正向用自定义 JFIF 矩阵 `[0.257,0.504,0.098]+16`，反向却用另一套系数，产生固定增益误差。改为两端都用 PIL `YCbCr` 字节变换 |
| 7 | **把"非安全上下文"误报成"浏览器不支持"** | 手机通过局域网访问时，点录音永远提示"浏览器不支持麦克风采集" | `http://` + 局域网 IP 不是安全上下文，浏览器会把 `navigator.mediaDevices` 置为 `undefined`。原代码只判断接口是否存在，于是把安全策略的主动禁用说成了浏览器能力缺失。已改为分层探测（`isSecureContext` → `mediaDevices` → 按 `getUserMedia` 错误名归因），并配套提供本地可信 HTTPS 方案 |
| 8 | **上传的图片被裁掉上下（静默的破坏性默认值）** | 竖构图手机照片（3:4）放进 5:4 制式画布后，顶部和底部的内容凭空消失 | 适配逻辑写死为 CSS `cover` 语义 —— 填满画布并裁掉溢出，且**没有任何提示**。用户不知道内容被丢掉了，也不知道本可以选择。已改为三选一（contain 默认 / cover / stretch），并在每次选择后输出**量化说明**（"完整保留 → 左右补黑边共占 40%"/"裁掉上下共 40%"），有损失或变形时以警示色标出。这正是"默认值必须是可逆的"这一原则的反例：**破坏性操作不能作为默认** |
| 9 | **隧道回源被 IPv6 打回（HTTP 530 / 错误码 1033）** | 公网域名能打开但报 Argo Tunnel 错误，本机访问一切正常 | origin 写的是 `localhost`，cloudflared 优先解析为 IPv6 `::1`；而 `python -m http.server --bind 0.0.0.0` **只监听 IPv4**，回源连接被拒。改用 `127.0.0.1` 即恢复。**教训：「本机好好的」不代表回环的另一个协议栈也通** |
| 10 | **隧道继承了别的项目的 ingress（HTTP 404）** | 隧道显示已连接，但公网访问一律 404，且 cloudflared 日志里**没有任何回源记录** | cloudflared 默认加载 `~/.cloudflared/config.yml`，那份配置属于另一个项目，其 ingress 兜底是 `http_status:404`，把所有请求都挡在边缘。加 `--config` 指定独立配置即恢复。**判别技巧：530/1033 是连不上回源（网络层），404 是连上了但路由不匹配（配置层）** |
| 11 | **RGB 当 RGBA 塞进 `ImageData`（解码"失败"其实是渲染失败）** | 手机上点「解码」报 `Failed to construct 'ImageData': The input data length is not equal to (4 * width * height)`，并被提示"可尝试手动指定模式"，让人以为信号不好 | 引擎输出的是 **RGB（3 字节/像素，245,760）**，而 `new ImageData()` 规范要求 **RGBA（4 字节/像素，327,680）**，恰好差 4/3 倍。已增加 `rgbToImageData()` 显式展开（alpha=255）并校验长度；同时把「解调」与「显示」两个阶段的错误分开上报 —— **渲染错误不再冒名顶替成"解码失败"**，避免把前端类型问题误导成射频问题。**这个缺陷之所以漏到现在，是因为此前的 E2E 只覆盖 TX，没覆盖 RX** |
| 12 | **录音在帧中间结束时解码器崩溃（`Invalid typed array length: -1255`）** | 麦克风录 12 s 后按停止、再点「解码」，报 `Invalid typed array length: -1255`，弹的是"解码失败"，让人以为信号不行 | 行循环里 `pos = s + step` 会越过信号末尾，于是下一轮搜索窗口 `[pos-0.15·step, pos+0.5·step]` **整个落到音频之外**，`findSync` 里 `new Uint8Array(hi - lo)` 拿到负长度就抛异常。语义上这就是"没有可搜的区间"，已加 `if (hi <= lo) return null;`。**触发条件是"录音提前停止"——恰好是实时逐行成像这个功能本身制造出来的新用法，此前的测试全部喂完整 WAV，永远碰不到** |
| 13 | **一处几毫秒的干扰就让整幅图从中间截断** | 麦克风录完整幅（36 s）后点解码，只有前半幅有图像，**后半幅全黑，且没有任何提示**。同一段音频用增量路径能解出 238/240 行 | 行循环 `if (s == null) break;` —— 只要有一行的同步脉冲被干扰吃掉就**直接放弃整条音轨**。已加恢复路径：窄窗口找不到就把搜索范围放宽到 1.5 个行周期（跳过这一行继续往下解），仍然找不到才放弃。**因为干净信号的同步必然落在窄窗口内，这条恢复路径对已有结果零影响**（回归见 `decode_robust_test.cjs` C 节）。实测 138/240 → 239/240 |

> **通用教训**：当常量涉及单位换算时，**在边界处一次性统一单位**，而不是让每个消费方各自去回忆「这个常量到底是什么单位」。本项目 6 个缺陷中有 4 个（`ms/s`、像素时长 vs 通道时长、VIS 跳过长度、像素取整）本质上都是单位或边界不一致问题。
>
> 第 7 项的教训不同：**"接口不存在"往往不是能力问题，而是策略问题。** 报错时不要止步于"不支持"，要区分「浏览器没有这个能力」和「浏览器有这个能力但当前不让你用」—— 后者通常有明确的、可执行的解法（本例即安装本地可信证书）。
>
> 第 12、13 项的教训是关于**测试输入的**：前 11 个缺陷都能用"完整的、干净的合成信号"测出来，而这两个只在"提前停止""中间掉一小块"这类真实使用形态下才会出现。**凡是引入新交互方式（这里是"边收边看"），都要重新问一遍：用户会用它做出哪些以前做不到的操作？那些操作对应的输入，测试覆盖了吗？**

---

## 9. 已知限制

1. **Robot 36 / PD 的 PSNR 天然偏低**（22–26 dB vs RGB 家族的 30–34 dB）。这是 YUV **色度隔行**制式的固有特性——色度垂直分辨率减半，不是实现 bug。
2. **无 AFC / 漂移校正**：解码器按"首个同步脉冲 + 固定行长步进"定位后续各行。若录音存在走带或采样时钟偏差（例如磁带机转速误差 >0.5%），图像会产生横向累积偏移。真实产品需引入 **AFC（自动频率控制）** 或逐行重新同步。
3. ~~**解码非实时**~~ **已解决（麦克风路径）**：麦克风接收改为**分块滑动窗口增量解调**（`createStreamDecoder`，见 §6.6），画面随信号逐行生长，Martin M1 也只是"播 115 s、看 115 s"。两种路径的分工：
   - **麦克风** → 增量解调，实时成像；停止后仍会自动跑一次批量精确重解做校验
   - **文件导入** → 仍是全信号 FFT（Martin M1 约 900 ms @22.05 kHz）。文件不需要"等"，而一次性 FFT 摊到整段上更省，因此没有改成渐进式
   - 增量路径的另一处差异：它按**麦克风原生采样率**处理（44.1/48 kHz，不做重采样），批量路径统一降到 22050 Hz。两者数学同源，实测差异 ≤1 个灰阶（50 dB 以上）
4. **信号中断的恢复是"跳过一行"级别的**：无论增量还是批量路径，一旦某一行的同步脉冲被吃掉，都会从下一行重新锁定——代价是**自该处起整幅图纵向错位一行**，且末尾会少一行。真正的修法是按实际同步位置动态推算行长（即 AFC），见第 2 条。
5. **麦克风需要安全上下文**：只有 `https://`（证书受信任）或 `localhost` / `127.0.0.1` 才可用。**`http://` + 局域网 IP 不可用** —— 浏览器会把 `navigator.mediaDevices` 直接置为 `undefined`。局域网场景的完整解决方案见 **[web/HTTPS_MIC_GUIDE.md](web/HTTPS_MIC_GUIDE.md)**（`web/serve.py` + `web/tools/gen_cert.py` 已内置支持）。
6. **实时成像仍受主线程牵制**：录音回调里每 ~186 ms 要跑一次 8k 点 FFT（约 1 ms）与增量绘制；低端手机上如果同时进行其它重绘制，可能出现丢块。此时关掉 `实时逐行成像` 开关即可回到纯批处理。
7. **单声道**：只取第一个声道；立体声文件时另一声道被忽略。
8. **未完成**：iOS 的 SwiftUI App target、Android 的**原生 Compose 界面**尚未纳入本仓库（见 §10）。
   Android 侧的**可安装 APK 已经有了** —— 走的是 WebView 壳路线（`android/app/`），
   复用 Web 版引擎；它自己的限制（WebView 版本差异、后台录音、base64 桥的内存开销）
   列在 [android/README.md](android/README.md) 的「已知限制」里。

---

## 10. 路线图

- [x] **Android WebView 壳 App** —— 复用 `web/` 前端，补齐安全上下文 / 麦克风权限 /
      文件导入导出，Gitee Go 云打包出 APK（见 §4.4 与 [android/README.md](android/README.md)）
- [ ] **Phase 3a** — iOS SwiftUI App（AVFoundation 麦克风实时 RX / 文件导入；播放 + 导出 WAV/M4A）
- [ ] **Phase 3b** — Android **原生** Compose App（AudioRecord / AudioTrack / MediaExtractor + MediaMuxer）；
      地基是现成的 `android/sstv-engine/`，用于替换掉 WebView 以换取性能
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
