# Session handoff — embedded MPV experiment

Short note for the next Claude session. Read `CLAUDE.md` first, then this.

## 1. Branch
`experiment/libmpv-native`

## 2. Embedded MPV progress (all standalone stages passed on Windows)
- ✅ **B-Headless** — native libmpv loads at runtime, plays a URL, reads
  events/properties, clean exit. (`native/libmpv-poc/`)
- ✅ **R1 render-to-PNG** — libmpv render API renders one real frame offscreen
  to `frame.png`. (`native/libmpv-poc/render-poc/`)
- ✅ **R1B render-loop** — continuous loop renders many *changing* frames over
  several seconds, metrics + sample PNGs, clean exit.
  (`native/libmpv-poc/render-loop-poc/`)
- ✅ **E1 experimental Electron canvas player** — implemented in the app
  (gated). Draws libmpv frames into a `<canvas>`.

`native/libmpv-poc/` is **frozen** as PoC history. Full history/plan is in
`docs/libmpv-native-approach-b.md`.

## 3. Experimental embedded player state (in the app, gated + isolated)
- Feature flag: **`experimentalEmbeddedPlayer`** (default **false**), stored in
  `app_settings`; toggle in Settings → "Experimental".
- Route: **`/experimental-embedded-player`** (+ a sidebar link), only present
  when the flag is on. Page: `src/pages/ExperimentalEmbeddedPlayerPage.tsx`.
- Native addon: **`native/embedded-mpv/`** (napi-rs; background render thread;
  `start`/`stop`/`getLatestFrame`). Built **manually/separately** (`npm install`
  + `npm run build` in that folder); **not** wired into the app's npm scripts.
  Reuses the libmpv + ANGLE DLLs in `native/embedded-mpv/vendor/`.
- IPC: channels `embedded:start|stop|get-frame` in `electron/ipc-channels.ts`;
  handlers in `electron/main.ts`; main-process module
  `electron/embeddedMpvExperimental.ts` (lazy addon load, friendly errors);
  preload bridge `window.embeddedMpv.{start,stop,getFrame}`.
- **External MPV remains the default/fallback player.** If the addon is missing
  or fails, the page shows a friendly error and the rest of the app is fine.

## 4. Latest architecture change — backend-tagged PlayRequest
- Playback handoff now goes through a single explicit unit: **`PlayRequest`**
  (`src/core/player/types.ts`) with `backend: "external-mpv" | "embedded-mpv-experimental"`.
- Built via `buildPlayRequest()` and dispatched via `dispatchPlayRequest()` in
  `src/features/player/playRequest.ts` (dev logs `[playrequest:create]` /
  `[playrequest:dispatch]`). `streamUrl` flows clicked-source → request →
  backend verbatim. No shared global "current URL".
- `external-mpv` and `embedded-mpv-experimental` are **separate backends**; the
  experimental page only ever emits an embedded request, so it cannot affect
  normal selection. `src/features/player/playSource.ts` is now a deprecation
  re-export shim.

## 5. Known current bug — embedded canvas video is UPSIDE DOWN
- Symptom: video in the experimental canvas is vertically flipped.
- Likely cause: OpenGL `glReadPixels` uses a **bottom-left** origin, while
  `canvas`/`ImageData.putImageData` uses a **top-left** origin. (The E1 addon
  copies the `glReadPixels` buffer straight into the shared frame; the standalone
  PoCs flipped rows before writing PNG, but the addon does not.)
- Likely fix: **vertically flip the RGBA rows in
  `native/embedded-mpv/src/lib.rs`** before storing the frame in the shared
  buffer (flip the `local` buffer row-by-row, stride = `W*4`, into the shared
  `rgba`). Do the flip on the render thread.
  - Alternative (do not prefer): toggle the `MPV_RENDER_PARAM_FLIP_Y` value in
    the render params — but the agreed fix is the explicit row flip on readback,
    matching the PoCs.
- This is a **native-addon-only** change; the renderer/canvas code stays as-is.

## 6–7. Guardrails for this fix
- Do **not** touch normal external MPV playback (`electron/mpv.ts`,
  `electron/mpvIpc.ts`, the external-mpv dispatch path).
- Do **not** touch the source picker (`SourcesSection`/`StreamCard`), subtitles,
  audio collectors, profiles, library, Continue Watching, source ranking, or the
  database for this fix.
- No debrid, no torrent, no `mpv.exe --wid`, no iframe/webview. Embedded is not
  the default.

## 8. Next recommended task
**Fix the embedded player vertical orientation only** — the row-flip in
`native/embedded-mpv/src/lib.rs` described in §5. Then rebuild the addon
(`cd native/embedded-mpv && npm run build`). Nothing else.

## 9. Exact test after the fix
1. Build the addon: `cd native/embedded-mpv && npm install && npm run build`
   (ensure `vendor/` has `libmpv-2.dll`, `libEGL.dll`, `libGLESv2.dll`).
2. In the app: Settings → Experimental → enable **Embedded player**
   (`experimentalEmbeddedPlayer`).
3. Open **`/experimental-embedded-player`** (sidebar "Embedded (exp)").
4. Play the Big Buck Bunny test URL:
   `https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4`
5. Confirm the video renders **upright**.
6. Confirm **normal external MPV playback still works** (open a movie/episode,
   play a source the usual way) — external MPV remains default/fallback.

## Build/verify reminders
- Enforced build: `tsc -p electron/tsconfig.json` (electron + `src/core`) and
  `vite build` (renderer). The embedded addon builds separately.
- Sandbox note from prior sessions: the Linux file mirror sometimes serves
  truncated copies of freshly-edited files, so `tsc` there can report bogus
  "unterminated" errors. Trust the real files; run `npm run build` locally.
