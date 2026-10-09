package com.qiaoyukeji.sstv

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * 唯一的 Activity：一个全屏 WebView，装载 assets/www 里的离线前端。
 *
 * 浏览器里能跑的东西，WebView 里往往差一点 —— 这里补齐的正是那"一点"：
 *
 * 1. **安全上下文**
 *    `getUserMedia` 只在安全上下文下存在。`file://` 不是安全上下文（接口直接消失），
 *    `http://` + 局域网也不是。`WebViewAssetLoader` 把本地资源挂到
 *    `https://appassets.androidplatform.net/` 下并由 `shouldInterceptRequest`
 *    就地拦截 —— 页面以为是 https，其实一个字节都没出网。
 *
 * 2. **运行时权限**
 *    WebView 拿到网页的 `getUserMedia` 后会先回调 `onPermissionRequest`。
 *    我们不能直接 grant：得先确认 Android 层的 RECORD_AUDIO 拿到了，
 *    否则会出现"网页以为有麦克风、实际拿到静音流"这种最难查的失败。
 *
 * 3. **文件导入**
 *    网页里的 `<input type="file">` 在 WebView 中必须由 `onShowFileChooser`
 *    接管才会弹出系统选择器，否则点击毫无反应。
 *
 * 4. **文件导出**
 *    网页导出用的是 `<a download>` + `blob:`，WebView 不会为此落地文件，
 *    也**不会**触发 DownloadListener（那个只认 http/https 链接）。
 *    所以走 JS 桥：网页把内容转成 base64 交给原生，原生写进系统相册 / 下载目录。
 *
 * 5. **"更像原生 App"**
 *    页面本身按 `html.app-shell` 换成 App 版文案（不含任何"浏览器 / HTTPS 证书 /
 *    双击 index.html"之类说明）；这里再补上原生触感：关掉长按弹出的文本选择菜单
 *    （那是浏览器特征最明显的一处），并让返回键在应用内退出。
 */
class MainActivity : AppCompatActivity() {

    private companion object {
        const val TAG = "SSTVStudio"
        const val DOMAIN = "appassets.androidplatform.net"
        const val START_URL = "https://$DOMAIN/assets/www/index.html"
        const val REQ_MIC = 1001
        /** 导出目录：系统相册/下载下的子目录，避免和用户其它文件混在一起 */
        const val SUBDIR = "SSTV"
    }

    private lateinit var webView: WebView

    /** 网页发起的麦克风请求，等 Android 权限结果回来后再答复它 */
    private var pendingPermission: PermissionRequest? = null

    /** 网页发起的文件选择请求，等用户选完再回填 */
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null

