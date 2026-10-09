import java.util.Properties

// CRAC SSTV · WebView 壳 App
//
// 这个模块本身几乎不含算法：它把仓库根 web/ 那份已经跑通的界面装进 WebView，
// 并补齐"浏览器有、WebView 没有"的四件事：
//   1. 安全上下文 —— 用 WebViewAssetLoader 以 https:// 提供本地资源，getUserMedia 才可用
//   2. 运行时权限 —— RECORD_AUDIO 的申请与 onPermissionRequest 授权
//   3. 文件导入   —— <input type="file"> 需要 onShowFileChooser 才会弹出选择器
//   4. 文件导出   —— <a download> + blob: 在 WebView 里不落地，需要 JS 桥接写进"下载"
//
// 详见 android/README.md。

plugins {
    id("com.android.application")
    kotlin("android")
}

// ---------------------------------------------------------------- 可选正式签名 --
// 有了 keystore.properties 就用正式签名（同一把钥匙才能覆盖安装升级）；
// 没有就退化为 debug 签名 —— 保证 assembleRelease 产出的 APK 也能直接装。
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.qiaoyukeji.sstv"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.qiaoyukeji.sstv"
        minSdk = 24
        targetSdk = 34
        // versionCode 必须严格递增 —— 安卓只认它来判定"能否覆盖安装"。
        // versionName 是给人看的：1.0.0 → 1.1.0（界面重做 + 去网页化 + 收满自动停止）
        // → 1.1.1（接收解码修复：VIS 结构校验、帧起点来源、三条收手判据上锁）。
        versionCode = 3
        versionName = "1.1.1"
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = if (keystoreProps.isNotEmpty()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = false
    }

    packaging {
        resources.excludes += setOf(
            "META-INF/*.kotlin_module",
            "META-INF/DEPENDENCIES",
            "META-INF/LICENSE*",
            "META-INF/NOTICE*",
            "kotlin/**"
        )
    }

    lint {
        abortOnError = false
    }
}

dependencies {
    // AppCompat：提供 DayNight 主题与 ActivityCompat（WebView 本身不需要它）
    implementation("androidx.appcompat:appcompat:1.7.0")
    // WebViewAssetLoader：让本地页面跑在 https:// 下，这是麦克风可用与否的分水岭
    implementation("androidx.webkit:webkit:1.11.0")
}

// ------------------------------------------------------------------ Web 资源同步 --
// 唯一真源是仓库根的 web/。同步进 assets/www，而不是在仓库里存一份副本 ——
// 两份副本一定会漂移（网页改了、APK 里还是旧的），这种 bug 最难查。
val webSourceDir = rootProject.file("../web")
val webAssetsDir = layout.projectDirectory.dir("src/main/assets/www")

val syncWebAssets by tasks.registering(Sync::class) {
    description = "把仓库根 web/ 同步到 app 的 assets/www"
    group = "build"

    if (!webSourceDir.isDirectory) {
        throw GradleException("找不到 Web 资源目录：${webSourceDir.absolutePath}（壳 App 依赖它打包前端）")
    }

    from(webSourceDir) {
        // 测试脚本、证书工具、本地服务脚本都不该进 APK
        exclude("test/**", "tools/**", "shots/**")
        exclude("serve.py", "HTTPS_MIC_GUIDE.md")
        exclude("**/*.md")
    }
    into(webAssetsDir)

    doLast {
        val idx = File(webAssetsDir.asFile, "index.html")
        if (!idx.isFile) throw GradleException("同步后仍找不到 ${idx.absolutePath}")
    }
}

tasks.named("preBuild") { dependsOn(syncWebAssets) }
// 双保险：即使某些 AGP 版本的 preBuild 不在资产合并的上游，也强制先同步
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }
    .configureEach { dependsOn(syncWebAssets) }
