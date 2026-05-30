// App-level embedded player overlay (E4 + E5 + E6 + E7 + E8).
//
// E8 additions (Next Episode pipeline):
//   - When playing a series episode the overlay queries series.getNextEpisode()
//     to find the next normal (non-special) episode.
//   - Sources for that episode are prefetched in the background via
//     sourcePrefetch.ts while the current episode is still playing.
//   - The best next-episode source is chosen via sourceAffinity.ts (same-pack
//     preference, falling back to quality ranking).
//   - When remaining time ≤ 180 s a "Next Episode" button appears.
//   - Clicking it flushes current progress (marks completed since remaining
//     ≤ 900 s satisfies the completed threshold), stops playback, and immediately
//     starts the next episode using the preselected source.
//   - The next-next episode is prefetched automatically after the transition.
//
// Safety: does not touch external MPV, profiles, library, DB schema, or debrid.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  clearEmbeddedPlayRequest,
  getEmbeddedPlayRequest,
  setEmbeddedPlayRequest,
  subscribeEmbeddedPlayRequest,
} from "../features/player/embeddedRequest.js";
import { useEmbeddedPlayback } from "../features/player/useEmbeddedPlayback.js";
import type { EmbeddedProgressContext } from "../features/player/useEmbeddedPlayback.js";
import { useProfile } from "../state/ProfileContext.js";
import { useSettings } from "../state/SettingsContext.js";
import {
  makePrefetchKey,
  getCachedSources,
  prefetchEpisodeSources,
} from "../core/player/sourcePrefetch.js";
import { chooseNextEpisodeSource } from "../core/player/sourceAffinity.js";
import type { PlayRequest } from "../core/player/types.js";
import type { MpvTrack } from "../types/embedded-mpv.js";
import type { SeriesNextEpisode } from "../types/preload.js";
import type { StreamSourceResult, StremioStream } from "../core/stremio/types.js";

// Dev flag — safe in both Vite (renderer) and plain Node.
const isDev =
  typeof process !== "undefined" && process.env.NODE_ENV !== "production";

// ---- Constants ---------------------------------------------------------------

const HIDE_DELAY_MS = 2500;
/** Show "Next Episode" button when this many seconds remain. */
const NEXT_EP_PROMPT_SECS = 180;

// ---- Utilities ---------------------------------------------------------------

