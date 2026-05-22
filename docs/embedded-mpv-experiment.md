# Embedded MPV / libmpv — Experiment Plan

Status: **experiment / planning. No embedded-player code has been written yet.**
This doc covers Steps 1–3 (inspect, research, document). Step 4 (code behind a
feature flag) happens only after explicit approval of the plan in §7.

Companion docs (earlier research): `docs/libmpv-embedded-plan.md`,
`docs/libmpv-stage1-windows.md`, `docs/libmpv-binding-evaluation.md`.

Hard rules for this experiment (restating the constraints):
- External MPV stays the **default and fallback**; it is never removed.
- MPV JSON-IPC controls (play/pause/seek/track menus/progress) are not broken.
- Profiles, Library, Continue Watching, stream fetching, and source ranking are
  untouched.
- No iframe/webview fake embedding. No debrid. No torrent resolving.

---

## 1. Current player architecture (as built)

**External MPV (the working default).**
- Launched in the Electron **main process**: `electron/mpv.ts` → `openInMpv()`
  uses `child_process.spawn(mpvPath, args, { detached, stdio: "ignore",
  shell: false })`. Inputs are validated (http(s) only); args are an array
  (never a shell string). MPV opens its **own OS window**.
- **Single active instance**: `openInMpv()` calls `stopActiveSession()` first
  (flush progress → `quit` over IPC → tear down → force-kill if needed). One
  `activeSession` + `activeChild` are tracked module-level.
- **JSON-IPC**: `electron/mpvIpc.ts` (`MpvIpcSession`) connects to
  `--input-ipc-server=<pipe>` (Windows named pipe / Unix socket). It polls
  progress every 5s and persists to SQLite, applies audio/subtitle language
  preferences on `file-loaded`, and exposes control methods
  (toggle pause, seek relative/absolute, set/cycle aid & sid, getState).
- **Control + state IPC**: channels `mpv:open`, `mpv:check-available`,
  `mpv:control`, `mpv:get-state` in `electron/ipc-channels.ts`; handlers in
  `electron/main.ts`; bridge in `electron/preload.ts` (`window.electronAPI`).
- **Renderer wrapper**: `src/core/player/mpvExternal.ts`
  (`playWithMpv`, `controlMpv`, `getMpvState`, `checkMpvAvailable`).
- **In-app controls UI**: `src/components/NowPlayingBar.tsx` polls
  `getMpvState()` (~1s) and drives the external MPV window (scrub bar,
  play/pause, seek, audio/sub track menus).
- **Browser player (secondary)**: `src/pages/PlayerPage.tsx` (HTML5 + hls.js),
  route `/watch/:type/:id`. Used only when the user prefers it / format is
  browser-safe.
- **Launch entry points**: `src/components/StreamCard.tsx` (per-source Play) and
  `src/components/SourcesSection.tsx` (auto-play / Play Best Source). Both build
  a `PlayableStreamPayload` and call the shared
  `src/features/player/playSource.ts → playSourceWithMpv()`.

**Where backends are defined.**
- `src/core/player/types.ts`:
  `type PlayerBackend = "browser" | "mpv-external" | "mpv-ipc" | "mpv-embedded-future"`
  plus `BackendCapability`, `PlayableStreamPayload`, `MpvControlAction`,
  `MpvPlaybackState`, `AppSettings`.
- `src/core/player/playerBackends.ts`: `BACKENDS` registry with an `implemented`
  flag. `mpv-external` and `browser` are `implemented: true`; `mpv-ipc` and
  `mpv-embedded-future` are `implemented: false` placeholders. `mpv-embedded-future`
  already documents the exact options (window-handle `wid`, render-API addon).

