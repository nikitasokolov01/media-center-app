# Alpha Build Guide — Media Center (Windows x64)

This guide covers building and packaging the Windows alpha installer.

---

## Prerequisites

### Required on the build machine

| Tool | Version / Notes |
|------|-----------------|
| **Node.js** | 20 LTS or newer (check with `node --version`) |
| **npm** | Comes with Node (check with `npm --version`) |
| **Rust toolchain** | stable, via [rustup](https://rustup.rs/) — needed for the native embedded-mpv addon |
| **Visual Studio Build Tools** | 2019 or 2022, with **Desktop development with C++** workload — needed by `napi-rs` and `better-sqlite3` |
| **Python 3** | Used by node-gyp (usually already present on Windows) |

### Confirm Rust is installed

```
rustup show
cargo --version
```

### Confirm napi-rs CLI is available (inside native/embedded-mpv)

```
cd native/embedded-mpv
npx napi --version
```

---

## Required DLL files

The embedded MPV player requires three DLLs that are **not** committed to the
repository. You must obtain them separately and place them in:

```
native/embedded-mpv/vendor/
  libmpv-2.dll
  libEGL.dll
  libGLESv2.dll
```

- **`libmpv-2.dll`** — from an [mpv Windows build](https://sourceforge.net/projects/mpv-player-windows/files/) (get the `libmpv` dev package, x64)
- **`libEGL.dll`** and **`libGLESv2.dll`** — ANGLE DLLs, typically from the same mpv dev package or from a Chromium/ANGLE distribution

All three must be 64-bit (`x64`).

---

## Build steps

### 1. Install npm dependencies

```
npm install
```

### 2. Build the native embedded-mpv addon

This step requires Rust + Visual Studio Build Tools.

```
npm run build:embedded-mpv
```

Which runs:
```
cd native/embedded-mpv && npm install && npm run build
```

After a successful build you should see:
```
native/embedded-mpv/embedded-mpv.node
```

Verify: `dir native\embedded-mpv\embedded-mpv.node`

### 3. Build the renderer and Electron main process

```
npm run build
```

This runs Vite (renderer → `dist/`) then tsc (main/preload → `dist-electron/`).

### 4a. Quick test — unpacked directory (faster, no installer)

```
npm run dist:dir
```

Output: `release/win-unpacked/Media Center.exe`

Use this to verify the packaged app works before creating the full installer.

### 4b. Full Windows installer

```
npm run dist
```

Output: `release/Media Center Setup <version>.exe` (NSIS installer)

---

## Output locations

| Artifact | Path |
|----------|------|
| Unpacked app directory | `release/win-unpacked/` |
| NSIS installer | `release/Media Center Setup 0.1.0.exe` |

---

## Where the packaged app looks for native files

In the installed/packaged app all native files live in the `resources/` directory
**outside** the asar archive so they are accessible as real filesystem paths.

| File | Packaged location |
|------|------------------|
| `embedded-mpv.node` | `resources/native/embedded-mpv/embedded-mpv.node` |
| `libmpv-2.dll` | `resources/native/embedded-mpv/vendor/libmpv-2.dll` |
| `libEGL.dll` | `resources/native/embedded-mpv/vendor/libEGL.dll` |
| `libGLESv2.dll` | `resources/native/embedded-mpv/vendor/libGLESv2.dll` |
| `better_sqlite3.node` | `resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/` |

The app uses `process.resourcesPath` at runtime to find `resources/` regardless
of where the app is installed.

---

## User data (SQLite database)

The database is stored in Electron's `userData` directory — **not** inside the
install folder. Reinstalling the app does not wipe user data.

| OS | Default path |
|----|-------------|
| Windows | `C:\Users\<name>\AppData\Roaming\Media Center\media-center.db` |

---

## Troubleshooting

### "Embedded player addon not built"
The `embedded-mpv.node` file is missing from `native/embedded-mpv/`.
Run `npm run build:embedded-mpv` (requires Rust + Visual Studio Build Tools).

### "libmpv not found" error in embedded player
`native/embedded-mpv/vendor/libmpv-2.dll` is missing. Download the mpv libmpv
dev package (x64) and copy the DLL to `vendor/`.

### "ANGLE DLLs not found" error in embedded player
`libEGL.dll` or `libGLESv2.dll` are missing from `vendor/`. These ship with
the mpv libmpv dev package.

### Windows security warning (SmartScreen)
The alpha installer is unsigned. Testers may see a "Windows protected your PC"
dialog. Click **More info → Run anyway**. Code signing will be added before
a public release.

### External MPV fallback
If the embedded player is disabled or unavailable, the app falls back to
launching an external MPV installation. Testers can install MPV from
https://mpv.io and configure the path in Settings → Player.

### The app window appears but is blank / white
Likely a Vite renderer build issue. Run `npm run build:renderer` and check for
errors. Make sure `dist/index.html` exists.
