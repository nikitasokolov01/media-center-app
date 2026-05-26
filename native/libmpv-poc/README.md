# libmpv-poc — Headless libmpv proof-of-concept (Approach B)

> **Status: ✅ B-Headless PASSED · ✅ R1 offscreen render-to-PNG PASSED (Windows).**
> B-Headless: `libmpv-2.dll` loaded at runtime, version read, URL loaded,
> `time-pos`/`duration`/`pause` + `file-loaded`/`end-file` events read, clean
> cleanup. R1 (`render-poc/`): a **real video frame** rendered offscreen via the
> libmpv render API and saved to `frame.png` (non-blank), clean exit. Next stage
> is **R1B planning** — continuous frames into an experimental Electron canvas
> (see `docs/libmpv-native-approach-b.md`); not implemented here.

**Isolated experiment. Not part of the Media Center app.** A standalone
Rust + napi-rs native addon that proves libmpv can be driven from a native Node
addon **headlessly** (no rendering). It does not touch `electron/**`, `src/**`,
the root `package.json`, the database, settings, or the external-MPV playback
path. Delete this folder to remove the experiment entirely.

## Why runtime dynamic loading (no import lib)

The Windows libmpv dev packages ship `libmpv-2.dll` and a **MinGW** import lib
`libmpv.dll.a` — but **no MSVC `mpv.lib`**. The Rust MSVC toolchain can't link a
`.dll.a`, and generating an `mpv.lib` is fiddly. So this PoC **does not link
libmpv at build time at all**: it opens `libmpv-2.dll` at **runtime** with the
Rust `libloading` crate and calls libmpv's C ABI directly. Result: **no
`mpv.lib`, no `libmpv.lib`, no `libmpv.dll.a`, and no headers** are required to
build or run.

What it proves (only this — no rendering, no Electron):
1. addon builds, 2. `libmpv-2.dll` loads at runtime, 3. mpv version reads,
4. a direct HTTP/HTTPS URL loads, 5. `time-pos`/`duration`/`pause` and
`file-loaded`/`end-file` events are read, 6. cleanup runs without crashing.

---

## 1. Setup commands (one-time)

Run in an **x64** shell.

1. **Rust (MSVC toolchain)** — <https://rustup.rs>, then:
   ```powershell
   rustup default stable-x86_64-pc-windows-msvc
   rustc --version
   ```
2. **Visual Studio Build Tools 2022** — "Build Tools for Visual Studio" with the
   **"Desktop development with C++"** workload (MSVC v143 + Windows SDK). Rust's
   MSVC target needs this linker. (No CMake, no node-gyp, no Python required.)
3. **napi CLI** (local to this folder, not the app):
   ```powershell
   cd "native\libmpv-poc"
   npm install
   ```

> You do **not** need the libmpv headers or any import lib. You only need the
> runtime DLL (next step).

---

## 2. Build command

```powershell
cd "native\libmpv-poc"
npm install        # first time only (installs @napi-rs/cli locally)
npm run build      # release build -> index.js + libmpv-poc.<triple>.node
```

No `LIBMPV_LIB_DIR`, no `lib.exe`/`.def` step — there is nothing to link.

---

## 3. Test command

```powershell
cd "native\libmpv-poc"
node test.mjs
# custom URL / duration:
node test.mjs "https://example.com/video.mp4" 8
```

(`npm test` runs the same `node test.mjs`.)

---

## 4. Where to put libmpv-2.dll

Place the DLL (from the dev package you already have) at:

```
native\libmpv-poc\vendor\libmpv\libmpv-2.dll
```

```powershell
mkdir "native\libmpv-poc\vendor\libmpv" 2>$null
copy "C:\path\to\mpv-dev\libmpv-2.dll" "native\libmpv-poc\vendor\libmpv\"
```

Alternatively point at it explicitly:
```powershell
$env:LIBMPV_DLL = "C:\path\to\libmpv-2.dll"
node test.mjs
```

Notes:
- Must be the **x64** `libmpv-2.dll` (match your x64 Node/Rust).
- You do **not** need `libmpv.dll.a`, `mpv.lib`, or the `include/` headers.
- The DLL is git-ignored (`/vendor/`) — each machine provides its own.

---

## 5. Expected output on success

```
[poc] libmpv-2.dll: ...\native\libmpv-poc\vendor\libmpv\libmpv-2.dll
[poc] loading native addon…
[poc] mpvVersion():
       mpv 0.xx.0 ...
[poc] runHeadlessDemo(url=…, seconds=8)…
[poc] report:
{
  "mpvVersion": "mpv 0.xx.0 ...",
  "created": true,
  "fileLoaded": true,
  "eofReached": false,        // true if the clip ended within the window
  "duration": 10.0,           // some number
  "lastTimePos": 3.2,         // advances over the run
  "paused": false,
  "propertyReads": 14,        // > 0 — the poll loop advanced
  "eventsLog": ["file-loaded", ...]
}

[poc] SUCCESS ✅  libmpv loaded, URL opened, properties/events read, cleanup OK.
```

