# CLAUDE.md — Kino

Project memory for future Claude sessions. Keep this accurate; if a detail is
uncertain, the note says "verify in code." Do not invent features.

Current session handoff notes, if present, live in docs/current-session-handoff.md and should be read before making changes.

## 1. Project Overview

**Kino** — Electron + React + TypeScript desktop media center, compatible with
Stremio addons. It can install addon `manifest.json` URLs and read their
catalogs/meta/streams. Implemented capabilities: installing addons, browsing
catalogs, expanded catalog pages, global search, metadata detail pages,
episode selection for series, stream source picking, MPV external playback,
multiple profiles, a profile-specific Library/Watchlist, watched/unwatched
state, Continue Watching, MPV JSON-IPC watch-progress tracking, theme system
(dark/OLED/purple/blue/red/neon-midnight + custom accent + custom CSS), custom themed
scrollbars, a rotating widescreen hero banner on the Home page, and a
tabbed Settings hub (left-nav sidebar, URL-driven via search params).
custom Theme Builder (user-defined named colour presets, fully authoritative
over built-in themes), and a player-first loading flow for the embedded player
(overlay opens immediately on Play, fetches sources internally).

**Active branch `experiment/libmpv-native`** also has an experimental embedded
libmpv canvas player (gated behind `experimentalEmbeddedPlayer` flag). External
MPV remains the default/fallback. See section 10 and handoff doc for details.

## 2. Tech Stack (from package.json)

- **Electron** ^32 (main process; `dist-electron/electron/main.js` entry)
- **React** ^18 + **react-dom** ^18
- **react-router-dom** ^6 (HashRouter; routes in `src/App.tsx`)
- **TypeScript** ^5.5
- **Vite** ^5 (`@vitejs/plugin-react`) for the renderer
- **better-sqlite3** ^11 — synchronous SQLite in the Electron main process
- **hls.js** ^1.6 — HLS in the secondary browser player
- **MPV** — external player launched via `child_process.spawn` (not an npm dep;
  user installs MPV, path configurable in Settings)
- Dev/build: electron-builder, concurrently, cross-env, wait-on
- `build.productName` = "Kino" (changed from "Media Center"); `appId` and `name` unchanged
  to keep existing user data accessible. userData is pinned via `app.setPath("userData", ...)`
  in `main.ts` to `AppData/Roaming/Media Center` for backward compatibility.
- Scripts: `npm run dev` (Vite + tsc + Electron), `npm run build`, `npm start`

### Code layout

- `electron/` — main process. `main.ts` (window + IPC handlers),
  `preload.ts` (contextBridge), `ipc-channels.ts` (channel name constants),
  `db.ts` (all SQLite + queries), `mpv.ts` (spawn + version probe),
  `mpvIpc.ts` (JSON-IPC progress client).
- `src/core/stremio/` — addon protocol logic (url normalize, fetch, validate,
  catalog, meta, streams, types). Pure, no Electron/React.
- `src/core/player/` — backend abstraction: `types.ts`, `playerBackends.ts`,
  `browserPlayer.ts`, `mpvExternal.ts` (renderer-side wrapper over electronAPI).
- `src/features/player/` — browser player support: `playability.ts`,
  `store.ts` (pending stream), `types.ts`. Also: `useEmbeddedPlayback.ts`
  (hook owning embedded IPC + RAF loop, E4), `embeddedRequest.ts` (store/event
  bus for the overlay), `playRequest.ts` (PlayRequest dispatch boundary).
- `src/state/` — React contexts: Profile, Settings, Library, Toast, ContextMenu.
- `src/theme/` — **theme system**: `themes.ts` (BUILT_IN_THEMES, ACCENT_PRESETS
  constants), `ThemeProvider.tsx` (applies `data-theme` attr, accent variable
  overrides, and custom CSS injection). ThemeProvider is inside SettingsProvider
  in `App.tsx`.
- `src/pages/` — Home, Search, Library, Media, ExpandedCatalog, Player,
  ProfilePicker, Addons. `SettingsPage.tsx` is the Settings hub (left-nav
  sidebar + content panel, URL-driven via `useSearchParams`).
  `src/pages/settings/sections/` holds 10 section components: GeneralSettings,
  AddonsSettings, EmbeddedPlayerSettings, ExternalMpvSettings,
  SourceSelectionSettings, SubtitleSettings, AudioSettings, AppearanceSettings,
  ProfileSettings, AboutSettings.
- `src/components/` — CatalogRow, CatalogItem, ContinueWatchingRow,
  EpisodeSelector, SourcesSection, StreamCard, ProfileAvatar, SearchBox,
  **HomeHero** (rotating banner, see section 12),
  **TopNav** (floating top navigation bar — brand, nav links, search, gear, profile pill),
  **LibraryRecentRow** (recently-added strip on Home, see section 3),
  **AddonManager** (shared addon install/list UI used by AddonsPage + AddonsSettings),
  **PlayerIcons** (`src/components/PlayerIcons.tsx` -- 15 inline SVG icon components used by
  the embedded player overlay; Feather-style, 24x24 viewBox, `size`/`className`/`style` props), etc.
- `src/types/` — preload/electron type declarations (`window.mediaCenter`,
  `window.electronAPI`). Note: multiple `.d.ts` files declare `electronAPI`
  (verify in code before editing typings).

### SQLite tables (in `electron/db.ts`)

`profiles` (id, name, color, emoji), `addons` (per profile), `watch_progress`
(per profile + media + playable; has `completed`), `app_settings` (global
key/value: defaultPlayer, mpvPath, **themeId**, **accentColor**, **customCss**,
**customThemes**, **activeCustomThemeId**, embeddedVol:<profileId>, …),
`library_items` (per profile), `source_prefs` (per profile+type+media+episode;
stores addonId, quality, sourceName of last played source -- no URLs stored),
`series_episodes` (global cached ordered episode list per series, drives
Continue Watching "next episode"). DB lives in Electron `userData`.

