// Standalone B-Headless test harness.
//
// Plain Node (no Electron, no app code). Loads the compiled napi addon, points
// it at libmpv-2.dll, prints the mpv version, then plays a direct URL
// headlessly for a few seconds and prints the collected report.
//
// libmpv-2.dll resolution (first match wins):
//   1. env LIBMPV_DLL=<full path to libmpv-2.dll>
//   2. native/libmpv-poc/vendor/libmpv/libmpv-2.dll   (default)
//
// Usage:
//   node test.mjs                       # default sample URL, 8 seconds
//   node test.mjs <url>                 # custom direct http(s) URL
//   node test.mjs <url> <seconds>

import { createRequire } from "node:module";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sep = process.platform === "win32" ? ";" : ":";

// Resolve libmpv-2.dll.
const vendorDefault = join(here, "vendor", "libmpv", "libmpv-2.dll");
const dllPath = process.env.LIBMPV_DLL ?? vendorDefault;

// Make the DLL's own folder (and this folder) discoverable so any dependent
// DLLs resolve at load time on Windows.
process.env.PATH = `${dirname(dllPath)}${sep}${here}${sep}${process.env.PATH ?? ""}`;

if (!existsSync(dllPath)) {
  console.error(
    `[poc] libmpv-2.dll not found at:\n      ${dllPath}\n` +
      `      Put it there, or set LIBMPV_DLL to its full path.`,
  );
  process.exit(1);
}

function loadAddon() {
  // Prefer the napi-rs generated loader (index.js) if present…
  try {
    return require(join(here, "index.js"));
  } catch (loaderErr) {
    // …otherwise fall back to the first *.node in this folder.
    const node = readdirSync(here).find((f) => f.endsWith(".node"));
    if (!node) {
      throw new Error(
        "Could not load the addon. Build it first with `npm run build`.\n" +
          `Loader error: ${loaderErr.message}`,
      );
    }
    return require(join(here, node));
  }
}

const url =
  process.argv[2] ??
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";
const seconds = Number(process.argv[3] ?? 8);

console.log(`[poc] libmpv-2.dll: ${dllPath}`);
console.log("[poc] loading native addon…");
let addon;
try {
  addon = loadAddon();
} catch (e) {
  console.error("[poc] FAILED to load addon:\n", e.message);
  process.exit(1);
}

console.log("[poc] mpvVersion():");
try {
  console.log("      ", addon.mpvVersion(dllPath));
} catch (e) {
  console.error("[poc] mpvVersion() failed (libmpv DLL not loadable / wrong bitness?):");
  console.error("      ", e.message);
  process.exit(1);
}

console.log(`[poc] runHeadlessDemo(url=${url}, seconds=${seconds})…`);
let report;
try {
  report = addon.runHeadlessDemo(dllPath, url, seconds);
} catch (e) {
  console.error("[poc] runHeadlessDemo() threw:\n", e.message);
  process.exit(1);
}

console.log("[poc] report:");
console.log(JSON.stringify(report, null, 2));

const ok =
  report.created &&
  report.fileLoaded &&
  (report.duration != null || report.lastTimePos != null);

console.log(
  ok
    ? "\n[poc] SUCCESS ✅  libmpv loaded, URL opened, properties/events read, cleanup OK."
    : "\n[poc] INCOMPLETE ⚠️  See report + eventsLog above.",
);
process.exit(ok ? 0 : 2);
