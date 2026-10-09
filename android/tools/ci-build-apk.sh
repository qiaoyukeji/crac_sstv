#!/usr/bin/env bash
#
# CRAC SSTV · 云打包入口脚本：在干净构建机上装好安卓工具链并产出 APK。
#
# 为什么把逻辑放在脚本里，而不是写进流水线 YAML：
#   1. YAML 里的多行 shell 会撞上 Gitee 的 `{参数}` 模板展开，`${VAR}` 这类写法行为不确定
#   2. 脚本进版本库、能被 review、能被本地复现，换 CI（GitHub Actions / GitLab CI）时直接复用
#   3. 流水线 YAML 负责"何时跑"，脚本负责"怎么跑" —— 关注点分开
#
# Gitee Go 里调用：  bash android/tools/ci-build-apk.sh
# 本地（装了 JDK 17 的 Linux/macOS，或 Git Bash）同样可以跑。
#
# 可覆盖的环境变量：
#   ANDROID_API=34                编译用 SDK 平台
#   BUILD_TOOLS=34.0.0            构建工具版本
#   CMDLINE_TOOLS_VERSION=11076708  Google 命令行工具包版本号
#   ANDROID_SDK_ROOT=...          复用已装好的 SDK（CI 缓存时用）
#   GRADLE_TASK=":app:assembleDebug"  想只出 debug 包时改这里
#   ENGINE_TESTS=":sstv-engine:test"  顺带跑的 Gradle 任务（默认就是算法库单测；置空可关闭）
#
set -eo pipefail

ANDROID_API="${ANDROID_API:-34}"
BUILD_TOOLS="${BUILD_TOOLS:-34.0.0}"
CMDLINE_TOOLS_VERSION="${CMDLINE_TOOLS_VERSION:-11076708}"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/android-sdk}}"
GRADLE_TASK="${GRADLE_TASK:-:app:assembleDebug :app:assembleRelease}"