## 3. Current Working Features

- **Profiles** — picker on launch, create/edit/delete (color+emoji avatar),
  sidebar switcher; all data scoped by `profile_id`. Last profile can't be
  deleted.
- **Addon install + manifest parsing** — normalize base/`manifest.json` URLs,
  fetch, validate (id/name/resources/types), store per profile. Dev-only
  "fake/broken addon" button for failure testing.
- **Catalog rows** (Home) with **in-memory TTL cache** (`src/core/catalog/homeCatalogCache.ts`,
  15-min TTL, profile-scoped) — returning to Home after navigating away is instant;
  background refresh keeps data fresh. Invalidated on addon install/remove.
  + **Expanded catalog pages** with skip-based pagination + dedup.
- **Search** — fan-out across searchable catalogs, dedup, per-addon warnings.
- **Media detail pages** — meta from first compatible addon; poster,
  background, cast/genres/etc.
- **Episode selector** (series) — season tabs, watched checkmarks, Next Up
  badge, per-episode + per-season mark watched. Each episode card has a direct
  **Play button** that fetches sources and dispatches to the best stream
  immediately (respects `autoPlayBestSource` / `experimentalEmbeddedPlayer` settings).
- **Inline episode sources** — for series, the source picker renders inside the
  selected episode card (not at page bottom); auto-scrolls into view.
- **Episode card redesign** — thumbnail area is a standalone `<button>` that triggers
  play; hover shows a play-triangle overlay with scale + brightness on the thumbnail.
  Body text area is a separate click target for selecting (shows info, sources in-panel).
  Compact "Sources" and "Watched" ghost buttons in a right-aligned column. No text Play button.
- **Series/movie Play/Resume header button** — `media-detail__actions` always shows a
  primary Play/Resume button. Movies: "Resume HH:MM (NN%)" when progress exists; auto-fetches
  best source or reveals source picker. Series: targets best episode (in-progress > next-up >
  first episode); "Resume SxEy HH:MM" or "Play Next SxEy" label.
- **Stream source picker** — cards with quality/codec/HDR/size detection,
  expandable raw details, dedup.
- **MPV external playback** — primary for direct HTTP/HTTPS URLs.
- **MPV path setting** + **Test MPV** in Settings; default-player toggle.
- **MPV IPC progress tracking** — named pipe / socket, polls every 5s, saves
  progress, auto-completes at ≥90% OR ≤15 min remaining.
- **Continue Watching** (Home) — advances series to next unwatched normal
  episode; completed items drop off.
- **Library/Watchlist** — profile-specific, badges, poster grid, empty state.
- **Watched/unwatched state** — movies and individual episodes; reuses
  `watch_progress.completed`.
- **Right-click context menus** — custom popover on poster cards (Open Details,
  Add/Remove Library; Continue Watching adds Reset Progress / Remove from CW).
- **Continue Watching dismissal (fixed)** — "Remove from CW" sets `cw_dismissed=1`.
  `listWatchProgress` filters `AND cw_dismissed=0`. A separate `progress:revive` IPC
  resets `cw_dismissed=0` exactly once when playback genuinely starts (embedded player
  `startPlayback`, external MPV IPC `connect()`, browser player `isReady`). The periodic
  save loop never touches `cw_dismissed` — eliminates the race condition where the first
  progress poll could re-enable a just-dismissed item.
- **Series next-episode behavior** + **Season 0 specials ignored** for auto
  Next Up / Continue Watching.
- **Library badges** — not started / watching / watched.
- **Browser player** — secondary HTML5 + hls.js player (PlayerPage).
- **Embedded player UI polish** -- all emoji/Unicode symbols replaced with SVG icons
  (`PlayerIcons.tsx`); subtitle/audio dropdowns themed via CSS vars (`--color-bg-elevated`,
  `--color-text`, `color-scheme: dark`); optimistic track selection (dropdown reflects change
  immediately, no 250ms wait); scroll-wheel volume: 2%/notch, clamped 0-100 (slider still
  allows 0-130 via drag).
- **Experimental embedded MPV overlay** (branch `experiment/libmpv-native`, gated
  behind `experimentalEmbeddedPlayer` flag): libmpv renders frames offscreen via
  ANGLE EGL, copies RGBA pixels to a `<canvas>` in a full-screen overlay. Supports
  real app sources (movies + episodes) via "⬡ Play Embedded" on StreamCards.
  Controls: play/pause, seek, volume, subtitle/audio track selection, fullscreen
  toggle (F key / ⤢ button). Watch progress saved every 5 s and on close, with
  completed detection (≥90% or ≤15 min remaining) — Continue Watching and
  watched state work identically to external MPV.
  External MPV remains the default/fallback and is completely unaffected.
- **Theme system** — Settings → Appearance: 6 built-in themes (Default Dark,
  OLED Black, Purple, Blue, Red, Neon Midnight), accent colour override, poster
  roundness, background style, custom CSS. All apply immediately. See section 11.
- **Floating top nav** — `src/components/TopNav.tsx` renders a glassmorphism
  pill bar at the top of every page: brand text, Home + Library NavLinks,
  a global search input (navigates to /search?q=... from any page), a Settings gear
  icon, and a profile pill that calls clearActiveProfile(). Sidebar is removed entirely.
- **Poster roundness** — `--poster-radius` CSS variable is applied to wrapper
  elements (`.catalog-item__poster-wrap`, `.cw-card__poster-wrap`, `.media-detail__poster`)
  which have `overflow: hidden`. Controlled by Settings -> Appearance -> Poster Roundness.
- **Library Recent Row** (Home) — `src/components/LibraryRecentRow.tsx` renders a
  horizontal scroll strip of recently-added library items (up to 20, newest first)
  between Continue Watching and catalog rows. Uses `useLibrary()` context; zero extra
  IPC. Hidden when library is empty. Each card shows a type badge (movie/series).
