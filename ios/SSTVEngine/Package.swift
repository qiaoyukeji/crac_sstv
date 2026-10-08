// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SSTVEngine",
    platforms: [
        .iOS(.v15),
        .macOS(.v12)
    ],
    products: [
        .library(name: "SSTVEngine", targets: ["SSTVEngine"])
    ],
    targets: [
        .target(name: "SSTVEngine", path: "Sources/SSTVEngine"),
        .testTarget(
            name: "SSTVEngineTests",
            dependencies: ["SSTVEngine"],
            path: "Tests/SSTVEngineTests"
        )
    ]
)
