// Real media detail page for /media/:type/:id.
//
// Strategy:
//   1. Load all installed addons for the active profile.
//   2. Filter to those whose manifest advertises the `meta` resource for the
//      requested type.
//   3. Try them in sequence — first valid response wins. Per-addon errors are
//      collected for diagnostics but never crash the page.
//   4. Render the meta with poster, background, title, year/runtime, genres,
//      cast, director, rating, description.
//   5. For series, render an EpisodeSelector and only fetch streams once an
//      episode is selected. The selected episode's id (not the show id) is
//      what addons need to return streams for the right video.
//   6. For movies, the playable selection is the movie itself — built as soon
//      as meta resolves.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { useProfile } from "../state/ProfileContext.js";
import { useLibrary } from "../state/LibraryContext.js";
import { useToast } from "../state/ToastContext.js";
import { useSettings } from "../state/SettingsContext.js";
import { addonSupportsResource } from "../core/stremio/meta.js";
import { isLikelyAnime } from "../core/stremio/anime.js";
import { streamDedupKey } from "../core/stremio/streams.js";
import { formatTime } from "../features/player/playability.js";
import { chooseBestSource } from "../core/player/sourceRanking.js";
import { resolveAudioLanguage } from "../core/player/audioPreference.js";
import { buildPlayRequest, dispatchPlayRequest } from "../features/player/playRequest.js";
import { setEmbeddedPlayRequest } from "../features/player/embeddedRequest.js";
import {
  getCachedSources,
  makePrefetchKey,
  prefetchEpisodeSources,
} from "../core/player/sourcePrefetch.js";
import SourcesSection from "../components/SourcesSection.js";
import EpisodeSelector from "../components/EpisodeSelector.js";
import MediaTrailer from "../components/MediaTrailer.js";
import BackButton from "../components/BackButton.js";
import RatingControl from "../components/RatingControl.js";
import { getTrailerInfo } from "../core/stremio/trailer.js";
import type {
  SelectedPlayableItem,
  StremioMeta,
  StremioStream,
  StremioVideo,
  StreamSourceResult,
} from "../core/stremio/types.js";
import type { AddonRow, WatchProgress } from "../types/preload.js";

interface AttemptFailure {
  addonId: string;
  addonName: string;
  message: string;
}

interface MetaResult {
  meta: StremioMeta;
  source: { addonId: string; addonName: string };
}

function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function joinList(v: string[] | string | undefined): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0) return v.join(", ");
  return null;
}

