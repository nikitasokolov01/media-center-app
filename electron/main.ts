// Electron main process: window lifecycle + IPC handlers wiring the core
// Stremio module and the SQLite layer.

import { app, BrowserWindow, dialog, ipcMain, protocol, shell, Menu } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  initDb,
  getDefaultProfile,
  listProfiles,
  createProfile,
  updateProfile,
  deleteProfile,
  listAddons,
  getAddon,
  upsertAddon,
  removeAddon,
  upsertWatchProgress,
  getWatchProgress,
  listContinueWatching,
  clearWatchProgress,
  reviveWatchProgress,
  resetWatchProgress,
  dismissMediaFromContinueWatching,
  setWatched,
  listWatchedForMedia,
  getRating,
  setRating,
  clearRating,
  listRatings,
  type SetRatingInput,
  type RatingMediaType,
  cacheSeriesEpisodes,
  getSeriesLibraryStatus,
  getNextEpisodeAfter,
  addLibraryItem,
  removeLibraryItem,
  getLibraryItem,
  listLibrary,
  getAppSettings,
  updateAppSettings,
  getSetting,
  setSetting,
  saveSourcePref,
  getSourcePref,
} from "./db.js";
import type {
  SetWatchedInput,
  AddLibraryItemInput,
  SeriesEpisodeInput,
  SourcePref,
} from "./db.js";
import {
  openInMpv,
  checkMpvAvailable,
  mpvControl,
  mpvGetState,
  type MpvPayload,
  type MpvControlAction,
} from "./mpv.js";
import {
  embeddedStart,
  embeddedStop,
  embeddedGetFrame,
  embeddedSendCommand,
  embeddedGetState,
  embeddedShutdown,
} from "./embeddedMpvExperimental.js";
import type { AppSettings } from "./db.js";
import {
  resolveAddonFromUrl,
  fetchStremioCatalog,
  fetchStremioMeta,
  fetchStremioStreams,
  fetchStremioSubtitles,
} from "../src/core/stremio/index.js";
import type { StremioManifest } from "../src/core/stremio/types.js";
import { IPC } from "./ipc-channels.js";

const isDev = process.env.NODE_ENV === "development";

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Kino",
    backgroundColor: "#0f1115",
    // Dev/taskbar window icon. In packaged builds electron-builder applies
    // build/icon.ico to the exe; build/ is not bundled, so this guard simply
    // no-ops there. resolves to <project>/build/icon.png in dev.
    icon: (() => {
      const p = path.join(app.getAppPath(), "build", "icon.png");
      return fs.existsSync(p) ? p : undefined;
    })(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Open external links in the user's browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // E5 fix: push fullscreen state changes to renderer so the embedded overlay
  // can sync its button icon.  DOM requestFullscreen() is unreliable in
  // Electron's renderer — BrowserWindow.setFullScreen() is the correct path.
  win.on("enter-full-screen", () =>
    win.webContents.send(IPC.EmbeddedFullscreenChanged, true),
  );
  win.on("leave-full-screen", () =>
    win.webContents.send(IPC.EmbeddedFullscreenChanged, false),
  );

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // After tsc, __dirname is <project>/dist-electron/electron, and Vite emits
    // the renderer to <project>/dist. Hence two levels up.
    win.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  return win;
}