**Settings that exist today** (`AppSettings`, stored as key/value in the
`app_settings` SQLite table; defaults in `electron/db.ts`):
`defaultPlayer` ("browser"|"mpv"), `mpvPath`, `autoEnableSubtitles`,
`subtitleLanguage`, `audioLanguage`, `animeAudioLanguage`, `autoSelectSource`,
`autoPlayBestSource`, `preferredSourceQuality`, `hideCamSources`. Settings flow:
`db.ts` ⇄ IPC `settings:get/update` ⇄ preload ⇄ `SettingsContext` ⇄
`SettingsPage`.

**Window/runtime facts relevant to embedding.**
- `electron/main.ts → createWindow()` makes a single `BrowserWindow` with
  `contextIsolation: true, nodeIntegration: false, sandbox: false`. The main
  process can call `win.getNativeWindowHandle()` (returns the HWND buffer on
  Windows) and can create child `BrowserWindow`s.
- App routes (`src/App.tsx`, HashRouter): `/`, `/search`, `/library`,
  `/addons`, `/catalog/...`, `/media/:type/:id`, `/watch/:type/:id`,
  `/settings`. Adding `/experimental-player` is a one-line route + a page.

**Files an experimental embedded backend would touch (minimal set):**
- Types: `src/core/player/types.ts` (add `"embedded-mpv-experimental"` to
  `PlayerBackend`; the existing `"mpv-external"` is the user's "external-mpv").
- Registry: `src/core/player/playerBackends.ts` (register the experimental
  backend, gated).
- Settings: `electron/db.ts`, `src/core/player/types.ts` (AppSettings),
  `src/state/SettingsContext.tsx`, `electron/preload.ts`,
  `src/pages/SettingsPage.tsx` (one boolean toggle).
- Main process: a NEW isolated module (e.g. `electron/embeddedMpv.ts`) +
  channels in `ipc-channels.ts` + handlers in `main.ts` + preload bindings. The
  existing `electron/mpv.ts` is **not modified** (so external MPV cannot break).
- Renderer: a NEW page `src/pages/ExperimentalPlayerPage.tsx` + route in
  `src/App.tsx`. Nothing in `StreamCard`/`SourcesSection`/`MediaPage` changes.

This isolation is deliberate: the experiment is additive and removable.

---

## 2. Approach evaluation

Order requested: prefer evaluating an **existing binding** first; do not install
new native deps without explaining why.

### A. Existing maintained Node/Electron libmpv binding — evaluated, rejected
Confirmed against npm/GitHub (see `docs/libmpv-binding-evaluation.md`):
- **mpv.js** (the only Electron-purpose-built one) embeds libmpv through
  Chromium's **PPAPI/Pepper plugin** mechanism, which **modern Chromium/Electron
  removed** (~Chromium 110). Our Electron ^32 is far past that → mpv.js cannot
  load. It also wanted relaxed sandbox/nodeIntegration that conflicts with our
  hardened `webPreferences`.
- **node-mpv** is the external-process + JSON-IPC model we already implement —
  not embedding.
- **node-libmpv** is ~7 years stale and ABI-incompatible with current Node/
  Electron; no Windows prebuilds for our ABI.
- **WebChimera.js / wcjs-renderer** wrap **libVLC**, not mpv → out of scope.

**Conclusion:** no off-the-shelf, maintained, modern-render-API, current-Electron,
Windows-prebuilt libmpv binding exists. Adopting one is not low-risk today.

### B. Native Node addon wrapping libmpv (render API) — the "true embed", deferred
Build an N-API addon (C++ or napi-rs + the `libmpv2` Rust crate) using the modern
`mpv/render.h` + `render_gl.h` to render frames into a GL/canvas surface.
- **Pros:** real in-renderer compositing; HTML controls can overlay video.
- **Cons:** we own a C/C++/Rust build matrix; needs Visual Studio Build Tools,
  node-gyp/cmake-js, libmpv dev files, **prebuilt `.node` per Electron ABI**, DLL
  bundling + code-signing; the GL-on-Chromium (ANGLE) surface path is unproven
  for us (the Stage-3 risk).
- **Risk:** **High.** This is NOT "clear and low-risk," and it requires
  installing/compiling a native dependency. **Deferred** to a later stage.

### C. Separate native helper window via `--wid` embedding — RECOMMENDED for PoC
Reuse the **existing `mpv.exe`** but launch it with `--wid=<HWND>` pointing at a
**frameless child `BrowserWindow`** that we position over a placeholder region of
the experimental page. mpv renders its video output into that child window's
native handle; we keep our existing `--input-ipc-server` so **play/pause/seek
already work** through the current IPC code.
- **Pros:** **No new native dependency** (uses installed MPV). Reuses
  `mpvIpc.ts` controls verbatim. Genuinely "video inside the app window."
  Smallest, most isolated change. Trivial rollback (it's just another spawn
  path). Windows-first: `--wid` HWND embedding is well-trodden on Windows.
- **Cons:** it's window **overlay**, not true compositing — HTML can't easily
  draw *over* the video; z-order/DPI/resize need handling; rounded corners and
  fullscreen are fiddly. Acceptable for a PoC; not the final form.
- **Risk:** **Low** for "video shows in-window + play/pause"; medium only for
  polish. This is the clear, low-risk first PoC.

### D. External MPV + IPC controls — already shipped (the fallback)
This is the current default and remains the guaranteed fallback for the
experiment. No work needed beyond keeping it intact.

**Recommendation:** do the first PoC with **Approach C (`--wid` child-window
embedding of existing mpv.exe)**. It satisfies all PoC success criteria with no
new dependencies and maximal isolation. Treat **Approach B (libmpv render-API
addon)** as the follow-up "true embedding" stage, to be planned separately once
C proves the UX and we accept the native-build cost.

---

## 3. Required Windows files / dependencies

**For Approach C (recommended PoC): none new.**
- Uses the user's existing **`mpv.exe`** (already required by the app; path is in
  Settings → `mpvPath`). `--wid` and `--input-ipc-server` are stock mpv options.
