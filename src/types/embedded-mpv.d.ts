// Ambient typing for the EXPERIMENTAL embedded libmpv bridge exposed by
// electron/preload.ts (`window.embeddedMpv`). Kept in its own file so it does
// not touch the existing (hand-edited) electronAPI/mediaCenter declarations.

export {};

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
  /** Present only when a new frame is available (RGBA bytes, width*height*4). */
  rgba?: Uint8Array;
}

/** E4: playback state polled from the render thread's shared mutex. */
export interface EmbeddedPlaybackState {
  ok: boolean;
  error?: string;
  hasSession: boolean;
  paused: boolean;
  /** Current playback position in seconds. -1 if unknown. */
  timePos: number;
  /** Total duration in seconds. -1 if unknown/not yet determined. */
  duration: number;
  /** Volume 0–130 (mpv scale; 100 = unity). */
  volume: number;
  /** Raw JSON string of mpv's track-list property. Parse to get track info. */
  trackListJson: string;
}

/** A single entry from mpv's track-list JSON (subset of fields we use). */
export interface MpvTrack {
  id: number;
  type: "audio" | "video" | "sub";
  title?: string;
  lang?: string;
  selected: boolean;
  external?: boolean;
  /** Codec or format string from mpv. */
  codec?: string;
}

declare global {
  interface Window {
    embeddedMpv?: {
      /** E5 fix: startTimeSecs enables resume-from-progress. Libmpv seeks on FILE_LOADED. */
      start: (url: string, startTimeSecs?: number) => Promise<EmbeddedStartResult>;
      stop: () => Promise<EmbeddedStartResult>;
      getFrame: (sinceIndex: number) => Promise<EmbeddedFrame>;
      /**
       * E4: Send a fire-and-forget control command to the render thread.
       * type: "pause" | "seek" | "volume" | "sid" | "aid"
       * value: 1=pause/0=resume for "pause"; seconds for "seek";
       *        0-130 for "volume"; track id (-1 = off) for "sid"/"aid"
       */
      command: (type: string, value: number) => Promise<EmbeddedStartResult>;
      /** E4: Read latest playback state from the render thread's shared mutex. */
      getState: () => Promise<EmbeddedPlaybackState>;
      /**
       * E5 fix: Toggle BrowserWindow fullscreen. DOM requestFullscreen() is
       * unreliable in Electron — use win.setFullScreen() via IPC instead.
       */
      setFullscreen: (fullscreen: boolean) => Promise<boolean>;
      /**
       * E5 fix: Subscribe to fullscreen state changes pushed from main process.
       * Returns an unsubscribe function.
       */
      onFullscreenChange: (cb: (isFullscreen: boolean) => void) => () => void;
      /**
       * Profile-scoped embedded player volume persistence.
       * getVolume returns the last saved volume (0–130) or null if never saved.
       * setVolume persists the value to the app_settings table.
       */
      getVolume: (profileId: number) => Promise<number | null>;
      setVolume: (profileId: number, volume: number) => Promise<void>;
    };
  }
}