function registerIpcHandlers() {
  ipcMain.handle(IPC.ProfileGetDefault, async () => getDefaultProfile());
  ipcMain.handle(IPC.ProfileList, async () => listProfiles());
  ipcMain.handle(
    IPC.ProfileCreate,
    async (_e, args: { name: string; color?: string | null; emoji?: string | null }) =>
      createProfile(args),
  );
  ipcMain.handle(
    IPC.ProfileUpdate,
    async (
      _e,
      args: { id: number; name?: string; color?: string | null; emoji?: string | null },
    ) => updateProfile(args.id, args),
  );
  ipcMain.handle(
    IPC.ProfileDelete,
    async (_e, args: { id: number }) => deleteProfile(args.id),
  );

  ipcMain.handle(IPC.AddonList, async (_e, profileId: number) =>
    listAddons(profileId),
  );

  ipcMain.handle(
    IPC.AddonGet,
    async (_e, args: { profileId: number; id: string }) =>
      getAddon(args.profileId, args.id),
  );

  ipcMain.handle(
    IPC.AddonInstall,
    async (_e, args: { profileId: number; url: string }) => {
      const { profileId, url } = args;
      // resolveAddonFromUrl normalizes, fetches, and validates the manifest.
      const resolved = await resolveAddonFromUrl(url);
      return upsertAddon({
        profileId,
        manifestUrl: resolved.manifestUrl,
        baseUrl: resolved.baseUrl,
        manifest: resolved.manifest,
      });
    },
  );

  ipcMain.handle(
    IPC.AddonRemove,
    async (_e, args: { profileId: number; id: string }) =>
      removeAddon(args.profileId, args.id),
  );

  ipcMain.handle(
    IPC.CatalogFetch,
    async (
      _e,
      args: {
        manifestUrl: string;
        type: string;
        catalogId: string;
        extra?: Record<string, string | number | null | undefined>;
      },
    ) =>
      fetchStremioCatalog({
        manifestUrl: args.manifestUrl,
        type: args.type,
        catalogId: args.catalogId,
        extra: args.extra,
      }),
  );

  ipcMain.handle(
    IPC.MetaFetch,
    async (_e, args: { manifestUrl: string; type: string; id: string }) =>
      fetchStremioMeta({
        manifestUrl: args.manifestUrl,
        type: args.type,
        id: args.id,
      }),
  );

  ipcMain.handle(
    IPC.StreamFetch,
    async (_e, args: { manifestUrl: string; type: string; id: string }) =>
      fetchStremioStreams({
        manifestUrl: args.manifestUrl,
        type: args.type,
        id: args.id,
      }),
  );

  ipcMain.handle(
    IPC.SubtitlesFetch,
    async (_e, args: { manifestUrl: string; type: string; id: string }) =>
      fetchStremioSubtitles({
        manifestUrl: args.manifestUrl,
        type: args.type,
        id: args.id,
      }),
  );

  // Watch progress -----------------------------------------------------------
  ipcMain.handle(
    IPC.ProgressUpsert,
    async (
      _e,
      args: Parameters<typeof upsertWatchProgress>[0],
    ) => upsertWatchProgress(args),
  );

  ipcMain.handle(
    IPC.ProgressGet,
    async (
      _e,
      args: { profileId: number; mediaId: string; playableId: string },
    ) => getWatchProgress(args.profileId, args.mediaId, args.playableId),
  );

  ipcMain.handle(
    IPC.ProgressList,
    async (_e, args: { profileId: number; limit?: number }) =>
      listContinueWatching(args.profileId, args.limit),
  );

  ipcMain.handle(
    IPC.ProgressClear,
    async (
      _e,
      args: { profileId: number; mediaId: string; playableId: string },
    ) => clearWatchProgress(args.profileId, args.mediaId, args.playableId),
  );

  ipcMain.handle(
    IPC.ProgressReset,
    async (
      _e,
      args: { profileId: number; mediaId: string; playableId: string },
    ) => resetWatchProgress(args.profileId, args.mediaId, args.playableId),
  );

  ipcMain.handle(
    IPC.ProgressRevive,
    (_e, args: { profileId: number; mediaId: string; playableId: string }) =>
      reviveWatchProgress(args.profileId, args.mediaId, args.playableId),
  );

  ipcMain.handle(
    IPC.ProgressDismiss,
    (_e, args: { profileId: number; mediaId: string }) =>
      dismissMediaFromContinueWatching(args.profileId, args.mediaId),
  );

  // Watched state ------------------------------------------------------------
  ipcMain.handle(
    IPC.WatchedSet,
    async (_e, args: SetWatchedInput) => setWatched(args),
  );

  ipcMain.handle(
    IPC.WatchedListForMedia,
    async (_e, args: { profileId: number; mediaId: string }) =>
      listWatchedForMedia(args.profileId, args.mediaId),
  );

  // Local media ratings (per profile) ----------------------------------------
  ipcMain.handle(
    IPC.RatingGet,
    async (_e, args: { profileId: number; mediaType: RatingMediaType; mediaId: string }) =>
      getRating(args.profileId, args.mediaType, args.mediaId),
  );
  ipcMain.handle(IPC.RatingSet, async (_e, args: SetRatingInput) => setRating(args));
  ipcMain.handle(
    IPC.RatingClear,
    async (_e, args: { profileId: number; mediaType: RatingMediaType; mediaId: string }) =>
      clearRating(args.profileId, args.mediaType, args.mediaId),
  );
  // Export ratings to movies.json / series.json / anime.json in a chosen folder.
  // No stream URLs are ever included (ratings carry none).
  ipcMain.handle(
    IPC.RatingExport,
    async (e, args: { profileId: number; profileName?: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win) return { ok: false as const, error: "No window" };
      const result = await dialog.showOpenDialog(win, {
        title: "Choose a folder to export ratings into",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || !result.filePaths.length) return null;
      const folder = result.filePaths[0];
      try {
        const rows = listRatings(args.profileId);
        const toExport = (r: typeof rows[number]) => ({
          title: r.title,
          year: r.year,
          type: r.mediaType,
          mediaId: r.mediaId,
          rating: r.rating,
          ratingScale: "1-10",
          poster: r.poster,
          profileId: r.profileId,
          profileName: args.profileName ?? null,
          ratedAt: r.ratedAt,
          updatedAt: r.updatedAt,
        });
        const movies = rows.filter((r) => r.mediaType === "movie").map(toExport);
        const series = rows.filter((r) => r.mediaType === "series").map(toExport);
        const anime = rows.filter((r) => r.mediaType === "anime").map(toExport);
        await fs.promises.writeFile(path.join(folder, "movies.json"), JSON.stringify(movies, null, 2), "utf-8");
        await fs.promises.writeFile(path.join(folder, "series.json"), JSON.stringify(series, null, 2), "utf-8");
        await fs.promises.writeFile(path.join(folder, "anime.json"), JSON.stringify(anime, null, 2), "utf-8");
        return {
          ok: true as const,
          folder,
          counts: { movies: movies.length, series: series.length, anime: anime.length },
        };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // Library ------------------------------------------------------------------
  ipcMain.handle(
    IPC.LibraryAdd,
    async (_e, args: AddLibraryItemInput) => addLibraryItem(args),
  );

  ipcMain.handle(
    IPC.LibraryRemove,
    async (_e, args: { profileId: number; type: string; mediaId: string }) =>
      removeLibraryItem(args.profileId, args.type, args.mediaId),
  );

  ipcMain.handle(
    IPC.LibraryGet,
    async (_e, args: { profileId: number; type: string; mediaId: string }) =>
      getLibraryItem(args.profileId, args.type, args.mediaId),
  );

  ipcMain.handle(
    IPC.LibraryList,
    async (_e, args: { profileId: number }) => listLibrary(args.profileId),
  );

  // Series episode cache (drives Continue Watching "next episode") -----------
  ipcMain.handle(
    IPC.SeriesCacheEpisodes,
    async (
      _e,
      args: { seriesId: string; episodes: SeriesEpisodeInput[] },
    ) => {
      cacheSeriesEpisodes(args.seriesId, args.episodes);
      return { ok: true as const };
    },
  );

  ipcMain.handle(
    IPC.SeriesLibraryStatus,
    async (_e, args: { profileId: number; mediaId: string }) =>
      getSeriesLibraryStatus(args.profileId, args.mediaId),
  );

  // Returns the next normal (season !== 0) episode after currentVideoId in
  // canonical position order. Used by the embedded player Next Episode pipeline.
  ipcMain.handle(
    IPC.SeriesGetNextEpisode,
    async (_e, args: { seriesId: string; currentVideoId: string }) =>
      getNextEpisodeAfter(args.seriesId, args.currentVideoId),
  );

  // Open a URL in the user's default browser. Only http/https — refuse
  // anything else so a malicious manifest can't trigger arbitrary shell URIs.
  ipcMain.handle(
    IPC.SystemOpenExternal,
    async (_e, args: { url: string }) => {
      try {
        const u = new URL(args.url);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          throw new Error(`Refusing to open non-http(s) URL: ${u.protocol}`);
        }
        await shell.openExternal(u.toString());
        return { ok: true as const };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: msg };
      }
    },
  );

  // App info (for About/Debug page) ----------------------------------------
  ipcMain.handle(IPC.AppGetInfo, async () => {
    const userData = app.getPath("userData");
    const dbPath = path.join(userData, "media-center.db");
    const nativeAddonDir = path.join(app.getAppPath(), "native", "embedded-mpv");
    const libmpvPath = path.join(nativeAddonDir, "vendor", "libmpv-2.dll");
    const libEglPath = path.join(nativeAddonDir, "vendor", "libEGL.dll");
    const libGlesPath = path.join(nativeAddonDir, "vendor", "libGLESv2.dll");
    const { mpvPath: mpvPathSetting } = await getAppSettings();
    return {
      appVersion: app.getVersion(),
      userDataPath: userData,
      dbPath,
      nativeAddonDir,
      libmpvPath,
      libEglPath,
      libGlesPath,
      mpvPath: mpvPathSetting,
      isDev,
    };
  });

  // Open a local folder in the OS file manager (safe: only local paths) -----
  ipcMain.handle(IPC.SystemGetFullscreen, (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    return w?.isFullScreen() ?? false;
  });

  ipcMain.handle(IPC.SystemSetFullscreen, (event, value: boolean) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return;
    w.setFullScreen(value);
  });

  ipcMain.handle(IPC.SystemOpenFolder, async (_e, args: { folderPath: string }) => {
    try {
      // shell.openPath opens folders in the system file manager on all platforms.
      const errMsg = await shell.openPath(args.folderPath);
      if (errMsg) return { ok: false as const, error: errMsg };
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Source preference memory (Phase 3) -------------------------------------
  ipcMain.handle(IPC.SourcePrefSave, (_e, args: SourcePref) => {
    try {
      saveSourcePref(args);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(
    IPC.SourcePrefGet,
    (_e, args: { profileId: number; type: string; mediaId: string; playableId: string }) => {
      try {
        return getSourcePref(args.profileId, args.type, args.mediaId, args.playableId);
      } catch {
        return null;
      }
    },
  );

  // Background image picker -- copies to userData/backgrounds/, returns absolute path
  ipcMain.handle(IPC.BgChooseImage, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return { ok: false as const, error: "No window" };
    const bgDir = path.join(app.getPath("userData"), "backgrounds");
    const result = await dialog.showOpenDialog(win, {
      title: "Choose background image",
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }],
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const srcPath = result.filePaths[0];
    const ext = path.extname(srcPath).toLowerCase();
    const allowed = [".jpg", ".jpeg", ".png", ".webp"];
    if (!allowed.includes(ext)) {
      return { ok: false as const, error: "Unsupported file type. Use jpg, png, or webp." };
    }
    await fs.promises.mkdir(bgDir, { recursive: true });
    const destPath = path.join(bgDir, `custom-background${ext}`);
    // Remove any old custom background files with different extensions
    for (const oldExt of allowed) {
      const oldPath = path.join(bgDir, `custom-background${oldExt}`);
      if (oldPath !== destPath) {
        try { await fs.promises.unlink(oldPath); } catch {}
      }
    }
    await fs.promises.copyFile(srcPath, destPath);
    return { ok: true as const, path: destPath };
  });

  ipcMain.handle(IPC.BgRemoveImage, async (_e, args: { imagePath: string }) => {
    if (!args?.imagePath) return { ok: true as const };
    try {
      await fs.promises.unlink(args.imagePath);
    } catch {
      // File already deleted or never existed -- fine
    }
    return { ok: true as const };
  });

  // App settings (global, not per-profile) ----------------------------------
  ipcMain.handle(IPC.SettingsGet, async () => getAppSettings());
  ipcMain.handle(
    IPC.SettingsUpdate,
    async (_e, args: Partial<AppSettings>) => updateAppSettings(args),
  );

  // MPV ---------------------------------------------------------------------
  ipcMain.handle(
    IPC.MpvOpen,
    async (_e, payload: MpvPayload) => openInMpv(payload),
  );
  ipcMain.handle(IPC.MpvCheckAvailable, async () => checkMpvAvailable());
  ipcMain.handle(
    IPC.MpvControl,
    async (_e, action: MpvControlAction) => mpvControl(action),
  );
  ipcMain.handle(IPC.MpvGetState, async () => mpvGetState());

  // Experimental embedded libmpv canvas player (gated; never the default).
  // All handlers degrade gracefully when the native addon is missing/fails.
  ipcMain.handle(
    IPC.EmbeddedStart,
    async (_e, args: { url: string; startTimeSecs?: number }) =>
      embeddedStart(args?.url, args?.startTimeSecs),
  );
  // E5 fix: fullscreen via BrowserWindow IPC (DOM requestFullscreen unreliable
  // in Electron).  Uses getAllWindows()[0] because registerIpcHandlers() runs
  // before createWindow() returns.
  ipcMain.handle(
    IPC.EmbeddedSetFullscreen,
    async (_e, fullscreen: boolean) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return false;
      win.setFullScreen(fullscreen);
      return fullscreen;
    },
  );
  ipcMain.handle(IPC.EmbeddedStop, async () => embeddedStop());
  ipcMain.handle(
    IPC.EmbeddedGetFrame,
    async (_e, args: { sinceIndex: number }) =>
      embeddedGetFrame(args?.sinceIndex ?? 0),
  );
  // E4: fire-and-forget control command (pause/seek/volume/sid/aid)
  ipcMain.handle(
    IPC.EmbeddedCommand,
    async (_e, args: { type: string; value: number }) =>
      embeddedSendCommand(args?.type ?? "", args?.value ?? 0),
  );
  // E4: read playback state (time-pos, duration, paused, volume, track-list JSON)
  ipcMain.handle(IPC.EmbeddedGetState, async () => embeddedGetState());

  // Profile-scoped embedded player volume (profile-specific key-value).
  ipcMain.handle(IPC.EmbeddedGetVolume, async (_e, args: { profileId: number }) => {
    const raw = getSetting(`embeddedVol:${args.profileId}`);
    if (raw === null) return null;
    const n = Number(raw);
    return isNaN(n) ? null : Math.min(130, Math.max(0, n));
  });
  ipcMain.handle(IPC.EmbeddedSetVolume, async (_e, args: { profileId: number; volume: number }) => {
    const vol = Math.min(130, Math.max(0, args.volume));
    setSetting(`embeddedVol:${args.profileId}`, String(vol));
  });

  // Dev-only: insert a synthetic addon whose endpoints will fail to fetch,
  // to verify graceful per-row/per-page failure handling end-to-end. Gated to
  // development builds in main.ts (we only register it when NODE_ENV is dev).
  if (isDev) {
    ipcMain.handle(
      IPC.AddonInstallFake,
      async (_e, args: { profileId: number }) => {
        const fakeManifest: StremioManifest = {
          id: "org.dev.fake-broken",
          name: "Fake Broken Addon (dev)",
          version: "0.0.0",
          description:
            "Test fixture: this addon is intentionally unreachable. Its catalog and meta requests will fail so you can verify the graceful-failure UI.",
          // RFC 2606 reserves `.invalid` for guaranteed-failure DNS, so the
          // catalog/meta requests below will fail reliably without depending
          // on the network.
          resources: ["catalog", "meta"],
          types: ["movie"],
          catalogs: [
            {
              type: "movie",
              id: "fake-top",
              name: "Fake Top (will fail)",
            },
          ],
        };
        return upsertAddon({
          profileId: args.profileId,
          manifestUrl: "https://stremio-dev-fake-broken.invalid/manifest.json",
          baseUrl: "https://stremio-dev-fake-broken.invalid/",
          manifest: fakeManifest,
        });
      },
    );
  }
}

// Register kino-local:// as a privileged scheme BEFORE the app is ready.
// This lets the renderer load local files (e.g. background images) from
// userData/backgrounds/ without file:// CORS restrictions in dev or prod.
protocol.registerSchemesAsPrivileged([
  { scheme: "kino-local", privileges: { secure: true, standard: true, bypassCSP: true } },
]);

app.whenReady().then(() => {
  // Pin userData to the legacy "Media Center" folder for backward compatibility.
  // productName is now "Kino", which would otherwise move data to AppData/Roaming/Kino.
  // Do NOT remove this: it keeps existing profiles, addons, and progress accessible.
  app.setPath("userData", path.join(app.getPath("appData"), "Media Center"));

  // Remove the default Electron application menu (File/Edit/View/Window/Help).
  // Custom app navigation lives in the React sidebar — the native menu bar
  // is redundant and looks jarring in a media center UI.
  Menu.setApplicationMenu(null);

  initDb();
  registerIpcHandlers();
  createWindow();

  // Serve userData/backgrounds/ files via kino-local://bg/<filename>.
  // This avoids file:// CORS restrictions when the renderer is at http://localhost.
  protocol.handle("kino-local", async (req) => {
    try {
      const url = new URL(req.url);
      if (url.hostname !== "bg") return new Response("Not Found", { status: 404 });
      const filename = decodeURIComponent(url.pathname.replace(/^\//, ""));
      if (!filename || filename.includes("..") || /[\/\\]/.test(filename)) {
        return new Response("Forbidden", { status: 403 });
      }
      const allowed = [".jpg", ".jpeg", ".png", ".webp"];
      const ext = path.extname(filename).toLowerCase();
      if (!allowed.includes(ext)) return new Response("Forbidden", { status: 403 });
      const filePath = path.join(app.getPath("userData"), "backgrounds", filename);
      const fileData = await fs.promises.readFile(filePath);
      const mime = ext === ".png" ? "image/png"
               : ext === ".webp" ? "image/webp"
               : "image/jpeg";
      return new Response(fileData, { headers: { "Content-Type": mime } });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Best-effort stop of the experimental embedded session on shutdown.
app.on("will-quit", () => {
  embeddedShutdown();
});
