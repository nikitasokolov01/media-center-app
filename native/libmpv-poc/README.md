# libmpv-poc — Headless libmpv proof-of-concept (Approach B)

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
