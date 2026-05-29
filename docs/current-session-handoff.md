# Session handoff — E7: Embedded as default player when flag is ON

Read `CLAUDE.md` (section 10 especially) before making changes.

## 1. Branch
`experiment/libmpv-native`

## 2. Embedded MPV stage history
- ✅ **E1–E5** — See previous handoff for full history.
- ✅ **E6** — YouTube/Netflix UX: video fills full area, floating chrome, auto-hide.
- ✅ **E7** — Embedded becomes the primary/default player when `experimentalEmbeddedPlayer` is ON.

## 3. E7 changes (this session)

### Goal
When `experimentalEmbeddedPlayer` is ON, clicking Play on any direct HTTP/HTTPS
source should open the embedded overlay by default. External MPV is demoted to a
secondary "Open in MPV" fallback button. Auto-play best source also uses embedded.

### `src/components/StreamCard.tsx`

**`renderActions()` for `playable`/`hls` case** — new branch at the top:

```tsx
if (settings.experimentalEmbeddedPlayer) {
  return (
    <>
      <button /* primary */ onClick={handlePlayEmbedded}>▶ Play</button>
      {mpvViable && <button /* secondary */ onClick={handlePlayInMpv}>Open in MPV</button>}
    </>
  );
}
// ... existing MPV-primary / browser-secondary logic unchanged
```

- The old "⬡ Play Embedded" tertiary button is gone — embedded is now primary.
- "Open in MPV" is the fallback (only shown when `mpvViable`).
- Flag OFF: behavior is completely unchanged.

### `src/components/SourcesSection.tsx`

**`handlePlayBest`** — backend selected from flag:

```ts
const backend = settings.experimentalEmbeddedPlayer
  ? "embedded-mpv-experimental"
  : "external-mpv";
```

- MPV-specific dispatch options (`subtitleAddons`, `startSeconds`, `audioLanguageOverride`)
  are only forwarded when `backend === "external-mpv"`.
- "Play Best Source" button tooltip updated to mention embedded vs MPV.

## 4. File map (E7)

| File | Change |
|---|---|
| `src/components/StreamCard.tsx` | `renderActions()`: embedded-first branch when flag ON; removed old "⬡ Play Embedded" tertiary button |
| `src/components/SourcesSection.tsx` | `handlePlayBest`: backend from flag; MPV options conditional; button title updated |
| `CLAUDE.md` | Section 10 updated with E7 |
| `docs/current-session-handoff.md` | This file |

## 5. Build steps

```
npm run dev    # development
npm run build  # production
```

No native Rust addon rebuild needed — all changes are TypeScript only.

## 6. Acceptance tests

### Flag OFF
1. Play any direct URL source → "▶ Play with MPV" is primary. ✓
2. Auto-play best source → launches external MPV. ✓
3. No "Open in MPV" secondary button visible (behavior unchanged). ✓

### Flag ON
4. Play any direct URL source → "▶ Play" is primary, opens embedded overlay. ✓
5. "Open in MPV" secondary button is visible as fallback. ✓
6. Click "Open in MPV" → external MPV launches exactly that source. ✓
7. Auto-play best source → opens embedded overlay. ✓
8. Auto-play followed by clicking another source's "▶ Play" → stops old embedded, starts new one. ✓
9. Progress/Continue Watching still updates for embedded sessions. ✓
10. External MPV progress still works when "Open in MPV" fallback is used. ✓

## 7. Guardrails (unchanged)
- Do **not** touch `electron/mpv.ts`, `electron/mpvIpc.ts`, external-mpv dispatch.
- Do **not** touch source picker, subtitles/audio for external MPV, profiles,
  library, Continue Watching, database, debrid/torrent.
- Embedded is gated on `experimentalEmbeddedPlayer` flag — external MPV is always
  available as a fallback when the flag is ON.