log() { printf '\n=== %s ===\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ 定位路径 --
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
android_root="$repo_root/android"
log "仓库根：$repo_root"
[ -f "$android_root/gradlew" ] || die "找不到 $android_root/gradlew"

# ------------------------------------------------------------------ 0. 前置 --
# JAVA_HOME 优先、PATH 兜底：CI 上 Gitee Go 会把 JAVA_HOME 设好；
# 本地（含 Git Bash）则常出现"PATH 里有 C:/ 形式的条目、command -v 却搜不到"的情况。
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  JAVA_BIN="$JAVA_HOME/bin/java"
elif command -v java >/dev/null 2>&1; then
  JAVA_BIN="$(command -v java)"
else
  die "缺少 java —— 本脚本需要 JDK 17（Gitee Go 里由 jdkVersion: 17 提供）"
fi

# JAVA_HOME 没设或指向无效目录时，从 java 可执行文件反推（sdkmanager 与 Gradle 都要用）
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$JAVA_HOME/bin/java" ]; then
  JAVA_REAL="$(readlink -f "$JAVA_BIN" 2>/dev/null || echo "$JAVA_BIN")"
  JAVA_HOME="$(dirname "$(dirname "$JAVA_REAL")")"
fi
export JAVA_HOME

# 注意 `|| true`：`set -o pipefail` 下，head 提前关管道会让 java 收到 SIGPIPE、
# 整个管道返回非零，进而被 `set -e` 当成失败 —— 取一行版本号不该让构建挂掉。
java_ver="$("$JAVA_BIN" -version 2>&1 | head -n 1 || true)"
log "Java：$java_ver"
log "JAVA_HOME=$JAVA_HOME"

# --------------------------------------------------------- 1. 下载/解压能力 --
# 构建机镜像可能是 CentOS 也可能是 Debian，工具未必齐全。
# 这里做降级链：curl→wget→python3 负责下载；unzip→JDK 自带的 jar 负责解压。
fetch() { # fetch <url> <out>
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 -o "$out" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --timeout=60 -O "$out" "$url"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,urllib.request;urllib.request.urlretrieve(sys.argv[1],sys.argv[2])' "$url" "$out"
  else
    die "没有 curl / wget / python3，无法下载 $url"
  fi
}

unzip_into() { # unzip_into <zip> <destdir>
  local zip="$1" dest="$2"
  mkdir -p "$dest"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$zip" -d "$dest"
  else
    # jar 是 JDK 自带的，永远存在 —— 这样即使镜像里没有 unzip 也能继续
    ( cd "$dest" && "$JAVA_HOME/bin/jar" xf "$zip" )
  fi
}

ensure_unzip() {
  command -v unzip >/dev/null 2>&1 && return 0
  log "镜像缺少 unzip，尝试安装（失败也不阻塞，后面会退化为 jar）"
  if command -v apt-get >/dev/null 2>&1; then
    (apt-get update -qq && apt-get install -y -qq unzip) || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q unzip || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q unzip || true
  fi
}
ensure_unzip

# ------------------------------------------------------------ 2. Android SDK --
log "Android SDK 目录：$SDK_ROOT"
mkdir -p "$SDK_ROOT"

SDKMANAGER="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
# Windows 上命令行工具装出来的是 sdkmanager.bat；本脚本也支持在 Git Bash 里本地跑，
# 所以这里两种形态都认，而不是写死 POSIX 那一个。
if [ ! -x "$SDKMANAGER" ] && [ -f "$SDKMANAGER.bat" ]; then
  SDKMANAGER="$SDKMANAGER.bat"
fi
if [ ! -x "$SDKMANAGER" ] && [ ! -f "$SDKMANAGER" ]; then
  log "下载 Android 命令行工具（commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip）"
  tmp="$(mktemp -d)"
  fetch "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" "$tmp/ct.zip"
  unzip_into "$tmp/ct.zip" "$tmp/ct"
  mkdir -p "$SDK_ROOT/cmdline-tools"
  # 刻意不用 `rm -rf`：把可能残缺的旧目录挪开即可。
  # 一来更安全（脚本不该有删除任意目录的能力），二来某些受限环境会拦截 rm。
  if [ -d "$SDK_ROOT/cmdline-tools/latest" ]; then
    mv "$SDK_ROOT/cmdline-tools/latest" "$SDK_ROOT/cmdline-tools/latest.incomplete.$$"
  fi
  mv "$tmp/ct/cmdline-tools" "$SDK_ROOT/cmdline-tools/latest"
  rm -rf "$tmp"
  SDKMANAGER="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
  if [ ! -x "$SDKMANAGER" ] && [ -f "$SDKMANAGER.bat" ]; then
    SDKMANAGER="$SDKMANAGER.bat"
  fi
else
  log "命令行工具已存在，跳过下载（缓存命中）"
fi

export ANDROID_HOME="$SDK_ROOT"
export ANDROID_SDK_ROOT="$SDK_ROOT"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# 一律用绝对路径调用，不依赖 PATH —— Windows(Git Bash) 下 PATH 里带盘符的条目
# 不会被解析，裸写 `sdkmanager` 会 command not found。
[ -x "$SDKMANAGER" ] || [ -f "$SDKMANAGER" ] || die "sdkmanager 不可用：$SDKMANAGER"

log "接受许可协议"
# 用循环代替 `yes`：极简镜像里不一定有 yes
for _ in $(seq 1 60); do echo y; done | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1 || true

log "安装 platform-tools / platforms;android-${ANDROID_API} / build-tools;${BUILD_TOOLS}"
"$SDKMANAGER" --sdk_root="$ANDROID_HOME" --install \
  "platform-tools" \
  "platforms;android-${ANDROID_API}" \
  "build-tools;${BUILD_TOOLS}"

# ------------------------------------------------------------------ 3. 构建 --
cd "$android_root"
# 路径一律转成正斜杠：java.util.Properties 会把反斜杠当转义符，
# 直接写 C:\Users\x\android-sdk 会被读成乱码路径（这个坑只在 Windows 上踩得到）
printf 'sdk.dir=%s\n' "$(printf '%s' "$ANDROID_HOME" | tr '\\' '/')" > local.properties
chmod +x gradlew

log "Gradle 任务：$GRADLE_TASK"
# 算法库单测挂进同一次 Gradle 调用（而不是起第二个 --no-daemon 进程，省一遍配置时间）。
# 为什么值得进 CI：sstv-engine/ 是 web/sstv-engine.js 的 Kotlin 移植，两边共用同一份
# DSP 数学。移植版曾经"能编译但结果是错的"（encode 用了图像尺寸而非制式尺寸、
# readPx 忘了把频率换算成灰度值），回环 PSNR 只有 4.9 dB 却没人发现 —— 因为没人跑它。
# 这组测试拿 Python 神谕的基线卡着，就是防这种事再发生。
ENGINE_TESTS="${ENGINE_TESTS:-:sstv-engine:test}"
if [ -n "$ENGINE_TESTS" ]; then
  log "同时运行：$ENGINE_TESTS（置 ENGINE_TESTS= 可关闭）"
fi

# ------------------------------------------- 3a. Windows 非 ASCII 路径兼容 --
# Gradle 把测试 worker 的类路径写进一个 @argfile，而 java.exe 是在**虚拟机启动之前**
# 展开它的，用的是系统 ANSI 代码页；daemon 却是按 -Dfile.encoding=UTF-8 写的。
# 路径里只要有一个非 ASCII 字符（中文目录名），类路径就整体乱码，测试类加载不到，
# 报 `initializationError / ClassNotFoundException` —— 看起来像"测试写错了"，其实是编码。
# CI 的工作目录是纯 ASCII，永远不会走到这里；只在 Windows + 非 ASCII 路径下把
# daemon 的编码拉回系统代码页（中文 Windows 是 GBK）。详见 android/README.md。
GRADLE_EXTRA=()
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*)
    if [ -n "$repo_root" ] && printf '%s' "$repo_root" | LC_ALL=C grep -q '[^ -~]'; then
      log "Windows + 非 ASCII 路径：启用 file.encoding=GBK 兼容（绕开 Gradle @argfile 编码缺陷）"
      # 必须整体作为一个 argv 元素（里面含空格），所以用数组而不是字符串 ——
      # 字符串会被 shell 按空格拆开，把 -XX:... / -Dfile.encoding=... 当成 Gradle
      # 的 CLI 选项，直接报 "Unknown command-line option"。
      GRADLE_EXTRA=("-Dorg.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m -Dfile.encoding=GBK")
    fi
    ;;
