# CRAC SSTV · Android 端

本目录有两个模块：

| 模块 | 是什么 | 谁在用 |
|------|--------|--------|
| `app/` | **WebView 壳 App** —— 把仓库根 `web/` 那份离线前端装进 WebView，产出可安装的 APK | 当前交付物 |
| `sstv-engine/` | 纯 Kotlin JVM 算法库（不依赖 Android SDK），已通过 Python 神谕的回环 PSNR 校验 | 保留给"将来看要不要写原生 Compose 界面" |

两个模块的**算法源头是同一份数学**：`app/` 跑的是 `web/sstv-engine.js`，`sstv-engine/`
是它的 Kotlin 移植，两者都以 `sstv_proto/` 里的 Python 神谕为基准。移植版现已实测对齐
（M1 35.727 dB / PD90 26.844 dB，见下文"本地构建"）。

## 为什么是 WebView 壳，而不是原生 Compose？

`web/` 那份前端已经是完整、可用的成品：TX 发射（含进度遮罩/画面适配）、RX 接收（含
**麦克风实时逐行成像**）、说明页，全部 100% 离线。把它装进 WebView，能立刻拿到一个
功能与 Web 版完全一致的 APK，而不用把整套界面和音频 I/O 用 Compose 重写一遍。

代价是性能：JS 引擎解调比 Kotlin 引擎慢。对"听着电台、画面慢慢长出来"这个使用场景而言，
这个代价可以接受；真到了要抠性能的时候，`sstv-engine/` 已经在那儿等着了
（`implementation(project(":sstv-engine"))`）。

**唯一真源仍然是 `web/`。** App 不存副本：构建时由 `app/build.gradle.kts` 里的
`syncWebAssets` 任务把 `web/` 同步进 `assets/www`。仓库里存两份前端一定会漂移
（网页改了、APK 里还是旧的），而这类 bug 最难查。

## 四个"浏览器有、WebView 没有"的坑

壳代码看着简单，真正花时间的是这四点，全部写在 `MainActivity.kt` 的注释里：

1. **安全上下文**
   `getUserMedia` 只在安全上下文下存在。`file://` 不是（接口直接消失），
   `http://` + 局域网也不是。所以用 `WebViewAssetLoader` 把本地资源挂到
   `https://appassets.androidplatform.net/` 下，由 `shouldInterceptRequest` 就地拦截 ——
   页面以为是 https，实际一个字节都没出网。

2. **运行时权限**
   WebView 收到网页的 `getUserMedia` 会先回调 `onPermissionRequest`。不能直接 grant：
   必须先确认 Android 层的 `RECORD_AUDIO` 拿到了，否则会出现
   "网页以为有麦克风、实际拿到静音流"这种最难查的失败。

3. **文件导入**
   `<input type="file">` 必须由 `onShowFileChooser` 接管才会弹出系统选择器，否则点击毫无反应。

4. **文件导出**
   网页导出用的是 `<a download>` + `blob:`。WebView 不会为此落地文件，也**不会**触发
   `DownloadListener`（那个只认 http/https 链接）。所以走 JS 桥：`web/app.js` 的
   `download()` 检测到 `window.SSTVNative` 就把内容转成 base64 交给原生，
   原生写进 **`下载/SSTV/`**（Android 10+ 走 MediaStore，无需存储权限）。

## 不申请 INTERNET 权限

这不是"忘了加"，是刻意的：本应用 100% 离线，不申请 INTERNET 就把这个承诺固化成了
系统级事实 —— 就算代码里出了漏洞，系统也不允许它联网。

---

## 云打包（Gitee Go）

流水线定义在仓库根的 `.workflow/android-apk.yml`，真正的构建逻辑在
`android/tools/ci-build-apk.sh`。

**首次使用需要手动做一步**：打开 Gitee 仓库页 → 「Gitee Go」→ 开通（免费额度：单仓库 200 分钟）。
之后推送到 `main` 会自动构建，也可以在「流水线」页点「运行」手动触发。

流水线做三件事：

1. 借 `build@maven` 插件拿到一个 **JDK 17** 的 shell（构建机本身没有 Android SDK）
2. 跑 `ci-build-apk.sh`：装 Android 命令行工具 → 接受许可 → 装
   `platforms;android-34` + `build-tools;34.0.0` → `./gradlew assembleDebug assembleRelease`
3. 归档 APK，并发布到「发布记录」供下载

构建机会缓存 `~/.gradle`、`~/.android`、`~/android-sdk`，所以**第一次慢（要下 SDK 与依赖）、
之后快**。

### 为什么构建逻辑在脚本里而不是 YAML 里

YAML 内联多行 shell 会撞上 Gitee 的 `{参数}` 模板展开，`${VAR}` 这类写法的行为不确定；
而且流水线一旦出问题，只能靠改 YAML → push → 等构建 → 看日志，非常难迭代。
放进脚本之后：能进版本库、能被 review、**本地能先跑通再提交**，换 CI 平台也直接复用。

脚本对构建机环境做了降级处理，不假设镜像里有什么：

- 下载：`curl` → `wget` → `python3` 三选一
- 解压：`unzip` → **JDK 自带的 `jar`**（`jar` 一定存在，所以永远不会因为缺 unzip 卡住）
- `unzip` 缺失时还会尝试 `apt-get` / `dnf` / `yum` 装一下（失败也不阻塞）
- `sdkmanager` 同时认 POSIX 与 Windows 的 `.bat` 两种形态

