fn main() {
    // Android 15+ can run with 16 KB memory pages, and Google Play now requires
    // apps to support them. Every bundled native `.so` must have its ELF LOAD
    // segments aligned to 16 KB, but the NDK r27 linker still defaults to 4 KB
    // for a plain cargo `cdylib` build (only NDK r28+ / ndk-build / CMake flip
    // the default), which fails the alignment check for `libmd_specpad_lib.so`.
    // Ask lld for a 16 KB max page size. Android only — `-z max-page-size` is an
    // ld/lld option the MSVC and Apple linkers don't understand, and the flag is
    // scoped to the cdylib so it never touches the desktop bin/rlib/staticlib.
    // https://developer.android.com/guide/practices/page-sizes
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-z,max-page-size=16384");
    }

    // Whisper's Vulkan backend (Cargo.toml) imports one symbol from
    // vulkan-1.dll. That DLL comes with the GPU driver, not with Windows, so
    // a machine without one (a VM, a server, a bare install) would fail to
    // start the app at all if it were an ordinary import. Delay-load it
    // instead, with a failure hook (src/vulkan_delayload.cpp) that turns
    // "DLL not found" into the C++ exception ggml's Vulkan registration
    // already catches — the backend is then simply absent and whisper.cpp
    // runs on the CPU. Test binaries get the same treatment (cargo test runs
    // on GPU-less runners).
    //
    // The hook pointers are data symbols that delayimp.lib also defines (as
    // null). A definition inside a static library only wins if that library
    // is searched first, which cargo's link line does not promise — so the
    // object file itself goes on the link line, ahead of every library, and
    // delayimp's own definitions are never pulled in. (LNK4199 is the
    // "no imports from vulkan-1.dll" note on the one test binary that never
    // touches whisper; not worth a warning per build.)
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let objects = cc::Build::new()
            .cpp(true)
            .file("src/vulkan_delayload.cpp")
            .flag("/EHsc")
            .compile_intermediates();
        for object in objects {
            println!("cargo:rustc-link-arg={}", object.display());
        }
        println!("cargo:rerun-if-changed=src/vulkan_delayload.cpp");
        println!("cargo:rustc-link-lib=delayimp");
        println!("cargo:rustc-link-arg=/DELAYLOAD:vulkan-1.dll");
        println!("cargo:rustc-link-arg=/IGNORE:4199");
    }
    tauri_build::build()
}