esac

# shellcheck disable=SC2086  # 故意让 GRADLE_TASK / ENGINE_TESTS 按空格拆成多个任务
./gradlew $GRADLE_TASK $ENGINE_TESTS "${GRADLE_EXTRA[@]}" --no-daemon --stacktrace

# ------------------------------------------------------------------ 4. 产物 --
log "APK 产物"
out_dir="$android_root/app/build/outputs/apk"
found="$(find "$out_dir" -type f -name '*.apk' 2>/dev/null || true)"
if [ -z "$found" ]; then
  die "构建结束但没找到任何 APK，请检查上面的日志"
fi

# 把版本号读出来：制品区里堆着好几个 app-release.apk 时，光看文件名分不出哪版是哪版。
# 只读 defaultConfig 块里那一行（第一个匹配即 versionName），不解析整个 Gradle 文件。
version_name="$(sed -n 's/^[[:space:]]*versionName[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$android_root/app/build.gradle.kts" | head -n 1)"
[ -n "$version_name" ] || version_name="unknown"
log "版本：$version_name"

# 改名成 sstv-<版本>-<构建类型>.apk。这里是纯 shell 收尾，任何一步失败都不该
# 让"已经成功的构建"变成失败 —— 所以处处 `|| true`，改名没成只是文件名叫旧的。
while IFS= read -r f; do
  [ -n "$f" ] || continue
  base="$(basename "$f")"
  kind="${base#app-}"; kind="${kind%.apk}"          # app-release.apk -> release
  dst="$(dirname "$f")/sstv-${version_name}-${kind}.apk"
  if [ "$f" != "$dst" ]; then
    mv -f "$f" "$dst" 2>/dev/null || true
    [ -f "$dst" ] && f="$dst"
  fi
  printf '  %s  (%s bytes)\n' "$f" "$(stat -c%s "$f" 2>/dev/null || echo '?')"
done <<< "$found"

log "完成"
