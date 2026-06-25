# Session Handoff Notes

Last updated: 2026-06-18

## What was done this session

Phase 2 of the bug-fix + foundations sprint: local ratings + watched controls.
Additive and local-only; no playback/source/progress/native-MPV changes. Verified
with `tsc` on renderer + electron (both clean). See CLAUDE.md section 17.

### Local ratings (per profile, local-only)
- New SQLite table `media_ratings` (per profile; movie/series/anime; 1-10 scale
  stored, 5 half-step stars in UI). `getRating`/`setRating`/`clearRating`/`listRatings`.
- IPC `rating:get|set|clear|export` (four layers); `window.mediaCenter.ratings.*`.
- `RatingControl.tsx` on the media detail page (set/update/clear, persists,
  profile-specific). No stream URLs involved.

### Ratings export
- Settings -> About -> Data -> "Export ratings (JSON)": folder picker writes
  pretty `movies.json` / `series.json` / `anime.json` (empty `[]` if none, no
  stream URLs). Success/failure message shown.

### Manual episode watched controls
- Confirmed existing per-episode watched/unwatched toggle in `EpisodeSelector`
  (via `watched.set`/`setWatched`) still works; unwatch clears only that
  episode's completion; Continue Watching / resume unaffected. Not rebuilt.

### AniList note
- Ratings + watched are structured to map onto a future AniList sync (per
  profile, stable media ids, 1-10 scale), but no AniList code exists yet.

## Files changed
- `electron/db.ts` (media_ratings table + rating fns/types)
- `electron/ipc-channels.ts`, `electron/main.ts` (rating handlers + export dialog)
- `electron/preload.ts`, `src/types/preload.d.ts` (ratings API + MediaRating)
- `src/components/RatingControl.tsx` (new)
- `src/pages/MediaPage.tsx` (RatingControl integration)
- `src/pages/settings/sections/AboutSettings.tsx` (export button + Data section)
- `src/styles.css` (rating control styles)

## Current state
- TypeScript: clean (renderer + electron).
- Run `npm run build` on Windows to confirm the production bundle (the Linux dev
  sandbox cannot run the platform-native rollup binary; `tsc` is the gate here).

## Critical edit rule (still in force)
Edit/Write tools truncate files mid-content AND convert CRLF->LF on this repo.
All edits this session used Python byte-ops with CRLF preserved. Verify with `tsc`.

## Suggested manual test pass
1. Rate a movie, a series, and an anime (1-10 via stars); reload the page and
   restart the app -> ratings persist.
2. Switch profile -> ratings are separate per profile.
3. Clear a rating -> it is removed.
4. Settings -> About -> Data -> Export ratings -> pick a folder -> confirm
   movies.json / series.json / anime.json are created, pretty-formatted, contain
   no stream URLs, and empty categories are `[]`.
5. Mark an episode watched/unwatched -> badge toggles; Continue Watching and
   resume still behave; episode play still works.
6. Playback, source picker, collections, spoiler blur all unaffected.