- Uses Electron's built-in `BrowserWindow.getNativeWindowHandle()` (HWND).

**For Approach B (future, NOT installed now):**
- libmpv runtime `libmpv-2.dll` (a.k.a. `mpv-2.dll`) + dependencies.
- Dev headers `mpv/client.h`, `mpv/render.h`, `mpv/render_gl.h` + import lib
  (`mpv.lib` / `libmpv.dll.a`). Sources: SourceForge mpv-player-windows `/libmpv`,
  zhongfly/mpv-winbuild, shinchiro/mpv-winbuild-cmake, Ivshti/libmpv (headers).
- Build toolchain: Visual Studio Build Tools (MSVC + Windows SDK), Python,
  node-gyp or cmake-js (or napi-rs/Rust), prebuild tooling. **Deferred.**

---

## 4. Risks

- **Approach C overlay limitations:** video sits *above* HTML, so app controls
  can't overlay it; child-window position must track the placeholder on
  resize/scroll. Mitigation: keep controls in a bar *outside* the video region;
  reposition the child window from the main process on bounds updates.
- **HWND lifetime / leaks:** the child window must be destroyed when the
  experimental page unmounts or playback stops. Mitigation: explicit teardown +
  reuse the single-active-instance discipline.
- **`--wid` quirks:** some mpv builds/versions behave differently with `--wid`;
  fullscreen/DPI edge cases. Mitigation: PoC targets windowed playback only.
- **Regression risk to the working player:** mitigated by putting all new code
  in a **separate `electron/embeddedMpv.ts`** + a separate page/route, leaving
  `electron/mpv.ts` and the existing flow untouched.
- **Approach B (if pursued later):** native ABI breakage on Electron upgrades,
  packaging/signing, unproven GL surface — high risk, hence deferred.

---

## 5. Rollback plan

- The experiment is **fully additive** and **off by default** (gated by a new
  `experimentalEmbeddedPlayer` setting + an `/experimental-player` route).
