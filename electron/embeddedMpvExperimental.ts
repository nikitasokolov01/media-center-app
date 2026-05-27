// EXPERIMENTAL embedded libmpv bridge (Stage E1).
//
// Loads the native `native/embedded-mpv` addon LAZILY (only when first used) so
// the app boots fine when the addon isn't built / DLLs are missing. Owns the
// single embedded session and exposes start/stop/get-frame to the renderer.
//
// This module does NOT touch electron/mpv.ts, electron/mpvIpc.ts, or any normal
// playback. External MPV remains the default/fallback player. If anything here
// fails, it returns a friendly error string and the rest of the app is
// unaffected.

import path from "node:path";
import fs from "node:fs";

// Shape of the napi addon (native/embedded-mpv/src/lib.rs).
interface EmbeddedAddon {
  start: (url: string, libmpvPath: string) => void;
  stop: () => void;
  getLatestFrame: (sinceIndex: number) => {
    noNewFrame: boolean;
    width: number;
    height: number;
    frameIndex: number;
    rgba?: Buffer | Uint8Array;
    error?: string;
  };
}

export interface EmbeddedStartResult {
  ok: boolean;
  error?: string;
}

export interface EmbeddedFrame {
  ok: boolean;
  error?: string;
  noNewFrame: boolean;
  width: number;
  height: number;
  frameIndex: number;
  /** Present only when a new frame is available. */
  rgba?: Buffer;
}

// Resolve <projectRoot>/native/embedded-mpv. In dev/build, this file compiles to
// dist-electron/electron/embeddedMpvExperimental.js, so the project root is two
// levels up.
const ADDON_DIR = path.join(__dirname, "..", "..", "native", "embedded-mpv");
const VENDOR_DIR = path.join(ADDON_DIR, "vendor");
const LIBMPV_DLL = path.join(VENDOR_DIR, "libmpv-2.dll");

let addon: EmbeddedAddon | null = null;
let loadError: string | null = null;
let pathPrepared = false;

/** Prepend the vendor dir to PATH so ANGLE (libEGL/libGLESv2) resolves. */
function preparePath(): void {
  if (pathPrepared) return;
  pathPrepared = true;
  try {
    const sep = process.platform === "win32" ? ";" : ":";
    process.env.PATH = `${VENDOR_DIR}${sep}${process.env.PATH ?? ""}`;
  } catch {
    /* ignore */
  }
}

/** Find the built .node next to the addon (napi loader index.js preferred). */
function resolveAddonModule(): string | null {
  const indexJs = path.join(ADDON_DIR, "index.js");
  if (fs.existsSync(indexJs)) return indexJs;
  try {
    const node = fs
      .readdirSync(ADDON_DIR)
      .find((f) => f.endsWith(".node"));
    if (node) return path.join(ADDON_DIR, node);
  } catch {
    /* ADDON_DIR may not exist */
  }
  return null;
}

/** Lazily load the addon. Returns null + sets loadError on failure. */
function getAddon(): EmbeddedAddon | null {
  if (addon) return addon;
  if (loadError) return null;

  if (!fs.existsSync(ADDON_DIR)) {
    loadError =
      "Embedded player addon not found. Build it: `cd native/embedded-mpv && npm install && npm run build`.";
    return null;
  }
  const mod = resolveAddonModule();
  if (!mod) {
    loadError =
      "Embedded player addon is not built. Run `npm run build` in native/embedded-mpv.";
    return null;
  }
  preparePath();
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    addon = require(mod) as EmbeddedAddon;
    return addon;
  } catch (e) {
    loadError = `Failed to load embedded player addon: ${
      e instanceof Error ? e.message : String(e)
    }`;
    return null;
  }
}

function isHttp(url: unknown): url is string {
  return (
    typeof url === "string" &&
    (url.startsWith("http://") || url.startsWith("https://"))
  );
}

export function embeddedStart(url: string): EmbeddedStartResult {
  if (!isHttp(url)) {
    return { ok: false, error: "URL must be http(s)." };
  }
  const a = getAddon();
  if (!a) return { ok: false, error: loadError ?? "Embedded addon unavailable." };

  if (!fs.existsSync(LIBMPV_DLL)) {
    return {
      ok: false,
      error: `libmpv-2.dll not found at ${LIBMPV_DLL}. See native/embedded-mpv/README.md.`,
    };
  }
  try {
    a.start(url, LIBMPV_DLL);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function embeddedStop(): EmbeddedStartResult {
  // Only call stop if the addon actually loaded; otherwise it's a no-op.
  if (!addon) return { ok: true };
  try {
    addon.stop();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function embeddedGetFrame(sinceIndex: number): EmbeddedFrame {
  const a = getAddon();
  if (!a) {
    return {
      ok: false,
      error: loadError ?? "Embedded addon unavailable.",
      noNewFrame: true,
      width: 0,
      height: 0,
      frameIndex: 0,
    };
  }
  try {
    const f = a.getLatestFrame(Math.max(0, Math.floor(sinceIndex || 0)));
    return {
      ok: !f.error,
      error: f.error,
      noNewFrame: f.noNewFrame,
      width: f.width,
      height: f.height,
      frameIndex: f.frameIndex,
      rgba: f.rgba ? Buffer.from(f.rgba) : undefined,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      noNewFrame: true,
      width: 0,
      height: 0,
      frameIndex: 0,
    };
  }
}

/** Best-effort stop on app shutdown. */
export function embeddedShutdown(): void {
  if (addon) {
    try {
      addon.stop();
    } catch {
      /* ignore */
    }
  }
}
