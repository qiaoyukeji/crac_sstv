# CRAC SSTV · R8 规则
#
# 当前 release 并未开启 minify（isMinifyEnabled = false），所以这份文件暂时是"保险绳"：
# 一旦将来打开混淆，下面两条能保证 JS 桥不被改名 —— 桥一旦被改名，网页调不到原生，
# 表现是"点导出没反应"，而且不报错，非常难查。

# JS 桥：@JavascriptInterface 标注的方法名必须原样保留
-keepclassmembers class com.qiaoyukeji.sstv.MainActivity$NativeBridge {
    public *;
}
-keepattributes JavascriptInterface

# WebView 相关
-keepclassmembers class * extends android.webkit.WebViewClient { *; }
-keepclassmembers class * extends android.webkit.WebChromeClient { *; }

# 保留行号，便于线上崩溃定位
-keepattributes SourceFile,LineNumberTable
