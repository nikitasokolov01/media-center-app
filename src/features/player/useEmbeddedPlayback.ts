// Custom hook owning the full libmpv canvas player lifecycle (E3 → E4 → E5).
//
// Owns: IPC start/stop, RAF draw loop, frame counters, stats state,
//       playback state polling (E4), control dispatch helpers (E4),
//       and watch-progress persistence (E5).
//
// StrictMode safety via cancelledRef:
//   - cancelledRef.current is set false at the top of startPlayback
//   - stopPlayback sets it to true synchronously
//   - startPlayback checks it after every await; stale first-pass bails out
//
// Progress tracking (E5):
//   - startPlayback accepts an optional EmbeddedProgressContext carrying the
//     profileId and media metadata needed to persist progress.
//   - Progress is flushed via window.mediaCenter.progress.upsert() every 5 s
//     while running, and once more immediately on stop.
//   - completed = timePos ≥ 90% of duration  OR  remaining ≤ 15 min.
//
// Consumers:
//   - EmbeddedPlayerOverlay (app-level overlay, receives req from store)
//   - ExperimentalEmbeddedPlayerPage (standalone test page, calls start directly)

import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbeddedPlaybackState, MpvTrack } from "../../types/embedded-mpv.js";

// ---- Dev flag ----------------------------------------------------------------

const isDev =
  typeof process !== "undefined" && process.env.NODE_ENV !== "production";

// ---- Error helpers -----------------------------------------------------------

/** Convert raw native-addon / IPC errors into user-readable messages. */
function friendlyError(e: unknown): string {
  const raw =
    typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  if (/libmpv/i.test(raw))
    return "libmpv not found. Place libmpv-2.dll in the vendor/ folder next to the app.";
  if (/libEGL|libGLES|ANGLE/i.test(raw))
    return "ANGLE DLLs not found. Place libEGL.dll and libGLESv2.dll in vendor/.";
  if (/Cannot find module|nativeAddon|embedded.?mpv/i.test(raw))
    return "Embedded player addon not built. Run: cd native/embedded-mpv && npm run build";
  return raw;
}


// ---- Progress constants (match mpvIpc.ts) ------------------------------------

const PROGRESS_POLL_MS = 5_000;
const COMPLETED_THRESHOLD = 0.9;        // 90%
const COMPLETED_REMAINING_SECS = 900;   // 15 minutes

// ---- Interfaces --------------------------------------------------------------

export interface EmbeddedPlaybackStats {
  fps: number;
  avgGetMs: number;
  drawn: number;
  skipped: number;
}

/**
 * Media context required to persist watch progress. Passed into startPlayback
 * by the overlay; optional so the standalone test page can omit it.
 */
export interface EmbeddedProgressContext {
  profileId: number;
  type: "movie" | "series";
  mediaId: string;
  playableId: string;
  mediaTitle: string;
  episodeTitle?: string | null;
  season?: number | null;
  episode?: number | null;
  poster?: string | null;
  streamTitle?: string | null;
  /** E5 fix: resume position in seconds. Libmpv seeks here on MPV_EVENT_FILE_LOADED. */
  startSeconds?: number;
}

export interface UseEmbeddedPlaybackReturn {
  // Canvas
  canvasRef: React.RefObject<HTMLCanvasElement>;
  // Frame loop state
  running: boolean;
  starting: boolean;
  error: string | null;
  stats: EmbeddedPlaybackStats;
  available: boolean;
  // Lifecycle
  startPlayback: (url: string, context?: EmbeddedProgressContext) => Promise<void>;
  stopPlayback: () => void;
  // E4: Playback state (polled every 250ms while running)
  playbackState: EmbeddedPlaybackState | null;
  audioTracks: MpvTrack[];
  subtitleTracks: MpvTrack[];
  // E4: Controls (fire-and-forget; safe to call when not running)
  setPause: (paused: boolean) => void;
  togglePause: () => void;
  seekTo: (seconds: number) => void;
  seekRelative: (deltaSecs: number) => void;
  setVolume: (volume: number) => void;
  setSubtitleTrack: (id: number) => void;  // -1 to disable
  setAudioTrack: (id: number) => void;
}

const EMPTY_STATS: EmbeddedPlaybackStats = {
  fps: 0,
  avgGetMs: 0,
  drawn: 0,
  skipped: 0,
};

function parseTracks(json: string): MpvTrack[] {
  try {
    const raw = JSON.parse(json) as unknown[];
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (t): t is MpvTrack =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as Record<string, unknown>).id === "number" &&
        typeof (t as Record<string, unknown>).type === "string",
    );
  } catch {
    return [];
  }
}

