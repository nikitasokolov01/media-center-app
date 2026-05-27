# embedded-mpv — EXPERIMENTAL embedded libmpv addon (Stage E1)

A napi-rs native addon that renders libmpv video **offscreen** on a background
thread and exposes the latest RGBA frame to JavaScript. The Electron **main
process** loads it for the experimental `/experimental-embedded-player` route
only. **It is not the default player** — external MPV remains the default and
fallback, and the app launches fine even if this addon is missing.

Graduated from `native/libmpv-poc/render-loop-poc` (which stays frozen as PoC
history). Same approach: dynamic-load `libmpv-2.dll`, offscreen ANGLE EGL
pbuffer + GLES, libmpv render API into an FBO, `glReadPixels` → CPU buffer.

## API (consumed by `electron/embeddedMpvExperimental.ts`)
- `start(url: string, libmpvPath: string): void` — spawn the render thread.
- `stop(): void` — signal + join + clean up (idempotent).
- `getLatestFrame(sinceIndex: number): FrameResult` where
  `FrameResult = { noNewFrame, width, height, frameIndex, rgba?: Buffer, error?: string }`.
  Returns `noNewFrame: true` (no buffer) when nothing newer than `sinceIndex`.

## Build (manual — not part of the app's npm scripts)
Prereqs (same as `native/libmpv-poc`): Rust MSVC toolchain + Visual Studio Build
Tools 2022 ("Desktop development with C++"), and `@napi-rs/cli`.

```powershell
cd "native\embedded-mpv"
npm install          # installs @napi-rs/cli locally
npm run build        # -> index.js + embedded-mpv.<triple>.node
```

## Required DLLs (place in vendor/)
Reuse the same x64 DLLs as the PoC:

```powershell
mkdir "native\embedded-mpv\vendor" 2>$null
copy "native\libmpv-poc\vendor\libmpv\libmpv-2.dll" "native\embedded-mpv\vendor\"
copy "native\libmpv-poc\vendor\angle\libEGL.dll"    "native\embedded-mpv\vendor\"
copy "native\libmpv-poc\vendor\angle\libGLESv2.dll" "native\embedded-mpv\vendor\"
```

At runtime the Electron main process prepends `native/embedded-mpv/vendor/` to
`PATH` (so ANGLE resolves) and passes the full `libmpv-2.dll` path to `start()`.

## How the app loads it
`electron/embeddedMpvExperimental.ts` lazily `require()`s the built `.node` from
this folder, inside a try/catch. If the build or DLLs are missing, the
experimental page shows a friendly error and the rest of the app is unaffected.

## Remove / rollback
Delete `native/embedded-mpv/` and turn the **Experimental → Embedded player**
setting off. Nothing else depends on it; external MPV is untouched.