Success = `created: true`, `fileLoaded: true`, a non-null `duration` or
`lastTimePos`, and a clean exit (code 0), with no crash.

---

## 6. If it fails — what to paste back

Copy the **full** output of the failing step.

- **Rust compile error** (`error[E…]` from `napi build`): paste the error lines.
  The FFI in `src/lib.rs` is plain libmpv C ABI, so this is usually a quick fix.
- **`mpvVersion()` throws / "failed to load '…libmpv-2.dll'"**: the DLL isn't at
  `vendor\libmpv\libmpv-2.dll` (or `LIBMPV_DLL`), or it's the wrong bitness, or a
  dependent DLL is missing. Paste the exact message (e.g. OS error 126/127).
- **"symbol mpv_… not found in libmpv"**: the DLL is unusually old/trimmed.
  Paste which symbol; we can adjust.
- **`fileLoaded: false` with `end-file` in `eventsLog`**: the URL didn't open
  (network/format). Paste the `report` JSON and try a known-good direct `.mp4`.
- **Crash / hang**: paste the last lines and whether it was during load, play,
  or exit.

Also paste, if relevant:
```powershell
rustc --version
cargo --version
node --version
npx napi --version
```

---

# B-Render PoC (R1, offscreen render-to-PNG)

A **separate** binary sub-crate at `render-poc/` that proves the libmpv **render
API** can produce a real video frame **offscreen** (no window, no Electron) and
save it to `frame.png`. It does not touch the headless addon above, `src/**`,
`electron/**`, or the app. Offscreen GL is an **ANGLE EGL pbuffer**, reusing
ANGLE DLLs from your existing Electron install.

> **✅ RESULT: PASSED on Windows.** Rendered a real (non-blank) video frame to
> `frame.png` with a clean exit. The next stage (R1B) makes frames *continuous*
> and draws them into an experimental Electron canvas — planned in
> `docs/libmpv-native-approach-b.md`, not implemented yet.

### One-time: copy the ANGLE DLLs

```powershell
mkdir "native\libmpv-poc\vendor\angle" 2>$null
copy "node_modules\electron\dist\libEGL.dll"     "native\libmpv-poc\vendor\angle\"
copy "node_modules\electron\dist\libGLESv2.dll"  "native\libmpv-poc\vendor\angle\"
```

(If your Electron is elsewhere, point at its `dist` folder. Both files must be
**x64**, matching your `libmpv-2.dll`.) `libmpv-2.dll` is reused from
`native\libmpv-poc\vendor\libmpv\` (placed during the headless PoC).

### Build + run

```powershell
cd "native\libmpv-poc\render-poc"
cargo run --release -- "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4"
```

`frame.png` is written into `render-poc\`.

### Expected success output

```
[render-poc] libmpv : ...\vendor\libmpv\libmpv-2.dll
[render-poc] angle  : ...\vendor\angle
[render-poc] EGL initialized: 1.5
[render-poc] EGL pbuffer + GLES context current
[render-poc] FBO 1280x720 ready (texture 1, fbo 1)
[render-poc] libmpv loaded: mpv 0.xx.0 ...
[render-poc] mpv_render_context created
[render-poc] file-loaded
[render-poc] frame on attempt 3: 92.4% non-black
[render-poc] wrote frame.png
[render-poc] SUCCESS ✅  rendered a real frame to frame.png (92.4% non-black)
```

Success = `frame.png` exists, is 1280×720, is **not** blank/near-black, exit 0.

### If it fails — what to paste back

- **Rust compile error** (`error[E…]`): paste the lines. Most likely the
  `khronos-egl` API (e.g. `load_required_from_filename`, `choose_first_config`,
  `create_pbuffer_surface`, `create_context`) differs slightly in your installed
  version — a quick fix.
- **"failed to load libEGL.dll (ANGLE)"**: `libEGL.dll`/`libGLESv2.dll` aren't in
  `vendor\angle\`, or are the wrong bitness. Paste the message.
- **`eglInitialize`/`eglChooseConfig`/`eglCreateContext` failed**: paste which
  call. (ANGLE version/config mismatch.)
- **`mpv_render_context_create failed`**: paste the code; usually the GL context
  isn't current or the init params struct needs adjusting.
- **`frame.png` blank / "near-black"**: paste the full output incl. any
  `glGetError` lines; try a known-good direct `.mp4`. (Decode may need more time,
  or hwdec/GL interop issue.)
- **Crash / hang**: paste the last lines and where it stopped.

Plus:
```powershell
rustc --version
cargo --version
```

### Rollback
Delete `native\libmpv-poc\render-poc\`, `native\libmpv-poc\vendor\angle\`, and
`frame.png`. Nothing else changes; the headless PoC and the app are untouched.