- **Source fallback / Try Next Source** — `SourcesSection` now tracks
  `currentSourceKey` and computes `nextBestResult` (second-ranked source). A
  'Next Source' button appears in the play bar once a source is playing. An inline
  'Try Next Source' button appears inside error banners. Uses generic
  `handlePlaySource(result)` — `handlePlayBest` delegates to it.
- **Theme export/import** — Settings > Appearance has Export (JSON download) and
  Import (file picker) for `themeId`, `accentColor`, `posterRadius`, `backgroundStyle`,
  `customBackgroundColor`. `customCss` excluded from export for safety. Import
  validates shape and known themeIds before applying. 'Copy example CSS' button
  copies a minimal custom CSS snippet to clipboard.
- **Custom Theme Builder** -- Settings > Appearance > Custom theme builder: color
  pickers for 11 CSS vars (bg, bg-elevated, surface, surface-hover, border, text,
  text-muted, accent, accent-hover, success, danger). Live preview. Named presets
  saved in `customThemes` JSON. When a custom theme is active (`activeCustomThemeId`
  set), ThemeProvider Effects 2 and 4 skip built-in accent/background overrides so
  the custom theme is fully authoritative. AppearanceSettings shows an 'active' banner
  and disables Theme/Accent/Background controls with opacity+pointer-events.
- **Library filters, sort, search** — LibraryPage has filter tabs (All / Movies /
  Series / Watched / In Progress / Unwatched), sort (Recently Added / A-Z / Release
  Year), and a live search input. All computed client-side via `useMemo`; no new IPC.
  Filtered item count shown in page header.
- **Settings > About / Debug** — AboutSettings shows app version, dev mode,
  profile, player settings, and all key paths (userData, DB, native addon dir,
  libmpv/libEGL/libGLES). Buttons: Clear Home cache (in-renderer), Open userData
  folder (`system.openFolder` IPC), Copy debug info (clipboard; no source URLs).
  Uses `app:get-info` and `system:open-folder` IPC channels (4-layer each).

## 4. Important Architecture Rules

- Stremio protocol logic stays in `src/core/stremio/`.
- MPV launch logic stays in the Electron **main process** (`electron/mpv.ts`).
- Renderer calls MPV only through preload → `window.electronAPI`
  (`src/core/player/mpvExternal.ts` wraps it). Never launch MPV from React.
- Never use `shell: true` for MPV spawn. Pass args as an **array** only.
  Validate `streamUrl` is http/https in main before spawning.
- Do not hardcode stream providers — only consume what installed addons return.
- Keep profile-specific data scoped by `profile_id`.
- Never wipe SQLite data during migrations. Use additive, idempotent migrations
  only (`CREATE TABLE IF NOT EXISTS`, `PRAGMA table_info` + `ALTER TABLE ADD
  COLUMN`). Existing migrations live at the top of `initDb()` in `db.ts`.
- IPC must stay symmetric: channel name in `ipc-channels.ts`, handler in
  `main.ts`, binding in `preload.ts`, type in `src/types/preload.d.ts`.

## 5. Player / Stream Rules

- **MPV is the preferred/default player** for direct HTTP/HTTPS stream URLs.
  Browser player exists but is secondary (good for mp4/webm/HLS; MKV handling
  is unreliable in Chromium — MPV handles MKV well).
- Play the direct URLs addons return.
- **infoHash-only** streams are not directly playable → show "Resolver Needed".
- **externalUrl** (no url) → show "Open External" (opens in OS browser).
- **ytId** → "YouTube Source" (not played in-app currently).
- Do not build torrent resolving unless explicitly requested.
- Do not fake embedded MPV with iframe/webview.
- The experimental embedded player (`backend: "embedded-mpv-experimental"`) uses
  a real libmpv render-API native addon (`native/embedded-mpv/`, napi-rs). It is
  gated behind `experimentalEmbeddedPlayer` and is **not** the default. External
  MPV (`backend: "external-mpv"`) is the default for direct URLs and must not
  be changed unless explicitly requested.
- The `PlayRequest` type in `src/core/player/types.ts` carries a `backend` field
  that routes to the correct player, and an optional `pendingSourceFetch?: boolean`
  flag for the player-first flow (overlay opens immediately; source resolved inside).
  `dispatchPlayRequest` in `src/features/player/playRequest.ts` is the single
  dispatch point for external-MPV; `setEmbeddedPlayRequest` in `embeddedRequest.ts`
  is used for the embedded player (both normal and player-first pending requests).
- Embedded addon controls (pause/seek/volume/tracks) are sent via an mpsc channel
  to the render thread via `window.embeddedMpv.command(type, value)`. State is
  polled via `window.embeddedMpv.getState()` every 250 ms while running.

### Project decision — NO debrid

Do **not** build native debrid integration: no debrid login, token storage,
provider APIs, or resolver logic. Debrid stays addon-side via user-installed
Stremio-compatible addons (e.g. AIOStreams). The app just consumes the streams
addons return and plays direct HTTP/HTTPS URLs through MPV.

## 6. Series / Episode Rules

- For series, streams use the **selected episode ID** from `meta.videos`, not
  the show ID. `SourcesSection` receives a `SelectedPlayableItem`.
- Inline episode sources render near the selected episode (variant `"inline"`),
  not at the bottom; movies use variant `"full"` below details.
- Continue Watching advances to the next **unwatched normal** episode
  (`getNextEpisodeToWatch` in `db.ts`, using the `series_episodes` cache).
- **Season 0 = specials**, ignored for automatic Next Up / Continue Watching
  (filter `season !== 0`). Episodes with missing season are treated as normal.
- Specials remain visible in the episode list and are manually selectable,
  playable, and markable.
- A series is WATCHED only when **all normal episodes** are watched
  (`getSeriesLibraryStatus`). Never "watched" without a cached episode list.

## 7. Library / Watched Rules

- Library is profile-specific (`library_items`, dedup on
  profile_id+type+media_id).