export function useEmbeddedPlayback(): UseEmbeddedPlaybackReturn {
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<EmbeddedPlaybackStats>(EMPTY_STATS);
  const [playbackState, setPlaybackState] =
    useState<EmbeddedPlaybackState | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const cancelledRef = useRef(false);
  const lastIndexRef = useRef(0);

  // E5: progress tracking refs (no re-render on change)
  const progressContextRef = useRef<EmbeddedProgressContext | null>(null);
  const lastKnownProgressRef = useRef<{ timePos: number; duration: number } | null>(null);

  const counters = useRef({
    drawn: 0,
    skipped: 0,
    getMsSum: 0,
    getCalls: 0,
    windowStart: 0,
    windowDrawn: 0,
  });

  const available =
    typeof window !== "undefined" && !!window.embeddedMpv;

  // ---- E5: Progress persistence --------------------------------------------
  //
  // flushProgress reads from refs — no React deps — safe to call from any
  // async or synchronous context, including stopPlayback.

  const flushProgress = useCallback(() => {
    const ctx = progressContextRef.current;
    const pos = lastKnownProgressRef.current;
    if (!ctx || !pos || pos.duration <= 0 || pos.timePos < 0) return;

    const completed =
      pos.timePos >= pos.duration * COMPLETED_THRESHOLD ||
      pos.duration - pos.timePos <= COMPLETED_REMAINING_SECS;

    void window.mediaCenter?.progress
      .upsert({
        profileId: ctx.profileId,
        type: ctx.type,
        mediaId: ctx.mediaId,
        playableId: ctx.playableId,
        title: ctx.mediaTitle,
        episodeTitle: ctx.episodeTitle ?? null,
        poster: ctx.poster ?? null,
        streamTitle: ctx.streamTitle ?? null,
        season: ctx.season ?? null,
        episode: ctx.episode ?? null,
        progressSeconds: pos.timePos,
        durationSeconds: pos.duration,
        completed,
      })
      .catch(() => {
        // DB write failures are non-fatal — playback isn't affected.
      });
  }, []); // pure ref reads — no deps needed

  // E5: Mirror playbackState into lastKnownProgressRef so flushProgress can
  //     always see the latest position even before state settles.
  useEffect(() => {
    if (
      playbackState &&
      typeof playbackState.timePos === "number" &&
      playbackState.timePos >= 0 &&
      typeof playbackState.duration === "number" &&
      playbackState.duration > 0
    ) {
      lastKnownProgressRef.current = {
        timePos: playbackState.timePos,
        duration: playbackState.duration,
      };
    }
  }, [playbackState]);

  // E5: 5-second progress save timer while running.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(flushProgress, PROGRESS_POLL_MS);
    return () => clearInterval(id);
  }, [running, flushProgress]);

  // ---- Flush progress on app quit (beforeunload) --------------------------

  useEffect(() => {
    window.addEventListener("beforeunload", flushProgress);
    return () => window.removeEventListener("beforeunload", flushProgress);
  }, [flushProgress]);

  // ---- Frame drawing -------------------------------------------------------

  const drawFrame = useCallback(
    (width: number, height: number, rgba: Uint8Array) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const expected = width * height * 4;
      if (rgba.length < expected) return;
      const clamped = new Uint8ClampedArray(expected);
      clamped.set(rgba.subarray(0, expected));
      ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
    },
    [],
  );

  // ---- RAF loop ------------------------------------------------------------

  const loop = useCallback(async () => {
    if (!runningRef.current) return;
    const api = window.embeddedMpv;
    if (!api) return;

    const t0 = performance.now();
    let frame: Awaited<ReturnType<NonNullable<Window["embeddedMpv"]>["getFrame"]>>;
    try {
      frame = await api.getFrame(lastIndexRef.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      runningRef.current = false;
      setRunning(false);
      return;
    }

    if (!runningRef.current) return;

    const getMs = performance.now() - t0;
    const c = counters.current;
    c.getMsSum += getMs;
    c.getCalls += 1;

    if (frame.error) {
      setError(frame.error);
      runningRef.current = false;
      setRunning(false);
      return;
    }

    if (!frame.noNewFrame && frame.rgba) {
      drawFrame(frame.width, frame.height, frame.rgba as Uint8Array);
      lastIndexRef.current = frame.frameIndex;
      c.drawn += 1;
      c.windowDrawn += 1;
    } else {
      c.skipped += 1;
    }

    const now = performance.now();
    if (c.windowStart === 0) c.windowStart = now;
    const elapsed = now - c.windowStart;
    if (elapsed >= 250) {
      setStats({
        fps: (c.windowDrawn * 1000) / elapsed,
        avgGetMs: c.getCalls > 0 ? c.getMsSum / c.getCalls : 0,
        drawn: c.drawn,
        skipped: c.skipped,
      });
      c.windowStart = now;
      c.windowDrawn = 0;
      c.getMsSum = 0;
      c.getCalls = 0;
    }

    rafRef.current = requestAnimationFrame(() => void loop());
  }, [drawFrame]);

  // ---- Loop control --------------------------------------------------------

  const stopLoop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback(() => {
    // E5: flush progress before tearing down (synchronous — reads refs).
    flushProgress();

    cancelledRef.current = true;
    stopLoop();
    setStarting(false);
    setPlaybackState(null);

    // Clear progress refs so a stale flush can't fire after the session ends.
    progressContextRef.current = null;
    lastKnownProgressRef.current = null;

    const api = window.embeddedMpv;
    if (api) void api.stop().catch(() => {});
    if (isDev) {
      console.log("[embedded:stop] native session stopped");
    }
  }, [stopLoop, flushProgress]);

  const startPlayback = useCallback(
    async (url: string, context?: EmbeddedProgressContext) => {
      if (!url) return;
      const api = window.embeddedMpv;
      if (!api) {
        setError("Embedded player bridge unavailable (window.embeddedMpv missing).");
        return;
      }

      cancelledRef.current = false;

      // E5: store progress context for this session; reset last known position.
      progressContextRef.current = context ?? null;
      lastKnownProgressRef.current = null;

      stopLoop();
      lastIndexRef.current = 0;
      counters.current = {
        drawn: 0, skipped: 0,
        getMsSum: 0, getCalls: 0,
        windowStart: 0, windowDrawn: 0,
      };
      setError(null);
      setStats(EMPTY_STATS);
      setPlaybackState(null);
      setStarting(true);

      if (isDev) {
        console.log("[embedded:start] calling api.start()", url.slice(0, 80));
      }

      // E5 fix: pass startSeconds so libmpv can seek on MPV_EVENT_FILE_LOADED.
      if (isDev && context?.startSeconds) {
        console.log("[embedded:resume] seeking to", context.startSeconds, "s on file load");
      }
      let res: { ok: boolean; error?: string };
      try {
        // Race against a 30-second timeout so the UI never stays stuck in
        // "Starting…" if the native addon hangs during init.
        const startPromise = api.start(url, context?.startSeconds);
        const timeoutPromise = new Promise<{ ok: false; error: string }>(
          (resolve) =>
            setTimeout(
              () =>
                resolve({
                  ok: false,
                  error:
                    "Embedded player start timed out after 30 s. Check that libmpv-2.dll is present.",
                }),
              30_000,
            ),
        );
        res = await Promise.race([startPromise, timeoutPromise]);
      } catch (e) {
        if (cancelledRef.current) return;
        setStarting(false);
        setError(friendlyError(e));
        return;
      }

      if (cancelledRef.current) {
        if (isDev) {
          console.log("[embedded:start] cancelled after api.start() — ignoring stale invocation");
        }
        return;
      }

      setStarting(false);

      if (!res.ok) {
        setError(friendlyError(res.error ?? "Native addon failed to start."));
        return;
      }

      if (isDev) {
        console.log("[embedded:start] native session started — beginning RAF loop");
      }

      runningRef.current = true;
      setRunning(true);
      rafRef.current = requestAnimationFrame(() => void loop());
    },
    [loop, stopLoop],
  );

  // ---- E4: Playback state polling ------------------------------------------
  // Poll getState() every 250ms while running. Stops automatically when the
  // RAF loop stops.

  useEffect(() => {
    if (!running) return;
    const api = window.embeddedMpv;
    if (!api) return;

    const poll = async () => {
      try {
        const s = await api.getState();
        setPlaybackState(s);
      } catch {
        // ignore — state read failures are non-fatal
      }
    };

    void poll(); // immediate first read
    const id = setInterval(() => void poll(), 250);
    return () => clearInterval(id);
  }, [running]);

  // ---- E4: Derived track lists ---------------------------------------------

  const allTracks = parseTracks(playbackState?.trackListJson ?? "[]");
  const audioTracks = allTracks.filter((t) => t.type === "audio");
  const subtitleTracks = allTracks.filter((t) => t.type === "sub");

  // ---- E4: Control helpers -------------------------------------------------

  const sendCmd = useCallback((type: string, value: number) => {
    const api = window.embeddedMpv;
    if (!api) return;
    void api.command(type, value).catch(() => {});
  }, []);

  const setPause = useCallback(
    (paused: boolean) => sendCmd("pause", paused ? 1 : 0),
    [sendCmd],
  );

  const togglePause = useCallback(() => {
    const paused = playbackState?.paused ?? false;
    setPause(!paused);
    // Optimistically flip local state immediately for snappy UI
    setPlaybackState((prev) =>
      prev ? { ...prev, paused: !paused } : prev,
    );
  }, [playbackState?.paused, setPause]);

  const seekTo = useCallback(
    (seconds: number) => sendCmd("seek", Math.max(0, seconds)),
    [sendCmd],
  );

  const seekRelative = useCallback(
    (deltaSecs: number) => {
      const current = playbackState?.timePos ?? 0;
      seekTo(Math.max(0, current + deltaSecs));
    },
    [playbackState?.timePos, seekTo],
  );

  const setVolume = useCallback(
    (volume: number) => sendCmd("volume", Math.min(130, Math.max(0, volume))),
    [sendCmd],
  );

  const setSubtitleTrack = useCallback(
    (id: number) => sendCmd("sid", id),
    [sendCmd],
  );

  const setAudioTrack = useCallback(
    (id: number) => sendCmd("aid", id),
    [sendCmd],
  );

  return {
    canvasRef,
    running,
    starting,
    error,
    stats,
    available,
    startPlayback,
    stopPlayback,
    playbackState,
    audioTracks,
    subtitleTracks,
    setPause,
    togglePause,
    seekTo,
    seekRelative,
    setVolume,
    setSubtitleTrack,
    setAudioTrack,
  };
}
