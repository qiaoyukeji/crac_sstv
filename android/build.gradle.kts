// CRAC SSTV · Android 根构建脚本
//
// 插件版本集中在这里声明（apply false 只声明不应用），子模块只写 `id("...")` 不带版本 ——
// 这是 Gradle 官方推荐的写法，可以避免"同一个插件在不同子模块里版本不一致"这种难查的问题。

plugins {
    id("com.android.application") version "8.5.2" apply false
    kotlin("android") version "1.9.22" apply false
    kotlin("jvm") version "1.9.22" apply false
}
