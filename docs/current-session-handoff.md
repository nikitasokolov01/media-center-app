# Current Session Handoff — Control Bar Redesign + Volume Memory

## Status: Complete (TypeScript clean)

---

## What Was Built This Session

### Part 1 — Profile-scoped Embedded Volume Memory

**IPC (4 layers):**
- `electron/ipc-channels.ts`: `EmbeddedGetVolume: "embedded:get-volume"`, `EmbeddedSetVolume: "embedded:set-volume"`
- `electron/main.ts`: handlers using `getSetting`/`setSetting` with key `embeddedVol:<profileId>`. Clamps 0–130.
- `electron/preload.ts`: `window.embeddedMpv.getVolume(profileId)` → `Promise<number | null>`, `window.embeddedMpv.setVolume(profileId, volume)` → `Promise<void>`
- `src/types/embedded-mpv.d.ts`: typed in the `Window.embeddedMpv` interface

**Overlay logic (`EmbeddedPlayerOverlay.tsx`):**
- `saveVolumeTimerRef` — debounce timer (400 ms) to avoid hammering the DB on rapid scroll/drag
- `saveVolume(vol)` — debounced persist via `window.embeddedMpv.setVolume(profileId, vol)`
- Called from: volume slider change, mouse wheel, mute/unmute (both button and M key)
- On playback start (`doStart`): calls `window.embeddedMpv.getVolume(profileId)`, stores in `volumeRef`, then after `startPlayback` resolves sends `command("volume", savedVol)` to mpv
- Mute preserves last non-zero volume in `prevVolumeRef`; unmute restores it

### Part 2 — Control Bar Layout Redesign

**Transport row split into left/right groups:**

Left group (`.emb-overlay__transport-left`):
- ▶/⏸ play-pause
- ⏭ next episode (only when `hasNextEp` is true)
- 🔊/🔉/🔇 mute toggle
- Volume slider
- `XX%` volume label

Right group (`.emb-overlay__transport-right`):
- CC subtitle track (icon + select wrapper)
- ♪ audio track (icon + select wrapper, only when >1 track)
- ⚙ source picker
- ⤢/⤡ fullscreen
- ⏹ stop/close

**Track wrap (`emb-overlay__track-wrap`):**
- Icon + native `<select>` in a styled pill (border + background)
- Select has no visible border itself; wrapper provides the border
- Hover lightens the wrapper

**CSS changes:**
- `.emb-overlay__transport` now `justify-content: space-between` with `.transport-left` / `.transport-right` children
- `.emb-overlay__vol-label` — volume percentage text
- `.emb-overlay__track-wrap` — styled pill container
- `.emb-overlay__track-icon` — CC / ♪ icon inside the wrap
- Transport spacer class removed (not needed; flex space-between handles it)

---

## Files Changed This Session

| File | Change |
|------|--------|
| `electron/ipc-channels.ts` | `EmbeddedGetVolume`, `EmbeddedSetVolume` |
| `electron/main.ts` | IPC handlers for volume get/set |
| `electron/preload.ts` | `embeddedMpv.getVolume`, `embeddedMpv.setVolume` |
| `src/types/embedded-mpv.d.ts` | Type signatures for new methods |
| `src/components/EmbeddedPlayerOverlay.tsx` | Volume persistence, control bar JSX redesign |
| `src/styles.css` | Transport left/right groups, track-wrap styling |

---

## Build State

- `npx tsc --noEmit` → clean
- No new npm dependencies
- No SQLite schema migrations (uses existing `app_settings` key-value table via `getSetting`/`setSetting`)

---

## Guardrails (unchanged)

- External MPV untouched
- No debrid/torrent logic
- All embedded code gated on `experimentalEmbeddedPlayer`
- Additive DB use only (`app_settings` key-value — existing pattern)
