// Player backend boundary.
//
// A PlayRequest is the single, explicit "play exactly this" unit. Source
// selection BUILDS one (`buildPlayRequest`) from the clicked/auto-selected
// source, then hands it to the chosen backend (`dispatchPlayRequest`). The
// authoritative URL is `req.streamUrl` — it is set from the clicked source and
// passed verbatim to the backend, so the clicked URL, the PlayRequest URL, and
// the URL the backend receives are guaranteed to be the same value.
//
// There is NO shared global "current URL". Each request is self-contained and
// backend-tagged, so the external-MPV and embedded-MPV paths can never leak
// into each other, and the experimental page can't affect normal playback.

import { playWithMpv } from "../../core/player/mpvExternal.js";
import { collectSubtitles } from "./subtitles.js";
import type {
  MpvOpenResult,
  PlayableStreamPayload,
  PlayRequest,
  PlayRequestSource,
} from "../../core/player/types.js";
import type { AddonRow } from "../../types/preload.js";

/** Backend-specific "how to play" options (NOT part of request identity). */
export interface DispatchOptions {
  /** Addons used to auto-collect subtitles for the external-MPV backend. */
  subtitleAddons?: AddonRow[];
  profileId?: number;
  startSeconds?: number;
  /** Resolved preferred audio language ("" = no preference). */
  audioLanguageOverride?: string;
  /** Where this request came from — for dev logging only. */
  origin?: PlayRequestSource;
}

export interface DispatchResult {
  ok: boolean;
  error?: string;
  /** Only meaningful for external MPV (IPC progress pipe connected). */
  progressTracking?: boolean;
}

/** First/last 80 chars of a URL for safe dev logging. */
function urlPreview(u: string): string {
  if (typeof u !== "string") return String(u);
  if (u.length <= 161) return u;
  return `${u.slice(0, 80)}…${u.slice(-80)}`;
}

/**
 * Build a PlayRequest from a clicked/auto-selected source. Single creation
 * point so the request — and its URL ownership — is explicit and logged.
 */
export function buildPlayRequest(
  req: PlayRequest,
  origin: PlayRequestSource,
): PlayRequest {
  if (import.meta.env.DEV) {
    console.log("[playrequest:create]", {
      origin,
      backend: req.backend,
      mediaTitle: req.mediaTitle,
      playableId: req.playableId,
      streamName: req.streamName,
      streamTitle: req.streamTitle,
      streamUrl: urlPreview(req.streamUrl),
    });
  }
  return req;
}

/**
 * Dispatch a PlayRequest to its backend. The backend receives `req.streamUrl`
 * verbatim. Never throws — returns `{ ok:false, error }` on failure.
 */
export async function dispatchPlayRequest(
  req: PlayRequest,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  if (import.meta.env.DEV) {
    console.log("[playrequest:dispatch]", {
      origin: options.origin,
      backend: req.backend,
      playableId: req.playableId,
      streamName: req.streamName,
      streamTitle: req.streamTitle,
      streamUrl: urlPreview(req.streamUrl),
    });
  }

  if (!req.streamUrl) {
    return { ok: false, error: "PlayRequest has no streamUrl." };
  }

  switch (req.backend) {
    case "external-mpv":
      return dispatchExternalMpv(req, options);
    case "embedded-mpv-experimental":
      return dispatchEmbeddedExperimental(req);
    default:
      return { ok: false, error: `Unknown backend: ${String(req.backend)}` };
  }
}

async function dispatchExternalMpv(
  req: PlayRequest,
  options: DispatchOptions,
): Promise<DispatchResult> {
  // Auto-collect subtitles for this exact playable. Failures never block.
  let subtitles: PlayableStreamPayload["subtitles"] = [];
  try {
    subtitles = await collectSubtitles(
      options.subtitleAddons ?? [],
      req.type,
      req.playableId,
    );
  } catch {
    subtitles = [];
  }
  if (import.meta.env.DEV) {
    console.log(
      `[subtitles] auto-loading ${subtitles?.length ?? 0} track(s) into MPV for ${req.type} ${req.playableId}`,
    );
  }

  const payload: PlayableStreamPayload = {
    type: req.type,
    mediaId: req.mediaId,
    playableId: req.playableId,
    mediaTitle: req.mediaTitle,
    episodeTitle: req.episodeTitle,
    season: req.season,
    episode: req.episode,
    poster: req.poster,
    // Authoritative URL — taken straight from the PlayRequest.
    streamUrl: req.streamUrl,
    streamTitle: req.streamTitle,
    streamName: req.streamName,
    profileId: options.profileId,
    startSeconds:
      typeof options.startSeconds === "number" && options.startSeconds > 0
        ? options.startSeconds
        : undefined,
    subtitles,
    audioLanguageOverride: options.audioLanguageOverride,
  };

  const res: MpvOpenResult = await playWithMpv(payload);
  return {
    ok: res.ok,
    error: res.error,
    progressTracking: res.progressTracking,
  };
}

async function dispatchEmbeddedExperimental(
  req: PlayRequest,
): Promise<DispatchResult> {
  const api = window.embeddedMpv;
  if (!api) {
    return {
      ok: false,
      error:
        "Embedded player bridge is unavailable (window.embeddedMpv missing).",
    };
  }
  try {
    const res = await api.start(req.streamUrl);
    return { ok: res.ok, error: res.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