## 本地构建

需要 **JDK 17**（其余工具链脚本会自己装）：

```bash
export JAVA_HOME=/path/to/jdk-17
bash android/tools/ci-build-apk.sh
```

脚本是幂等的 —— 第二次跑会复用已装好的 SDK，只重跑 Gradle。

产物：

```
android/app/build/outputs/apk/debug/app-debug.apk
android/app/build/outputs/apk/release/app-release.apk   # 无正式签名时用 debug 钥匙签，可直接安装
```

只想要 debug 包，或者想复用别处的 SDK：

```bash
GRADLE_TASK=":app:assembleDebug" ANDROID_SDK_ROOT=/path/to/sdk bash android/tools/ci-build-apk.sh
```

单独跑算法库的单测：

```bash
cd android && ./gradlew :sstv-engine:test
```

这组测试是**回环一致性校验**：用同一张程序生成的参考图编码成音频、再解回来，比对
PSNR 是否命中 Python 神谕（`sstv_proto/test_parity_ref.py`）的基线值。实测：

```
M1  round-trip PSNR = 35.726719 dB (oracle 35.73)
PD90 round-trip PSNR = 26.843932 dB (oracle 26.76)
```

> **路径含中文时**（Windows 上尤其常见）
>
> `ci-build-apk.sh` **会自动处理**：检测到「Windows + 非 ASCII 路径」就自动补上
> `-Dorg.gradle.jvmargs=... -Dfile.encoding=GBK`，你什么都不用做。
> 但如果你是**直接调 Gradle**，就会撞上这个坑：
>
> ```
> SSTVEngineTest > initializationError FAILED
>     java.lang.ClassNotFoundException: com.example.sstv.engine.SSTVEngineTest
> ```
>
> 这不是测试写错了，是 **Gradle 的一个 Windows 编码缺陷**：Gradle 把测试 worker 的
> 类路径写进一个 `@argfile`（`~/.gradle/.tmp/gradle-worker-classpath*.txt`），而 daemon
> JVM 带 `-Dfile.encoding=UTF-8`，于是文件按 UTF-8 写；但 `java.exe` 是在虚拟机启动**之前**
> 展开 `@argfile` 的，用的是系统 ANSI 代码页（中文 Windows 上是 GBK）。两者不一致，
> 类路径里的中文目录名全部变成乱码，测试类自然加载不到。
>
> CI 上不存在这个问题（Gitee Go 的工作目录是纯 ASCII）。本机直接调 Gradle 时，
> 把 daemon 的编码拉回系统代码页即可：
>
> ```bash
> cd android && ./gradlew :sstv-engine:test \
>   -Dorg.gradle.jvmargs="-Xmx2048m -XX:MaxMetaspaceSize=512m -Dfile.encoding=GBK"
> ```
>
> 或者干脆把仓库放到纯英文路径下（`E:\code\crac_sstv`）。**不要把这个参数写进
> `android/gradle.properties`** —— 那样会把 CI 也一起带偏。

## 签名

默认用 **debug 钥匙**签 release 包 —— 能装、能跑、性能也比 debug 包好（没有调试开销），
但缺点是**换一台机器构建就装不上去了**（签名不一致，系统会拒绝覆盖安装）。

要正经发版，生成一把自己的钥匙：

```bash
keytool -genkeypair -v -keystore sstv-release.jks -alias sstv \
        -keyalg RSA -keysize 2048 -validity 10950 \
        -dname "CN=SSTV Studio, OU=Dev, O=CRAC, L=Hefei, ST=Anhui, C=CN"
```

然后：

```bash
mkdir -p android/keystore && mv sstv-release.jks android/keystore/
cp android/keystore.properties.example android/keystore.properties
# 编辑 keystore.properties 填真实密码
```

`android/keystore.properties`、`android/keystore/`、`*.jks`、`*.keystore` 都已在 `.gitignore` 里。
**千万不要把它们提交上去** —— 钥匙泄露等于任何人都能以你的名义发版。

## 已知限制

1. **WebView 版本差异**：Android 7.0 出厂机自带的 WebView 较老，`AudioContext` 的
   采样率与 `MediaRecorder` 行为可能不一致。建议 Android 8.0+ 使用。
2. **后台录音**：屏幕熄灭或切到后台时，系统可能限制 WebView 的音频采集。
   接收长制式（Martin M1 ≈ 115 s）时请保持前台亮屏。
3. **base64 桥的内存开销**：导出最大的产物（Martin M1 的 WAV 约 5 MB）会以 base64
   （约 7 MB 字符串）过桥，峰值多占十几 MB。低端机上如果导出大文件时闪退，
   这是第一嫌疑。
4. **不做 minify**：`isMinifyEnabled = false`。JS 桥一旦被 R8 改名就会静默失效
   （点导出没反应、不报错），所以宁可不压这点体积。
5. **Kotlin 引擎只移植了离线路径**：`web/sstv-engine.js` 里的**流式解码器**
   （`createStreamDecoder`，支撑麦克风"边收边成像"）在 `sstv-engine/` 中还没有对应实现。
   当前 App 走 WebView，用的是 JS 那份，所以没有功能缺口；将来真要切原生 Compose，
   这块是必须补的第一件事。
6. **本地路径含中文时不要直接调 Gradle**：`ci-build-apk.sh` 会自动兼容，手工调
   `./gradlew` 则会撞上 Gradle 在 Windows 上的 `@argfile` 编码缺陷 —— 详见"本地构建"一节。
