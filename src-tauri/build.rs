fn main() {
    tauri_build::build();
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_macos_storekit();
    }
}

#[cfg(target_os = "macos")]
fn build_macos_storekit() {
    use std::{env, path::PathBuf, process::Command};

    let sources = [
        "tauri-plugin-ios-folder/ios/Sources/CommercePolicy.swift",
        "tauri-plugin-ios-folder/ios/Sources/CommercePlugin.swift",
        "macos-commerce/CommerceBridge.swift",
    ];
    for source in sources {
        println!("cargo:rerun-if-changed={source}");
    }
    let availability = "macos-commerce/Availability.c";
    println!("cargo:rerun-if-changed={availability}");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");

    let deployment = env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "10.13".into());
    let arch = env::var("CARGO_CFG_TARGET_ARCH").expect("Cargo target architecture");
    let swift_arch = if arch == "aarch64" { "arm64" } else { &arch };
    let target = format!("{swift_arch}-apple-macosx{deployment}");
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    let library = out.join("libgai_mac_commerce.a");
    let probe = out.join("gai_macos_availability.o");

    let status = Command::new("xcrun")
        .args(["--sdk", "macosx", "swiftc", "-target", &target])
        .args(["-swift-version", "5", "-O", "-parse-as-library"])
        .args(["-emit-library", "-static", "-module-name", "GAIMacCommerce"])
        .args(sources)
        .arg("-o")
        .arg(&library)
        .status()
        .expect("run the macOS Swift compiler");
    assert!(
        status.success(),
        "macOS StoreKit bridge compilation failed: {status}"
    );

    let status = Command::new("xcrun")
        .args([
            "--sdk",
            "macosx",
            "clang",
            "-target",
            &target,
            "-c",
            availability,
            "-o",
        ])
        .arg(&probe)
        .status()
        .expect("compile the macOS availability check");
    assert!(
        status.success(),
        "macOS availability check failed: {status}"
    );

    let status = Command::new("xcrun")
        .arg("ar")
        .arg("-r")
        .arg(&library)
        .arg(&probe)
        .status()
        .expect("add the macOS availability check to the bridge library");
    assert!(
        status.success(),
        "could not finish the macOS StoreKit library: {status}"
    );

    swift_rs::SwiftLinker::new(&deployment).link();
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=gai_mac_commerce");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

    // The Intel build still launches on macOS versions that predate system Swift.
    if arch == "x86_64" {
        let compiler = Command::new("xcrun")
            .args(["--sdk", "macosx", "--find", "swiftc"])
            .output()
            .expect("locate the macOS Swift toolchain");
        assert!(
            compiler.status.success(),
            "could not locate the macOS Swift toolchain"
        );
        let compiler = String::from_utf8(compiler.stdout).expect("UTF-8 Swift compiler path");
        let foundation = PathBuf::from(compiler.trim())
            .parent()
            .and_then(std::path::Path::parent)
            .expect("Swift compiler toolchain directory")
            .join("lib/swift-5.0/macosx/libswiftFoundation.dylib");
        println!("cargo:rustc-link-arg=-Wl,-weak-lswiftCore");
        println!(
            "cargo:rustc-link-arg=-Wl,-weak_library,{}",
            foundation.display()
        );
    }
}