- Rollback = set the toggle off (UI), or revert the additive commits. Because
  `electron/mpv.ts`, `StreamCard`, `SourcesSection`, `MediaPage`, settings other
  than the one new flag, profiles/library/CW/ranking are **not modified**,
  removing the experiment leaves the shipping app byte-for-byte as before.
- No DB migration is required for the PoC (the toggle is one additive
  `app_settings` key/value; absent → default off).

---

## 6. How external MPV remains the fallback

- `defaultPlayer` and the normal launch path (`playSourceWithMpv` → `openInMpv`)
  are unchanged; external MPV is what every existing button uses.
- The experimental embedded path is reachable **only** via the
  `/experimental-player` page when the flag is on.
- If embedded launch fails for any reason (no mpv, `--wid` error, child-window
  failure), the experimental page **falls back to external MPV** via the
  existing `playWithMpv`/`openInMpv` and surfaces a notice.
- The experiment never changes which player StreamCard/SourcesSection use.

---

## 7. Proposed Step-4 implementation (PENDING APPROVAL)

Only if approved. Kept small and isolated.

**Settings + types (additive):**
1. Add `"embedded-mpv-experimental"` to the `PlayerBackend` union and register it
   in `BACKENDS` with `implemented: false` (it never becomes a default-selectable
   backend; it's reachable only through the experimental page).
2. Add one boolean setting `experimentalEmbeddedPlayer` (default **false**) across
   `db.ts` / `AppSettings` / `SettingsContext` / preload, and a Settings toggle
   under a new "Experimental" section with a clear "may not work" note.

**Main process (new, isolated — does not touch `electron/mpv.ts`):**
3. New `electron/embeddedMpv.ts`: create a frameless child `BrowserWindow`
   (`parent: mainWindow`), get its HWND via `getNativeWindowHandle()`, spawn the
   existing mpv with `--wid=<hwnd>`, `--input-ipc-server=<pipe>`, `--force-window=yes`,
   the validated http(s) URL, and reuse `MpvIpcSession` for play/pause. Provide
   `openEmbeddedMpv(payload, bounds)`, `setEmbeddedBounds(bounds)`, and
   `closeEmbedded()`. Enforce a single embedded instance + teardown.
4. New channels (`embedded:open`, `embedded:set-bounds`, `embedded:close`) in
   `ipc-channels.ts`, handlers in `main.ts`, bindings in `preload.ts`. Reuse the
   existing `mpv:control`/`mpv:get-state` for play/pause/state (the embedded
   session registers as the active session).

**Renderer (new page only):**
5. New `src/pages/ExperimentalPlayerPage.tsx` at route `/experimental-player`:
   a URL input (default to a known direct sample), a placeholder `<div>` whose
   bounds are reported to main (so the child window tracks it), a Play/Pause
   button (via existing `controlMpv`), and a "Fall back to external MPV" button.
   Gated so it's only reachable when the flag is on.

**Explicitly out of scope for the PoC:** subtitles, audio menus, progress
persistence, Continue Watching, source ranking, StreamCard integration — none of
these are wired to the embedded path yet.

---

## 8. What success looks like (PoC exit criteria)

1. With the flag **off**, the app behaves exactly as today (external MPV default,
   nothing experimental visible). ✔ regression guard.
2. With the flag **on**, navigating to `/experimental-player` and pressing Play:
   - a direct **HTTP/HTTPS** video URL loads, and
   - **video renders inside (a child window attached to) the app window**, and
   - **basic play/pause** works (via existing IPC).
3. If embedded playback fails, the page falls back to **external MPV** and says
   so.
4. `electron/mpv.ts`, IPC progress tracking, profiles, library, Continue
   Watching, stream fetching, and source ranking are unchanged and still work.

An honest "embedding via `--wid` is too clunky; recommend investing in the
Approach B native addon next" is also an acceptable PoC outcome.