- Movies can be marked watched directly (MediaPage button).
- Episodes can be marked watched individually (and per season).
- Series Library badge: `not_started` / `watching` (shows "Next: SxEy") /
  `watched` (only when all normal episodes watched).
- Continue Watching "Remove from Continue Watching" / "Reset Watch Progress"
  affect `watch_progress` only — they do **not** remove the item from Library.
- Watched state reuses `watch_progress.completed` (no separate table).

## 8. Development Rules

- Make small, focused changes. Do not rewrite working systems.
- Preserve existing database data; safe migrations only.
- Keep UI changes separate from backend/player changes when possible.
- Prefer minimal targeted bug fixes; ask before large refactors.
- Keep TypeScript types updated and fix TS errors before moving on.
- After any IPC change, update all four layers (channel/handler/preload/types).
- Note: some `electronAPI` typings were hand-edited by the user across multiple
  `.d.ts` files — verify in code before changing them.

## 9. Future Roadmap

- Subtitle auto-loading for embedded player (addons + OpenSubtitles; external MPV already has this)
- Dynamic embedded render resolution (currently fixed 1280×720 in `lib.rs`)
- Fade-on-inactivity for the embedded control bar
- Source filtering/sorting (only if needed later)
- Addon management polish
- Better external MPV IPC controls (pause/seek from the app — "Custom MPV arguments"
  setting is already TODO'd in `electron/mpv.ts`)
- Packaging/bundling MPV with the app
- Settings polish
- Theme / UI polish
- Performance for large catalogs and long anime seasons

(Debrid integration is intentionally **not** on the roadmap.)

## 10. Experimental Embedded MPV (branch: experiment/libmpv-native)

This section describes the embedded canvas player that exists on this branch.
Do **not** merge to main or remove external MPV unless explicitly decided.

### Architecture
- **Flag**: `experimentalEmbeddedPlayer` in `app_settings` (default `false`).
  Toggle in Settings → Experimental. All embedded code is gated on this flag.
- **Overlay**: `src/components/EmbeddedPlayerOverlay.tsx` — app-level component
  rendered outside `.app-shell` in `App.tsx`. Appears over the current page
  when a `PlayRequest` with `backend: "embedded-mpv-experimental"` is dispatched.
- **Hook**: `src/features/player/useEmbeddedPlayback.ts` — owns the full IPC +
  RAF lifecycle, state polling, and control helpers. StrictMode-safe via
  `cancelledRef` pattern.
- **Store**: `src/features/player/embeddedRequest.ts` — module-level store +
  event bus. `dispatchEmbeddedExperimental` pushes here; the overlay subscribes.
- **Dispatch**: `dispatchEmbeddedExperimental` in `playRequest.ts` only calls
  `setEmbeddedPlayRequest(req)` — no navigation, no IPC. The overlay owns IPC.
- **Native addon**: `native/embedded-mpv/` (Rust + napi-rs). Built separately:
  `cd native/embedded-mpv && npm install && npm run build`. Requires
  `vendor/libmpv-2.dll`, `vendor/libEGL.dll`, `vendor/libGLESv2.dll`.
- **IPC channels** (all in `ipc-channels.ts`): `embedded:start`, `embedded:stop`,
  `embedded:get-frame`, `embedded:command` (E4), `embedded:get-state` (E4).

### E4 Control API
- `window.embeddedMpv.command(type, value)` — fire-and-forget to render thread
  via mpsc channel. Types: `"pause"` (1/0), `"seek"` (seconds), `"volume"`
  (0-130), `"sid"` (track id, -1=off), `"aid"` (track id).
- `window.embeddedMpv.getState()` → `EmbeddedPlaybackState` — reads from a
  Mutex updated by the render thread every ~200 ms. Fields: `paused`, `timePos`,
  `duration`, `volume`, `trackListJson` (JSON from mpv's `track-list` property).

### E5 Progress tracking + fullscreen
- **Progress**: `useEmbeddedPlayback` accepts an optional `EmbeddedProgressContext`
  (profileId + media metadata) via `startPlayback(url, ctx)`. While running, a
  5-second `setInterval` calls `flushProgress()` which reads from refs (no React
  deps) and calls `window.mediaCenter.progress.upsert(...)` (existing IPC
  channel). On stop, `flushProgress()` is called synchronously before teardown.
  `completed` is set when `timePos ≥ duration * 0.9` OR `duration - timePos ≤ 900`.
  The overlay (`EmbeddedPlayerOverlay.tsx`) gets `profileId` from `useProfile()`
  and builds the context on each req change.

### E5 Bug fixes (same branch — fixes for fullscreen, resume, subtitle quality)

- **Fullscreen (fixed)**: DOM `requestFullscreen()` silently fails in Electron.
  Replaced with BrowserWindow IPC: renderer calls `window.embeddedMpv.setFullscreen(bool)`
  → main calls `win.setFullScreen(bool)` → main pushes `embedded:fullscreen-changed`
  back to renderer → renderer syncs `isFullscreen` state via `onFullscreenChange`
  subscription. IPC channels: `EmbeddedSetFullscreen` + `EmbeddedFullscreenChanged`
  in `ipc-channels.ts`. Esc exits fullscreen first, then closes. F key toggles.
  Button hidden if `window.embeddedMpv.setFullscreen` is unavailable.
  CSS rules (`:fullscreen` / `:-webkit-full-screen`) hide header+stats in fullscreen —
  these still apply because BrowserWindow fullscreen propagates to the document.

- **Resume from saved progress (fixed)**: `EmbeddedProgressContext` has a new
  `startSeconds?: number` field. Before calling `startPlayback`, the overlay
  queries `window.mediaCenter.progress.get(...)` and sets `startSeconds` to
  `progressSeconds` if the record exists, is not completed, and is > 10 s.
  `useEmbeddedPlayback.startPlayback` passes `context?.startSeconds` to
  `api.start(url, startTimeSecs)`. The Rust `start()` function now accepts
  `start_time_secs: Option<f64>`; the render thread stores it in `pending_resume`
  and issues an absolute seek on `MPV_EVENT_FILE_LOADED`.

- **Subtitle quality (fixed)**: Render resolution raised from 1280×720 to
  1920×1080 (constants `W` and `H` in `native/embedded-mpv/src/lib.rs`). libmpv
  composites subtitles into the FBO at render resolution — 720p FBO caused
  blurry subtitles at full window size. Per-frame copy increases from ~3.5 MB to
  ~8 MB; still viable for the experimental path.

### E6 YouTube/Netflix UX (same branch)

- **Stage fills entire window**: `.emb-overlay__stage` is `position:absolute; inset:0`.
  Canvas uses `object-fit:contain` — aspect ratio preserved at all sizes.
- **Floating chrome**: header, controls bar, error banners, and stats are all
  `position:absolute` overlays inside the stage. They never take layout space or
  shrink the canvas.
- **Auto-hide**: `controlsVisible` state drives a `controls-hidden` class on the root.
  After 2500 ms of inactivity the class is applied → CSS fades header/controls/stats
  to `opacity:0; pointer-events:none` and sets `cursor:none`. Controls reappear on
  any mouse move/enter or key press. Never hides while paused, scrubbing (draggingRef),
  or while the pointer is over controls (isInteractingRef). Refs avoid stale closures.
- **`is-fullscreen` class**: React class on root mirrors BrowserWindow fullscreen state
  (set via `onFullscreenChange` subscription). Used for styling; replaces old CSS
  `:fullscreen` / `:-webkit-full-screen` selectors that didn't work in Electron.
- **Esc behavior**: first Esc exits fullscreen; second Esc closes overlay.

### E7 Embedded as default player (when flag is ON)

When `experimentalEmbeddedPlayer` is ON, the embedded overlay becomes the **primary
playback path** for direct HTTP/HTTPS sources. External MPV is demoted to a secondary
fallback button.

**StreamCard button layout**:
- Flag OFF (default): unchanged — "▶ Play with MPV" primary, "Play in App" secondary.
- Flag ON: "▶ Play" primary → `handlePlayEmbedded`; "Open in MPV" secondary fallback.
  The old "⬡ Play Embedded" tertiary button is removed (embedded IS the primary).

**Auto-play best source** (`SourcesSection.handlePlayBest`):
- Flag ON: `backend: "embedded-mpv-experimental"` — opens embedded overlay.
- Flag OFF: `backend: "external-mpv"` — existing MPV behavior.
- MPV-specific dispatch options (`subtitleAddons`, `startSeconds`, audio language)
  are only passed through when using external MPV.

**No other changes**: source ranking, profiles, library, progress tracking, Continue
Watching, and external MPV IPC are all untouched.

### E9 Player-first loading flow (same branch)

**Goal**: Open the embedded overlay immediately on Play click; source resolution
happens inside the overlay, not before it opens.

**`PlayRequest.pendingSourceFetch?: boolean`** (in `src/core/player/types.ts`):
- When `true`: overlay opens with `streamUrl: ""` and fetches sources internally.
- When `false` or absent: existing direct-URL flow (unchanged).

**`EmbeddedPlayerOverlay.tsx`** changes:
- New state: `fetchStatus: null | "finding" | "choosing" | "error-fetch"`, `fetchError`.
- `doStart` (effect triggered by `req` change): when `pendingSourceFetch === true`,
  runs status phases ("Finding sources..." -> "Choosing best source..."), applies
  saved source-pref ordering, calls `chooseBestSource`, saves pref, then
  calls `startPlayback(resolvedUrl, ctx)`. Direct-URL path unchanged.
- Fetch-error panel: Choose Source / Retry / Close.
- Playback error panel: added "Try next source" + "Choose Source" buttons.
- `handleOverlaySourceSelect`: adds `pendingSourceFetch: false` to prevent re-triggering.

**`src/components/SourcesSection.tsx`** -- `handlePlayBest`:
- When `settings.experimentalEmbeddedPlayer && selected`: dispatches
  `setEmbeddedPlayRequest({ ..., streamUrl: "", pendingSourceFetch: true })` immediately.
  Returns without fetching sources in SourcesSection (overlay handles it).
- External MPV path fully unchanged.

**`src/pages/MediaPage.tsx`** -- `handleDirectPlayEpisode`:
- When embedded player ON: dispatches pending request immediately and returns.
  Overlay opens and fetches episode streams itself.

### Known limitations / TODO
- No subtitle auto-loading from addons/OpenSubtitles (only mpv's loaded tracks).
- No pause/seek keyboard IPC for the standalone test page (only overlay has it).
- Canvas uses copy-based frame transfer (native → main → renderer) — may be
  choppy at high frame rates.
- Render resolution is now fixed 1920×1080. Dynamic resolution is still a future item.

### Guardrails
- Do **not** touch `electron/mpv.ts`, `electron/mpvIpc.ts`, external-mpv dispatch.
- Do **not** touch source picker, subtitles/audio collectors for external MPV,
  profiles, library, Continue Watching, database, debrid/torrent.
- Embedded is **never** the default. External MPV is always the fallback.

### E8 Next Episode Pipeline (same branch)

**Goal**: Smoother series playback — preload the next episode's sources while the
current episode plays, then offer a one-click "Next Episode" button near the end.

**New modules**:
- `src/core/player/sourcePrefetch.ts` — module-level in-memory TTL cache (7 min)
  keyed by `profileId:type:mediaId:playableId`. `prefetchEpisodeSources()` fans out
  to all eligible addons in the background; non-blocking, deduped, failure-safe.
  `getCachedSources()` returns fresh results or null.
- `src/core/player/sourceAffinity.ts` — `extractSourceAffinity()` extracts signals
  (addon ID, stream name, hostname, path prefix, release group, quality, codec, HDR,
  season-pack indicators). `scoreNextEpisodeSource()` scores a candidate relative to
  the current stream. `chooseNextEpisodeSource()` picks the top affinity match
  (threshold 25 pts) or falls back to `chooseBestSource()`.

**New IPC** (`series:get-next-episode`): returns the next normal (season ≠ 0)
episode after a given videoId from the cached `series_episodes` table.
DB: `getNextEpisodeAfter(seriesId, currentVideoId)` in `electron/db.ts`.
Four-layer: `ipc-channels.ts` → `main.ts` → `preload.ts` → `preload.d.ts`.

**`EmbeddedPlayerOverlay.tsx` additions**:
- On `req` change (series only): query `series.getNextEpisode()` → if found,
  fetch addons + fire `prefetchEpisodeSources()` → poll cache every 2 s (up to 30 s)
  → run `chooseNextEpisodeSource()` → store as `nextSource` state.
- `showNextEpPrompt` becomes true when `remaining ≤ 180 s` and `nextEpisode` is set.
- "Next ▶ S01E02: Title" button shown bottom-right above controls; fades with
  `controls-hidden`. Disabled while loading, enabled once `nextSource` is set.
- Clicking calls `setEmbeddedPlayRequest(nextReq)` — the store update triggers the
  overlay's lifecycle effect which flushes progress, stops current, starts next.
- N key shortcut triggers next episode when prompt is visible.
- `transitioning` flag prevents double-clicks.

**Progress/watched correctness**: since remaining ≤ 180 s satisfies the
`duration - timePos ≤ 900 s` completed threshold in `flushProgress()`, the current
episode is correctly marked as watched during the `stopPlayback()` teardown.

## 11. Theme System

Settings → Appearance section. Changes apply immediately without restart.

### Architecture

- **`src/theme/themes.ts`** — `BUILT_IN_THEMES` array (5 themes), `ACCENT_PRESETS`
  array (6 named accent colours + custom hex). Pure constants, no React.
- **`src/theme/ThemeProvider.tsx`** — React component wrapping the app inside
  `SettingsProvider`. Reads all appearance settings and applies five effects:
  1. Sets `data-theme="<id>"` on `document.documentElement` → CSS palette.
  2. Sets `--color-accent` / `--color-accent-hover` / `--accent` inline on `<html>`.
  3. Sets `--poster-radius` on `<html>` from the `posterRadius` setting.
  4. Sets `--app-bg-override` on `<html>` from `backgroundStyle` + `customBackgroundColor`.
  5. Injects/updates `<style id="custom-user-css">` in `<head>` (textContent, not innerHTML).
  Valid themes: "default-dark", "oled-black", "purple", "blue", "red", "neon-midnight".
- **`src/styles.css`** — `:root` now declares the full semantic token set:
  `--color-bg`, `--color-bg-elevated`, `--color-surface`, `--color-surface-hover`,
  `--color-border`, `--color-text`, `--color-text-muted`, `--color-accent`,
  `--color-accent-hover`, `--color-accent-2`, `--color-danger`, `--color-success`,
  `--color-warning`, `--color-accent-fg`, `--radius-sm/md/lg`, `--shadow-soft`,
  `--font-ui`. Legacy aliases (`--bg`, `--panel`, etc.) point to the new tokens so
  all existing selectors continue to work without rewrites.
  Theme palette overrides live in `html[data-theme="<id>"]` blocks also in
  `styles.css`.

### Built-in themes

| ID | Label |
|----|-------|
| *(empty)* / `default-dark` | Default Dark (#0f1115 bg, #6aa3ff accent) |
| `oled-black` | OLED Black (pure #000 bg) |
| `purple` | Purple (#0d0b14 bg, #a87fff accent) |
| `blue` | Blue (#090d14 bg, #4d9fff accent) |
| `red` | Red (#130b0b bg, #ff6b6b accent) |
| `neon-midnight` | Neon Midnight (#050713 bg, #38bdf8 cyan accent) |
| `emerald-noir` | Emerald Noir (#060d0c bg, #34d399 green accent) |
| `amber-theater` | Amber Theater (#0e0b06 bg, #f59e0b amber accent) |
| `arctic-blue` | Arctic Blue (#070c14 bg, #60c8ff icy-blue accent) |
| `royal-violet` | Royal Violet (#0a0814 bg, #c084fc violet accent) |

### AppSettings fields

- `themeId: string` -- stored as `"themeId"` key in `app_settings`. Empty = default.
- `accentColor: string` -- stored as `"accentColor"`. Empty = theme default.
- `customCss: string` -- stored as `"customCss"`. Empty = none.
- `posterRadius: string` -- stored as `"posterRadius"`. Values: "square"/"soft"/"rounded"/"pill". Default "soft".
- `backgroundStyle: string` -- stored as `"backgroundStyle"`. Values: ""/"oled-black"/"subtle-gradient"/"neon-gradient"/"custom-solid".
- `customBackgroundColor: string` -- stored as `"customBackgroundColor"`. Hex color for custom-solid bg.
- `customBackgroundGradient: string` -- stored as `"customBackgroundGradient"`. Reserved for future use.
- `bgGradientColorA: string` -- stored as `"bgGradientColorA"`. Gradient start color hex. Default "#0a0d14".
- `bgGradientColorB: string` -- stored as `"bgGradientColorB"`. Gradient end color hex. Default "#111520".
- `bgGradientAngle: number` -- stored as `"bgGradientAngle"`. Gradient angle in degrees. Default 135.
- `heroSourceMode: "auto" | "catalog"` -- stored as `"heroSourceMode"`. Controls which catalog feeds the Home hero banner. Default "auto".
- `heroAddonId: string` -- stored as `"heroAddonId"`. Addon ID for catalog mode. Empty = not set.
- `heroCatalogType: string` -- stored as `"heroCatalogType"`. Catalog type (e.g., "movie", "series") for catalog mode.
- `heroCatalogId: string` -- stored as `"heroCatalogId"`. Catalog ID for catalog mode.
- `customBackgroundImagePath: string` -- stored as `"customBackgroundImagePath"`. Absolute path to the copied image file in userData/backgrounds/. Empty = none.
- `customBackgroundImageFit: string` -- stored as `"customBackgroundImageFit"`. "cover" or "contain". Default "cover".
- `customBackgroundImagePosition: string` -- stored as `"customBackgroundImagePosition"`. "center", "top", or "bottom". Default "center".
- `customBackgroundImageDim: number` -- stored as `"customBackgroundImageDim"`. Overlay opacity 0-0.85. Default 0.45.
- `customBackgroundImageBlur: number` -- stored as `"customBackgroundImageBlur"`. Blur radius in px 0-20. Default 0.

### Custom image background

When `backgroundStyle = "custom-image"`, ThemeProvider Effect 7 sets CSS variables on
`<html>` and adds the class `has-bg-image`. CSS rules in `styles.css` use `body::before`
(image layer, z-index:-1) and `body::after` (dim overlay, z-index:-1) to paint the
background behind all app content. Body and .content backgrounds become transparent via
`--app-bg-override: transparent`.

Image is copied from user selection to `userData/backgrounds/custom-background.{ext}`
via IPC (`bg:choose-image`). The file is served via the `kino-local://bg/<filename>`
custom Electron protocol (registered in main.ts before app.whenReady()) which avoids
`file://` CORS restrictions when the renderer is at `http://localhost` in dev mode.

CSS vars set by Effect 7: `--bg-img-url`, `--bg-img-fit`, `--bg-img-pos`, `--bg-img-dim`,
`--bg-img-blur`, `--bg-img-margin`. Blur uses negative margin to hide edge artifacts.

Custom themes and custom image backgrounds are compatible -- the image shows even when
a custom theme is active (the `!activeCustomThemeId` constraint was removed).

AppearanceSettings shows a 160x90 preview thumbnail loaded via `kino-local://` with
`onLoad`/`onError` handlers for file-missing detection.

Removal: `bg:remove-image` deletes the copied file; settings reset to empty string.
Controls: fit (cover/contain), position (center/top/bottom), dim (0-0.85), blur (0-20px).
Export excludes custom-image style (image files are local-only, not portable).
Supported formats: jpg, jpeg, png, webp.

### Rules for future work

- **Never hardcode colours in new UI.** Use `var(--color-accent)`, `var(--color-bg)`,
  etc. Use `var(--color-accent-fg)` for text on accent-coloured backgrounds.
- New built-in themes: add to `BUILT_IN_THEMES` in `themes.ts` AND add a
  `html[data-theme="<id>"]` block to `styles.css`.
- The embedded player overlay uses its own opacity/rgba colours (intentionally
  black with transparency) -- these do not need to respond to themes.

## 12. Custom Scrollbars + Home Hero

### Custom scrollbars (`src/styles.css`)

Three CSS variables control all scrollbar appearance; they live in `:root` and
are overridden per theme by the `html[data-theme="<id>"]` blocks as needed:

- `--scrollbar-size: 6px` -- width (and height for horizontal bars)
- `--scrollbar-track: transparent`
- `--scrollbar-thumb: rgba(255,255,255,0.12)` -- subtle white
- `--scrollbar-thumb-hover: color-mix(in srgb, var(--color-accent) 45%, rgba(255,255,255,0.18))` -- accent-tinted on hover

Chromium/Electron styling uses `::-webkit-scrollbar*` pseudo-elements.
Firefox fallback uses `scrollbar-width: thin` + `scrollbar-color` on `*`.
All scrollable areas (catalog strips, source drawer, settings, episode list,
etc.) automatically inherit the thin rounded look without individual rule changes.

### Home hero banner (`src/components/HomeHero.tsx`)

A rotating widescreen banner rendered at the top of `src/pages/HomePage.tsx`
when addons are loaded and have browsable catalogs.

**Behaviour:**
- Fetches from the first `MAX_CATALOGS_TO_FETCH = 3` catalog descriptors.
- Selects up to `MAX_HERO_ITEMS = 8` items; first pass prefers items with a
  `background` (landscape backdrop); second pass fills with `poster`-only items.
- Deduplicates by `type:id` across catalogs.
- Rotates every 10 seconds; pauses while the mouse is over the hero.
- Fade transition (180 ms) between items.
- Left/right arrow buttons (visible on hover) and pill/dot indicators.
- "More Info" button navigates to `/media/:type/:id` (existing detail page).
- Skeleton shimmer shows while catalog data loads; renders nothing if no items.

**CSS (`src/styles.css`, block `/* --- Home hero banner --- */`):**
- Height: `clamp(280px, 38vw, 520px)`
- Background image layer (`.home-hero__bg`) -- opacity transitions for fade.
- Dark vignette gradient (`.home-hero__gradient`) -- ensures text readability.
- Content (`.home-hero__content`) -- fades + translates up on enter.
- All colours via CSS variables; no hardcoded hex.

**Props:**
- `descriptors: CatalogDescriptor[]` -- the full list from installed addons.
- `forcedDescriptor?: CatalogDescriptor | null` -- when provided (catalog mode), the hero
  fetches only from that descriptor. Falls back to auto-pick if it returns no items.

**Integration in `src/pages/HomePage.tsx`:**
- `showHero: boolean = profile != null && !addonsLoading && descriptors.length > 0`
- `heroForcedDescriptor` computed via `useMemo`: looks up the descriptor matching
  `settings.heroAddonId + heroCatalogType + heroCatalogId`; returns `null` in auto mode.
- When `showHero`, renders `<HomeHero descriptors={descriptors} forcedDescriptor={heroForcedDescriptor} />`
  and hides the `<h1>Home</h1>` page title.
- Uses ternary (`? :`) rather than `&&` to avoid the `null | Profile` JSX
  children issue that causes TSX parse errors in TypeScript 5.9+.

## 13. Settings Hub

### Architecture

Settings live at `/settings` (same route). `SettingsPage.tsx` renders a
two-column layout: a 200px left nav sidebar and a scrollable right content panel.

Navigation is URL-driven via `useSearchParams` -- no new routes added to App.tsx:
- `?tab=general` -- Default player
- `?tab=addons` -- Addon manager (reuses AddonManager component)
- `?tab=player&sub=embedded` -- Experimental embedded player toggle
- `?tab=player&sub=mpv` -- External MPV path + test
- `?tab=player&sub=sources` -- Source selection / quality / CAM filter
- `?tab=player&sub=subtitles` -- Auto-enable subtitles + language
- `?tab=player&sub=audio` -- Audio language + anime override
- `?tab=appearance` -- Theme / accent / custom CSS (includes Neon Midnight)
- `?tab=profiles` -- Profile list + sidebar switcher link
- `?tab=about` -- App info table

### Files

- `src/pages/SettingsPage.tsx` -- hub shell with left nav + `renderContent()` switch
- `src/pages/settings/sections/GeneralSettings.tsx`
- `src/pages/settings/sections/AddonsSettings.tsx` -- renders `<AddonManager />`
- `src/pages/settings/sections/EmbeddedPlayerSettings.tsx`
- `src/pages/settings/sections/ExternalMpvSettings.tsx`
- `src/pages/settings/sections/SourceSelectionSettings.tsx`
- `src/pages/settings/sections/SubtitleSettings.tsx`
- `src/pages/settings/sections/AudioSettings.tsx`
- `src/pages/settings/sections/AppearanceSettings.tsx`
- `src/pages/settings/sections/ProfileSettings.tsx`
- `src/pages/settings/sections/AboutSettings.tsx`
- `src/components/AddonManager.tsx` -- shared between AddonsPage and AddonsSettings

### Old Addons route

`/addons` route and sidebar link are preserved unchanged. `AddonsPage.tsx` is now
a thin wrapper around `AddonManager`. The same `AddonManager` renders inside
`AddonsSettings` in the Settings hub.

### CSS classes (in `src/styles.css`)

- `.settings-hub-page` -- outer page wrapper (flex column, no padding)
- `.settings-hub` -- 2-column grid (200px | 1fr)
- `.settings-hub__nav` -- left sidebar
- `.settings-nav-item` -- nav button; `--active` uses accent; `--sub` indented
- `.settings-hub__panel` -- scrollable right panel (28px 36px padding)
- `.settings-panel__title` -- 20px bold section heading
- `.settings-section__label` -- muted uppercase sub-group label
- `.profile-settings-list/row/badge` -- profile list in Profiles section
- `.about-table` -- key/value table in About section

### Write/Edit tool truncation rule (critical)

Never write content containing em dash (U+2014), ellipsis (U+2026), middle dot
(U+00B7), or box-drawing characters (U+2500 etc.) via the Edit or Write tools.
The tool silently truncates the file at those characters. Use bash heredoc
(`cat > file << 'ENDOFFILE'`) for all file creation, and Python byte-level
operations for repairs.

## 14. Design System (Cinematic UI Foundation)

### Design direction

"Cinematic desktop media center, not a SaaS dashboard."
- Dark matte backgrounds, poster/backdrop-first layouts
- Minimal chrome, no over-rounded floating pill UI
- Premium media shelf feel (Netflix/Plex-like, not a web form)
- Scale+shadow hover on poster cards (not border-color glow)
- Consistent motion tokens for all transitions

### Token reference (src/styles.css :root additions)

Colors: --app-bg, --color-surface-2, --color-border-strong, --color-text-subtle
Shape: --radius-xs (3px), --radius-xl (18px), --control-radius (6px)
Layout: --nav-height (56px), --page-padding (32px), --content-max-width (1200px)
Typography: --font-display, --text-xs/sm/md/lg/xl/display
Effects: --shadow-card, --shadow-hero, --focus-ring, --backdrop-blur
Motion: --motion-fast (120ms), --motion-med (220ms), --ease-standard

### Reusable UI primitive classes

- `.btn` + modifiers: `--primary`, `--secondary`, `--ghost`, `--danger`, `--sm`, `--lg`
- `.icon-btn` -- 34x34 square icon-only button
- `.badge` + `--accent`, `--muted`, `--success`, `--danger`
- `.skeleton` + `--text`, `--title`, `--card` -- shimmer loading placeholders
- `.progress-bar` + `.progress-bar__fill`
- `.input` -- styled text input (also applied via `.settings-hub__panel input` override)
- `.select-input` -- styled select
- `.ghost-button` + `--xs`, `--sm` -- secondary actions
- `.card` + `--flat`
- `.setting-row` -- horizontal label+control layout for settings pages
- `.toggle-switch` -- CSS-only toggle

### Key layout rules

- `.content`: `padding: 20px 0 0` only -- horizontal padding is per-page
- `.page`: `padding: 0 var(--page-padding) 40px`
- Catalog strips: `padding: 4px var(--page-padding) 12px` (aligns with row headers)
- Media detail hero: full-bleed, pseudo-element gradients for readability

### Rules for future UI work

1. Never use Edit/Write tools on styles.css (box-drawing chars truncate). Use Python.
2. All colors via CSS variables -- never hardcode hex in new CSS.
3. Hover on poster cards = transform + shadow (not border-color).
4. Episode cards have no persistent selection highlight -- hover state only.
5. New buttons use .btn primitives, not one-off inline styles.
6. Settings form controls are standardized via .settings-hub__panel input/select selectors.
7. Media hero is full-bleed + gradient overlay -- no border-bottom.
8. Catalog strips use padding: 0 var(--page-padding) for consistent alignment.
9. No over-rounded pills, no rainbow gradients, no excessive glassmorphism, no emoji icons.
