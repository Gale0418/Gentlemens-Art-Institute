// swift-tools-version:5.5
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "tauri-plugin-ios-folder",
    platforms: [
        .macOS(.v10_13),
        .iOS(.v15),
    ],
    products: [
        // Products define the executables and libraries a package produces, and make them visible to other packages.
        .library(
            name: "tauri-plugin-ios-folder",
            type: .static,
            targets: ["tauri-plugin-ios-folder"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        // Targets are the basic building blocks of a package. A target can define a module or a test suite.
        // Targets can depend on other targets in this package, and on products in packages this package depends on.
        .target(
            name: "tauri-plugin-ios-folder",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources",
            linkerSettings: [
                .linkedFramework("Security")
            ]),
        .target(
            name: "StoreKitTestSupport",
            path: "Tests/StoreKitTestSupport",
            publicHeadersPath: "include"),
        .testTarget(
            name: "StoreKitCommerceTests",
            dependencies: [
                .byName(name: "tauri-plugin-ios-folder"),
                .byName(name: "StoreKitTestSupport")
            ],
            path: "Tests/StoreKitCommerceTests",
            resources: [
                .copy("GAI.storekit")
            ],
            linkerSettings: [
                .linkedFramework("StoreKitTest", .when(platforms: [.iOS]))
            ])
    ]
)
