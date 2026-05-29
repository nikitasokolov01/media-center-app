// "Sources" section on the media detail page. Takes a SelectedPlayableItem
// (movie id, or chosen series episode id) and fans out one stream fetch per
// stream-supporting addon for that exact id.
//
// For series, this means streams are fetched for the *episode* id, not the
// show id — which is what Stremio addons actually expect.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import StreamCard from "./StreamCard.js";
import { addonSupportsResource } from "../core/stremio/meta.js";
import { streamDedupKey } from "../core/stremio/streams.js";
import { chooseBestSource, detectResolution } from "../core/player/sourceRanking.js";
import { resolveAudioLanguage } from "../core/player/audioPreference.js";
import {
  buildPlayRequest,
  dispatchPlayRequest,
} from "../features/player/playRequest.js";
import { useSettings } from "../state/SettingsContext.js";
import { useProfile } from "../state/ProfileContext.js";
import type {
  SelectedPlayableItem,
  StreamSourceResult,
  StremioStream,
} from "../core/stremio/types.js";
import type { PlayRequestSource } from "../core/player/types.js";
import type { AddonRow } from "../types/preload.js";

interface Props {
  addons: AddonRow[];
  /**
   * Null for series that haven't had an episode picked yet. Movies always pass
   * a populated selection as soon as their meta resolves.
   */
  selected: SelectedPlayableItem | null;

  // Context needed by StreamCard to build a PlayableStream when the user hits
  // Play. Kept as flat props instead of stuffed into `selected` so the player
  // gets the show poster + show id alongside the per-episode info.
  mediaId: string;
  mediaTitle: string;
  mediaPoster?: string;
  /** For series: the chosen episode's own title (not the show title). */
  episodeTitle?: string;
  /** Resume position passed to MPV (--start); 0 starts from the beginning. */
  startSeconds?: number;
  /**
   * Layout variant:
   *  - "full" (default): bottom-of-page block for movies, with a big header.
   *  - "inline": compact, rendered inside the selected episode card on series.
   * Only affects presentation — fetching/dedup logic is identical.
   */
  variant?: "full" | "inline";
  /** Whether this media was classified as anime (drives anime audio default). */
  isAnime?: boolean;
}

interface AddonFailure {
  addonId: string;
  addonName: string;
  message: string;
}

/** Free-text fields a quality label can be parsed from. */
function streamText(s: StremioStream): string {
  return [s.name, s.title, s.behaviorHints?.filename]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join("\n");
}

/** Human label for the Sources button (null when quality is unknown). */
function prettyQuality(tier: string): string | null {
  switch (tier) {
    case "2160p":
      return "4K";
    case "1440p":
      return "1440p";
    case "1080p":
      return "1080p";
    case "720p":
      return "720p";
    case "480p":
      return "480p";
    default:
      return null;
  }
}

