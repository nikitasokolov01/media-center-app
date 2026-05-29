// One stream rendered as a card. Click toggles a details panel with raw
// fields.
//
// Button layout depends on settings:
//
// experimentalEmbeddedPlayer OFF (default):
//   Primary:   ▶ Play with MPV  (or ▶ Play in App if browser is recommended)
//   Secondary: Play in App / Play with MPV  (when both are viable)
//
// experimentalEmbeddedPlayer ON:
//   Primary:   ▶ Play           (launches embedded overlay)
//   Secondary: Open in MPV      (external MPV fallback, always visible when viable)
//   The old "⬡ Play Embedded" button is gone — embedded IS the primary.

import { useEffect, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  detectCodec,
  detectHdr,
  detectQuality,
  detectSize,
  streamKind,
} from "../core/stremio/streams.js";
import { classifyStream } from "../features/player/playability.js";
import { setPendingPlayable } from "../features/player/store.js";
import {
  canBrowserPlay,
  recommendedBackend,
} from "../core/player/browserPlayer.js";
import {
  buildPlayRequest,
  dispatchPlayRequest,
} from "../features/player/playRequest.js";
import { resolveAudioLanguage } from "../core/player/audioPreference.js";
import { useSettings } from "../state/SettingsContext.js";
import { useProfile } from "../state/ProfileContext.js";
import type {
  StreamSourceResult,
  StremioStream,
} from "../core/stremio/types.js";
import type { AddonRow } from "../types/preload.js";

interface Props {
  result: StreamSourceResult;
  type: "movie" | "series";
  mediaId: string;
  playableId: string;
  mediaTitle: string;
  mediaPoster?: string;
  episodeTitle?: string;
  season?: number;
  episode?: number;
  /** Resume position to hand MPV as --start; 0/undefined starts from the top. */
  startSeconds?: number;
  /**
   * Installed addons used to auto-collect subtitle tracks at play time. We
   * filter to subtitle-capable ones inside collectSubtitles(). Subtitles are
   * NOT chosen before playback — every valid track is loaded into MPV and the
   * user selects one from the player controls afterward.
   */
  subtitleAddons?: AddonRow[];
  /** Whether this media was classified as anime (drives anime audio default). */
  isAnime?: boolean;
  /** True when the auto-selector chose this source — shows an "Auto-selected" badge. */
  autoSelected?: boolean;
  /** True when this source is the one currently playing — shows a "Playing" marker. */
  current?: boolean;
  /** Fired after this source successfully launches in MPV (used by the Sources dropdown). */
  onPlayed?: () => void;
}

function streamText(s: StremioStream): string {
  return `${s.name ?? ""}\n${s.title ?? ""}`;
}

function kindLabel(k: ReturnType<typeof streamKind>): string {
  switch (k) {
    case "http": return "HTTP";
    case "torrent": return "Torrent";
    case "youtube": return "YouTube";
    case "external": return "External";
    default: return "Unknown";
  }
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return String(n);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

interface FieldRowProps {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}
function FieldRow({ label, value, mono }: FieldRowProps) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{value}</dd>
    </>
  );
}

