// Central list of IPC channel names so main and preload stay in sync.

export const IPC = {
  ProfileGetDefault: "profile:get-default",
  ProfileList: "profile:list",
  ProfileCreate: "profile:create",
  ProfileUpdate: "profile:update",
  ProfileDelete: "profile:delete",
  AddonList: "addon:list",
  AddonGet: "addon:get",
  AddonInstall: "addon:install",
  AddonInstallFake: "addon:install-fake",
  AddonRemove: "addon:remove",
  CatalogFetch: "catalog:fetch",
  MetaFetch: "meta:fetch",
  StreamFetch: "stream:fetch",
  SubtitlesFetch: "subtitles:fetch",
  ProgressUpsert: "progress:upsert",
  ProgressGet: "progress:get",
  ProgressList: "progress:list",
  ProgressClear: "progress:clear",
  ProgressReset: "progress:reset",
  WatchedSet: "watched:set",
  WatchedListForMedia: "watched:list-for-media",
  LibraryAdd: "library:add",
  LibraryRemove: "library:remove",
  LibraryGet: "library:get",
  LibraryList: "library:list",
  SeriesCacheEpisodes: "series:cache-episodes",
  SeriesLibraryStatus: "series:library-status",
  SeriesGetNextEpisode: "series:get-next-episode",
  SystemOpenExternal: "system:open-external",
  SettingsGet: "settings:get",
  SettingsUpdate: "settings:update",
  MpvOpen: "mpv:open",
  MpvCheckAvailable: "mpv:check-available",
  MpvControl: "mpv:control",
  MpvGetState: "mpv:get-state",
  // Experimental embedded libmpv canvas player (gated; not the default).
  EmbeddedStart: "embedded:start",
  EmbeddedStop: "embedded:stop",
  EmbeddedGetFrame: "embedded:get-frame",
  // E4 control API — fire-and-forget command + state read
  EmbeddedCommand: "embedded:command",
  EmbeddedGetState: "embedded:get-state",
  // E5 fixes — fullscreen via BrowserWindow IPC (DOM requestFullscreen unreliable in Electron)
  EmbeddedSetFullscreen: "embedded:set-fullscreen",     // renderer → main
  EmbeddedFullscreenChanged: "embedded:fullscreen-changed", // main → renderer (push)
  // Profile-scoped embedded player volume persistence
  EmbeddedGetVolume: "embedded:get-volume",
  EmbeddedSetVolume: "embedded:set-volume",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
