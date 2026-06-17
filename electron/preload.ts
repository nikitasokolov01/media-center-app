// Preload: exposes a small, typed API to the renderer via contextBridge.
// IPC errors propagate as rejected promises in the renderer.

import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "./ipc-channels.js";

const api = {
  profile: {
    getDefault: () => ipcRenderer.invoke(IPC.ProfileGetDefault),
    list: () => ipcRenderer.invoke(IPC.ProfileList),
    create: (args: { name: string; color?: string | null; emoji?: string | null }) =>
      ipcRenderer.invoke(IPC.ProfileCreate, args),
    update: (args: {
      id: number;
      name?: string;
      color?: string | null;
      emoji?: string | null;
    }) => ipcRenderer.invoke(IPC.ProfileUpdate, args),
    remove: (id: number) => ipcRenderer.invoke(IPC.ProfileDelete, { id }),
  },
  addons: {
    list: (profileId: number) => ipcRenderer.invoke(IPC.AddonList, profileId),
    get: (profileId: number, id: string) =>
      ipcRenderer.invoke(IPC.AddonGet, { profileId, id }),
    install: (profileId: number, url: string) =>
      ipcRenderer.invoke(IPC.AddonInstall, { profileId, url }),
    installFake: (profileId: number) =>
      ipcRenderer.invoke(IPC.AddonInstallFake, { profileId }),
    remove: (profileId: number, id: string) =>
      ipcRenderer.invoke(IPC.AddonRemove, { profileId, id }),
  },
  catalog: {
    fetch: (args: {
      manifestUrl: string;
      type: string;
      catalogId: string;
      extra?: Record<string, string | number | null | undefined>;
    }) => ipcRenderer.invoke(IPC.CatalogFetch, args),
  },
  meta: {
    fetch: (args: { manifestUrl: string; type: string; id: string }) =>
      ipcRenderer.invoke(IPC.MetaFetch, args),
  },
  streams: {
    fetch: (args: { manifestUrl: string; type: string; id: string }) =>
      ipcRenderer.invoke(IPC.StreamFetch, args),
  },
  subtitles: {
    fetch: (args: { manifestUrl: string; type: string; id: string }) =>
      ipcRenderer.invoke(IPC.SubtitlesFetch, args),
  },
  progress: {
    upsert: (args: {
      profileId: number;
      type: "movie" | "series";
      mediaId: string;
      playableId: string;
      title: string;
      episodeTitle?: string | null;
      poster?: string | null;
      streamTitle?: string | null;
      season?: number | null;
      episode?: number | null;
      progressSeconds: number;
      durationSeconds: number;
      completed?: boolean;
    }) => ipcRenderer.invoke(IPC.ProgressUpsert, args),
    get: (args: { profileId: number; mediaId: string; playableId: string }) =>
      ipcRenderer.invoke(IPC.ProgressGet, args),
    list: (args: { profileId: number; limit?: number }) =>
      ipcRenderer.invoke(IPC.ProgressList, args),
    clear: (args: { profileId: number; mediaId: string; playableId: string }) =>
      ipcRenderer.invoke(IPC.ProgressClear, args),
    reset: (args: { profileId: number; mediaId: string; playableId: string }) =>
      ipcRenderer.invoke(IPC.ProgressReset, args),
    revive: (args: { profileId: number; mediaId: string; playableId: string }) =>
      ipcRenderer.invoke(IPC.ProgressRevive, args),
    dismiss: (args: { profileId: number; mediaId: string }) =>
      ipcRenderer.invoke(IPC.ProgressDismiss, args),
  },
  watched: {
    set: (args: {
      profileId: number;
      type: "movie" | "series";
      mediaId: string;
      playableId: string;
      title: string;
      episodeTitle?: string | null;
      poster?: string | null;
      season?: number | null;
      episode?: number | null;
      completed: boolean;
    }) => ipcRenderer.invoke(IPC.WatchedSet, args),
    listForMedia: (args: { profileId: number; mediaId: string }) =>
      ipcRenderer.invoke(IPC.WatchedListForMedia, args),
  },
  library: {
    add: (args: {
      profileId: number;
      type: string;
      mediaId: string;
      title: string;
      poster?: string | null;
      background?: string | null;
      releaseInfo?: string | null;
    }) => ipcRenderer.invoke(IPC.LibraryAdd, args),
    remove: (args: { profileId: number; type: string; mediaId: string }) =>
      ipcRenderer.invoke(IPC.LibraryRemove, args),
    get: (args: { profileId: number; type: string; mediaId: string }) =>
      ipcRenderer.invoke(IPC.LibraryGet, args),
    list: (args: { profileId: number }) =>
      ipcRenderer.invoke(IPC.LibraryList, args),
  },
  series: {
    cacheEpisodes: (args: {
      seriesId: string;
      episodes: Array<{
        videoId: string;
        season?: number | null;
        episode?: number | null;
        title?: string | null;
      }>;
    }) => ipcRenderer.invoke(IPC.SeriesCacheEpisodes, args),
    libraryStatus: (args: { profileId: number; mediaId: string }) =>
      ipcRenderer.invoke(IPC.SeriesLibraryStatus, args),
    getNextEpisode: (args: { seriesId: string; currentVideoId: string }) =>
      ipcRenderer.invoke(IPC.SeriesGetNextEpisode, args),
  },
  system: {
    openExternal: (url: string) =>
      ipcRenderer.invoke(IPC.SystemOpenExternal, { url }),
    getFullscreen: (): Promise<boolean> => ipcRenderer.invoke(IPC.SystemGetFullscreen),
    setFullscreen: (value: boolean): Promise<void> => ipcRenderer.invoke(IPC.SystemSetFullscreen, value),
    openFolder: (folderPath: string) =>
      ipcRenderer.invoke(IPC.SystemOpenFolder, { folderPath }),
  },
  app: {
    getInfo: () => ipcRenderer.invoke(IPC.AppGetInfo),
  },
  sourcePref: {
    save: (args: {
      profileId: number; type: string; mediaId: string; playableId: string;
      addonId: string; quality: string; sourceName: string;
    }) => ipcRenderer.invoke(IPC.SourcePrefSave, args),
    get: (args: { profileId: number; type: string; mediaId: string; playableId: string }) =>
      ipcRenderer.invoke(IPC.SourcePrefGet, args),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.SettingsGet),
    update: (patch: {
      defaultPlayer?: "browser" | "mpv";
      mpvPath?: string;
      autoEnableSubtitles?: boolean;
      subtitleLanguage?: string;
      audioLanguage?: string;
      animeAudioLanguage?: string;
      autoSelectSource?: boolean;
      autoPlayBestSource?: boolean;
      preferredSourceQuality?: "best" | "2160p" | "1080p" | "720p" | "first";
      hideCamSources?: boolean;
      experimentalEmbeddedPlayer?: boolean;
    }) => ipcRenderer.invoke(IPC.SettingsUpdate, patch),
  },
  bg: {
    chooseImage: () => ipcRenderer.invoke(IPC.BgChooseImage),
    removeImage: (args: { imagePath: string }) => ipcRenderer.invoke(IPC.BgRemoveImage, args),
  },
};

