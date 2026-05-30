# Alpha Release Checklist

Use this checklist before sharing an alpha build with testers.
Check each item on a **fresh Windows install** where possible.

---

## Pre-flight

- [ ] `npm run build` passes with no errors
- [ ] `npm run dist:dir` produces a working `release/win-unpacked/` directory
- [ ] `native/embedded-mpv/embedded-mpv.node` exists
- [ ] All three vendor DLLs exist in `native/embedded-mpv/vendor/`
- [ ] No `.env` files or private credentials are present in the project

---

## Launch and first run

- [ ] **1. Fresh install launches**
  - Run the installer (or the unpacked exe)
  - App window appears with correct title "Media Center"
  - No crash on startup
  - Profile picker / first-run flow appears

- [ ] **2. Create a profile**
  - Create a new profile (name, color/emoji)
  - Profile appears in the sidebar

- [ ] **3. Switch profiles**
  - Create a second profile
  - Switch between them — each has independent data

---

## Addon and catalog

- [ ] **4. Install an addon**
  - Navigate to Addons page
  - Paste a Stremio addon URL (e.g. Cinemeta: `https://v3-cinemeta.strem.io/manifest.json`)
  - Addon appears in the installed list with name/description/logo

- [ ] **5. Catalog loads on Home**
  - Home page shows catalog rows from the installed addon
  - Poster cards appear with titles

- [ ] **6. Search works**
  - Search for a known title
  - Results appear from installed addons

---

## Media detail pages

- [ ] **7. Movie detail loads**
  - Click a movie poster
  - Poster, title, year, description, and genres show
  - Play button and Sources button are visible

- [ ] **8. Series episode list loads**
  - Click a series poster
  - Episode list with season tabs appears
  - Episodes have titles and dates

---

## Embedded playback

*(Requires `experimentalEmbeddedPlayer` enabled in Settings → Experimental)*

- [ ] **9. Embedded movie playback**
  - Open a movie detail page
  - Click ▶ Play
  - Embedded player overlay appears
  - Video plays within a few seconds

- [ ] **10. Embedded episode playback**
  - Open a series, select an episode
  - Click ▶ Play
  - Embedded player plays the episode

- [ ] **11. Embedded controls**
  - [ ] Play / pause button (and Space key)
  - [ ] Seek by clicking/dragging the progress bar
  - [ ] Left/Right arrow keys seek ±5 seconds
  - [ ] Volume slider and mouse wheel on video
  - [ ] M key mutes/unmutes
  - [ ] Volume is remembered after closing and reopening
  - [ ] Subtitle track selector (if tracks available)
  - [ ] Audio track selector (if multiple tracks)
  - [ ] Source picker drawer (⚙ button) opens and shows sources
  - [ ] Selecting a different source switches playback
  - [ ] Fullscreen (F key / ⤢ button) enters and exits cleanly
  - [ ] Double-clicking video toggles fullscreen
  - [ ] Single-clicking video toggles play/pause
  - [ ] Esc exits fullscreen (first press) then closes overlay (second press)
  - [ ] Close button (✕) exits overlay and exits fullscreen if active

- [ ] **12. Next episode**
  - Play a series episode
  - Near the end (≤3 min remaining) "Up Next ▶" button appears
  - Clicking it transitions to the next episode
  - Volume is preserved across the transition

---

## Progress and Continue Watching

- [ ] **13. Watch progress saves**
  - Play a movie or episode, pause at a recognizable timestamp
  - Close the overlay
  - Re-open the same movie/episode — playback resumes from saved position

- [ ] **14. Continue Watching appears on Home**
  - After watching partway, the item appears in Continue Watching on Home
  - Clicking it resumes from the saved position

---

## External MPV fallback

- [ ] **15. External MPV fallback works**
  - Install MPV or configure its path in Settings → Player
  - Disable `experimentalEmbeddedPlayer` (or use a StreamCard "Open in MPV" button)
  - A movie/episode opens in external MPV window
  - External MPV session is independent of the embedded player

---

## Shutdown safety

- [ ] **16. App closes without leaving audio playing**
  - Start embedded playback
  - Close the app window
  - No audio continues after the window closes

---

## Persistence

- [ ] **17. userData persists across restarts**
  - Close the app
  - Reopen — profiles, addons, and progress are still there

- [ ] **18. Reinstall does not wipe data** *(optional — test if NSIS installer available)*
  - Run the installer again on top of existing install
  - userData (profiles, addons, progress) is preserved

---

## Notes for testers

- The embedded player is **experimental**. If it fails to load, the app still works — use external MPV as the fallback.
- The installer is **unsigned**. Windows SmartScreen will warn about it — click **More info → Run anyway**.
- Report crashes by sharing the log from `%APPDATA%\Media Center\logs\` (if present) or a screenshot of any error dialog.
- To reset all data, delete `%APPDATA%\Media Center\` — this removes the database, settings, and logs.