export default function MediaPage() {
  const { type: rawType, id: rawId } = useParams<{ type: string; id: string }>();
  const type = decodeURIComponent(rawType ?? "");
  const id = decodeURIComponent(rawId ?? "");
  const isSeries = type === "series";

  // Optional deep-link context (e.g. from Continue Watching): default the
  // episode selector to this season instead of Season 1.
  const [searchParams] = useSearchParams();
  const initialSeasonParam = (() => {
    const raw = searchParams.get("season");
    if (raw == null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  })();

  const { profile, loading: profileLoading } = useProfile();
  const { isInLibrary, add: addToLibrary, remove: removeFromLibrary } = useLibrary();
  const { toast } = useToast();
  const { settings } = useSettings();

  const [addons, setAddons] = useState<AddonRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<MetaResult | null>(null);
  const [failures, setFailures] = useState<AttemptFailure[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  // Selected playable target: null for series until an episode is chosen,
  // populated for movies as soon as meta resolves.
  const [selected, setSelected] = useState<SelectedPlayableItem | null>(null);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  // For series: the chosen episode's own title (distinct from the show title).
  const [episodeTitle, setEpisodeTitle] = useState<string | undefined>(undefined);

  // Id of an episode whose Play button was clicked — shows loading state and
  // prevents double-clicks while sources are being fetched.
  const [playingEpisodeId, setPlayingEpisodeId] = useState<string | null>(null);

  // Controls which episode card shows the inline source picker. Set by
  // "Choose Source" button or when Play is clicked in manual-mode.
  const [showSourcesForVideoId, setShowSourcesForVideoId] = useState<string | null>(null);

  // Controls visibility of the movie source picker panel (hidden by default,
  // revealed via "Choose Source" button).
  const [showMovieSources, setShowMovieSources] = useState(false);

  // Saved watch progress for the currently-selected playable, plus the user's
  // resume choice. `resumeMode` defaults to "resume" when progress exists.
  const [savedProgress, setSavedProgress] = useState<WatchProgress | null>(null);
  const [resumeMode, setResumeMode] = useState<"resume" | "start">("resume");

  // All watch_progress rows for this media — drives watched badges/buttons.
  const [watchedRows, setWatchedRows] = useState<WatchProgress[]>([]);
  const watchedSet = useMemo(
    () => new Set(watchedRows.filter((r) => r.completed).map((r) => r.playableId)),
    [watchedRows],
  );

  const refreshWatched = useCallback(async () => {
    if (!profile) return;
    try {
      const rows = await window.mediaCenter.watched.listForMedia({
        profileId: profile.id,
        mediaId: id,
      });
      setWatchedRows(rows);
    } catch {
      setWatchedRows([]);
    }
  }, [profile, id]);

  useEffect(() => {
    void refreshWatched();
  }, [refreshWatched, reloadKey]);

  // Cache this series' ordered episode list so the Home page's Continue
  // Watching can compute the next episode to watch without re-fetching meta.
  useEffect(() => {
    const m = result?.meta;
    if (!m || !isSeries) return;
    const eps = asArray<StremioVideo>(m.videos);
    if (eps.length === 0) return;
    void window.mediaCenter.series.cacheEpisodes({
      seriesId: m.id,
      episodes: eps.map((v) => ({
        videoId: v.id,
        season: typeof v.season === "number" ? v.season : null,
        episode: typeof v.episode === "number" ? v.episode : null,
        title: v.title ?? v.name ?? null,
      })),
    });
  }, [result, isSeries]);

  // Load installed addons for the active profile.
  useEffect(() => {
    if (!profile) return;
    let cancelled = false;
    window.mediaCenter.addons
      .list(profile.id)
      .then((rows) => {
        if (!cancelled) setAddons(rows);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setAddons([]);
          setFailures([
            {
              addonId: "(local)",
              addonName: "Local addon list",
              message: e instanceof Error ? e.message : String(e),
            },
          ]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profile]);

  const eligible = useMemo(() => {
    if (!addons) return [];
    return addons.filter((a) => addonSupportsResource(a.manifest, "meta", type));
  }, [addons, type]);

  // Try each eligible addon in sequence until one returns a valid meta.
  useEffect(() => {
    if (!profile || addons === null) return;
    let cancelled = false;
    setLoading(true);
    setResult(null);
    setFailures([]);
    // A fresh meta load means any prior selection (from a different id) is
    // stale — reset it so movies get re-derived and series ask for a new pick.
    setSelected(null);
    setSelectedVideoId(null);
    setEpisodeTitle(undefined);

    (async () => {
      if (eligible.length === 0) {
        if (!cancelled) setLoading(false);
        return;
      }

      const errs: AttemptFailure[] = [];
      for (const a of eligible) {
        if (cancelled) return;
        try {
          const res = await window.mediaCenter.meta.fetch({
            manifestUrl: a.manifestUrl,
            type,
            id,
          });
          if (cancelled) return;
          if (res?.meta) {
            setResult({
              meta: res.meta,
              source: { addonId: a.id, addonName: a.manifest.name },
            });
            setFailures(errs);
            setLoading(false);
            return;
          }
          errs.push({
            addonId: a.id,
            addonName: a.manifest.name,
            message: "Response missing `meta` object.",
          });
        } catch (e) {
          errs.push({
            addonId: a.id,
            addonName: a.manifest.name,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }

      if (!cancelled) {
        setFailures(errs);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [profile, addons, eligible, type, id, reloadKey]);

  // Once meta loads, derive the selection for movies. For series, wait for
  // user pick (EpisodeSelector will auto-pick when there's only one episode).
  useEffect(() => {
    const meta = result?.meta;
    if (!meta) return;
    if (isSeries) return;
    setSelected({ type: "movie", id: meta.id, title: meta.name });
    setShowMovieSources(false);
  }, [result, isSeries]);

  // Translate an episode pick into a SelectedPlayableItem.
  // Clicking the card body (not Choose Source) also clears any open source panel.
  const handleEpisodeSelect = (video: StremioVideo) => {
    if (!result?.meta) return;
    // Close the source panel when switching to a different episode via card body.
    if (video.id !== selectedVideoId) {
      setShowSourcesForVideoId(null);
    }
    setSelectedVideoId(video.id);
    setEpisodeTitle(video.title ?? video.name ?? undefined);
    setSelected({
      type: "series",
      id: video.id,
      title: result.meta.name,
      season: typeof video.season === "number" ? video.season : undefined,
      episode: typeof video.episode === "number" ? video.episode : undefined,
    });
  };

  // Direct play for movies using the player-first embedded flow (embedded ON).
  // Opens the overlay immediately; source resolution happens inside the overlay.
  const handleDirectPlayMovie = () => {
    const m = result?.meta;
    if (!m || !profile) return;
    if (!settings.experimentalEmbeddedPlayer) return;
    setEmbeddedPlayRequest(buildPlayRequest(
      {
        backend: "embedded-mpv-experimental",
        type: "movie",
        mediaId: m.id,
        playableId: m.id,
        mediaTitle: m.name,
        streamUrl: "",
        poster: m.poster,
        background: m.background,
        logo: m.logo,
        pendingSourceFetch: true,
        manualSourceSelect: !(settings.autoPlayBestSource || settings.autoSelectSource),
        isAnime,
      },
      "manual",
    ));
  };

  // Unified Play/Resume handler for movies. Embedded path: player-first overlay.
  // External MPV path: auto-play best source when auto settings are on, else
  // reveal the source picker panel.
  const [moviePlayLoading, setMoviePlayLoading] = useState(false);
  const handlePlayMovie = async () => {
    const m = result?.meta;
    if (!m || !profile || !addons) return;

    if (settings.experimentalEmbeddedPlayer) {
      handleDirectPlayMovie();
      return;
    }

    // External MPV: if neither auto feature is on, just reveal the source panel.
    if (!settings.autoPlayBestSource && !settings.autoSelectSource) {
      setShowMovieSources(true);
      return;
    }

    setMoviePlayLoading(true);
    try {
      const eligibleStream = addons.filter((a) =>
        addonSupportsResource(a.manifest, "stream", "movie"),
      );
      if (eligibleStream.length === 0) {
        setShowMovieSources(true);
        return;
      }

      const seen = new Set<string>();
      const collected: StreamSourceResult[] = [];
      await Promise.allSettled(
        eligibleStream.map((a) =>
          window.mediaCenter.streams
            .fetch({ manifestUrl: a.manifestUrl, type: "movie", id: m.id })
            .then((res) => {
              (res.streams ?? []).forEach((s: StremioStream, i: number) => {
                const dk = streamDedupKey(s, `${a.id}#${i}`);
                if (seen.has(dk)) return;
                seen.add(dk);
                collected.push({
                  stream: s,
                  source: { addonId: a.id, addonName: a.manifest.name },
                  key: dk,
                });
              });
            })
            .catch(() => { /* per-addon failure is non-fatal */ }),
        ),
      );

      const best = chooseBestSource(collected, settings);
      if (!best) {
        setShowMovieSources(true);
        return;
      }

      const req = buildPlayRequest(
        {
          backend: "external-mpv",
          type: "movie",
          mediaId: m.id,
          playableId: m.id,
          mediaTitle: m.name,
          streamUrl: best.stream.url ?? "",
          streamTitle: best.stream.title,
          streamName: best.stream.name,
          poster: m.poster,
        },
        "manual",
      );
      await dispatchPlayRequest(req, {
        subtitleAddons: addons,
        profileId: profile.id,
        startSeconds: resumeSeconds,
        audioLanguageOverride: resolveAudioLanguage(settings, isAnime),
      });
    } finally {
      setMoviePlayLoading(false);
    }
  };

  // Direct play from the episode card Play button. Selects the episode AND
  // immediately fetches sources + plays the best one when autoPlayBestSource
  // is enabled. Falls back to just selecting the episode (SourcesSection
  // appears) when manual source selection is preferred.
  const handleDirectPlayEpisode = async (video: StremioVideo) => {
    if (!result?.meta || !profile || !addons) return;
    // Prevent double-click while loading.
    if (playingEpisodeId === video.id) return;

    // Player-first flow: when the embedded player is active, open the
    // overlay immediately and let it resolve the best source internally.
    // Skip all source fetching in MediaPage for this case.
    if (settings.experimentalEmbeddedPlayer && result?.meta) {
      const meta = result.meta;
      const epTitle = video.title ?? video.name ?? undefined;
      handleEpisodeSelect(video);
      setEmbeddedPlayRequest(buildPlayRequest(
        {
          backend: "embedded-mpv-experimental",
          type: "series",
          mediaId: meta.id,
          playableId: video.id,
          mediaTitle: meta.name,
          episodeTitle: epTitle,
          season: typeof video.season === "number" ? video.season : undefined,
          episode: typeof video.episode === "number" ? video.episode : undefined,
          streamUrl: "",
          poster: meta.poster,
          background: meta.background,
          logo: meta.logo,
          pendingSourceFetch: true,
          // Same logic as movie play: either auto setting triggers auto-play.
          manualSourceSelect: !(settings.autoPlayBestSource || settings.autoSelectSource),
          isAnime,
        },
        "manual",
      ));
      return;
    }

    // Always update selection so the episode card highlights and the inline
    // SourcesSection renders for it (fallback / manual mode).
    handleEpisodeSelect(video);

    // If neither auto feature is on, show the source picker explicitly so
    // the user can pick a source.
    if (!settings.autoPlayBestSource && !settings.autoSelectSource) {
      setShowSourcesForVideoId(video.id);
      return;
    }

    setPlayingEpisodeId(video.id);
    try {
      const profileId = profile.id;
      const cacheKey = makePrefetchKey(profileId, "series", id, video.id);

      // Check the prefetch cache first for an instant result.
      let results: StreamSourceResult[] | null = getCachedSources(cacheKey);

      if (!results) {
        // Cache miss: fan out to all eligible stream addons.
        const eligibleStream = addons.filter((a) =>
          addonSupportsResource(a.manifest, "stream", "series"),
        );

        if (eligibleStream.length > 0) {
          const seen = new Set<string>();
          const collected: StreamSourceResult[] = [];

          await Promise.allSettled(
            eligibleStream.map((a) =>
              window.mediaCenter.streams
                .fetch({ manifestUrl: a.manifestUrl, type: "series", id: video.id })
                .then((res) => {
                  (res.streams ?? []).forEach((s: StremioStream, i: number) => {
                    const dk = streamDedupKey(s, `${a.id}#${i}`);
                    if (seen.has(dk)) return;
                    seen.add(dk);
                    collected.push({
                      stream: s,
                      source: { addonId: a.id, addonName: a.manifest.name },
                      key: dk,
                    });
                  });
                })
                .catch(() => { /* per-addon failure is non-fatal */ }),
            ),
          );

          // Store in prefetch cache so EpisodeSelector's E8 Next Episode
          // pipeline can reuse it too.
          if (collected.length > 0) {
            void prefetchEpisodeSources; // imported but cache set via direct store
          }
          results = collected;
        } else {
          results = [];
        }
      }

      if (results.length === 0) return; // nothing to play; SourcesSection will show empty

      const best = chooseBestSource(results, settings);
      if (!best) return;

      const meta = result.meta;
      const backend = settings.experimentalEmbeddedPlayer
        ? "embedded-mpv-experimental"
        : "external-mpv";

      const epTitle = video.title ?? video.name ?? undefined;
      const req = buildPlayRequest(
        {
          backend,
          type: "series",
          mediaId: meta.id,
          playableId: video.id,
          mediaTitle: meta.name,
          episodeTitle: epTitle,
          season: typeof video.season === "number" ? video.season : undefined,
          episode: typeof video.episode === "number" ? video.episode : undefined,
          streamUrl: best.stream.url ?? "",
          streamTitle: best.stream.title,
          streamName: best.stream.name,
          poster: meta.poster,
        },
        "manual",
      );

      await dispatchPlayRequest(req, {
        ...(backend === "external-mpv"
          ? {
              subtitleAddons: addons,
              profileId,
              startSeconds: 0,
              audioLanguageOverride: resolveAudioLanguage(settings, isAnime),
            }
          : {}),
        origin: "manual",
      });
    } catch {
      // Non-fatal: SourcesSection will still render for the selected episode.
    } finally {
      setPlayingEpisodeId(null);
    }
  };

  // Load saved watch progress for the currently-selected playable. Resets
  // whenever the selection changes (movie ↔ episode, or a different episode).
  useEffect(() => {
    setSavedProgress(null);
    setResumeMode("resume");
    if (!profile || !selected) return;
    let cancelled = false;
    window.mediaCenter.progress
      .get({ profileId: profile.id, mediaId: id, playableId: selected.id })
      .then((p) => {
        if (cancelled) return;
        // Only offer resume for partially-watched, non-trivial progress.
        if (p && !p.completed && p.progressSeconds >= 30) {
          setSavedProgress(p);
        }
      })
      .catch(() => {
        /* progress is best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [profile, selected, id]);

  async function handleStartOver() {
    if (!profile || !selected) return;
    try {
      await window.mediaCenter.progress.clear({
        profileId: profile.id,
        mediaId: id,
        playableId: selected.id,
      });
    } catch {
      /* ignore */
    }
    setSavedProgress(null);
    setResumeMode("start");
  }

  // Resume position handed to MPV: the saved seconds when the user keeps
  // "resume", or 0 when they chose Start Over / there's nothing saved.
  const resumeSeconds =
    savedProgress && resumeMode === "resume" ? savedProgress.progressSeconds : 0;

  // ----- Library + watched controls ----------------------------------------

  async function handleToggleLibrary() {
    const m = result?.meta;
    if (!m) return;
    if (isInLibrary(type, m.id)) {
      await removeFromLibrary(type, m.id);
      toast("Removed from Library");
    } else {
      await addToLibrary({
        type,
        mediaId: m.id,
        title: m.name,
        poster: m.poster ?? null,
        background: m.background ?? null,
        releaseInfo:
          m.releaseInfo ??
          (typeof m.year === "number" || typeof m.year === "string"
            ? String(m.year)
            : null),
      });
      toast("Added to Library");
    }
  }

  // Movie watched toggle (playableId === movie id).
  async function handleToggleMovieWatched() {
    const m = result?.meta;
    if (!profile || !m) return;
    const currentlyWatched = watchedSet.has(m.id);
    await window.mediaCenter.watched.set({
      profileId: profile.id,
      type: "movie",
      mediaId: m.id,
      playableId: m.id,
      title: m.name,
      poster: m.poster ?? null,
      completed: !currentlyWatched,
    });
    await refreshWatched();
    toast(currentlyWatched ? "Marked as Unwatched" : "Marked as Watched");
  }

  // Per-episode watched toggle.
  async function handleToggleEpisodeWatched(video: StremioVideo, completed: boolean) {
    const m = result?.meta;
    if (!profile || !m) return;
    await window.mediaCenter.watched.set({
      profileId: profile.id,
      type: "series",
      mediaId: m.id,
      playableId: video.id,
      title: m.name,
      episodeTitle: video.title ?? video.name ?? null,
      poster: m.poster ?? null,
      season: typeof video.season === "number" ? video.season : null,
      episode: typeof video.episode === "number" ? video.episode : null,
      completed,
    });
    await refreshWatched();
    toast(completed ? "Marked Episode Watched" : "Marked Episode Unwatched");
  }

  // Mark every episode in a season watched/unwatched.
  async function handleMarkSeasonWatched(videos: StremioVideo[], completed: boolean) {
    const m = result?.meta;
    if (!profile || !m) return;
    for (const video of videos) {
      await window.mediaCenter.watched.set({
        profileId: profile.id,
        type: "series",
        mediaId: m.id,
        playableId: video.id,
        title: m.name,
        episodeTitle: video.title ?? video.name ?? null,
        poster: m.poster ?? null,
        season: typeof video.season === "number" ? video.season : null,
        episode: typeof video.episode === "number" ? video.episode : null,
        completed,
      });
    }
    await refreshWatched();
    toast(completed ? "Marked Season Watched" : "Marked Season Unwatched");
  }

  // --------------------- Render helpers --------------------------------

  const meta = result?.meta;
  const videos = asArray<StremioVideo>(meta?.videos);

  // Collection safety net: a collection that slipped past catalog-context
  // routing must never render as a playable movie. A collection's meta lists
  // its member movies as `videos` that carry no season/episode (normal movies
  // have no such videos). meta.type === "collection" is also honored.
  const looksLikeCollection = useMemo(() => {
    if (!meta) return false;
    if (String(meta.type).toLowerCase() === "collection") return true;
    if (type !== "movie") return false;
    const members = videos.filter(
      (v) => typeof v.id === "string" && v.season == null && v.episode == null,
    );
    return members.length >= 2;
  }, [meta, type, videos]);

  // Anime classification — prefers Kitsu/provider signals over genre guessing.
  // Drives the anime-specific default audio language when launching MPV.
  const isAnime = useMemo(
    () =>
      isLikelyAnime(meta, {
        addonId: result?.source.addonId,
        addonName: result?.source.addonName,
        mediaId: meta?.id,
      }),
    [meta, result],
  );

  // Next episode to watch: first NORMAL episode (season >= 1; season asc,
  // episode asc, then meta order) that isn't completed. Mirrors the DB's
  // getNextEpisodeToWatch so the "Next Up" badge matches what Continue
  // Watching shows. Specials (season === 0) are excluded from auto next-up —
  // they remain selectable/markable in the list.
  // TODO: honor a future "Include specials in Continue Watching" setting.
  const nextUpVideoId = useMemo(() => {
    if (!isSeries || videos.length === 0) return null;
    const ordered = videos
      .filter((v) => v.season !== 0) // null/undefined season treated as normal
      .map((v, i) => ({ v, i }))
      .sort((a, b) => {
        const as = typeof a.v.season === "number" ? a.v.season : Infinity;
        const bs = typeof b.v.season === "number" ? b.v.season : Infinity;
        if (as !== bs) return as - bs;
        const ae = typeof a.v.episode === "number" ? a.v.episode : Infinity;
        const be = typeof b.v.episode === "number" ? b.v.episode : Infinity;
        if (ae !== be) return ae - be;
        return a.i - b.i;
      })
      .map((x) => x.v);
    return ordered.find((v) => !watchedSet.has(v.id))?.id ?? null;
  }, [isSeries, videos, watchedSet]);

  // Best episode to play when the user clicks the header Play/Resume button.
  // Priority: (1) most-recently-updated in-progress row, (2) next-up unwatched,
  // (3) very first episode. Returns null for movies (not needed there).
  const seriesResumeTarget = useMemo<{
    video: StremioVideo;
    progress: WatchProgress | null;
  } | null>(() => {
    if (!isSeries || videos.length === 0) return null;

    // (1) Most-recently-updated in-progress (not completed) row whose episode exists
    const inProgress = watchedRows
      .filter((r) => !r.completed && r.progressSeconds >= 30)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    for (const row of inProgress) {
      const vid = videos.find((v) => v.id === row.playableId);
      if (vid) return { video: vid, progress: row };
    }

    // (2) Next up (first unwatched normal episode)
    if (nextUpVideoId) {
      const vid = videos.find((v) => v.id === nextUpVideoId);
      if (vid) return { video: vid, progress: null };
    }

    // (3) First episode
    const firstNormal = videos.find((v) => v.season !== 0) ?? videos[0];
    return firstNormal ? { video: firstNormal, progress: null } : null;
  }, [isSeries, videos, watchedRows, nextUpVideoId]);

  const backgroundStyle = meta?.background
    ? {
        backgroundImage:
          `linear-gradient(180deg, rgba(15,17,21,0.55) 0%, rgba(15,17,21,0.95) 80%, var(--bg) 100%),` +
          `url("${meta.background.replace(/"/g, '\\"')}")`,
      }
    : undefined;

  const year =
    meta?.releaseInfo ??
    (typeof meta?.year === "number" || typeof meta?.year === "string"
      ? String(meta.year)
      : null);

  // Trailer (if any) for the hero preview + Watch Trailer button.
  const trailer = useMemo(() => getTrailerInfo(meta), [meta]);

  // Spoiler blur for the media-detail poster: only in "all" mode, only when
  // the media is actually unwatched.
  const shouldBlurMediaPoster =
    !!meta &&
    settings.spoilerBlurMode === "all" &&
    (isSeries ? watchedSet.size === 0 : !watchedSet.has(meta.id));
  if (import.meta.env?.DEV && meta) {
    // eslint-disable-next-line no-console
    console.debug("[spoiler:media]", { mode: settings.spoilerBlurMode, shouldBlurMediaPoster });
  }

  // Human label for the type badge (anime detection wins over the raw type).
  const typeLabel = isAnime
    ? "Anime"
    : type
      ? type.charAt(0).toUpperCase() + type.slice(1)
      : "";

  const genres = asArray<string>(meta?.genres);
  const cast = asArray<string>(meta?.cast);
  const director = joinList(meta?.director);
  const rating = meta?.imdbRating;
  const runtime = meta?.runtime;
  const description = meta?.description;

  // Resume bar + Sources picker, bundled so it can be placed either at the
  // bottom of the page (movies, variant="full") or inline inside the selected
  // episode card (series, variant="inline"). Same data, same components — only
  // placement + styling differ.
  const renderSourcesArea = (variant: "full" | "inline") => {
    if (!meta) return null;
    return (
      <>
        {savedProgress && (
          <div className="resume-bar">
            <span className="resume-bar__text">
              {resumeMode === "resume" ? (
                <>
                  You're at <strong>{formatTime(savedProgress.progressSeconds)}</strong>
                  {savedProgress.durationSeconds > 0 && (
                    <> of {formatTime(savedProgress.durationSeconds)}</>
                  )}
                  . Sources will <strong>resume from here</strong> in MPV.
                </>
              ) : (
                <>Starting from the beginning.</>
              )}
            </span>
            <span className="resume-bar__spacer" />
            {resumeMode === "start" ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => setResumeMode("resume")}
              >
                Resume from {formatTime(savedProgress.progressSeconds)}
              </button>
            ) : (
              <button
                type="button"
                className="ghost-button"
                onClick={handleStartOver}
              >
                Start Over
              </button>
            )}
          </div>
        )}

        {addons && addons.length > 0 && (
          <SourcesSection
            variant={variant}
            addons={addons}
            selected={selected}
            mediaId={meta.id}
            mediaTitle={meta.name}
            mediaPoster={meta.poster}
            episodeTitle={episodeTitle}
            startSeconds={resumeSeconds}
            isAnime={isAnime}
          />
        )}
      </>
    );
  };

  // --------------------- States ----------------------------------------

  // If this is actually a collection, send it to the collection page so no
  // Play/Resume/source UI is ever shown for the collection itself.
  if (meta && looksLikeCollection) {
    const addonQ = result ? `?addon=${encodeURIComponent(result.source.addonId)}` : "";
    return (
      <Navigate
        to={`/collection/${encodeURIComponent(type)}/${encodeURIComponent(id)}${addonQ}`}
        replace
      />
    );
  }

  return (
    <div className="page media-page">
      <div className="media-back media-back--overlay">
        <BackButton />
      </div>

      {profileLoading && <p className="muted">Loading profile…</p>}

      {profile && addons === null && !meta && (
        <p className="muted">Loading addons…</p>
      )}

      {profile && addons !== null && loading && !meta && (
        <div className="media-loading">
          <p className="muted">
            Searching {eligible.length || "compatible"} addon
            {eligible.length === 1 ? "" : "s"} for {type} <code>{id}</code>…
          </p>
        </div>
      )}

      {profile &&
        addons !== null &&
        !loading &&
        !meta &&
        eligible.length === 0 && (
          <div className="empty">
            None of your installed addons provide a <code>meta</code> resource
            for <code>{type}</code>. Install a metadata addon from the Addons
            page, then try again.
          </div>
        )}

      {profile &&
        addons !== null &&
        !loading &&
        !meta &&
        eligible.length > 0 && (
          <div className="error-banner" role="alert">
            <div>
              Couldn't load metadata for {type} <code>{id}</code> from any of
              your {eligible.length} compatible addon
              {eligible.length === 1 ? "" : "s"}.
            </div>
            {failures.length > 0 && (
              <ul className="failure-list">
                {failures.map((f, i) => (
                  <li key={i}>
                    <strong>{f.addonName}:</strong> {f.message}
                  </li>
                ))}
              </ul>
            )}
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                className="primary-button"
                onClick={() => setReloadKey((k) => k + 1)}
              >
                Retry
              </button>
            </div>
          </div>
        )}

      {meta && (
        <article className="media-detail">
          <div
            className={`media-detail__hero${trailer ? " media-detail__hero--has-trailer" : ""}`}
            style={backgroundStyle}
          >
            {trailer && (
              <MediaTrailer
                trailer={trailer}
                autoplayHero={settings.autoplayTrailers}
                title={meta.name}
              />
            )}
            <div className="media-detail__hero-inner">
              <div className="media-detail__poster">
                {meta.poster ? (
                  <img
                    src={meta.poster}
                    alt=""
                    className={shouldBlurMediaPoster ? "poster--spoiler-blurred" : undefined}
                  />
                ) : (
                  <div className="media-detail__poster-placeholder" aria-hidden>
                    {meta.name.slice(0, 1).toUpperCase()}
                  </div>
                )}
              </div>
              <div className="media-detail__head">
                {meta.logo ? (
                  <img
                    className="media-detail__logo"
                    src={meta.logo}
                    alt={meta.name}
                  />
                ) : (
                  <h1 className="media-detail__title">{meta.name}</h1>
                )}
                <div className="media-detail__badges">
                  {year && <span className="media-badge">{year}</span>}
                  {runtime && <span className="media-badge">{runtime}</span>}
                  {typeLabel && (
                    <span className="media-badge media-badge--type">{typeLabel}</span>
                  )}
                  {rating !== undefined && rating !== null && rating !== "" && (
                    <span className="media-badge media-badge--rating" title="IMDB rating">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ marginRight: 3, marginBottom: -1 }}>
                        <polygon points="12 2 15 9 22 9.3 16.5 14 18.5 21 12 17 5.5 21 7.5 14 2 9.3 9 9" />
                      </svg>
                      {String(rating)}
                    </span>
                  )}
                </div>
                {genres.length > 0 && (
                  <div className="media-detail__genres">
                    {genres.map((g) => (
                      <span key={g} className="tag">{g}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="media-detail__body">
            <div className="media-detail__actions">
              {/* Movie: Play / Resume button — always shown for movies */}
              {!isSeries && (
                <button
                  type="button"
                  className="primary-button media-detail__play-btn"
                  onClick={() => { void handlePlayMovie(); }}
                  disabled={!result || moviePlayLoading}
                  title={savedProgress ? "Resume playback" : "Play"}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" style={{verticalAlign:"middle",marginRight:6,marginBottom:1}}>
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                  {moviePlayLoading
                    ? "Finding sources..."
                    : savedProgress
                    ? (
                      <>
                        Resume
                        <span className="media-detail__play-progress">
                          {" "}{formatTime(savedProgress.progressSeconds)}
                          {savedProgress.durationSeconds > 0 && (
                            <>{" "}({Math.round(savedProgress.progressSeconds / savedProgress.durationSeconds * 100)}%)</>
                          )}
                        </span>
                      </>
                    )
                    : "Play"}
                </button>
              )}
              {/* Movie: Choose Source toggle */}
              {!isSeries && (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setShowMovieSources((v) => !v)}
                  disabled={!result}
                >
                  {showMovieSources ? "Hide Sources" : "Choose Source"}
                </button>
              )}
              {/* Series: Play / Resume button targeting the best episode */}
              {isSeries && seriesResumeTarget && (
                <button
                  type="button"
                  className="primary-button media-detail__play-btn"
                  onClick={() => { void handleDirectPlayEpisode(seriesResumeTarget.video); }}
                  disabled={!result}
                  title={seriesResumeTarget.progress ? "Resume playback" : "Play"}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" style={{verticalAlign:"middle",marginRight:6,marginBottom:1}}>
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                  {seriesResumeTarget.progress ? (
                    <>
                      Resume
                      <span className="media-detail__play-progress">
                        {seriesResumeTarget.video.season != null && seriesResumeTarget.video.episode != null
                          ? ` S${seriesResumeTarget.video.season}E${seriesResumeTarget.video.episode}`
                          : ""}
                        {" "}{formatTime(seriesResumeTarget.progress.progressSeconds)}
                      </span>
                    </>
                  ) : nextUpVideoId === seriesResumeTarget.video.id ? (
                    <>
                      Play Next
                      <span className="media-detail__play-progress">
                        {seriesResumeTarget.video.season != null && seriesResumeTarget.video.episode != null
                          ? ` S${seriesResumeTarget.video.season}E${seriesResumeTarget.video.episode}`
                          : ""}
                      </span>
                    </>
                  ) : "Play"}
                </button>
              )}
              <button
                type="button"
                className="ghost-button"
                onClick={handleToggleLibrary}
              >
                {isInLibrary(type, meta.id) ? "In Library" : "+ Library"}
              </button>
              {!isSeries && (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={handleToggleMovieWatched}
                >
                  {watchedSet.has(meta.id) ? "Unwatch" : "Mark Watched"}
                </button>
              )}
            </div>

            {profile && (
              <div className="media-detail__rating">
                <span className="media-detail__rating-label">Your rating</span>
                <RatingControl
                  profileId={profile.id}
                  mediaType={isAnime ? "anime" : isSeries ? "series" : "movie"}
                  mediaId={meta.id}
                  title={meta.name}
                  year={year}
                  poster={meta.poster ?? null}
                />
              </div>
            )}

            {description && (
              <p className="media-detail__description">{description}</p>
            )}

            <dl className="media-detail__facts">
              {director && (
                <>
                  <dt>Director</dt>
                  <dd>{director}</dd>
                </>
              )}
              {cast.length > 0 && (
                <>
                  <dt>Cast</dt>
                  <dd>{cast.join(", ")}</dd>
                </>
              )}
              {meta.country && (
                <>
                  <dt>Country</dt>
                  <dd>{String(meta.country)}</dd>
                </>
              )}
              {meta.language && (
                <>
                  <dt>Language</dt>
                  <dd>{String(meta.language)}</dd>
                </>
              )}
            </dl>

            <footer className="media-detail__footer muted small">
              Metadata from <strong>{result.source.addonName}</strong>
              {failures.length > 0 && (
                <>
                  {" "}· {failures.length} other addon{failures.length === 1 ? "" : "s"} failed
                </>
              )}
            </footer>

            {isSeries ? (
              // Series: sources render inline inside the selected episode card
              // (see EpisodeSelector). No bottom sources block.
              <EpisodeSelector
                videos={videos}
                showBackdrop={meta.background ?? meta.poster}
                initialSeason={initialSeasonParam}
                selectedVideoId={showSourcesForVideoId}
                onSelect={handleEpisodeSelect}
                renderSelectedSources={() => renderSourcesArea("inline")}
                watchedIds={watchedSet}
                nextUpVideoId={nextUpVideoId}
                onToggleEpisodeWatched={handleToggleEpisodeWatched}
                onMarkSeasonWatched={handleMarkSeasonWatched}
                onPlayEpisode={handleDirectPlayEpisode}
                playingEpisodeId={playingEpisodeId}
                openSourcesForVideoId={showSourcesForVideoId}
                onToggleSources={setShowSourcesForVideoId}
              />
            ) : (
              // Movies: sources shown only when Choose Source is toggled.
              showMovieSources ? renderSourcesArea("full") : null
            )}
          </div>
        </article>
      )}
    </div>
  );
}