function formatTime(seconds: number): string {
  if (seconds < 0 || !isFinite(seconds)) return "--:--";
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) {
    return `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function trackLabel(t: MpvTrack, fallbackIndex: number): string {
  const parts: string[] = [];
  if (t.lang) parts.push(t.lang.toUpperCase());
  if (t.title) parts.push(t.title);
  if (parts.length === 0) parts.push(`Track ${fallbackIndex + 1}`);
  return parts.join(" — ");
}

function nextEpLabel(ep: SeriesNextEpisode): string {
  const s = ep.season != null ? `S${String(ep.season).padStart(2, "0")}` : "";
  const e = ep.episode != null ? `E${String(ep.episode).padStart(2, "0")}` : "";
  const se = [s, e].filter(Boolean).join("");
  return se || "Next Episode";
}

// ---- Component ---------------------------------------------------------------

export default function EmbeddedPlayerOverlay() {
  const [req, setReq] = useState<PlayRequest | null>(
    () => getEmbeddedPlayRequest(),
  );

  const { profile } = useProfile();
  const { settings } = useSettings();

  const {
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
    togglePause,
    seekTo,
    seekRelative,
    setVolume,
    setSubtitleTrack,
    setAudioTrack,
  } = useEmbeddedPlayback();

  // ---- Fullscreen (E5 fix) -------------------------------------------------

  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenAvailable =
    typeof window !== "undefined" && !!window.embeddedMpv?.setFullscreen;

  // ---- Auto-hide controls (E6) --------------------------------------------

  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(true);
  const runningRef = useRef(false);
  const draggingRef = useRef(false);
  const isInteractingRef = useRef(false);

  // ---- Scrub bar state -----------------------------------------------------

  const [dragging, setDragging] = useState(false);
  const [dragValue, setDragValue] = useState(0);
  const prevVolumeRef = useRef(100);

  // ---- E8: Next Episode state ----------------------------------------------

  /** Next normal episode in canonical order (null if last or unknown). */
  const [nextEpisode, setNextEpisode] = useState<SeriesNextEpisode | null>(null);
  /** The preselected best source for the next episode (null while loading). */
  const [nextSource, setNextSource] = useState<StreamSourceResult | null>(null);
  /** True while the prefetch result is being evaluated. */
  const [nextSourceLoading, setNextSourceLoading] = useState(false);
  /** Show the Next Episode prompt (remaining ≤ NEXT_EP_PROMPT_SECS). */
  const [showNextEpPrompt, setShowNextEpPrompt] = useState(false);
  /** Transitioning to next episode — prevents double-click. */
  const [transitioning, setTransitioning] = useState(false);

  // ---- Store subscription --------------------------------------------------

  useEffect(() => {
    const unsub = subscribeEmbeddedPlayRequest((r) => setReq(r));
    return () => unsub();
  }, []);

  // ---- Playback lifecycle --------------------------------------------------

  const profileId = profile?.id ?? null;

  useEffect(() => {
    if (!req || profileId === null) return;
    let cancelled = false;

    const doStart = async () => {
      let startSeconds: number | undefined;
      try {
        const saved = await window.mediaCenter.progress.get({
          profileId,
          mediaId: req.mediaId,
          playableId: req.playableId,
        });
        if (saved && !saved.completed && saved.progressSeconds > 10) {
          startSeconds = saved.progressSeconds;
          if (isDev) {
            console.log(
              "[embedded:resume] found saved progress:",
              startSeconds,
              "s — will seek on file load",
            );
          }
        }
      } catch {
        // Progress lookup failure is non-fatal.
      }

      if (cancelled) return;

      const ctx: EmbeddedProgressContext = {
        profileId,
        type: req.type,
        mediaId: req.mediaId,
        playableId: req.playableId,
        mediaTitle: req.mediaTitle,
        episodeTitle: req.episodeTitle ?? null,
        season: req.season ?? null,
        episode: req.episode ?? null,
        poster: req.poster ?? null,
        streamTitle: req.streamTitle ?? null,
        startSeconds,
      };

      await startPlayback(req.streamUrl, ctx);
    };

    void doStart();
    return () => {
      cancelled = true;
      stopPlayback();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, profileId, startPlayback, stopPlayback]);

  // ---- E8: Resolve next episode + prefetch when req changes ---------------

  useEffect(() => {
    // Reset next-episode state whenever the current episode changes.
    setNextEpisode(null);
    setNextSource(null);
    setNextSourceLoading(false);
    setShowNextEpPrompt(false);

    if (!req || req.type !== "series" || profileId === null) return;
    let cancelled = false;

    const resolveAndPrefetch = async () => {
      // 1. Resolve the next normal episode from the DB cache.
      let next: SeriesNextEpisode | null = null;
      try {
        next = await window.mediaCenter.series.getNextEpisode({
          seriesId: req.mediaId,
          currentVideoId: req.playableId,
        });
      } catch {
        return; // Non-fatal — series may not be cached yet.
      }
      if (cancelled || !next) return;

      setNextEpisode(next);
      if (isDev) {
        console.log("[next-ep] resolved:", nextEpLabel(next), next.videoId);
      }

      // 2. Get addon list for prefetching.
      let addons;
      try {
        addons = await window.mediaCenter.addons.list(profileId);
      } catch {
        return;
      }
      if (cancelled) return;

      // 3. Fire-and-forget prefetch (non-blocking).
      prefetchEpisodeSources(addons, "series", req.mediaId, next.videoId, profileId);
      if (isDev) {
        console.log("[next-ep] prefetch triggered for", next.videoId);
      }

      // 4. Poll for the prefetch result (up to ~30s, checking every 2s).
      //    Once sources arrive, run affinity scoring to pick the best one.
      setNextSourceLoading(true);
      let attempts = 0;
      const MAX_ATTEMPTS = 15;
      const POLL_INTERVAL = 2000;

      const pollForSource = () => {
        if (cancelled) return;
        const cacheKey = makePrefetchKey(profileId, "series", req.mediaId, next!.videoId);
        const cached = getCachedSources(cacheKey);
        if (cached !== null) {
          // Sources arrived — pick the best using affinity scoring.
          const currentStream: StremioStream = {
            url: req.streamUrl,
            name: req.streamName,
            title: req.streamTitle,
          };
          const best = chooseNextEpisodeSource(
            currentStream,
            "", // addonId unknown from PlayRequest; affinity uses other signals
            cached,
            settings,
          );
          if (!cancelled) {
            setNextSource(best);
            setNextSourceLoading(false);
            if (isDev) {
              console.log(
                "[next-ep] source preselected:",
                best?.stream.name ?? "(none)",
                best?.stream.url?.slice(0, 60) ?? "",
              );
            }
          }
          return;
        }
        attempts++;
        if (attempts < MAX_ATTEMPTS) {
          setTimeout(pollForSource, POLL_INTERVAL);
        } else {
          if (!cancelled) setNextSourceLoading(false);
          if (isDev) {
            console.log("[next-ep] prefetch timed out — no source preselected");
          }
        }
      };
      setTimeout(pollForSource, POLL_INTERVAL);
    };

    void resolveAndPrefetch();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, profileId]);

  // ---- E8: Show/hide next episode prompt based on remaining time -----------

  useEffect(() => {
    if (!nextEpisode || !running) {
      setShowNextEpPrompt(false);
      return;
    }
    const timePos = playbackState?.timePos ?? -1;
    const duration = playbackState?.duration ?? -1;
    if (timePos < 0 || duration <= 0) return;
    const remaining = duration - timePos;
    const shouldShow = remaining > 0 && remaining <= NEXT_EP_PROMPT_SECS;
    setShowNextEpPrompt(shouldShow);
    if (isDev && shouldShow) {
      console.log(`[next-ep] prompt shown — ${remaining.toFixed(0)}s remaining`);
    }
  }, [playbackState?.timePos, playbackState?.duration, nextEpisode, running]);

  // ---- E8: Transition to next episode -------------------------------------

  const handleNextEpisode = useCallback(() => {
    if (!nextEpisode || !nextSource || transitioning || profileId === null || !req) return;
    setTransitioning(true);
    if (isDev) {
      console.log("[next-ep] clicked — transitioning to", nextEpLabel(nextEpisode));
    }
    // Build the new PlayRequest for the next episode.
    const nextReq: PlayRequest = {
      backend: "embedded-mpv-experimental",
      type: "series",
      mediaId: req.mediaId,
      playableId: nextEpisode.videoId,
      mediaTitle: req.mediaTitle,
      episodeTitle: nextEpisode.title ?? undefined,
      season: nextEpisode.season ?? undefined,
      episode: nextEpisode.episode ?? undefined,
      poster: req.poster,
      streamUrl: nextSource.stream.url ?? "",
      streamTitle: nextSource.stream.title,
      streamName: nextSource.stream.name,
    };
    // Dispatch to the store — the overlay's lifecycle effect will stop the
    // current session (including progress flush) and start the new one.
    setEmbeddedPlayRequest(nextReq);
    // transitioning is reset by the req-change effect resetting state.
  }, [nextEpisode, nextSource, transitioning, profileId, req]);

  // Reset transitioning flag when req changes (new episode started).
  useEffect(() => {
    setTransitioning(false);
  }, [req]);

  // ---- Fullscreen subscription --------------------------------------------

  useEffect(() => {
    const api = window.embeddedMpv;
    if (!api?.onFullscreenChange) return;
    return api.onFullscreenChange(setIsFullscreen);
  }, []);

  const toggleFullscreen = useCallback(() => {
    void window.embeddedMpv?.setFullscreen(!isFullscreen);
  }, [isFullscreen]);

  // ---- Auto-hide controls (E6) --------------------------------------------

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHideControls = useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = setTimeout(() => {
      if (pausedRef.current || draggingRef.current || isInteractingRef.current) return;
      if (!runningRef.current) return;
      setControlsVisible(false);
    }, HIDE_DELAY_MS);
  }, [clearHideTimer]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHideControls();
  }, [scheduleHideControls]);

  const pinControls = useCallback(() => {
    isInteractingRef.current = true;
    clearHideTimer();
    setControlsVisible(true);
  }, [clearHideTimer]);

  const unpinControls = useCallback(() => {
    isInteractingRef.current = false;
    scheduleHideControls();
  }, [scheduleHideControls]);

  const paused = playbackState?.paused ?? true;

  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { runningRef.current = running; }, [running]);

  useEffect(() => {
    if (running) showControls();
  }, [running, showControls]);

  useEffect(() => {
    if (paused) {
      clearHideTimer();
      setControlsVisible(true);
    } else if (running) {
      scheduleHideControls();
    }
  }, [paused, running, clearHideTimer, scheduleHideControls]);

  useEffect(() => {
    if (!req) {
      clearHideTimer();
      setControlsVisible(true);
    }
  }, [req, clearHideTimer]);

  useEffect(() => () => clearHideTimer(), [clearHideTimer]);

  const handleMouseActivity = useCallback(() => showControls(), [showControls]);

  // ---- Fix stuck scrub drag -----------------------------------------------
  // mouseup can fire outside the <input> if the user drags quickly. This
  // window-level handler catches those releases and commits the seek.

  useEffect(() => {
    if (!dragging) return;
    const onGlobalMouseUp = () => {
      if (!draggingRef.current) return;
      const val = dragValue;
      draggingRef.current = false;
      setDragging(false);
      seekTo(val);
      unpinControls();
    };
    window.addEventListener("mouseup", onGlobalMouseUp);
    return () => window.removeEventListener("mouseup", onGlobalMouseUp);
  }, [dragging, dragValue, seekTo, unpinControls]);

  // ---- Keyboard shortcuts --------------------------------------------------

  const handleClose = useCallback(() => clearEmbeddedPlayRequest(), []);

  useEffect(() => {
    if (!req) return;
    function onKey(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      showControls();
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          if (isFullscreen) {
            void window.embeddedMpv?.setFullscreen(false);
          } else {
            handleClose();
          }
          break;
        case " ":
          e.preventDefault();
          togglePause();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekRelative(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          seekRelative(5);
          break;
        case "m":
        case "M": {
          e.preventDefault();
          const vol = playbackState?.volume ?? 100;
          if (vol > 0) {
            prevVolumeRef.current = vol;
            setVolume(0);
          } else {
            setVolume(prevVolumeRef.current || 100);
          }
          break;
        }
        case "f":
        case "F":
          if (fullscreenAvailable) {
            e.preventDefault();
            toggleFullscreen();
          }
          break;
        case "n":
        case "N":
          if (showNextEpPrompt && nextSource && !transitioning) {
            e.preventDefault();
            handleNextEpisode();
          }
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    req, handleClose, togglePause, seekRelative, setVolume,
    playbackState?.volume, fullscreenAvailable, toggleFullscreen, isFullscreen,
    showControls, showNextEpPrompt, nextSource, transitioning, handleNextEpisode,
  ]);

  // ---- Track select handlers -----------------------------------------------

  const handleSubtitleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => setSubtitleTrack(Number(e.target.value)),
    [setSubtitleTrack],
  );
  const handleAudioChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => setAudioTrack(Number(e.target.value)),
    [setAudioTrack],
  );

  // ---- Progress bar --------------------------------------------------------

  const timePos = playbackState?.timePos ?? -1;
  const duration = playbackState?.duration ?? -1;
  const progressValue = dragging ? dragValue : (timePos >= 0 ? timePos : 0);
  const progressMax = duration > 0 ? duration : 100;

  const handleProgressMouseDown = (e: React.MouseEvent<HTMLInputElement>) => {
    draggingRef.current = true;
    setDragging(true);
    setDragValue(Number((e.target as HTMLInputElement).value));
    pinControls();
  };
  const handleProgressChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDragValue(Number(e.target.value));
  };
  const handleProgressMouseUp = (e: React.MouseEvent<HTMLInputElement>) => {
    const val = Number((e.target as HTMLInputElement).value);
    draggingRef.current = false;
    setDragging(false);
    seekTo(val);
    unpinControls();
  };

  // ---- Volume --------------------------------------------------------------

  const volume = playbackState?.volume ?? 100;
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setVolume(Number(e.target.value));
  };

  // ---- Derived display values ---------------------------------------------

  const selectedSid = subtitleTracks.find((t) => t.selected)?.id ?? -1;
  const selectedAid = audioTracks.find((t) => t.selected)?.id ?? -1;

  const title =
    req && req.mediaId !== "experimental"
      ? req.episodeTitle
        ? `${req.mediaTitle} — ${req.episodeTitle}`
        : req.mediaTitle
      : "(experimental URL)";

  const statusText = starting
    ? "Starting…"
    : !running && !error
      ? "Idle"
      : error
        ? "Error"
        : paused
          ? "Paused"
          : "Playing";

  // ---- Render --------------------------------------------------------------

  if (!req) return null;

  const rootClass = [
    "emb-overlay",
    isFullscreen ? "is-fullscreen" : "",
    !controlsVisible ? "controls-hidden" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Next episode prompt content.
  const nextEpButtonLabel = (() => {
    if (!nextEpisode) return null;
    if (nextSourceLoading) return "Preparing…";
    if (!nextSource) return null; // no playable source found
    const label = nextEpLabel(nextEpisode);
    const epTitle = nextEpisode.title;
    return epTitle ? `${label}: ${epTitle}` : label;
  })();

  return (
    <div
      className={rootClass}
      role="dialog"
      aria-label="Embedded player"
      onMouseMove={handleMouseActivity}
      onMouseEnter={handleMouseActivity}
    >
      <div className="emb-overlay__stage">
        {starting && (
          <div className="emb-overlay__loading muted small">
            Starting native session…
          </div>
        )}

        <canvas ref={canvasRef} className="emb-overlay__canvas" />

        {/* ── Header ── */}
        <div className="emb-overlay__header">
          <div className="emb-overlay__title-area">
            <span className="emb-overlay__title" title={title}>
              {title}
            </span>
            <span className="exp-badge">EXPERIMENTAL</span>
          </div>
          <span className="emb-overlay__status muted small">{statusText}</span>
          <button
            type="button"
            className="emb-overlay__close"
            onClick={handleClose}
            title="Close embedded player (Esc)"
            aria-label="Close embedded player"
            onMouseEnter={pinControls}
            onMouseLeave={unpinControls}
          >
            ✕
          </button>
        </div>

        {/* ── Error banners ── */}
        {(!available || error) && (
          <div className="emb-overlay__errors">
            {!available && (
              <div className="error-banner emb-overlay__banner" role="alert">
                Embedded player addon unavailable — <code>window.embeddedMpv</code> is
                missing. Make sure the native addon is built (
                <code>native/embedded-mpv/</code>) and all DLLs are present in{" "}
                <code>vendor/</code>.
              </div>
            )}
            {error && (
              <div className="error-banner emb-overlay__banner" role="alert">
                {error}
              </div>
            )}
          </div>
        )}

        {/* ── E8: Next Episode prompt (bottom-right, above controls) ── */}
        {showNextEpPrompt && nextEpButtonLabel && (
          <div
            className="emb-overlay__next-ep"
            onMouseEnter={pinControls}
            onMouseLeave={unpinControls}
          >
            <button
              type="button"
              className="emb-overlay__next-ep-btn"
              onClick={handleNextEpisode}
              disabled={!nextSource || transitioning}
              title={nextSource ? "Play next episode (N)" : "Preparing next episode…"}
            >
              {transitioning
                ? "Starting…"
                : nextSourceLoading
                  ? "Preparing next episode…"
                  : `Next ▶ ${nextEpButtonLabel}`}
            </button>
          </div>
        )}

        {/* ── Dev stats HUD ── */}
        <div className="emb-overlay__stats muted small">
          <span>{stats.fps.toFixed(1)} fps</span>
          <span>· {stats.avgGetMs.toFixed(1)} ms</span>
          <span>· {stats.drawn}d/{stats.skipped}s</span>
        </div>

        {/* ── Controls bar ── */}
        {(running || starting) && (
          <div
            className="emb-overlay__controls"
            onMouseEnter={pinControls}
            onMouseLeave={unpinControls}
            onFocus={pinControls}
            onBlur={unpinControls}
          >
            <button
              type="button"
              className="emb-overlay__ctrl emb-overlay__ctrl--icon"
              onClick={togglePause}
              title={paused ? "Play (Space)" : "Pause (Space)"}
              aria-label={paused ? "Play" : "Pause"}
              disabled={starting}
            >
              {paused ? "▶" : "⏸"}
            </button>

            <span className="emb-overlay__time">
              {formatTime(dragging ? dragValue : timePos)}
            </span>

            <input
              type="range"
              className="emb-overlay__progress"
              min={0}
              max={progressMax}
              step={0.5}
              value={progressValue}
              onMouseDown={handleProgressMouseDown}
              onChange={handleProgressChange}
              onMouseUp={handleProgressMouseUp}
              aria-label="Seek"
              title="Seek (Left/Right arrows)"
            />

            <span className="emb-overlay__time emb-overlay__time--dur">
              {formatTime(duration)}
            </span>

            <button
              type="button"
              className="emb-overlay__ctrl emb-overlay__ctrl--icon"
              onClick={() => {
                if (volume > 0) {
                  prevVolumeRef.current = volume;
                  setVolume(0);
                } else {
                  setVolume(prevVolumeRef.current || 100);
                }
              }}
              title="Mute/unmute (M)"
              aria-label={volume === 0 ? "Unmute" : "Mute"}
            >
              {volume === 0 ? "🔇" : volume < 50 ? "🔉" : "🔊"}
            </button>
            <input
              type="range"
              className="emb-overlay__volume"
              min={0}
              max={130}
              step={1}
              value={volume}
              onChange={handleVolumeChange}
              aria-label="Volume"
              title="Volume"
            />

            {subtitleTracks.length > 0 ? (
              <select
                className="emb-overlay__track-select"
                value={selectedSid}
                onChange={handleSubtitleChange}
                title="Subtitle track"
                aria-label="Subtitle track"
              >
                <option value={-1}>CC: Off</option>
                {subtitleTracks.map((t, i) => (
                  <option key={t.id} value={t.id}>
                    CC: {trackLabel(t, i)}
                  </option>
                ))}
              </select>
            ) : (
              <span
                className="emb-overlay__ctrl emb-overlay__ctrl--disabled muted small"
                title="No subtitle tracks loaded"
              >
                CC: —
              </span>
            )}

            {audioTracks.length > 1 ? (
              <select
                className="emb-overlay__track-select"
                value={selectedAid}
                onChange={handleAudioChange}
                title="Audio track"
                aria-label="Audio track"
              >
                {audioTracks.map((t, i) => (
                  <option key={t.id} value={t.id}>
                    🎵 {trackLabel(t, i)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="emb-overlay__ctrl emb-overlay__ctrl--disabled muted small">
                🎵 —
              </span>
            )}

            {fullscreenAvailable && (
              <button
                type="button"
                className="emb-overlay__ctrl emb-overlay__ctrl--icon"
                onClick={toggleFullscreen}
                title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen (F)"}
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              >
                {isFullscreen ? "⤡" : "⤢"}
              </button>
            )}

            <button
              type="button"
              className="emb-overlay__ctrl emb-overlay__ctrl--stop"
              onClick={handleClose}
              title="Stop and close (Esc)"
            >
              ⏹ Stop
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
