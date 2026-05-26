# Approach B — True libmpv Native Addon (render API): Research

Status: **research / documentation only. Nothing installed. No `package.json`
change. No native code. No edits to existing player files.**

Scope per request: evaluate a *true* libmpv embed — libmpv used as a native
library, modern **render API** (`mpv/render.h`) if rendering is attempted. Do
**not** launch `mpv.exe` as the player, do **not** use `--wid`, do **not** fake
embedding with iframe/webview. This is an isolated PoC investigation; external
MPV stays the default/fallback and the working flow is untouched.

Companion docs: `docs/embedded-mpv-experiment.md`,
`docs/libmpv-binding-evaluation.md`, `docs/libmpv-stage1-windows.md`,
`docs/libmpv-embedded-plan.md`.

---

## Step 1 — Existing Node/Electron libmpv bindings (evaluate before building)

The bar for "suitable" here is strict: it must (a) embed **libmpv** in-process,
(b) actually **render video** (not just control mpv), (c) use the **modern
render API** (not the removed PPAPI plugin path or deprecated `opengl-cb`),
(d) work on **current Electron** (we're on Electron ^32 / its Node ABI) on
**Windows x64**, and (e) be **maintained**.

### Candidate matrix

| Package / project | Maintenance | Windows | Electron compat | Node/ABI compat | Renders video? | Render API | Install / build | Risk |
|---|---|---|---|---|---|---|---|---|
| **mpv.js** (Kagami/mpv.js) | Stalled (~2019–2020) | Yes (ships prebuilt `mpvjs.node` + needs mpv DLL beside it) | **No** — embeds via Chromium **PPAPI/Pepper plugin**, removed from Chromium ~110; Electron 32 is far newer | Old; also wanted relaxed sandbox / `nodeIntegration` (conflicts with our `contextIsolation:true, sandbox:false, nodeIntegration:false`) | Yes (Pepper `<embed>`) | Pepper-plugin path — **dead mechanism** | npm install; register `getPluginEntry`; copy mpv DLL | **High** — won't load on E32 |
| **mpv.js-vanilla / mpv.js-bumped** (forks) | Sporadic | Same as mpv.js | **No** — still PPAPI-based; not re-architected | Same caveats | Yes | Same dead mechanism | Same | **High** |
| **zenwarr/libmpvjs** | Personal, ~34 commits, **1★/0 forks**, no release cadence — effectively unmaintained | Has a `build-mpv` script (Windows-oriented) | Built for an **older** Electron; unverified on E32 | C++ addon via `binding.gyp` (node-gyp); N-API status unverified | **Yes** — true libmpv render into a surface (see its `slowpoke-player`) | Likely modern `render.h`/OpenGL (needs source verification) | **Build from source**: node-gyp + build/obtain libmpv | **High** as a dependency — **but the best open reference** for our own addon |
| **stevevista/electron-mpv** | Personal, low activity | Electron-targeted | Unverified on E32 | Native addon | Provides an `<x-mpv>` custom element (renders) | Unverified (render API or handle) | Build from source | **High** — reference only |
| **node-libmpv** (npm) | ~7 years stale | No current prebuilds | ABI-incompatible with current Node/Electron | Stale ABI | Control-focused (`client.h`); **rendering unclear/none** | n/a (not a renderer) | node-gyp build | **High / not viable** |
| **node-mpv** (npm) | ~6 years stale | n/a | Works (it's just IPC) | n/a | **No** — spawns `mpv.exe`, JSON-IPC only | n/a | npm install | Not applicable to B (and would mean launching mpv.exe, which is excluded) |
| **WebChimera.js / wcjs-renderer** | Low | — | — | — | Yes, **but wraps libVLC, not mpv** | n/a | — | Out of scope |
| **Rust crates: `libmpv2` / `libmpv-sys` / `libmpv-rs`** | Moderately maintained | Yes (links libmpv) | n/a directly — would back a **napi-rs** addon | Via napi-rs → N-API | Yes — `libmpv2` exposes a render context | **Modern render API** | Rust toolchain + napi-rs + libmpv | Medium — viable **building block** for our own addon, but this **is** "build our own" |

### Step 1 conclusion
There is **no maintained, render-capable, Electron-32-compatible, Windows-prebuilt
Node/libmpv binding**. The only Electron-purpose-built renderers are either
mechanism-dead (`mpv.js` = PPAPI) or tiny unmaintained personal projects
(`zenwarr/libmpvjs`, `stevevista/electron-mpv`). None is safe to *adopt as a
dependency*. `zenwarr/libmpvjs` is, however, the most useful **reference
implementation** for how a libmpv render-API addon is wired with node-gyp on
Windows. The Rust `libmpv2` crate is the most attractive **building block** if
we write our own addon — but that is Step 2 (build our own), not an existing
binding.

---

## Step 2 — What building our own native addon would require

Two implementation languages are realistic:

**Option B1 — C/C++ N-API addon** (`node-addon-api`, built with `node-gyp` or
`cmake-js`). Closest to `zenwarr/libmpvjs`; most examples; we own C++.

**Option B2 — Rust addon via `napi-rs`** backed by the `libmpv2` crate. Less C++
to hand-write; memory-safety wins; still produces an N-API `.node`.

Either way the addon must be **N-API / context-aware** (Electron requires native
modules used in the renderer to be N-API or context-aware), and rebuilt for the
exact **Electron ABI**.

### Native pieces required
- **libmpv runtime:** `libmpv-2.dll` (a.k.a. `mpv-2.dll`) + its dependencies,
  bundled beside the `.node` (Windows requires the DLL next to the addon, and
  matching bitness/x64).
- **Dev files to compile against:** headers `mpv/client.h` (core API:
  `mpv_create`, `mpv_initialize`, `mpv_command`, `mpv_set/observe_property`,
  `mpv_wait_event`) and `mpv/render.h` + `mpv/render_gl.h` (render context:
  `mpv_render_context_create`, `mpv_render_context_render`,
  `mpv_render_context_set_update_callback`, `MPV_RENDER_API_TYPE_OPENGL`), plus
  the import lib (`mpv.lib` / `libmpv.dll.a`). Sources: SourceForge
  mpv-player-windows `/libmpv`, zhongfly/mpv-winbuild, shinchiro/mpv-winbuild-cmake,
  Ivshti/libmpv (headers).
- **Build toolchain (Windows):** Visual Studio Build Tools (MSVC + Windows SDK),
  Python (for node-gyp), and `node-gyp` **or** `cmake-js`; for B2 additionally
  the Rust toolchain + `@napi-rs/cli`.
- **Prebuild/packaging:** ship a compiled `.node` per Electron ABI + arch
  (prebuildify / prebuild-install), `electron-builder` `extraResources` +
  `asarUnpack`, and code-sign the DLL/addon on Windows to avoid SmartScreen
  friction.

### The rendering target — the genuinely hard part
The render API hands frames to **our** GL context; it does not draw into a
Chromium `<video>`/`<canvas>` for us. On Electron/Windows the realistic paths:
- **Offscreen FBO → texture → upload to a WebGL `<canvas>`** in the renderer.
  True compositing (HTML can overlay video, per the render API's design), but
  there is a **per-frame GPU→CPU→GPU copy cost** unless a zero-copy GL share can
  be arranged (hard across the addon/Chromium boundary).
- **Native GL surface created by the addon** and presented — but a separate
  native surface starts to resemble window embedding, which is explicitly out of
  scope here.
- Chromium's GL on Windows is **ANGLE → D3D11**; aligning libmpv's GL
  (`render_gl.h`) with ANGLE is the unproven, high-effort piece (the "Stage 3"
  risk from `docs/libmpv-embedded-plan.md`).

Because rendering is the risk, the smallest honest PoC is **two staged steps**:
1. **B-Headless:** addon loads `libmpv-2.dll` under Electron 32 on Windows,
   `mpv_create` + `mpv_initialize` succeed, `loadfile <direct http(s) URL>`
   plays (audio is enough), and `mpv_observe_property`/`mpv_wait_event` deliver
   `time-pos`/`duration`/`pause`. **No rendering.** This de-risks binding + ABI +
   DLL packaging cheaply.
2. **B-Render:** only if B-Headless passes — stand up `mpv_render_context` with
   the OpenGL render API and get visible frames into an in-app surface, then
   decide whether the FBO→canvas copy path is acceptable.

---

## Step 3 — Recommendation, difficulty, files, deps, rollback, fallback, success

### Recommendation
- **Do not adopt any existing binding** as a dependency — none is maintained +
  render-capable + Electron-32-compatible + Windows-prebuilt.
- If we proceed with Approach B, **build our own minimal N-API addon**, starting
  with **B-Headless** to prove libmpv loads/plays under our exact Electron/Node
  ABI on Windows, using **`zenwarr/libmpvjs` as a reference** and either C++
  (`node-gyp`/`cmake-js`) or Rust (`napi-rs` + `libmpv2`). Attempt **B-Render**
  only after B-Headless succeeds.
- This requires installing native build tooling and a native dependency, so per
  the rules **we stop here and request confirmation before any install/build**
  (Step 4).

### Why Approach B is hard
- No drop-in binding; we own a native build matrix and must rebuild per Electron
  ABI bump.
- Windows DLL bundling + code-signing + bitness matching.
- The render API needs our own GL context; bridging libmpv GL ↔ Chromium ANGLE
  cheaply is unproven (likely a per-frame copy via FBO→canvas).
- Native modules must be N-API/context-aware; thread-safe callbacks for the
  render update + event loop add complexity.

### Files that *would* be needed (none created now)
- `native/` (new, isolated): addon source (`*.cc` + `binding.gyp`, or Rust
  `Cargo.toml` + `lib.rs` for napi-rs), plus bundled `libmpv-2.dll` and headers
  used only at build time.
- A new isolated main-process loader (e.g. `electron/embeddedMpvNative.ts`) —
  **never** importing/altering `electron/mpv.ts`.
- A gated experimental page/route (e.g. `/experimental-player`) reachable only
  behind a new `experimentalEmbeddedPlayer` flag.
- No changes to `StreamCard`, `SourcesSection`, `MediaPage`, source ranking,
  subtitles, profiles, library, Continue Watching, or DB logic.

### Dependencies that *would* be required (NOT installed yet)
- Build: `node-addon-api` + `node-gyp` (or `cmake-js`); or `@napi-rs/cli` +
  Rust + `libmpv2`. Plus Visual Studio Build Tools + Windows SDK + Python.
- Runtime: `libmpv-2.dll` (+ deps) bundled with the app.
- Packaging: prebuildify/prebuild-install, electron-builder unpack/sign config.

### Rollback plan
- Everything is **additive and gated** (one new off-by-default flag + a separate
  page + a separate `native/`/loader module). Rollback = turn the flag off, or
  revert the additive commits and remove `native/`. Because no existing player
  file or dependency-of-the-default-path is touched, removal leaves the shipping
  app byte-for-byte unchanged. No DB migration (the flag is one additive
  `app_settings` key/value; absent → off).

### How external MPV remains the fallback
- `defaultPlayer` and the normal `playSourceWithMpv → openInMpv` path are
  unchanged; every existing Play button still uses external MPV.
- The native embedded path is reachable **only** from the experimental page when
  the flag is on, and on **any** failure (addon load, `mpv_initialize`, render)
  it falls back to external MPV via the existing `playWithMpv`.

### What success looks like (PoC exit criteria)
- **B-Headless (primary goal):** with the flag on, the native addon loads
  `libmpv-2.dll` under Electron 32 on Windows; `mpv_create`/`mpv_initialize`
  succeed; a direct HTTP/HTTPS URL plays (audio sufficient); property/event
  round-trip works. Regression guard: with the flag off, the app is exactly as
  today and `electron/mpv.ts` + IPC progress + profiles/library/CW/ranking are
  untouched.
- **B-Render (stretch):** video frames render via the modern render API into an
  in-app surface, with a written verdict on whether the surface/copy path is
  viable.
- A documented honest "render-into-Electron isn't worth the cost; stay on
  external MPV" is an acceptable outcome of the PoC.

---

## Step 4 — STOP. Confirmation required before any install or code.

Proceeding with Approach B means **installing native build tooling and a native
dependency** and writing a native addon. Per your instruction, I will not
install packages, modify `package.json`, write native addon code, or edit player
files until you confirm. Open decisions to confirm:
1. Build the addon in **C++ (node-gyp/cmake-js)** or **Rust (napi-rs + libmpv2)**?
2. Start with **B-Headless only** (recommended) before attempting any rendering?
3. OK to install the required **build tooling + libmpv dev files** at that point?

---

## B-Headless execution plan (DECIDED: Rust + napi-rs + libmpv2 — pending install approval)

Decisions locked: **Rust + napi-rs + `libmpv2`**, **B-Headless only** (no
rendering), and **nothing installed until explicitly approved**.

### 1. Packages / tooling to install (when approved)
System tooling (installers, NOT npm into the app):
- **Rust toolchain** via `rustup`, stable `x86_64-pc-windows-msvc`.
- **Visual Studio Build Tools 2022** with "Desktop development with C++"
  (MSVC v143 + Windows SDK) — Rust's MSVC target needs the MSVC linker.

npm dev-dependency **inside the isolated addon folder only** (its own
`package.json`, NOT the app root):
- `@napi-rs/cli` (runs `napi build`).

Rust crates (fetched by Cargo from the addon's `Cargo.toml`, not npm):
- `napi`, `napi-derive`, `napi-build` (build dep), `libmpv2`.

Manual download (NOT a package manager entry): the **`mpv-dev-x86_64-*.7z`**
Windows libmpv package providing `libmpv-2.dll`, the import lib
(`mpv.lib` / `libmpv.dll.a`), and `include/mpv/*.h` (for linking + runtime).

**Not needed:** `node-gyp`, `cmake` (napi-rs uses Cargo; `libmpv2` links the
prebuilt import lib, no CMake build of mpv required).

### 2. Where the addon lives
A single new, self-contained folder: **`native/libmpv-poc/`** — its own Cargo
project + its own `package.json`. Built and run **standalone** (system Node) for
this stage; because napi-rs produces an **N-API** `.node` (ABI-stable), success
under Node also validates it for Electron later, with no app wiring yet.

### 3. Files changed in this stage
All new, all under `native/libmpv-poc/` — **zero changes** to the app:
- `Cargo.toml`, `src/lib.rs` (napi addon: create/init handle, `loadfile` a
  direct http(s) URL, observe `time-pos`/`duration`/`pause`/`eof-reached`, read
  events, explicit destroy/cleanup), `build.rs` (point the linker at the libmpv
  import lib).
- `package.json` (devDep `@napi-rs/cli`; `build` script), `test.mjs` (standalone
  harness: load `.node`, play a URL, print events for a few seconds, clean up).
- `README.md` (build/run/remove), `.gitignore` (`target/`, `*.node`, libmpv
  binaries).
- **No** change to root `package.json`, `electron/**`, `src/**`, settings,
  routes, or DB. The experimental flag/route comes only if we later wire it in.

### 4. Isolation from the working external MPV player
Separate folder, separate Cargo/napi build, standalone Node test harness. The
app root `package.json`, all of `electron/` (including `electron/mpv.ts` and
`mpvIpc.ts`), all of `src/`, profiles, library, Continue Watching, source
ranking, subtitles, and the DB are **untouched**. External MPV remains the only
player the app uses.

### 5. Rollback
Delete the `native/libmpv-poc/` folder (and any downloaded libmpv binaries).
Optionally uninstall Rust / VS Build Tools at the OS level. Since nothing in the
app changed, removal leaves the app exactly as it is now.

### 6. Headless success criteria (this stage)
Addon builds; `libmpv-2.dll` is found/loaded; `mpv_create` + `mpv_initialize`
succeed; a direct HTTP/HTTPS URL loads and plays (audio is enough); `time-pos`/
`duration`/events are readable; teardown runs without crashing. No video
rendering.

---

## ✅ B-Headless RESULT — PASSED on Windows

Confirmed by the user: the addon **built and ran with no errors** on Windows.
All headless criteria met — `libmpv-2.dll` loaded at runtime, mpv version read,
a direct HTTP/HTTPS URL loaded, `time-pos`/`duration`/`pause` and
`file-loaded`/`end-file` events read, and cleanup ran without crashing.

**Implementation note (supersedes §1/§3 above):** the shipped PoC **switched
from linking the `libmpv2` crate to runtime dynamic loading via `libloading`**.
The Windows libmpv dev packages provide only `libmpv.dll.a` (MinGW), not an MSVC
`mpv.lib`, so the addon opens `libmpv-2.dll` at runtime and calls its C ABI
directly. Net: **no import lib, no headers, no `mpv.lib`** — only `libmpv-2.dll`
at runtime (placed in `native/libmpv-poc/vendor/libmpv/`). See
`native/libmpv-poc/README.md`. The addon remains fully isolated; `src/**`,
`electron/**`, root `package.json`, DB, settings, and external MPV are untouched.

---

# Stage B-Render — Planning (NEXT STAGE, planning only)

**No rendering is implemented here.** No `src/**` or `electron/**` changes. The
goal is to identify the *smallest safe* path to render libmpv video inside an
Electron window. External MPV stays the default/fallback. No debrid, no torrent.

## The core problem
The libmpv **render API** hands decoded frames to **our own GL context** — it
does not draw into an HTML `<video>`/`<canvas>` for us. So "render inside
Electron" means getting libmpv's output onto a surface Electron displays.
Chromium's renderer GL on Windows is **ANGLE → D3D11**, and that context is
**not directly shareable** with a native Node addon. Every realistic option is a
trade-off between copy cost, compositing fidelity, and native-windowing
complexity.

## Approaches compared

### R1 — Render API (OpenGL) → offscreen FBO → upload to a WebGL `<canvas>`
- **How:** the addon owns a GL context, creates `mpv_render_context`
  (`MPV_RENDER_API_TYPE_OPENGL`), renders each frame into an FBO/texture, reads
  it back, and uploads it to a WebGL texture in the renderer's `<canvas>`.
- **Realistic in Electron?** Yes — but with a per-frame GPU→CPU→GPU copy
  (`mpv_render_context_render` → PBO readback → canvas upload). Works; costs
  CPU/bandwidth at high resolution/fps. **True compositing** — HTML overlays on
  top of the video.
- **Native code:** yes — GL context + `get_proc_address`, render context, a
  thread-safe update callback, readback path.
- **Risk:** medium-high (perf + GL interplay), but it is the genuine in-window
  embed.

### R2 — Render API with ANGLE/D3D11 interop (low/zero-copy)
- **How:** drive libmpv's GL through **ANGLE** so it shares Chromium's
  ANGLE/D3D11 device, enabling a shared texture (EGL image / D3D11 shared
  handle) with little or no copy.
- **Realistic?** Theoretically the best performance, but **fragile and
  unproven** for us: matching Chromium's EGL/ANGLE context is undocumented and
  version-sensitive.
- **Native code:** yes, substantial (EGL/ANGLE/D3D11 interop).
- **Risk:** high. The optimization to pursue *after* R1, not first.

### R3 — Native child window/surface owned by the addon
- **How:** the addon creates its own native surface (D3D11/GL swapchain or an
  HWND) and renders mpv there via the render API, positioned over a placeholder
  region of the `BrowserWindow`.
- **Realistic?** Yes for "a picture on screen," but it's a **window overlay** —
  the same UX limits we set out to avoid (HTML can't draw over it; z-order/DPI/
  resize/fullscreen fiddliness). Note this is *render-API-into-a-native-surface*,
  still libmpv (not `mpv.exe --wid`), but the overlay caveats are identical.
- **Native code:** yes (window + surface management).
- **Risk:** medium for first frame; overlay UX caveats persist.

### R4 — Separate native helper window/process
- **How:** a dedicated native window (or helper process) owns libmpv + its
  surface; the main app positions it. Isolates native crashes.
- **Realistic?** Yes, with the R3 overlay caveats **plus** multi-window/process
  lifecycle and focus management.
- **Risk:** medium; more moving parts.

### R5 — Electron `NativeImage` / canvas CPU frame-push
- **How:** render frames to CPU memory and push them as `NativeImage`/`ImageData`
  to a canvas each frame.
- **Realistic?** **No** for real-time video — full CPU readback + per-frame JS
  image handling is far too slow; `NativeImage` is built for static images, not
  a video pipeline.
- **Risk:** low complexity but unacceptable performance → **not recommended**.

## What can realistically render inside Electron (verdict)
- For **true in-renderer compositing**, **R1** (render API → FBO → WebGL canvas)
  is the realistic first target; accept the copy cost for the PoC and measure it.
  **R2** (zero-copy ANGLE interop) is the later optimization.
- **R3/R4** get a picture on screen fastest but reintroduce the overlay UX limits
  we deliberately moved away from.
- **R5** is out on performance.

## What would need native code
All viable options require native code **in the addon** (extending the existing
`native/libmpv-poc/` Rust project): a GL context + `get_proc_address`,
`mpv_render_context_create/render/free`, a thread-safe render update callback,
and either a readback→upload path (R1) or surface/interop (R2/R3/R4). **No
`src/**` or `electron/**` changes for the PoC.**

## Proof-of-concept files that would be created NEXT (when approved)
Kept isolated (in `native/libmpv-poc/` or a sibling `native/libmpv-render-poc/`):
- A new Rust source (e.g. `src/render.rs`): create an **offscreen** GL context,
  build an `mpv_render_context` (OpenGL), render N frames from a URL into an FBO,
  and read the pixels back.
- A standalone test (e.g. `render_test.mjs`) that asks the addon to render a few
  frames and **writes a PNG/PPM to disk** (or reports non-blank frame stats) —
  proving frames are produced **without Electron** yet.
- README additions: the GL dependency, how to run, and success = a saved frame
  image that isn't blank.
- Only after that "frames exist" proof would we consider a **separate, later,
  explicitly-approved** Electron canvas-upload step, gated behind the
  experimental flag/route.
- No new app dependencies, no `src/**`/`electron/**` edits, external MPV
  unchanged.

## Recommended next PoC (smallest safe step)
**R1, offscreen, no Electron yet:** prove the render API produces real
(non-blank) frames into an FBO and that we can read them back to a PNG. This
de-risks the hardest piece (GL context + render API) **before** touching
Electron's canvas at all. If it passes, the *next* step is uploading those frames
to a WebGL canvas in a gated experimental page.

## Guardrails (unchanged)
External MPV remains the default/fallback; the experiment stays additive, gated,
and removable; no debrid; no torrent; and **no rendering is implemented in this
planning step.**

---

## ✅ R1 RESULT — offscreen render-to-PNG PASSED on Windows

Confirmed by the user: the `render-poc` binary rendered a **real video frame**
offscreen through the libmpv render API and saved it to `frame.png` (non-blank),
with a clean exit. This validates the hardest piece — an offscreen ANGLE EGL
pbuffer + GLES context, an `mpv_render_context`, rendering into an FBO, and a
pixel read-back — entirely **without Electron** and **without a window**.

Built form (see `native/libmpv-poc/render-poc/`): a standalone Rust binary
(`cargo run`), separate from the headless addon. Crates used: `libloading`,
`khronos-egl` (dynamic, ANGLE), `png` — plus direct GL FFI (no `glow`). ANGLE
DLLs (`libEGL.dll`/`libGLESv2.dll`) were copied from the Electron install into
`vendor/angle/`; `libmpv-2.dll` reused from `vendor/libmpv/`. The app
(`src/**`, `electron/**`, root `package.json`, DB, settings, external MPV)
remained untouched.

**Proven so far:** B-Headless (load/play/events/cleanup) ✅ and R1 (one real
frame rendered offscreen to PNG) ✅. Next is making frames *continuous* and
getting them onto a surface Electron can show — Stage R1B below.

---

# Stage R1B — Continuous frames into an experimental Electron canvas (PLANNING)

**No `src/**` or `electron/**` changes here. Planning only.** Goal: the smallest
safe step to display libmpv-rendered frames **inside Electron** without touching
the current player. External MPV stays default/fallback; the path is
experimental, gated, and removable. No debrid, no torrent.

## From one `frame.png` to live frames — what changes
R1 rendered a single frame on demand and read it back once. R1B needs four
things on top of that:

1. **A repeated render loop driven by mpv.** Instead of our `sleep`+poll, use the
   render API's signal: `mpv_render_context_set_update_callback(cb, ctx)` fires
   when a new frame is ready; then `mpv_render_context_update()` returns flags
   (`MPV_RENDER_UPDATE_FRAME`) telling us to call `mpv_render_context_render()`.
   Render into the FBO each time a frame is due (cap to display refresh).
2. **A defined frame buffer format.** Keep the R1 path: render into an RGBA8 FBO,
   `glReadPixels(GL_RGBA, GL_UNSIGNED_BYTE)` → a tightly-packed
   `width*height*4` byte buffer. Document stride = `width*4`, origin (top-left
   after the existing FLIP_Y / row flip), and color order **RGBA** (matches
   `ImageData` and WebGL `RGBA/UNSIGNED_BYTE`, so no swizzle needed).
3. **A way to push frames to JS.** The native addon (napi-rs) exposes the latest
   frame to the renderer process — either by copying the RGBA buffer across the
   N-API boundary, or via shared memory (see approach comparison).
4. **Drawing frames in the renderer.** Put the bytes into a `<canvas>`:
   - **2D canvas:** wrap the buffer in `ImageData` and `ctx.putImageData()` — simplest.
   - **WebGL:** upload the buffer with `texImage2D`/`texSubImage2D` and draw a
     full-screen quad — faster, less main-thread cost, scales better.
   For the first experiment, 2D `putImageData` is the least code; WebGL is the
   follow-up if/when perf needs it.

## Approaches compared (getting frames from the addon to the canvas)

### A1 — Native addon returns raw RGBA frames to JS (copy per frame)
- **How:** a napi method returns the latest frame as a `Buffer`/`Uint8Array`
  (RGBA). The renderer polls (or is notified) and draws it.
- **Pros:** simplest; no shared-memory plumbing; works with the existing napi
  addon; easy to reason about and roll back.
- **Cons:** a full-frame copy across the N-API boundary each frame
  (720p ≈ 3.5 MB, 1080p ≈ 8 MB). Fine for a PoC at modest size/fps; CPU/GC
  pressure at high res/fps.
- **Risk:** low. **Recommended for the first experiment.**

### A2 — Native addon writes frames into shared memory
- **How:** the addon writes RGBA into a shared buffer (e.g. a `SharedArrayBuffer`
  view, or OS shared memory) that the renderer reads without copying.
- **Pros:** avoids the per-frame copy; better at high res/fps.
- **Cons:** synchronization (double/triple buffering, tear-free hand-off),
  lifetime management, and `SharedArrayBuffer` requires cross-origin isolation
  headers — added complexity for a first step.
- **Risk:** medium. A later optimization once A1's pipeline works.

### A3 — Native addon exposes a GPU texture handle (zero-copy)
- **How:** share the GPU texture (D3D11 shared handle / EGLImage) so the renderer
  composites it without any CPU readback — this is essentially **R2**.
- **Pros:** best performance; no readback, no copy.
- **Cons:** must interop with Chromium's exact ANGLE/D3D11 device; undocumented,
  fragile, version-sensitive. Not a "smallest step."
- **Risk:** high. Defer until A1 proves the UX and we decide perf warrants it.

### A4 — Separate helper process streams frames
- **How:** a helper process owns libmpv + rendering and streams frames (shared
  mem / pipe) to the app.
- **Pros:** isolates native crashes from the renderer.
- **Cons:** IPC + serialization overhead, process lifecycle, more moving parts.
- **Risk:** medium-high. Overkill for a first experiment.

## Smallest first Electron experiment (recommended)
**A1 + 2D-canvas, behind an experimental flag, on a dedicated route.**
- Extend the **napi addon** (in `native/libmpv-poc/`, or graduate it into a real
  app addon later) to: open a URL, run the update-callback render loop into an
  offscreen FBO, and expose `getLatestFrame()` returning `{ width, height, rgba }`
  plus `start(url)` / `stop()`.
- In a **gated experimental renderer page** (`/experimental-player`), poll
  `getLatestFrame()` on `requestAnimationFrame`, `putImageData` into a `<canvas>`.
- Keep it modest (e.g. 854×480 or 1280×720, cap fps) to stay smooth with the
  copy path. Audio can stay on (`ao` default) or off for the experiment.
- This proves *moving video* shows inside an Electron window with the least new
  surface area, and is trivially removable.

## Exact files that WOULD be touched (when approved — not yet)
Isolated/experimental; external MPV path untouched:
- **Native (extend the PoC, or a sibling addon):**
  `native/libmpv-poc/src/lib.rs` (add `start`/`stop`/`getLatestFrame` + the
  update-callback render loop; reuse the R1 EGL/GL/render code), and its
  `Cargo.toml` (add the EGL/GL deps already used by `render-poc`).
- **Electron main:** a NEW isolated module `electron/embeddedMpvExperimental.ts`
  (loads the addon, exposes IPC), NEW channels in `electron/ipc-channels.ts`,
  handlers in `electron/main.ts`, and a preload binding in `electron/preload.ts`.
  `electron/mpv.ts` / `mpvIpc.ts` are **not** modified.
- **Renderer:** a NEW page `src/pages/ExperimentalPlayerPage.tsx` + a route in
  `src/App.tsx`, gated behind a new `experimentalEmbeddedPlayer` flag
  (`db.ts` + `AppSettings` + `SettingsContext` + a Settings toggle).
- **No** changes to `StreamCard`, `SourcesSection`, `MediaPage`, source ranking,
  subtitles, profiles, library, Continue Watching, or the external-MPV flow.

> Note: this is the first step that would touch `src/**` and `electron/**` — and
> only behind a flag + dedicated route. We will scope and approve that
> separately; **nothing is implemented in this planning step.**

## R1B success criteria
With the flag on, the experimental page shows **moving** libmpv video inside the
Electron window (frames updating from a direct URL) via the 2D canvas, with a
clean start/stop and no impact on the default external-MPV player when the flag
is off. An honest "the copy path is too costly → move to WebGL upload or A2/A3"
is an acceptable outcome that informs the next step.

## Guardrails (unchanged)
External MPV remains default/fallback; experiment additive + gated + removable;
no debrid; no torrent; and **no code is written in this planning step.**