// `window.electronAPI` is the namespace spec'd for the MPV bridge.
// Kept narrow on purpose: the only methods exposed here are the ones the
// stream cards and Settings page need to launch / verify MPV.
const electronAPI = {
  openInMpv: (payload: {
    type: "movie" | "series";
    mediaId: string;
    playableId: string;
    mediaTitle: string;
    episodeTitle?: string;
    season?: number;
    episode?: number;
    poster?: string;
    streamUrl: string;
    streamTitle?: string;
    streamName?: string;
    profileId?: number;
    startSeconds?: number;
    subtitleUrl?: string;
  }) => ipcRenderer.invoke(IPC.MpvOpen, payload),
  checkMpvAvailable: () => ipcRenderer.invoke(IPC.MpvCheckAvailable),
  // Track 1: control + live state for the active external-MPV session.
  mpvControl: (
    action:
      | { kind: "play-pause" }
      | { kind: "stop" }
      | { kind: "seek"; deltaSeconds: number }
      | { kind: "seek-absolute"; seconds: number }
      | { kind: "cycle-audio" }
      | { kind: "cycle-sub" }
      | { kind: "set-audio"; id: number }
      | { kind: "set-sub"; id: number | "off" },
  ) => ipcRenderer.invoke(IPC.MpvControl, action),
  mpvGetState: () => ipcRenderer.invoke(IPC.MpvGetState),
};

// EXPERIMENTAL embedded libmpv canvas player bridge (gated; not the default).
// Separate namespace so it's clearly opt-in and isolated from the normal API.
const embeddedMpv = {
  // E5 fix: startTimeSecs enables resume-from-progress; libmpv seeks on FILE_LOADED.
  start: (url: string, startTimeSecs?: number) =>
    ipcRenderer.invoke(IPC.EmbeddedStart, { url, startTimeSecs }),
  stop: () => ipcRenderer.invoke(IPC.EmbeddedStop),
  getFrame: (sinceIndex: number) =>
    ipcRenderer.invoke(IPC.EmbeddedGetFrame, { sinceIndex }),
  // E4: control API — fire-and-forget command + state read
  command: (type: string, value: number) =>
    ipcRenderer.invoke(IPC.EmbeddedCommand, { type, value }),
  getState: () => ipcRenderer.invoke(IPC.EmbeddedGetState),
  // E5 fix: BrowserWindow fullscreen (DOM requestFullscreen unreliable in Electron).
  setFullscreen: (fullscreen: boolean) =>
    ipcRenderer.invoke(IPC.EmbeddedSetFullscreen, fullscreen),
  // Profile-scoped volume persistence.
  getVolume: (profileId: number) =>
    ipcRenderer.invoke(IPC.EmbeddedGetVolume, { profileId }) as Promise<number | null>,
  setVolume: (profileId: number, volume: number) =>
    ipcRenderer.invoke(IPC.EmbeddedSetVolume, { profileId, volume }),
  // Subscribe to fullscreen state changes pushed from the main process.
  // Returns an unsubscribe function.
  onFullscreenChange: (cb: (isFullscreen: boolean) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, isFullscreen: boolean) =>
      cb(isFullscreen);
    ipcRenderer.on(IPC.EmbeddedFullscreenChanged, handler);
    return () => ipcRenderer.removeListener(IPC.EmbeddedFullscreenChanged, handler);
  },
};

contextBridge.exposeInMainWorld("mediaCenter", api);
contextBridge.exposeInMainWorld("electronAPI", electronAPI);
contextBridge.exposeInMainWorld("embeddedMpv", embeddedMpv);

export type MediaCenterApi = typeof api;
export type ElectronApi = typeof electronAPI;
export type EmbeddedMpvApi = typeof embeddedMpv;
