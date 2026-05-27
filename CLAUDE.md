# CLAUDE.md — Media Center App

Project memory for future Claude sessions. Keep this accurate; if a detail is
uncertain, the note says "verify in code." Do not invent features.

Current session handoff notes, if present, live in docs/current-session-handoff.md and should be read before making changes.

## 1. Project Overview

Electron + React + TypeScript desktop media center, compatible with
Stremio addons. It can install addon `manifest.json` URLs and read their
catalogs/meta/streams. Implemented capabilities: installing addons, browsing
catalogs, expanded catalog pages, global search, metadata detail pages,
episode selection for series, stream source picking, MPV external playback,
multiple profiles, a profile-specific Library/Watchlist, watched/unwatched
state, Continue Watching, and MPV JSON-IPC watch-progress tracking.

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
  `store.ts` (pending stream), `types.ts`.
- `src/state/` — React contexts: Profile, Settings, Library, Toast, ContextMenu.
- `src/pages/` — Home, Search, Library, Media, ExpandedCatalog, Player,
  Settings, ProfilePicker, Addons.
- `src/components/` — CatalogRow, CatalogItem, ContinueWatchingRow,
  EpisodeSelector, SourcesSection, StreamCard, ProfileAvatar, SearchBox, etc.
- `src/types/` — preload/electron type declarations (`window.mediaCenter`,
  `window.electronAPI`). Note: multiple `.d.ts` files declare `electronAPI`
  (verify in code before editing typings).

### SQLite tables (in `electron/db.ts`)

`profiles` (id, name, color, emoji), `addons` (per profile), `watch_progress`
(per profile + media + playable; has `completed`), `app_settings` (global
key/value: defaultPlayer, mpvPath), `library_items` (per profile),
`series_episodes` (global cached ordered episode list per series, drives
Continue Watching "next episode"). DB lives in Electron `userData`.

## 3. Current Working Features

- **Profiles** — picker on launch, create/edit/delete (color+emoji avatar),
  sidebar switcher; all data scoped by `profile_id`. Last profile can't be
  deleted.
- **Addon install + manifest parsing** — normalize base/`manifest.json` URLs,
  fetch, validate (id/name/resources/types), store per profile. Dev-only
  "fake/broken addon" button for failure testing.
- **Catalog rows** (Home) + **expanded catalog pages** with skip-based
  pagination + dedup.
- **Search** — fan-out across searchable catalogs, dedup, per-addon warnings.
- **Media detail pages** — meta from first compatible addon; poster,
  background, cast/genres/etc.
- **Episode selector** (series) — season tabs, watched checkmarks, Next Up
  badge, per-episode + per-season mark watched.
- **Inline episode sources** — for series, the source picker renders inside the
  selected episode card (not at page bottom); auto-scrolls into view.
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
- **Series next-episode behavior** + **Season 0 specials ignored** for auto
  Next Up / Continue Watching.
- **Library badges** — not started / watching / watched.
- **Browser player** — secondary HTML5 + hls.js player (PlayerPage).

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
- Do not fake embedded MPV with iframe/webview. True embedded MPV would need a
  native window handle / libmpv / render-API native addon — future research
  only (see `playerBackends.ts` for staged backend notes).

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

- Subtitle support
- Source filtering/sorting (only if needed later)
- Addon management polish
- Better MPV IPC controls (pause/seek from the app — "Custom MPV arguments"
  setting is already TODO'd in `electron/mpv.ts`)
- Optional embedded MPV research (native handle / libmpv / render API)
- Packaging/bundling MPV with the app
- Settings polish
- Theme / UI polish
- Performance for large catalogs and long anime seasons

(Debrid integration is intentionally **not** on the roadmap.)
