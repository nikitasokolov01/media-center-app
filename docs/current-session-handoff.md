# Current Session Handoff — Mouse Controls + Responsive UI Scaling

## Status: Complete (TypeScript clean)

---

## What Was Built This Session

### Part 1 — Mouse Wheel Volume Control

**`EmbeddedPlayerOverlay.tsx`:**

New state / refs:
- `volumeRef` — ref mirror of current volume so the wheel handler never has a stale closure
- `volumeToastTimerRef` — timer for auto-dismissing the volume toast after 1.2 s
- `dblClickTimerRef` — used for double-click detection (300 ms window)
- `volumeToast: string | null` state — drives the volume feedback overlay

New logic:
- `showVolumeToast(vol)` — sets toast text, resets dismiss timer
- `handleWheelVolume` — attached to `.emb-overlay__stage` via `onWheel`.
  - Skips if `!running || !req`.
  - Skips if target is `INPUT` or `SELECT` (volume slider, track dropdowns).
  - Calls `e.preventDefault()` to suppress page scroll.
  - `deltaY < 0` (scroll up) → +5; `deltaY > 0` (scroll down) → −5; clamped 0–130.
  - Calls `setVolume()`, `showControls()`, `showVolumeToast()`.
- Source panel has `onWheel={(e) => e.stopPropagation()}` so panel scrolling stays local.

### Part 2 — Double-Click Play/Pause

**`EmbeddedPlayerOverlay.tsx`:**

- `handleStageClick` — attached to `.emb-overlay__stage` via `onClick`.
  - Ignores clicks that land inside `.emb-overlay__controls`, `.emb-overlay__header`, `.emb-overlay__source-panel`, `.emb-overlay__next-ep`, or any `button/input/select`.
  - Skips if `!running || starting`.
  - Uses `dblClickTimerRef` as a 300 ms window:
    - First click → set timer (single click just shows controls on expiry).
    - Second click within 300 ms → clear timer, call `togglePause()`, `showControls()`.

### Part 3 — Responsive CSS Scaling

**`src/styles.css` — Embedded overlay section rewritten:**

CSS custom properties set on `.emb-overlay` (so they inherit to all children):

| Variable | Value | Controls |
|----------|-------|----------|
| `--emb-ctrl-font`    | `clamp(13px, 1.1vw, 16px)` | Button text, title, toast |
| `--emb-icon-font`    | `clamp(16px, 1.4vw, 20px)` | Icon buttons (⚙ ⤢ ⓘ)     |
| `--emb-play-font`    | `clamp(20px, 1.8vw, 28px)` | ▶ / ⏸ play-pause          |
| `--emb-time-font`    | `clamp(11px, 0.9vw, 14px)` | Timestamps, track selects |
| `--emb-track-font`   | `clamp(11px, 0.9vw, 13px)` | CC/audio dropdowns        |
| `--emb-toast-font`   | `clamp(13px, 1.1vw, 16px)` | Volume toast              |
| `--emb-ctrl-pad-v`   | `clamp(3px, 0.3vw, 6px)`   | Button vertical padding   |
| `--emb-ctrl-pad-h`   | `clamp(7px, 0.6vw, 12px)`  | Button horizontal padding |
| `--emb-bar-pad-h`    | `clamp(10px, 1.0vw, 20px)` | Control bar side padding  |
| `--emb-bar-pad-top`  | `clamp(32px, 3.0vw, 56px)` | Gradient fade height      |
| `--emb-bar-gap`      | `clamp(4px, 0.4vw, 8px)`   | Between controls          |
| `--emb-progress-h`   | `clamp(4px, 0.35vw, 6px)`  | Scrub bar height          |
| `--emb-progress-h-hover` | `clamp(6px, 0.5vw, 9px)` | Scrub bar on hover      |
| `--emb-volume-w`     | `clamp(64px, 5.5vw, 100px)`| Volume slider width       |
| `--emb-panel-w`      | `clamp(280px, 26vw, 380px)`| Source drawer width       |

All button sizes, padding, font sizes, scrub/volume bars, and the source panel use these variables. At 1440p windowed the controls are comfortably larger; at small windows they stay compact and don't overflow.

**Volume toast** `.emb-overlay__volume-toast`:
- Centred top area (below header).
- Slide-in animation `emb-toast-in`.
- `pointer-events: none` — doesn't block video interaction.

---

## Files Changed This Session

| File | Change |
|------|--------|
| `src/components/EmbeddedPlayerOverlay.tsx` | Wheel volume handler, double-click toggle, volume toast, volumeRef |
| `src/styles.css` | Full responsive overlay CSS rewrite with CSS vars + clamp() |

---

## Build State

- `npx tsc --noEmit` → clean
- No new npm dependencies
- No IPC / DB changes
- External MPV untouched

---

## Guardrails (unchanged)

- External MPV path untouched
- No debrid/torrent logic
- All embedded code gated on `experimentalEmbeddedPlayer`
- No SQLite schema changes
