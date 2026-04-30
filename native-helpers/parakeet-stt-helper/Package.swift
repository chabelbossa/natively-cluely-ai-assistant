// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ParakeetSTTHelper",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "parakeet-stt-helper", targets: ["ParakeetSTTHelper"]),
    ],
    dependencies: [
        .package(path: "../../../VoiceInk/.spm-packages/checkouts/FluidAudio"),
    ],
    targets: [
        .executableTarget(
            name: "ParakeetSTTHelper",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
            ]
        ),
    ]
)