export default function StreamCard({
  result,
  type,
  mediaId,
  playableId,
  mediaTitle,
  mediaPoster,
  episodeTitle,
  season,
  episode,
  startSeconds,
  subtitleAddons,
  isAnime,
  autoSelected,
  current,
  onPlayed,
}: Props) {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const { profile } = useProfile();
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [launching, setLaunching] = useState<"mpv" | "browser" | "embedded" | null>(null);
  const [copied, setCopied] = useState(false);

  // Auto-clear the success message a few seconds after it shows so the card
  // doesn't sit with a stale banner.
  useEffect(() => {
    if (!actionSuccess) return;
    const id = window.setTimeout(() => setActionSuccess(null), 3000);
    return () => window.clearTimeout(id);
  }, [actionSuccess]);

  // Auto-clear the "Copied!" feedback on the Copy URL button.
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);
  const { stream: s, source } = result;
  const text = streamText(s);

  const kind = streamKind(s);
  const quality = detectQuality(text);
  const hdr = detectHdr(text);
  const codec = detectCodec(text);
  const size =
    typeof s.behaviorHints?.videoSize === "number"
      ? formatBytes(s.behaviorHints.videoSize)
      : detectSize(text);

  const filename = s.behaviorHints?.filename;
  const titleLines = (s.title ?? "").split("\n").filter((l) => l.trim().length > 0);
  const primaryTitle = titleLines[0] ?? s.name ?? "(untitled stream)";
  const extraTitleLines = titleLines.slice(1);

  const playability = classifyStream(s);

  // Both "playable" (direct file) and "hls" (m3u8) are viable in either
  // backend. recommendedBackend() returns "mpv-external" or "browser".
  const browserViable =
    (playability.kind === "playable" || playability.kind === "hls") &&
    canBrowserPlay(playability.format) &&
    !!s.url &&
    (s.url.startsWith("http://") || s.url.startsWith("https://"));
  const mpvViable =
    (playability.kind === "playable" || playability.kind === "hls") &&
    !!s.url &&
    (s.url.startsWith("http://") || s.url.startsWith("https://"));
  const recommended =
    playability.kind === "playable" || playability.kind === "hls"
      ? recommendedBackend(playability, settings.defaultPlayer)
      : null;

  // Kind label mirrors the action button category.
  const playabilityLabel = (() => {
    switch (playability.kind) {
      case "playable":
      case "hls":
        return "Direct URL";
      case "external": return "External";
      case "torrent": return "Torrent/Resolver";
      case "youtube": return "YouTube";
      default: return "Unsupported";
    }
  })();
  const playabilityClass = (() => {
    switch (playability.kind) {
      case "playable":
      case "hls":
        return "stream-card__playability--direct";
      case "external": return "stream-card__playability--external";
      case "torrent": return "stream-card__playability--torrent";
      case "youtube": return "stream-card__playability--youtube";
      default: return "stream-card__playability--unsupported";
    }
  })();

  function stop(e: MouseEvent) {
    e.stopPropagation();
  }

  // ---- Browser playback (existing in-app player) --------------------------
  function handlePlayInApp(e: MouseEvent) {
    stop(e);
    setActionError(null);
    setActionSuccess(null);
    setPendingPlayable({
      type,
      mediaId,
      playableId,
      mediaTitle,
      episodeTitle,
      season,
      episode,
      poster: mediaPoster,
      stream: s,
      source,
    });
    navigate(`/watch/${encodeURIComponent(type)}/${encodeURIComponent(mediaId)}`);
  }

  // ---- MPV external playback ----------------------------------------------
  async function handlePlayInMpv(e: MouseEvent) {
    stop(e);
    // Double-click guard: every other entry point also checks `launching`,
    // but the button could still receive two clicks before disabled latches
    // on slower machines. Cheap belt-and-braces check.
    if (launching !== null) return;
    setActionError(null);
    setActionSuccess(null);
    if (!s.url) {
      setActionError("Stream has no direct URL.");
      return;
    }
    setLaunching("mpv");

    // Build an explicit PlayRequest from THIS clicked source, then dispatch to
    // the external-MPV backend. The URL comes straight from the clicked stream
    // (s.url) so what's clicked is exactly what plays.
    try {
      const req = buildPlayRequest(
        {
          backend: "external-mpv",
          type,
          mediaId,
          playableId,
          mediaTitle,
          episodeTitle,
          season,
          episode,
          streamUrl: s.url,
          streamTitle: s.title,
          streamName: s.name,
          poster: mediaPoster,
        },
        "manual",
      );
      const res = await dispatchPlayRequest(req, {
        subtitleAddons,
        profileId: profile?.id,
        startSeconds,
        audioLanguageOverride: resolveAudioLanguage(settings, isAnime ?? false),
        origin: "manual",
      });
      if (res.ok) {
        // Let the parent mark this as the active/current source.
        onPlayed?.();
        // progressTracking is only present from the MPV-IPC backend; when it's
        // explicitly false, MPV opened but the IPC pipe didn't connect.
        if (res.progressTracking === false) {
          setActionSuccess(
            "MPV opened, but progress tracking is unavailable.",
          );
        } else {
          setActionSuccess("Opened in MPV");
        }
      } else {
        setActionError(
          res.error ??
            "MPV was not found. Install MPV or set the MPV path in Settings.",
        );
      }
    } finally {
      setLaunching(null);
    }
  }

  // ---- Experimental embedded playback (E2, gated by experimentalEmbeddedPlayer) ----
  async function handlePlayEmbedded(e: MouseEvent) {
    stop(e);
    if (launching !== null) return;
    setActionError(null);
    setActionSuccess(null);
    if (!s.url) {
      setActionError("Stream has no direct URL.");
      return;
    }
    setLaunching("embedded");
    try {
      const req = buildPlayRequest(
        {
          backend: "embedded-mpv-experimental",
          type,
          mediaId,
          playableId,
          mediaTitle,
          episodeTitle,
          season,
          episode,
          streamUrl: s.url,
          streamTitle: s.title,
          streamName: s.name,
          poster: mediaPoster,
        },
        "manual",
      );
      const res = await dispatchPlayRequest(req, { origin: "manual" });
      if (res.ok) {
        onPlayed?.();
        setActionSuccess("Opening in embedded player…");
      } else {
        setActionError(
          res.error ?? "Failed to start embedded player.",
        );
      }
    } finally {
      setLaunching(null);
    }
  }

  // ---- Copy stream URL (debugging aid) ------------------------------------
  async function handleCopyUrl(e: MouseEvent) {
    stop(e);
    if (!s.url) return;
    try {
      await navigator.clipboard.writeText(s.url);
      setCopied(true);
    } catch (err) {
      setActionError(
        err instanceof Error
          ? `Could not copy URL: ${err.message}`
          : "Could not copy URL.",
      );
    }
  }

  async function handleExternal(e: MouseEvent) {
    stop(e);
    setActionError(null);
    const url = playability.url;
    if (!url) {
      setActionError("No external URL on this stream.");
      return;
    }
    try {
      const res = await window.mediaCenter.system.openExternal(url);
      if (!res.ok) setActionError(res.error);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  // ---- Build the action buttons -------------------------------------------

  function renderActions(): React.ReactNode {
    // Non-direct streams: single-action behavior (unchanged).
    switch (playability.kind) {
      case "external":
        return (
          <button
            type="button"
            className="stream-card__action"
            onClick={handleExternal}
            title="Open in your browser"
          >
            ↗ Open External
          </button>
        );
      case "youtube":
        return (
          <button
            type="button"
            className="stream-card__action stream-card__action--disabled"
            disabled
            title="YouTube playback is not enabled yet"
            onClick={stop}
          >
            YouTube Source
          </button>
        );
      case "torrent":
        return (
          <button
            type="button"
            className="stream-card__action stream-card__action--disabled"
            disabled
            title="Torrent playback needs a resolver (not in this build)"
            onClick={stop}
          >
            Resolver Needed
          </button>
        );
      case "playable":
      case "hls": {
        if (!mpvViable && !browserViable) {
          return (
            <button
              type="button"
              className="stream-card__action stream-card__action--disabled"
              disabled
              title="Stream URL must be http(s)"
              onClick={stop}
            >
              Unsupported
            </button>
          );
        }

        // ── Embedded-first mode (experimentalEmbeddedPlayer ON) ──────────────
        // Primary = embedded overlay. External MPV is a secondary fallback.
        // Browser "Play in App" is not shown in this mode to keep UI clean.
        if (settings.experimentalEmbeddedPlayer) {
          return (
            <>
              <button
                type="button"
                className="stream-card__action stream-card__action--primary"
                onClick={handlePlayEmbedded}
                disabled={launching !== null}
                title="Play in the embedded player"
              >
                {launching === "embedded" ? "Starting…" : "▶ Play"}
              </button>
              {mpvViable && (
                <button
                  type="button"
                  className="stream-card__action"
                  onClick={handlePlayInMpv}
                  disabled={launching !== null}
                  title={`Open in external MPV (${playability.format?.toUpperCase() ?? "stream"})`}
                >
                  {launching === "mpv" ? "Launching MPV…" : "Open in MPV"}
                </button>
              )}
            </>
          );
        }

        // ── Default mode (experimentalEmbeddedPlayer OFF) ────────────────────
        // Existing behavior: MPV primary, browser secondary when viable.
        // Recommended backend can promote browser to primary.
        const mpvBtn = (
          <button
            type="button"
            className="stream-card__action stream-card__action--primary"
            onClick={handlePlayInMpv}
            disabled={launching !== null}
            title={`Open MPV (${playability.format?.toUpperCase() ?? "stream"})`}
          >
            {launching === "mpv" ? "Launching MPV…" : "▶ Play with MPV"}
          </button>
        );
        const browserBtn = (
          <button
            type="button"
            className="stream-card__action"
            onClick={handlePlayInApp}
            disabled={launching !== null}
            title="Play in the built-in browser player"
          >
            Play in App
          </button>
        );
        if (recommended === "browser") {
          return (
            <>
              <button
                type="button"
                className="stream-card__action stream-card__action--primary"
                onClick={handlePlayInApp}
                disabled={launching !== null}
                title="Play in the built-in browser player"
              >
                ▶ Play in App
              </button>
              <button
                type="button"
                className="stream-card__action"
                onClick={handlePlayInMpv}
                disabled={launching !== null}
                title={`Open MPV (${playability.format?.toUpperCase() ?? "stream"})`}
              >
                {launching === "mpv" ? "Launching MPV…" : "Play with MPV"}
              </button>
            </>
          );
        }
        return (
          <>
            {mpvBtn}
            {browserViable && browserBtn}
          </>
        );
      }
      default:
        return (
          <button
            type="button"
            className="stream-card__action stream-card__action--disabled"
            disabled
            title={playability.reason ?? "Unsupported"}
            onClick={stop}
          >
            Unsupported
          </button>
        );
    }
  }

  return (
    <div
      className={`stream-card ${open ? "stream-card--open" : ""} ${
        autoSelected ? "stream-card--auto" : ""
      } ${current ? "stream-card--current" : ""}`}
    >
      <button
        type="button"
        className="stream-card__summary"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <div className="stream-card__main">
          <div className="stream-card__title-row">
            {current && (
              <span className="stream-card__current-badge" title="Currently playing">
                ● Playing
              </span>
            )}
            {autoSelected && !current && (
              <span className="stream-card__auto-badge" title="Chosen by auto-select">
                ★ Auto-selected
              </span>
            )}
            <span className="stream-card__name">{s.name ?? source.addonName}</span>
            <span className="stream-card__addon">{source.addonName}</span>
          </div>
          <div className="stream-card__title">{primaryTitle}</div>
          {extraTitleLines.length > 0 && (
            <div className="stream-card__title-extra">
              {extraTitleLines.join(" · ")}
            </div>
          )}
          {filename && (
            <div className="stream-card__filename mono" title={filename}>
              {filename}
            </div>
          )}
        </div>
        <div className="stream-card__right">
          <div className="stream-card__tags">
            <span className={`tag tag--kind tag--kind-${kind}`}>{kindLabel(kind)}</span>
            {quality && <span className="tag tag--quality">{quality}</span>}
            {hdr && <span className="tag tag--hdr">{hdr}</span>}
            {codec && <span className="tag tag--codec">{codec}</span>}
            {size && <span className="tag tag--size">{size}</span>}
          </div>
          <div className="stream-card__actions">
            <span
              className={`stream-card__playability ${playabilityClass}`}
              title={playability.reason ?? undefined}
            >
              {playabilityLabel}
            </span>
            {renderActions()}
            {/* Copy Stream URL — only for cards that actually have a direct
                URL we could copy. Mostly a debugging affordance. */}
            {s.url &&
              (s.url.startsWith("http://") || s.url.startsWith("https://")) && (
                <button
                  type="button"
                  className="stream-card__action stream-card__action--small"
                  onClick={handleCopyUrl}
                  title="Copy the stream URL to the clipboard"
                >
                  {copied ? "Copied!" : "Copy URL"}
                </button>
              )}
          </div>
        </div>
      </button>

      {actionError && (
        <div className="stream-card__action-error" role="alert">
          {actionError}
        </div>
      )}

      {actionSuccess && (
        <div className="stream-card__action-success" role="status">
          {actionSuccess}
        </div>
      )}

      {open && (
        <div className="stream-card__details">
          <dl className="kv">
            <FieldRow label="Addon" value={`${source.addonName} (${source.addonId})`} />
            <FieldRow label="Kind" value={kindLabel(kind)} />
            <FieldRow
              label="Playability"
              value={
                <>
                  {playability.kind}
                  {playability.format && playability.format !== "unknown" && (
                    <> · {playability.format}</>
                  )}
                  {playability.reason && (
                    <span className="muted small"> ({playability.reason})</span>
                  )}
                </>
              }
            />
            {s.name && <FieldRow label="name" value={s.name} />}
            {s.title && <FieldRow label="title" value={<span style={{ whiteSpace: "pre-line" }}>{s.title}</span>} />}
            {s.description && <FieldRow label="description" value={s.description} />}
            {s.url && <FieldRow label="url" value={s.url} mono />}
            {s.externalUrl && (
              <FieldRow label="externalUrl" value={s.externalUrl} mono />
            )}
            {s.infoHash && <FieldRow label="infoHash" value={s.infoHash} mono />}
            {typeof s.fileIdx === "number" && (
              <FieldRow label="fileIdx" value={String(s.fileIdx)} mono />
            )}
            {s.ytId && <FieldRow label="ytId" value={s.ytId} mono />}
            {Array.isArray(s.sources) && s.sources.length > 0 && (
              <FieldRow
                label="sources"
                value={
                  <ul className="raw-list">
                    {s.sources.map((src, i) => (
                      <li key={i} className="mono">{src}</li>
                    ))}
                  </ul>
                }
              />
            )}
            {s.behaviorHints && Object.keys(s.behaviorHints).length > 0 && (
              <FieldRow
                label="behaviorHints"
                value={
                  <pre className="raw-json">
                    {JSON.stringify(s.behaviorHints, null, 2)}
                  </pre>
                }
              />
            )}
            {Array.isArray(s.subtitles) && s.subtitles.length > 0 && (
              <FieldRow
                label="subtitles"
                value={<span>{s.subtitles.length} subtitle{s.subtitles.length === 1 ? "" : "s"}</span>}
              />
            )}
          </dl>
        </div>
      )}
    </div>
  );
}
