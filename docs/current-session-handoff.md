# Session Handoff Notes

Last updated: 2026-06-16

## What was done this session

### 1. Kino rebrand (complete)
- Window title changed to "Kino" in `electron/main.ts`
- `app.setPath("userData", ...)` pins userData to `AppData/Roaming/Media Center`
- `src/components/KinoLogo.tsx` created: SVG cinema-frame wordmark
- `TopNav.tsx` uses `<KinoLogo mode="wordmark" size={18} />`
- `AboutSettings.tsx` section heading updated to "Kino"

### 2. Custom image background (complete + fixed)

**IPC (4-layer each):**
- `bg:choose-image` (BgChooseImage): opens file dialog, copies to userData/backgrounds/,
  returns { ok, path } or null (cancelled)
- `bg:remove-image` (BgRemoveImage): deletes copied file

**New AppSettings fields (5):**
- `customBackgroundImagePath` - absolute path to copied file
- `customBackgroundImageFit` - "cover" | "contain"
- `customBackgroundImagePosition` - "center" | "top" | "bottom"
- `customBackgroundImageDim` - 0 to 0.85, default 0.45
- `customBackgroundImageBlur` - 0 to 20px, default 0

**Architecture:**
- `kino-local://` custom Electron protocol registered in `electron/main.ts` (before
  `app.whenReady()` with `protocol.registerSchemesAsPrivileged`; handler inside
  `app.whenReady()` serves `userData/backgrounds/<filename>` via `fs.promises.readFile`)
- ThemeProvider Effect 7 sets CSS vars (`--bg-img-url`, `--bg-img-fit`, `--bg-img-pos`,
  `--bg-img-dim`, `--bg-img-blur`, `--bg-img-margin`) on `<html>` and adds class
  `has-bg-image`
- `styles.css` rules: `html.has-bg-image body::before` (image, z-index:-1) and
  `html.has-bg-image body::after` (dim overlay, z-index:-1) handle the painting
- Custom themes and custom image backgrounds are now COMPATIBLE (removed `!activeCustomThemeId`
  constraint from showImageBg)
- AppearanceSettings shows 160x90 preview thumbnail via `kino-local://bg/<filename>` with
  `onLoad`/`onError` for file-missing detection

**Root cause of the original bug:**
The previous implementation used `file://` URLs in CSS `background-image`. In Electron dev
mode the renderer is at `http://localhost:5173`, so `file://` is a different origin and is
CORS-blocked. The `kino-local://` custom protocol fixes this in both dev and production.

**Files changed this session:**
- `electron/main.ts` - `protocol` import, `registerSchemesAsPrivileged`, `protocol.handle`
- `electron/db.ts` - `AppSettings` interface now includes all 5 custom bg image fields
  (DEFAULTS, getAppSettings, updateAppSettings were already correct)
- `src/theme/ThemeProvider.tsx` - replaced `pathToFileUrl` with `pathToKinoLocalUrl`,
  replaced fixed React divs with CSS-var Effect 7, removed `!activeCustomThemeId` constraint
- `src/styles.css` - appended `html.has-bg-image body::before` + `body::after` rules
- `src/pages/settings/sections/AppearanceSettings.tsx` - added `bgImageMissing` state,
  preview thumbnail with onLoad/onError

## Current state
- TypeScript: clean (both renderer and electron)
- No pending fixes
- Ready to run / build

## Critical edit rule
ALL file edits must use Python byte-level operations. The Edit/Write tools truncate files
containing em-dash (U+2014), ellipsis (U+2026), or box-drawing characters.
