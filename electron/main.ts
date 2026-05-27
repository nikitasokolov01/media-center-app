// Electron main process: window lifecycle + IPC handlers wiring the core
// Stremio module and the SQLite layer.

import { app, BrowserWindow, ipcMain, shell } from "electron";
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
  resetWatchProgress,
  setWatched,
  listWatchedForMedia,
  cacheSeriesEpisodes,
  getSeriesLibraryStatus,
  addLibraryItem,
  removeLibraryItem,
  getLibraryItem,
  listLibrary,
  getAppSettings,
  updateAppSettings,
} from "./db.js";
import type {
  SetWatchedInput,
  AddLibraryItemInput,
  SeriesEpisodeInput,
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
    title: "Media Center",
    backgroundColor: "#0f1115",
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
  ipcMain.handle(IPC.EmbeddedStart, async (_e, args: { url: string }) =>
    embeddedStart(args?.url),
  );
  ipcMain.handle(IPC.EmbeddedStop, async () => embeddedStop());
  ipcMain.handle(
    IPC.EmbeddedGetFrame,
    async (_e, args: { sinceIndex: number }) =>
      embeddedGetFrame(args?.sinceIndex ?? 0),
  );

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

app.whenReady().then(() => {
  initDb();
  registerIpcHandlers();
  createWindow();

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
