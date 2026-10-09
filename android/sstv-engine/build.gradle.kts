// CRAC SSTV · 纯 Kotlin JVM 算法库
//
// 这个模块不含任何 Android API，桌面上就能跑单测 —— 它是"算法神谕"的 Kotlin 移植版，
// 与 ios/SSTVEngine 一一对应。当前壳 App 走 WebView（复用 web/ 的 JS 引擎），
// 所以 App 并不依赖它；保留它是为了：
//   · 让移植算法始终处于"可编译、可测"状态，不会烂在仓库里
//   · 将来要写原生 Compose 界面时直接 `implementation(project(":sstv-engine"))`
//
// CI 会单独跑它的 JUnit 自环校验（./gradlew :sstv-engine:test）。

plugins {
    // 版本在根 build.gradle.kts 统一声明，此处只应用
    kotlin("jvm")
}

group = "com.example.sstv"
version = "0.1.0"

// 注意：这里**不能**再写 repositories { mavenCentral() }。
// 根 settings.gradle.kts 设了 RepositoriesMode.FAIL_ON_PROJECT_REPOS，
// 模块级声明仓库会直接让构建失败。仓库统一由根工程提供。

dependencies {
    testImplementation(kotlin("test"))
}

kotlin {
    jvmToolchain(17)
}

tasks.withType<Test>().configureEach {
    testLogging {
        events("passed", "failed", "skipped")
    }
}
