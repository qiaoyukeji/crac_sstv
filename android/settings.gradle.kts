// CRAC SSTV · Android 工程根构建脚本
//
// 目录约定（本文件所在目录即 Gradle 根工程）：
//   android/app/          —— WebView 壳 App（产出 APK）
//   android/sstv-engine/  —— 纯 Kotlin JVM 算法库（不依赖 Android SDK）
//
// 为什么壳 App 不依赖 :sstv-engine：
//   壳 App 把 web/ 那份已经跑通的 JS 引擎装进 WebView，所以算法只存在一份（JS）。
//   :sstv-engine 保留给"将来要写原生 Compose 界面"的场景，现在由 CI 单独跑它的单测，
//   两条路径互不干扰 —— 需要原生实现时再 `implementation(project(":sstv-engine"))` 即可。
//
// 仓库顺序：优先国内镜像（构建机与国内开发者都更快），官方仓库兜底。
// Gradle 会按顺序逐个尝试，镜像缺件时自动落到下一个，不会因为缺件直接失败。

pluginManagement {
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        google()
        mavenCentral()
    }
}

rootProject.name = "crac-sstv-android"

include(":app")
include(":sstv-engine")
