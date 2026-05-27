// Build script for the experimental embedded-mpv napi addon.
// libmpv + ANGLE are loaded at RUNTIME (libloading / khronos-egl dynamic), so
// there is nothing to link at build time — just wire up the N-API symbols.

fn main() {
    napi_build::setup();
}
