// Build script for the headless libmpv PoC.
//
// We load libmpv-2.dll at RUNTIME (via `libloading`), so there is nothing to
// link at build time — no import lib, no headers, no link-search paths. The
// only job here is to wire up the N-API symbols.

fn main() {
    napi_build::setup();
}