    private val filePicker =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
            val cb = pendingFileCallback
            pendingFileCallback = null
            cb?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setupWebView()
        // 只在首次创建时加载，配置变更（旋转屏幕）后由 WebView 自己恢复，避免重新走一遍 VIS
        if (savedInstanceState == null) {
            webView.loadUrl(START_URL)
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    // ------------------------------------------------------------------ WebView --

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(DOMAIN)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this)
        webView.setBackgroundColor(0xFF0A0F15.toInt()) // 与页面底色一致，消除加载瞬间白闪
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // 页面完全离线：把"可能联网 / 可能读任意本地文件"的开关全部关掉。
            // 这不是安全表演 —— 关掉之后即便页面被注入，也拿不到本地文件系统。
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            // TX 播放音频前不想再让用户点一次；解码播放也不该被手势策略挡住
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = false
            cacheMode = WebSettings.LOAD_DEFAULT
            textZoom = 100
        }
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER)
        // 长按弹出的"复制 / 全选 / 网页搜索"菜单是浏览器最明显的破绽：原生 App 里
        // 没有这种东西。消费掉长按事件即不再触发文本选择 ActionMode；页面侧还有
        // CSS 的 user-select:none 兜底（两处配合，单靠其中一处都不稳）。
        // 代价是诊断文本在 App 里选不中 —— 页面侧就没给它放行 user-select，
        // 两处行为保持一致。
        webView.isLongClickable = false
        webView.setOnLongClickListener { true }
        // 双指缩放会露出"这是个网页"的观感，且会让画布像素对不齐
        webView.settings.setSupportZoom(false)
        webView.settings.builtInZoomControls = false
        webView.settings.displayZoomControls = false
        webView.addJavascriptInterface(NativeBridge(), "SSTVNative")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            /** 本应用没有外链：任何离开本地 asset 域的跳转一律拦下 */
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val u = request.url
                return !(u.scheme == "https" && u.host == DOMAIN)
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                // 本地资源加载失败 = 打包漏了文件，必须显式暴露，不能白屏了事。
                // 对用户说是"应用资源缺失"，括号里保留 assets/www 这个定位线索给排障用。
                if (request.isForMainFrame) {
                    Log.e(TAG, "主框架加载失败 ${request.url}: ${error.description}")
                    Toast.makeText(
                        this@MainActivity,
                        "应用资源缺失，请重新安装应用（assets/www 不完整）",
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d(TAG, "JS[${m.messageLevel()}] ${m.message()} @ ${m.sourceId()}:${m.lineNumber()}")
                return true
            }

            /** 网页要麦克风 —— 先确认真有，再答复它 */
            override fun onPermissionRequest(request: PermissionRequest) {
                val wantsAudio = request.resources.any { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                if (!wantsAudio) {
                    request.deny()
                    return
                }
                if (hasMicPermission()) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else {
                    pendingPermission = request
                    ActivityCompat.requestPermissions(
                        this@MainActivity,
                        arrayOf(Manifest.permission.RECORD_AUDIO),
                        REQ_MIC
                    )
                }
            }

            /** `<input type="file">` 必须有它才会弹选择器，否则点击毫无反应 */
            override fun onShowFileChooser(
                view: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                pendingFileCallback?.onReceiveValue(null) // 丢掉上一次没走完的，避免回调悬挂
                pendingFileCallback = filePathCallback
                return try {
                    val mimes = (fileChooserParams.acceptTypes ?: emptyArray())
                        .filter { it.isNotBlank() }
                        .toTypedArray()
                        .ifEmpty { arrayOf("*/*") }
                    filePicker.launch(mimes)
                    true
                } catch (e: Exception) {
                    Log.e(TAG, "打开文件选择器失败", e)
                    pendingFileCallback = null
                    filePathCallback.onReceiveValue(null)
                    false
                }
            }
        }
    }

    // ------------------------------------------------------------------ 权限 --

    private fun hasMicPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_MIC) return

        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        pendingPermission?.let { req ->
            if (granted) req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else req.deny()
            pendingPermission = null
        }
        if (!granted) {
            Toast.makeText(
                this,
                "未授予麦克风权限：实时接收不可用，但仍可用「音频文件」解码",
                Toast.LENGTH_LONG
            ).show()
        }
    }

    // ------------------------------------------------------------------ JS 桥 --

    /** 暴露给网页：window.SSTVNative.* */
    inner class NativeBridge {

        /**
         * 网页导出文件时调用。内容以 base64 传入 —— 之所以不用流式传输，
         * 是因为 addJavascriptInterface 是同进程调用，没有 Binder 的 1 MB 限制；
         * 本工具最大的产物（Martin M1 的 WAV）约 5 MB，base64 后约 7 MB，可接受。
         */
        @JavascriptInterface
        fun saveFile(name: String, mime: String, base64: String) {
            // 注意：此方法运行在 WebView 的 JavaBridge 线程（不是主线程），IO 可以放心做
            val outcome = runCatching {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                storeFile(name, mime, bytes)
            }
            val ok = outcome.isSuccess
            val message = outcome.getOrElse {
                Log.e(TAG, "保存失败", it)
                "保存失败：${it.message ?: it.javaClass.simpleName}"
            }
            runOnUiThread {
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_LONG).show()
                val js = "window.__sstvOnSaved&&window.__sstvOnSaved(" +
                    JSONObject.quote(name) + "," + ok + "," + JSONObject.quote(message) + ")"
                webView.evaluateJavascript(js, null)
            }
        }

        /** 让网页能显示"你在 App 里跑"这类信息 */
        @JavascriptInterface
        fun platform(): String = "android-webview"
    }

    // ------------------------------------------------------------------ 落盘 --

    private fun storeFile(name: String, mime: String, bytes: ByteArray): String {
        val safeName = sanitizeFileName(name)
        // 图片进「相册」，其它进「下载」。
        //
        // 为什么必须分开：用户说"保存图片"，期待的就是在系统相册里能看到。
        // MediaStore.Downloads 写进去的文件**不会**进相册索引，只能在文件管理器里翻 ——
        // 于是"我明明点了保存，相册里却没有"就成了一条报障，还很难解释清楚。
        // 图片走 MediaStore.Images（Pictures/SSTV），系统会自动建立相册；
        // WAV 这类非媒体文件放 Downloads/SSTV 更合适（否则会混进音乐库）。
        val isImage = mime.startsWith("image/")
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (isImage) {
                storeViaMediaStore(
                    MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
                    Environment.DIRECTORY_PICTURES, safeName, mime, bytes
                )
            } else {
                storeViaMediaStore(
                    MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
                    Environment.DIRECTORY_DOWNLOADS, safeName, mime, bytes
                )
            }
        } else {
            storeViaFileApi(
                if (isImage) Environment.DIRECTORY_PICTURES else Environment.DIRECTORY_DOWNLOADS,
                safeName, bytes
            )
        }
    }

    /** Android 10+：走 MediaStore，无需存储权限，用户能在相册/下载里直接看到 */
    private fun storeViaMediaStore(
        collection: Uri,
        baseDir: String,
        name: String,
        mime: String,
        bytes: ByteArray
    ): String {
        val relDir = "$baseDir/$SUBDIR/"
        val finalName = uniqueName(collection, relDir, name)

        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, finalName)
            put(MediaStore.MediaColumns.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
            put(MediaStore.MediaColumns.RELATIVE_PATH, relDir)
            put(MediaStore.MediaColumns.IS_PENDING, 1) // 写完再解除，避免半截文件被其它应用读到
        }
        val uri = contentResolver.insert(collection, values)
            ?: throw IllegalStateException("MediaStore 拒绝创建文件")

        try {
            contentResolver.openOutputStream(uri).use { out ->
                if (out == null) throw IllegalStateException("无法打开输出流")
                out.write(bytes)
                out.flush()
            }
        } catch (e: Exception) {
            runCatching { contentResolver.delete(uri, null, null) } // 失败别留残骸
            throw e
        }

        values.clear()
        values.put(MediaStore.MediaColumns.IS_PENDING, 0)
        contentResolver.update(uri, values, null, null)
        val where = if (baseDir == Environment.DIRECTORY_PICTURES) "相册" else "下载"
        return "已保存到 $where/$SUBDIR/$finalName"
    }

    /** 同名文件不覆盖，改成 name-1、name-2 …… 用户的导出不该互相踩掉 */
    private fun uniqueName(collection: Uri, relDir: String, name: String): String {
        val taken = LinkedHashSet<String>()
        runCatching {
            contentResolver.query(
                collection,
                arrayOf(MediaStore.MediaColumns.DISPLAY_NAME),
                "${MediaStore.MediaColumns.RELATIVE_PATH}=?",
                arrayOf(relDir),
                null
            )?.use { c ->
                val idx = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME)
                if (idx >= 0) while (c.moveToNext()) c.getString(idx)?.let { taken.add(it) }
            }
        }
        if (name !in taken) return name
        val base = name.substringBeforeLast('.', name)
        val ext = name.substringAfterLast('.', "")
        var i = 1
        while (true) {
            val cand = if (ext.isEmpty()) "$base-$i" else "$base-$i.$ext"
            if (cand !in taken) return cand
            i++
        }
    }

    /** Android 9 及以下：直接写公共目录（已在清单里限制该权限的最大 SDK 版本） */
    private fun storeViaFileApi(baseDir: String, name: String, bytes: ByteArray): String {
        @Suppress("DEPRECATION")
        val dir = File(Environment.getExternalStoragePublicDirectory(baseDir), SUBDIR)
        if (!dir.isDirectory && !dir.mkdirs()) {
            throw IllegalStateException("无法创建目录 ${dir.absolutePath}")
        }
        val base = name.substringBeforeLast('.', name)
        val ext = name.substringAfterLast('.', "")
        var target = File(dir, name)
        var i = 1
        while (target.exists()) {
            target = File(dir, if (ext.isEmpty()) "$base-$i" else "$base-$i.$ext")
            i++
        }
        FileOutputStream(target).use { it.write(bytes) }
        // API ≤28 上 MediaStore 不会自动收录新文件，必须显式通知媒体扫描器，
        // 否则图片同样进不了相册 —— 老设备上就会复现"保存了但相册看不到"。
        runCatching {
            MediaScannerConnection.scanFile(
                this, arrayOf(target.absolutePath), null, null
            )
        }
        val where = if (baseDir == Environment.DIRECTORY_PICTURES) "相册" else "下载"
        return "已保存到 $where/$SUBDIR/${target.name}"
    }

    private fun sanitizeFileName(raw: String): String {
        val cleaned = raw
            .replace(Regex("[/\\\\:*?\"<>|\\u0000-\\u001f]"), "_")
            .trim()
            .trim('.')
        val name = cleaned.ifEmpty { "sstv-export" }
        return if (name.length > 120) name.take(120) else name
    }

    // ------------------------------------------------------------------ 其它 --

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        // 页面里可能还有正在录音的 AudioContext，销毁 WebView 才能让它彻底停下来
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface("SSTVNative")
            webView.destroy()
        }
        super.onDestroy()
    }
}