export default function SourcesSection({
  addons,
  selected,
  mediaId,
  mediaTitle,
  mediaPoster,
  episodeTitle,
  startSeconds,
  variant = "full",
  isAnime,
}: Props) {
  const inline = variant === "inline";
  const { settings } = useSettings();
  const { profile } = useProfile();
  const eligible = useMemo(() => {
    if (!selected) return [];
    return addons.filter((a) =>
      addonSupportsResource(a.manifest, "stream", selected.type),
    );
  }, [addons, selected]);

  const [results, setResults] = useState<StreamSourceResult[]>([]);
  const [failures, setFailures] = useState<AddonFailure[]>([]);
  const [loading, setLoading] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [playingBest, setPlayingBest] = useState(false);
  const [bestError, setBestError] = useState<string | null>(null);
  // Which selection the current `results` belong to. Guards auto-play against
  // acting on a previous selection's still-cached results during the brief
  // window after `selected` changes but before the refetch settles.
  const [completedSel, setCompletedSel] = useState<SelectedPlayableItem | null>(
    null,
  );
  // Auto-play mode only: whether the manual "Sources" dropdown is open, and the
  // key of the source currently playing (auto-selected best, or a manual pick).
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [currentSourceKey, setCurrentSourceKey] = useState<string | null>(null);

  const run = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  // Rank the best playable source whenever EITHER source feature is on
  // (auto-select badges it; auto-play launches it). null when neither is on,
  // still loading, or nothing is playable.
  const bestResult = useMemo(() => {
    if (
      !(settings.autoSelectSource || settings.autoPlayBestSource) ||
      loading ||
      results.length === 0
    ) {
      return null;
    }
    return chooseBestSource(results, settings);
  }, [settings, loading, results]);

  const handlePlayBest = useCallback(
    async (origin: PlayRequestSource = "manual") => {
    if (!bestResult || !selected || playingBest) return;
    setBestError(null);
    setPlayingBest(true);
    try {
      // When experimentalEmbeddedPlayer is ON, auto-play uses the embedded
      // overlay as the primary backend. External MPV is used otherwise.
      const backend = settings.experimentalEmbeddedPlayer
        ? "embedded-mpv-experimental"
        : "external-mpv";

      const req = buildPlayRequest(
        {
          backend,
          type: selected.type,
          mediaId,
          playableId: selected.id,
          mediaTitle,
          episodeTitle,
          season: selected.type === "series" ? selected.season : undefined,
          episode: selected.type === "series" ? selected.episode : undefined,
          streamUrl: bestResult.stream.url ?? "",
          streamTitle: bestResult.stream.title,
          streamName: bestResult.stream.name,
          poster: mediaPoster,
        },
        origin,
      );
      const res = await dispatchPlayRequest(req, {
        // Only pass MPV-specific options when using external MPV.
        ...(backend === "external-mpv"
          ? {
              subtitleAddons: addons,
              profileId: profile?.id,
              startSeconds,
              audioLanguageOverride: resolveAudioLanguage(settings, isAnime ?? false),
            }
          : {}),
        origin,
      });
      if (!res.ok) {
        setBestError(
          res.error ??
            (backend === "external-mpv"
              ? "MPV was not found. Install MPV or set the MPV path in Settings."
              : "Failed to start the embedded player."),
        );
      }
    } finally {
      setPlayingBest(false);
    }
  }, [
    bestResult,
    selected,
    playingBest,
    mediaId,
    mediaTitle,
    mediaPoster,
    episodeTitle,
    startSeconds,
    addons,
    profile,
    settings,
    isAnime,
  ]);

  // ---- Auto-play best source (loop-safe) -----------------------------------
  // Fires AT MOST ONCE per selected playable. We key the guard on the `selected`
  // object identity: it only changes when MediaPage sets a new selection (a new
  // movie, or the user (re)selecting an episode), NOT on re-renders, settings
  // updates, subtitle/progress changes, or source re-fetches with the same
  // target. That prevents relaunch loops while still auto-playing a freshly
  // selected episode (whose single-session close is handled in the main process).
  const autoPlayedSelRef = useRef<SelectedPlayableItem | null>(null);

  // Reset transient per-selection UI when the selected playable changes.
  useEffect(() => {
    setSourcesOpen(false);
    setCurrentSourceKey(null);
  }, [selected]);

  useEffect(() => {
    if (!settings.autoPlayBestSource) return;
    // Wait for the fetch to settle and a direct playable best to exist.
    // `completedSel === selected` ensures the current results were fetched for
    // THIS selection (not a stale prior episode/movie still in state).
    if (loading || !selected || completedSel !== selected || !bestResult) return;
    // Already auto-played THIS exact selection — don't relaunch on re-renders,
    // subtitle/progress updates, or the user manually stopping MPV.
    if (autoPlayedSelRef.current === selected) return;
    autoPlayedSelRef.current = selected;
    setCurrentSourceKey(bestResult.key);
    void handlePlayBest("autoplay");
  }, [
    settings.autoPlayBestSource,
    loading,
    completedSel,
    selected,
    bestResult,
    handlePlayBest,
  ]);

  useEffect(() => {
    // Nothing selected (series with no episode picked) — clear and bail.
    if (!selected) {
      setResults([]);
      setFailures([]);
      setLoading(false);
      setCompleted(false);
      setCompletedSel(null);
      return;
    }

    if (eligible.length === 0) {
      setResults([]);
      setFailures([]);
      setLoading(false);
      setCompleted(true);
      setCompletedSel(selected);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setResults([]);
    setFailures([]);
    setCompleted(false);
    // Mark results as not-yet-for-this-selection until the fetch settles.
    setCompletedSel(null);

    const seen = new Set<string>();
    const collected: StreamSourceResult[] = [];
    const fails: AddonFailure[] = [];

    const tasks = eligible.map((a) =>
      window.mediaCenter.streams
        .fetch({
          manifestUrl: a.manifestUrl,
          type: selected.type,
          id: selected.id,
        })
        .then((res) => {
          if (cancelled) return;
          const streams = (res.streams ?? []) as StremioStream[];
          streams.forEach((s, i) => {
            const fallback = `${a.id}#${i}`;
            const key = streamDedupKey(s, fallback);
            if (seen.has(key)) return;
            seen.add(key);
            collected.push({
              stream: s,
              source: { addonId: a.id, addonName: a.manifest.name },
              key,
            });
          });
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          fails.push({
            addonId: a.id,
            addonName: a.manifest.name,
            message: e instanceof Error ? e.message : String(e),
          });
        }),
    );

    Promise.allSettled(tasks).then(() => {
      if (cancelled) return;
      setResults(collected);
      setFailures(fails);
      setLoading(false);
      setCompleted(true);
      // Results now belong to this selection — unlocks auto-play for it.
      setCompletedSel(selected);
    });

    return () => {
      cancelled = true;
    };
  }, [eligible, selected, reloadKey]);

  // ---- Render --------------------------------------------------------------

  const sectionClass = `sources${inline ? " sources--inline" : ""}`;

  // Series with no episode picked yet.
  if (!selected) {
    return (
      <section className={sectionClass}>
        <header className="sources__header">
          <h2>Sources</h2>
        </header>
        <div className="empty">Select an episode to view sources.</div>
      </section>
    );
  }

  if (eligible.length === 0) {
    return (
      <section className={sectionClass}>
        {!inline && (
          <header className="sources__header">
            <h2>Sources</h2>
          </header>
        )}
        <div className="empty">
          None of your installed addons provide a <code>stream</code> resource
          for <code>{selected.type}</code>.
        </div>
      </section>
    );
  }

  // Season/episode are only meaningful when `selected` is a series pick.
  const season =
    selected.type === "series" ? selected.season : undefined;
  const episode =
    selected.type === "series" ? selected.episode : undefined;

  const autoMode = settings.autoPlayBestSource;
  // Results are settled for THIS selection (not a stale prior one).
  const settled = completedSel === selected;

  // The source whose label/marker we surface: a manual pick if any, else the
  // auto-selected best.
  const currentResult =
    results.find((r) => r.key === currentSourceKey) ?? bestResult ?? null;
  const currentQuality = currentResult
    ? prettyQuality(detectResolution(streamText(currentResult.stream)))
    : null;
  const sourcesButtonLabel = currentQuality ? `Source: ${currentQuality}` : "Sources";

  const autoStatus =
    loading || !settled
      ? "Finding best source…"
      : bestResult
        ? "Playing best source…"
        : "No playable source found";

  // Shared failure banner (both modes).
  const failuresBanner =
    failures.length > 0 ? (
      <div className="warning-banner" role="alert">
        {failures.length} addon{failures.length === 1 ? "" : "s"} couldn't be
        reached — showing results from the rest.
        <details>
          <summary>Details</summary>
          <ul className="failure-list">
            {failures.map((f, i) => (
              <li key={i}>
                <strong>{f.addonName}:</strong> {f.message}
              </li>
            ))}
          </ul>
        </details>
        <div style={{ marginTop: 8 }}>
          <button type="button" className="ghost-button" onClick={run}>
            Retry failed addons
          </button>
        </div>
      </div>
    ) : null;

  // The full source picker (skeletons / empty / cards). Used directly in manual
  // mode and inside the Sources dropdown panel in auto-play mode.
  const renderSourceList = () => {
    if (loading) {
      return (
        <div className="sources__list">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="stream-card stream-card--skeleton" aria-hidden>
              <div className="stream-card__main">
                <div className="skeleton-line" style={{ width: "40%" }} />
                <div className="skeleton-line" style={{ width: "80%" }} />
                <div className="skeleton-line skeleton-line--short" />
              </div>
            </div>
          ))}
        </div>
      );
    }
    if (completed && results.length === 0 && failures.length === 0) {
      return (
        <div className="empty">
          No sources found for {selected.type} <code>{selected.id}</code> in any
          installed addon.
        </div>
      );
    }
    if (results.length > 0) {
      return (
        <div className="sources__list">
          {results.map((r) => (
            <StreamCard
              key={r.key}
              result={r}
              type={selected.type}
              mediaId={mediaId}
              playableId={selected.id}
              mediaTitle={mediaTitle}
              mediaPoster={mediaPoster}
              episodeTitle={episodeTitle}
              season={season}
              episode={episode}
              startSeconds={startSeconds}
              subtitleAddons={addons}
              isAnime={isAnime}
              autoSelected={
                settings.autoSelectSource && bestResult?.key === r.key
              }
              current={currentSourceKey === r.key}
              onPlayed={() => {
                // Manual pick becomes the active/current source; in auto-play
                // mode also collapse the dropdown. The main process closes any
                // existing MPV session before launching the new one.
                setCurrentSourceKey(r.key);
                if (autoMode) setSourcesOpen(false);
              }}
            />
          ))}
        </div>
      );
    }
    return null;
  };

  // ---- Auto-play mode: compact status + on-demand Sources dropdown ---------
  if (autoMode) {
    return (
      <section className={`${sectionClass} sources--auto`}>
        <header className="sources__header">
          {inline ? (
            <span className="sources__inline-label">Sources</span>
          ) : (
            <h2>Sources</h2>
          )}
          <span className="muted small sources__status" role="status">
            {autoStatus}
            {selected.type === "series" &&
              typeof season === "number" &&
              typeof episode === "number" && (
                <>
                  {" "}· S{String(season).padStart(2, "0")}E
                  {String(episode).padStart(2, "0")}
                </>
              )}
          </span>
          <span className="sources__spacer" />
          {settled && (
            <button
              type="button"
              className="ghost-button"
              onClick={() => setSourcesOpen((o) => !o)}
              aria-expanded={sourcesOpen}
              aria-haspopup="true"
              title="Open the source picker to choose a different source"
            >
              {sourcesButtonLabel} ▾
            </button>
          )}
          {!loading && (
            <button type="button" className="ghost-button" onClick={run}>
              Refresh
            </button>
          )}
        </header>

        {bestError && (
          <div className="stream-card__action-error" role="alert">
            {bestError}
          </div>
        )}

        {failuresBanner}

        {sourcesOpen && <div className="sources__panel">{renderSourceList()}</div>}
      </section>
    );
  }

  // ---- Manual mode: the full visible source list (unchanged behavior) ------
  return (
    <section className={sectionClass}>
      <header className="sources__header">
        {inline ? (
          <span className="sources__inline-label">Sources</span>
        ) : (
          <h2>Sources</h2>
        )}
        <span className="muted small">
          {loading
            ? `Searching ${eligible.length} addon${eligible.length === 1 ? "" : "s"}…`
            : `${results.length} source${results.length === 1 ? "" : "s"} from ${eligible.length - failures.length}/${eligible.length} addon${eligible.length === 1 ? "" : "s"}`}
          {selected.type === "series" && typeof season === "number" && typeof episode === "number" && (
            <>
              {" "}· S{String(season).padStart(2, "0")}E{String(episode).padStart(2, "0")}
            </>
          )}
        </span>
        <span className="sources__spacer" />
        {/* Manual best-play button when auto-select is on. */}
        {bestResult && (
          <button
            type="button"
            className="primary-button sources__play-best"
            onClick={() => void handlePlayBest("manual")}
            disabled={playingBest}
            title={
              settings.experimentalEmbeddedPlayer
                ? "Play the auto-selected best source in the embedded player"
                : "Play the auto-selected best source with MPV"
            }
          >
            {playingBest ? "Launching…" : "▶ Play Best Source"}
          </button>
        )}
        {!loading && (
          <button type="button" className="ghost-button" onClick={run}>
            Refresh
          </button>
        )}
      </header>

      {bestError && (
        <div className="stream-card__action-error" role="alert">
          {bestError}
        </div>
      )}

      {failuresBanner}

      {renderSourceList()}
    </section>
  );
}
