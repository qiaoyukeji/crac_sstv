plugins {
    kotlin("jvm") version "1.9.22"
}

group = "com.example.sstv"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    testImplementation(kotlin("test"))
}

kotlin {
    jvmToolchain(17)
}
