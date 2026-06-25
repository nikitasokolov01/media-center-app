// SQLite storage layer for the media center MVP.
// Uses better-sqlite3 in the Electron main process. The database file lives in
// Electron's userData directory so it survives upgrades and is per-user.

import Database from "better-sqlite3";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";
import type { StremioManifest } from "../src/core/stremio/types.js";

export interface Profile {
  id: number;
  name: string;
  color?: string | null;
  emoji?: string | null;
  createdAt: string;
}

export interface AddonRow {
  id: string;
  profileId: number;
  manifestUrl: string;
  baseUrl: string;
  manifest: StremioManifest;
  installedAt: string;
}

let db: Database.Database | null = null;

function getDbPath(): string {
  const dir = app.getPath("userData");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "media-center.db");
}

/**
 * Initialize the database: open the file, run schema migrations, and ensure a
 * default profile exists. Idempotent — safe to call on every app start.
 */
export function initDb(): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS addons (
      id           TEXT    NOT NULL,
      profile_id   INTEGER NOT NULL,
      manifest_url TEXT    NOT NULL,
      base_url     TEXT    NOT NULL,
      manifest     TEXT    NOT NULL,
      installed_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (profile_id, id),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_addons_profile ON addons(profile_id);

    CREATE TABLE IF NOT EXISTS watch_progress (
      profile_id        INTEGER NOT NULL,
      media_id          TEXT    NOT NULL,
      playable_id       TEXT    NOT NULL,
      type              TEXT    NOT NULL,
      title             TEXT    NOT NULL,
      episode_title     TEXT,
      poster            TEXT,
      stream_title      TEXT,
      season            INTEGER,
      episode           INTEGER,
      progress_seconds  REAL    NOT NULL,
      duration_seconds  REAL    NOT NULL,
      updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (profile_id, media_id, playable_id),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_watch_progress_profile_updated
      ON watch_progress(profile_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS library_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id   INTEGER NOT NULL,
      type         TEXT    NOT NULL,
      media_id     TEXT    NOT NULL,
      title        TEXT    NOT NULL,
      poster       TEXT,
      background   TEXT,
      release_info TEXT,
      added_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (profile_id, type, media_id),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_library_profile
      ON library_items(profile_id, added_at DESC);

    -- Cached, ordered episode list per series so Continue Watching can compute
    -- the "next episode to watch" without re-fetching addon metadata. Global
    -- (episode lists are the same for every profile); refreshed whenever a
    -- series detail page loads.
    CREATE TABLE IF NOT EXISTS series_episodes (
      series_id TEXT    NOT NULL,
      video_id  TEXT    NOT NULL,
      season    INTEGER,
      episode   INTEGER,
      title     TEXT,
      position  INTEGER NOT NULL,
      PRIMARY KEY (series_id, video_id)
    );

    -- Per-profile source preference: remembers which source (by fingerprint)
    -- worked last time for a given movie/episode.  No direct stream URLs are
    -- stored here -- only stable identity metadata.
    CREATE TABLE IF NOT EXISTS source_prefs (
      profile_id   INTEGER NOT NULL,
      type         TEXT    NOT NULL,
      media_id     TEXT    NOT NULL,
      playable_id  TEXT    NOT NULL,
      addon_id     TEXT    NOT NULL,
      quality      TEXT    NOT NULL DEFAULT '',
      source_name  TEXT    NOT NULL DEFAULT '',
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (profile_id, type, media_id, playable_id),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    -- Local, per-profile media ratings (movies/series/anime). Rating is on a
    -- 1-10 scale (rendered as 5 half-step stars). No stream URLs are stored.
    CREATE TABLE IF NOT EXISTS media_ratings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id  INTEGER NOT NULL,
      media_type  TEXT    NOT NULL,
      media_id    TEXT    NOT NULL,
      title       TEXT    NOT NULL DEFAULT '',
      year        TEXT,
      poster      TEXT,
      rating      REAL    NOT NULL,
      rated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (profile_id, media_type, media_id),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_media_ratings_profile
      ON media_ratings(profile_id, media_type);
  `);

  // Migration: add `completed` to watch_progress if upgrading from an older
  // schema that predates IPC progress tracking. CREATE TABLE IF NOT EXISTS
  // won't add columns to an existing table, so we check + ALTER.
  const wpCols = db
    .prepare("PRAGMA table_info(watch_progress)")
    .all() as Array<{ name: string }>;
  if (!wpCols.some((c) => c.name === "completed")) {
    db.exec(
      "ALTER TABLE watch_progress ADD COLUMN completed INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!wpCols.some((c) => c.name === "cw_dismissed")) {
    db.exec(
      "ALTER TABLE watch_progress ADD COLUMN cw_dismissed INTEGER NOT NULL DEFAULT 0",
    );
  }

  // Migration: add avatar columns to profiles (color + emoji). Existing rows
  // keep NULL and render with a generated fallback color + initial.
  const profCols = db
    .prepare("PRAGMA table_info(profiles)")
    .all() as Array<{ name: string }>;
  if (!profCols.some((c) => c.name === "color")) {
    db.exec("ALTER TABLE profiles ADD COLUMN color TEXT");
  }
  if (!profCols.some((c) => c.name === "emoji")) {
    db.exec("ALTER TABLE profiles ADD COLUMN emoji TEXT");
  }

  ensureDefaultProfile();

  // One-time onboarding migration (additive; never wipes data). Existing
  // installs that already have addons/progress/library or extra profiles are
  // marked as onboarded so an upgrade never forces them through onboarding.
  // Fresh installs leave it false so onboarding shows. Only runs when the key
  // is absent, so a user-initiated "Reset onboarding" is never undone.
  try {
    if (getSetting("hasCompletedOnboarding") === null) {
      const count = (sql: string): number =>
        ((db!.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);
      const hasExistingData =
        count("SELECT COUNT(*) AS n FROM addons") > 0 ||
        count("SELECT COUNT(*) AS n FROM watch_progress") > 0 ||
        count("SELECT COUNT(*) AS n FROM library_items") > 0 ||
        count("SELECT COUNT(*) AS n FROM profiles") > 1;
      setSetting("hasCompletedOnboarding", hasExistingData ? "true" : "false");
    }
  } catch {
    /* non-fatal: onboarding will simply show if this fails */
  }

  return db;
}

function require_db(): Database.Database {
  if (!db) throw new Error("Database not initialized — call initDb() first");
  return db;
}

const PROFILE_SELECT =
  "SELECT id, name, color, emoji, created_at AS createdAt FROM profiles";

/** Create a "Default" profile on first launch if no profiles exist. */
export function ensureDefaultProfile(): Profile {
  const d = require_db();
  const existing = d
    .prepare(`${PROFILE_SELECT} ORDER BY id ASC LIMIT 1`)
    .get() as Profile | undefined;
  if (existing) return existing;

  const info = d
    .prepare("INSERT INTO profiles (name, color, emoji) VALUES (?, ?, ?)")
    .run("Default", "#6aa3ff", "🍿");
  return d
    .prepare(`${PROFILE_SELECT} WHERE id = ?`)
    .get(info.lastInsertRowid) as Profile;
}

export function getDefaultProfile(): Profile {
  // Either find one or create one — used by the UI on boot.
  return ensureDefaultProfile();
}

export function getProfile(id: number): Profile | null {
  const row = require_db()
    .prepare(`${PROFILE_SELECT} WHERE id = ?`)
    .get(id) as Profile | undefined;
  return row ?? null;
}

export function listProfiles(): Profile[] {
  return require_db()
    .prepare(`${PROFILE_SELECT} ORDER BY id ASC`)
    .all() as Profile[];
}

export interface CreateProfileInput {
  name: string;
  color?: string | null;
  emoji?: string | null;
}

export function createProfile(input: CreateProfileInput): Profile {
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("Profile name is required.");
  const d = require_db();
  try {
    const info = d
      .prepare("INSERT INTO profiles (name, color, emoji) VALUES (?, ?, ?)")
      .run(name, input.color ?? null, input.emoji ?? null);
    return getProfile(Number(info.lastInsertRowid))!;
  } catch (err) {
    // profiles.name is UNIQUE — surface a friendly message.
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      throw new Error(`A profile named "${name}" already exists.`);
    }
    throw err;
  }
}

export interface UpdateProfileInput {
  name?: string;
  color?: string | null;
  emoji?: string | null;
}

export function updateProfile(id: number, patch: UpdateProfileInput): Profile {
  const d = require_db();
  const existing = getProfile(id);
  if (!existing) throw new Error("Profile not found.");

  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("Profile name cannot be empty.");
    sets.push("name = @name");
    params.name = name;
  }
  if (patch.color !== undefined) {
    sets.push("color = @color");
    params.color = patch.color ?? null;
  }
  if (patch.emoji !== undefined) {
    sets.push("emoji = @emoji");
    params.emoji = patch.emoji ?? null;
  }
  if (sets.length === 0) return existing;

  try {
    d.prepare(`UPDATE profiles SET ${sets.join(", ")} WHERE id = @id`).run(params);
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      throw new Error("Another profile already uses that name.");
    }
    throw err;
  }
  return getProfile(id)!;
}

/**
 * Delete a profile. Refuses to remove the last remaining profile. Addons and
 * watch_progress rows are removed automatically via ON DELETE CASCADE.
 */
export function deleteProfile(id: number): { ok: boolean; error?: string } {
  const d = require_db();
  const count = (
    d.prepare("SELECT COUNT(*) AS c FROM profiles").get() as { c: number }
  ).c;
  if (count <= 1) {
    return { ok: false, error: "You can't delete the last remaining profile." };
  }
  const info = d.prepare("DELETE FROM profiles WHERE id = ?").run(id);
  return { ok: info.changes > 0 };
}

export interface UpsertAddonInput {
  profileId: number;
  manifestUrl: string;
  baseUrl: string;
  manifest: StremioManifest;
}

/**
 * Insert or replace an addon for a profile. Addons are keyed by (profileId,
 * manifest.id) so installing the same addon twice updates the stored copy.
 */
export function upsertAddon(input: UpsertAddonInput): AddonRow {
  const d = require_db();
  const id = input.manifest.id;
  d.prepare(
    `INSERT INTO addons (id, profile_id, manifest_url, base_url, manifest)
     VALUES (@id, @profileId, @manifestUrl, @baseUrl, @manifest)
     ON CONFLICT(profile_id, id) DO UPDATE SET
       manifest_url = excluded.manifest_url,
       base_url     = excluded.base_url,
       manifest     = excluded.manifest,
       installed_at = datetime('now')`,
  ).run({
    id,
    profileId: input.profileId,
    manifestUrl: input.manifestUrl,
    baseUrl: input.baseUrl,
    manifest: JSON.stringify(input.manifest),
  });

  return getAddon(input.profileId, id)!;
}

export function getAddon(profileId: number, id: string): AddonRow | null {
  const row = require_db()
    .prepare(
      `SELECT id, profile_id AS profileId, manifest_url AS manifestUrl,
              base_url AS baseUrl, manifest, installed_at AS installedAt
       FROM addons WHERE profile_id = ? AND id = ?`,
    )
    .get(profileId, id) as
    | (Omit<AddonRow, "manifest"> & { manifest: string })
    | undefined;
  if (!row) return null;
  return { ...row, manifest: JSON.parse(row.manifest) as StremioManifest };
}

export function listAddons(profileId: number): AddonRow[] {
  const rows = require_db()
    .prepare(
      `SELECT id, profile_id AS profileId, manifest_url AS manifestUrl,
              base_url AS baseUrl, manifest, installed_at AS installedAt
       FROM addons WHERE profile_id = ?
       ORDER BY installed_at DESC`,
    )
    .all(profileId) as Array<Omit<AddonRow, "manifest"> & { manifest: string }>;
  return rows.map((r) => ({
    ...r,
    manifest: JSON.parse(r.manifest) as StremioManifest,
  }));
}

export function removeAddon(profileId: number, id: string): boolean {
  const info = require_db()
    .prepare("DELETE FROM addons WHERE profile_id = ? AND id = ?")
    .run(profileId, id);
  return info.changes > 0;
}

// ----- Watch progress ------------------------------------------------------

export interface WatchProgress {
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
  completed: boolean;
  updatedAt: string;
}

export interface UpsertWatchProgressInput {
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
}

const PROGRESS_SELECT = `
  SELECT profile_id      AS profileId,
         type            AS type,
         media_id        AS mediaId,
         playable_id     AS playableId,
         title           AS title,
         episode_title   AS episodeTitle,
         poster          AS poster,
         stream_title    AS streamTitle,
         season          AS season,
         episode         AS episode,
         progress_seconds AS progressSeconds,
         duration_seconds AS durationSeconds,
         completed       AS completed,
         updated_at      AS updatedAt
  FROM watch_progress
`;

// better-sqlite3 returns INTEGER columns as numbers; normalize `completed`
// (0/1) to a boolean on the way out.
function rowToProgress(
  row: (Omit<WatchProgress, "completed"> & { completed: number }) | undefined,
): WatchProgress | null {
  if (!row) return null;
  return { ...row, completed: Boolean(row.completed) };
}

export function upsertWatchProgress(
  input: UpsertWatchProgressInput,
): WatchProgress {
  require_db()
    .prepare(
      `INSERT INTO watch_progress (
         profile_id, media_id, playable_id, type, title, episode_title,
         poster, stream_title, season, episode,
         progress_seconds, duration_seconds, completed, updated_at
       ) VALUES (
         @profileId, @mediaId, @playableId, @type, @title, @episodeTitle,
         @poster, @streamTitle, @season, @episode,
         @progressSeconds, @durationSeconds, @completed, datetime('now')
       )
       ON CONFLICT(profile_id, media_id, playable_id) DO UPDATE SET
         type             = excluded.type,
         title            = excluded.title,
         episode_title    = excluded.episode_title,
         poster           = excluded.poster,
         stream_title     = excluded.stream_title,
         season           = excluded.season,
         episode          = excluded.episode,
         progress_seconds = excluded.progress_seconds,
         duration_seconds = excluded.duration_seconds,
         completed        = excluded.completed,
         updated_at       = datetime('now')`,
    )
    .run({
      profileId: input.profileId,
      mediaId: input.mediaId,
      playableId: input.playableId,
      type: input.type,
      title: input.title,
      episodeTitle: input.episodeTitle ?? null,
      poster: input.poster ?? null,
      streamTitle: input.streamTitle ?? null,
      season: input.season ?? null,
      episode: input.episode ?? null,
      progressSeconds: input.progressSeconds,
      durationSeconds: input.durationSeconds,
      completed: input.completed ? 1 : 0,
    });

  return getWatchProgress(input.profileId, input.mediaId, input.playableId)!;
}

export function getWatchProgress(
  profileId: number,
  mediaId: string,
  playableId: string,
): WatchProgress | null {
  const row = require_db()
    .prepare(`${PROGRESS_SELECT} WHERE profile_id = ? AND media_id = ? AND playable_id = ?`)
    .get(profileId, mediaId, playableId) as
    | (Omit<WatchProgress, "completed"> & { completed: number })
    | undefined;
  return rowToProgress(row);
}

/**
 * Recent, still-in-progress items for the Continue Watching row. Excludes
 * completed items and anything with under 30s watched (avoids surfacing
 * accidental opens).
 */
export function listWatchProgress(
  profileId: number,
  limit = 20,
): WatchProgress[] {
  const rows = require_db()
    .prepare(
      `${PROGRESS_SELECT}
       WHERE profile_id = ?
         AND completed = 0
         AND cw_dismissed = 0
         AND progress_seconds >= 30
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(profileId, limit) as Array<
    Omit<WatchProgress, "completed"> & { completed: number }
  >;
  return rows.map((r) => rowToProgress(r)!);
}

export function clearWatchProgress(
  profileId: number,
  mediaId: string,
  playableId: string,
): boolean {
  const info = require_db()
    .prepare(
      `UPDATE watch_progress
       SET cw_dismissed = 1, updated_at = datetime('now')
       WHERE profile_id = ? AND media_id = ? AND playable_id = ?`,
    )
    .run(profileId, mediaId, playableId);
  return info.changes > 0;
}

/**
 * Clear the cw_dismissed flag so the item re-appears in Continue Watching.
 * Called once when a new play session starts (not from the periodic poll loop).
 */
export function reviveWatchProgress(
  profileId: number,
  mediaId: string,
  playableId: string,
): void {
  require_db()
    .prepare(
      `UPDATE watch_progress
       SET cw_dismissed = 0, updated_at = datetime('now')
       WHERE profile_id = ? AND media_id = ? AND playable_id = ?`,
    )
    .run(profileId, mediaId, playableId);
}

/**
 * Dismiss a movie or entire series from Continue Watching by setting
 * cw_dismissed=1 on ALL progress rows for that media_id (profile-scoped).
 * For movies this is one row; for series this covers every episode row.
 * The revive() call at playback start will restore the specific episode.
 */
export function dismissMediaFromContinueWatching(
  profileId: number,
  mediaId: string,
): void {
  require_db()
    .prepare(
      `UPDATE watch_progress
       SET cw_dismissed = 1, updated_at = datetime('now')
       WHERE profile_id = ? AND media_id = ?`,
    )
    .run(profileId, mediaId);
}

/** Reset progress to 0 and clear completed, keeping the row's metadata. */
export function resetWatchProgress(
  profileId: number,
  mediaId: string,
  playableId: string,
): boolean {
  const info = require_db()
    .prepare(
      `UPDATE watch_progress
       SET progress_seconds = 0, completed = 0, updated_at = datetime('now')
       WHERE profile_id = ? AND media_id = ? AND playable_id = ?`,
    )
    .run(profileId, mediaId, playableId);
  return info.changes > 0;
}

// ----- Watched state (reuses watch_progress.completed) ---------------------

export interface SetWatchedInput {
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
}

/**
 * Mark a movie or episode watched/unwatched.
 *  - Watched: set completed=1, preserving any existing progress/duration so a
 *    partially-watched item's position isn't lost.
 *  - Unwatched: set completed=0 AND reset progress to 0 so it doesn't reappear
 *    in Continue Watching as "in progress".
 * If no row exists yet (item never played), a minimal row is created.
 */
export function setWatched(input: SetWatchedInput): WatchProgress {
  const d = require_db();
  const existing = getWatchProgress(
    input.profileId,
    input.mediaId,
    input.playableId,
  );

  if (existing) {
    d.prepare(
      `UPDATE watch_progress
       SET completed = @completed,
           progress_seconds = @progress,
           updated_at = datetime('now')
       WHERE profile_id = @profileId AND media_id = @mediaId AND playable_id = @playableId`,
    ).run({
      completed: input.completed ? 1 : 0,
      // Keep position when marking watched; zero it when unwatching.
      progress: input.completed ? existing.progressSeconds : 0,
      profileId: input.profileId,
      mediaId: input.mediaId,
      playableId: input.playableId,
    });
  } else {
    upsertWatchProgress({
      profileId: input.profileId,
      type: input.type,
      mediaId: input.mediaId,
      playableId: input.playableId,
      title: input.title,
      episodeTitle: input.episodeTitle ?? null,
      poster: input.poster ?? null,
      streamTitle: null,
      season: input.season ?? null,
      episode: input.episode ?? null,
      progressSeconds: 0,
      durationSeconds: 0,
      completed: input.completed,
    });
  }

  return getWatchProgress(input.profileId, input.mediaId, input.playableId)!;
}

/**
 * All watch_progress rows for a given media (used for series episode badges
 * and computing overall series completion).
 */
export function listWatchedForMedia(
  profileId: number,
  mediaId: string,
): WatchProgress[] {
  const rows = require_db()
    .prepare(`${PROGRESS_SELECT} WHERE profile_id = ? AND media_id = ?`)
    .all(profileId, mediaId) as Array<
    Omit<WatchProgress, "completed"> & { completed: number }
  >;
  return rows.map((r) => rowToProgress(r)!);
}

// ----- Local media ratings (per profile) -------------------------------------

export type RatingMediaType = "movie" | "series" | "anime";

export interface MediaRating {
  id: number;
  profileId: number;
  mediaType: RatingMediaType;
  mediaId: string;
  title: string;
  year: string | null;
  poster: string | null;
  /** 1-10 scale (rendered as 5 half-step stars). */
  rating: number;
  ratedAt: string;
  updatedAt: string;
}

export interface SetRatingInput {
  profileId: number;
  mediaType: RatingMediaType;
  mediaId: string;
  title?: string;
  year?: string | null;
  poster?: string | null;
  rating: number;
}

const RATING_SELECT =
  "SELECT id, profile_id AS profileId, media_type AS mediaType, media_id AS mediaId, " +
  "title, year, poster, rating, rated_at AS ratedAt, updated_at AS updatedAt FROM media_ratings";

function clampRating(n: number): number {
  if (!Number.isFinite(n)) return 0;
  // 1-10, half steps.
  const r = Math.round(n * 2) / 2;
  return Math.min(10, Math.max(0.5, r));
}

export function getRating(
  profileId: number,
  mediaType: RatingMediaType,
  mediaId: string,
): MediaRating | null {
  const row = require_db()
    .prepare(`${RATING_SELECT} WHERE profile_id = ? AND media_type = ? AND media_id = ?`)
    .get(profileId, mediaType, mediaId) as MediaRating | undefined;
  return row ?? null;
}

export function setRating(input: SetRatingInput): MediaRating {
  const d = require_db();
  const rating = clampRating(input.rating);
  d.prepare(
    `INSERT INTO media_ratings (profile_id, media_type, media_id, title, year, poster, rating, rated_at, updated_at)
     VALUES (@profileId, @mediaType, @mediaId, @title, @year, @poster, @rating, datetime('now'), datetime('now'))
     ON CONFLICT(profile_id, media_type, media_id) DO UPDATE SET
       rating = excluded.rating,
       title = excluded.title,
       year = excluded.year,
       poster = excluded.poster,
       updated_at = datetime('now')`,
  ).run({
    profileId: input.profileId,
    mediaType: input.mediaType,
    mediaId: input.mediaId,
    title: input.title ?? "",
    year: input.year ?? null,
    poster: input.poster ?? null,
    rating,
  });
  return getRating(input.profileId, input.mediaType, input.mediaId)!;
}

export function clearRating(
  profileId: number,
  mediaType: RatingMediaType,
  mediaId: string,
): { ok: true } {
  require_db()
    .prepare("DELETE FROM media_ratings WHERE profile_id = ? AND media_type = ? AND media_id = ?")
    .run(profileId, mediaType, mediaId);
  return { ok: true };
}

/** All ratings for a profile, newest-updated first. Used for export. */
export function listRatings(profileId: number): MediaRating[] {
  return require_db()
    .prepare(`${RATING_SELECT} WHERE profile_id = ? ORDER BY updated_at DESC`)
    .all(profileId) as MediaRating[];
}

// ----- Series episode cache + "next episode to watch" ----------------------

export interface SeriesEpisodeInput {
  videoId: string;
  season?: number | null;
  episode?: number | null;
  title?: string | null;
}

export interface SeriesEpisode {
  videoId: string;
  season: number | null;
  episode: number | null;
  title: string | null;
  position: number;
}

/**
 * Replace the cached episode list for a series. Episodes are stored in
 * canonical watch order: season asc, then episode asc, falling back to the
 * incoming order when season/episode are missing.
 */
export function cacheSeriesEpisodes(
  seriesId: string,
  episodes: SeriesEpisodeInput[],
): void {
  if (!seriesId || !Array.isArray(episodes)) return;
  const d = require_db();
  const ordered = episodes
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const as = typeof a.e.season === "number" ? a.e.season : Number.POSITIVE_INFINITY;
      const bs = typeof b.e.season === "number" ? b.e.season : Number.POSITIVE_INFINITY;
      if (as !== bs) return as - bs;
      const ae = typeof a.e.episode === "number" ? a.e.episode : Number.POSITIVE_INFINITY;
      const be = typeof b.e.episode === "number" ? b.e.episode : Number.POSITIVE_INFINITY;
      if (ae !== be) return ae - be;
      return a.i - b.i;
    })
    .map((x) => x.e);

  const tx = d.transaction(() => {
    d.prepare("DELETE FROM series_episodes WHERE series_id = ?").run(seriesId);
    const ins = d.prepare(
      `INSERT INTO series_episodes (series_id, video_id, season, episode, title, position)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    ordered.forEach((e, position) => {
      ins.run(
        seriesId,
        e.videoId,
        typeof e.season === "number" ? e.season : null,
        typeof e.episode === "number" ? e.episode : null,
        e.title ?? null,
        position,
      );
    });
  });
  tx();
}

export function getSeriesEpisodes(seriesId: string): SeriesEpisode[] {
  return require_db()
    .prepare(
      `SELECT video_id AS videoId, season, episode, title, position
       FROM series_episodes WHERE series_id = ? ORDER BY position ASC`,
    )
    .all(seriesId) as SeriesEpisode[];
}

/**
 * The next NORMAL episode (season !== 0) after `currentVideoId` in canonical
 * position order. Used by the embedded player Next Episode pipeline to
 * determine what to preload — independent of watch state.
 * Returns null when `currentVideoId` is not found, is the last normal episode,
 * or the series has no cached episode data yet.
 */
export function getNextEpisodeAfter(
  seriesId: string,
  currentVideoId: string,
): SeriesEpisode | null {
  const eps = getSeriesEpisodes(seriesId).filter((e) => e.season !== 0);
  if (eps.length === 0) return null;
  const idx = eps.findIndex((e) => e.videoId === currentVideoId);
  if (idx === -1 || idx >= eps.length - 1) return null;
  return eps[idx + 1];
}

/**
 * The next episode a profile should watch for a series: the first NORMAL
 * episode (season >= 1, in canonical order) that isn't completed. Returns null
 * when the series has no cached normal episodes or every normal episode is
 * completed (series finished).
 *
 * Specials (season === 0) are excluded from automatic progression — they sort
 * before season 1 and would otherwise be picked as "next." They remain in the
 * episode list and can still be selected/marked manually.
 *
 * TODO: add an "Include specials in Continue Watching" setting that, when on,
 * would skip this `season !== 0` filter.
 */
export function getNextEpisodeToWatch(
  profileId: number,
  seriesId: string,
): SeriesEpisode | null {
  // season === 0 → special; null/undefined season is treated as normal so we
  // don't drop episodes that simply lack season metadata.
  const eps = getSeriesEpisodes(seriesId).filter((e) => e.season !== 0);
  if (eps.length === 0) return null;
  const completedRows = require_db()
    .prepare(
      "SELECT playable_id FROM watch_progress WHERE profile_id = ? AND media_id = ? AND completed = 1",
    )
    .all(profileId, seriesId) as Array<{ playable_id: string }>;
  const completed = new Set(completedRows.map((r) => r.playable_id));
  return eps.find((e) => !completed.has(e.videoId)) ?? null;
}

export interface SeriesLibraryStatusEpisode {
  id: string;
  season?: number | null;
  episode?: number | null;
  title?: string | null;
}

export interface SeriesLibraryStatus {
  status: "not_started" | "watching" | "watched";
  watchedCount: number;
  totalCount: number;
  nextEpisode?: SeriesLibraryStatusEpisode;
  lastWatchedEpisode?: SeriesLibraryStatusEpisode;
}

/**
 * Watched status for a series in the Library, based on NORMAL episodes only
 * (season > 0; specials are ignored). A series is "watched" only when every
 * normal episode is completed AND we actually have the episode list cached —
 * without that data we never report "watched", only "watching"/"not_started".
 */
export function getSeriesLibraryStatus(
  profileId: number,
  seriesId: string,
): SeriesLibraryStatus {
  const normal = getSeriesEpisodes(seriesId).filter((e) => e.season !== 0);

  const completedRows = require_db()
    .prepare(
      `SELECT playable_id AS videoId, season, episode, title
       FROM watch_progress
       WHERE profile_id = ? AND media_id = ? AND completed = 1`,
    )
    .all(profileId, seriesId) as Array<{
    videoId: string;
    season: number | null;
    episode: number | null;
    title: string | null;
  }>;
  // Specials don't count toward completion.
  const completedNormalRows = completedRows.filter((r) => r.season !== 0);
  const completedIds = new Set(completedNormalRows.map((r) => r.videoId));

  const totalCount = normal.length;
  let watchedCount: number;
  let nextEpisode: SeriesLibraryStatusEpisode | undefined;
  let lastWatchedEpisode: SeriesLibraryStatusEpisode | undefined;

  if (totalCount > 0) {
    const watchedNormal = normal.filter((e) => completedIds.has(e.videoId));
    watchedCount = watchedNormal.length;
    const next = normal.find((e) => !completedIds.has(e.videoId));
    if (next) {
      nextEpisode = {
        id: next.videoId,
        season: next.season,
        episode: next.episode,
        title: next.title,
      };
    }
    const last = watchedNormal[watchedNormal.length - 1];
    if (last) {
      lastWatchedEpisode = {
        id: last.videoId,
        season: last.season,
        episode: last.episode,
        title: last.title,
      };
    }
  } else {
    // No cached episode list — count completed rows but never claim "watched".
    watchedCount = completedNormalRows.length;
    const sorted = [...completedNormalRows].sort((a, b) => {
      const as = typeof a.season === "number" ? a.season : Infinity;
      const bs = typeof b.season === "number" ? b.season : Infinity;
      if (as !== bs) return as - bs;
      const ae = typeof a.episode === "number" ? a.episode : Infinity;
      const be = typeof b.episode === "number" ? b.episode : Infinity;
      return ae - be;
    });
    const last = sorted[sorted.length - 1];
    if (last) {
      lastWatchedEpisode = {
        id: last.videoId,
        season: last.season,
        episode: last.episode,
        title: last.title,
      };
    }
  }

  let status: SeriesLibraryStatus["status"];
  if (totalCount > 0 && watchedCount >= totalCount) status = "watched";
  else if (watchedCount > 0) status = "watching";
  else status = "not_started";

  return { status, watchedCount, totalCount, nextEpisode, lastWatchedEpisode };
}

/**
 * Continue Watching entries for a profile.
 *  - Movies: in-progress (completed=0, ≥30s) — unchanged.
 *  - Series: the next unwatched episode (advances as episodes complete). Shows
 *    that episode's progress if any, else 0. Series with every episode
 *    completed (or no remaining episode) drop off the list.
 * Falls back to the old "show in-progress episode" behavior when a series has
 * no cached episode list yet.
 */
export function listContinueWatching(
  profileId: number,
  limit = 20,
): WatchProgress[] {
  const allRows = (
    require_db()
      .prepare(`${PROGRESS_SELECT} WHERE profile_id = ? AND cw_dismissed = 0 ORDER BY updated_at DESC`)
      .all(profileId) as Array<Omit<WatchProgress, "completed"> & { completed: number }>
  ).map((r) => rowToProgress(r)!);

  const entries: WatchProgress[] = [];
  const handledSeries = new Set<string>();

  for (const row of allRows) {
    if (row.type === "movie") {
      if (!row.completed && row.progressSeconds >= 30) entries.push(row);
      continue;
    }

    // Series — process each show once, driven by its most-recent row.
    if (handledSeries.has(row.mediaId)) continue;
    handledSeries.add(row.mediaId);

    const cached = getSeriesEpisodes(row.mediaId);
    if (cached.length === 0) {
      // No cache yet → fall back to surfacing the in-progress episode.
      const inProg = allRows.find(
        (r) =>
          r.type === "series" &&
          r.mediaId === row.mediaId &&
          !r.completed &&
          r.progressSeconds >= 30,
      );
      if (inProg) entries.push(inProg);
      continue;
    }

    const next = getNextEpisodeToWatch(profileId, row.mediaId);
    if (!next) continue; // every episode completed → series finished

    const existing = getWatchProgress(profileId, row.mediaId, next.videoId);
    entries.push({
      profileId,
      type: "series",
      mediaId: row.mediaId,
      playableId: next.videoId,
      title: row.title, // show title (row is the most recent for this series)
      episodeTitle: next.title ?? existing?.episodeTitle ?? null,
      poster: row.poster ?? null,
      streamTitle: null,
      season: next.season,
      episode: next.episode,
      progressSeconds:
        existing && !existing.completed ? existing.progressSeconds : 0,
      durationSeconds: existing?.durationSeconds ?? 0,
      completed: false,
      updatedAt: row.updatedAt,
    });
  }

  entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return entries.slice(0, limit);
}

// ----- Library / Watchlist -------------------------------------------------

export interface LibraryItem {
  id: number;
  profileId: number;
  type: string;
  mediaId: string;
  title: string;
  poster?: string | null;
  background?: string | null;
  releaseInfo?: string | null;
  addedAt: string;
  updatedAt: string;
}

export interface AddLibraryItemInput {
  profileId: number;
  type: string;
  mediaId: string;
  title: string;
  poster?: string | null;
  background?: string | null;
  releaseInfo?: string | null;
}

const LIBRARY_SELECT = `
  SELECT id, profile_id AS profileId, type, media_id AS mediaId, title,
         poster, background, release_info AS releaseInfo,
         added_at AS addedAt, updated_at AS updatedAt
  FROM library_items
`;

export function addLibraryItem(input: AddLibraryItemInput): LibraryItem {
  require_db()
    .prepare(
      `INSERT INTO library_items
         (profile_id, type, media_id, title, poster, background, release_info)
       VALUES (@profileId, @type, @mediaId, @title, @poster, @background, @releaseInfo)
       ON CONFLICT(profile_id, type, media_id) DO UPDATE SET
         title        = excluded.title,
         poster       = excluded.poster,
         background   = excluded.background,
         release_info = excluded.release_info,
         updated_at   = datetime('now')`,
    )
    .run({
      profileId: input.profileId,
      type: input.type,
      mediaId: input.mediaId,
      title: input.title,
      poster: input.poster ?? null,
      background: input.background ?? null,
      releaseInfo: input.releaseInfo ?? null,
    });
  return getLibraryItem(input.profileId, input.type, input.mediaId)!;
}

export function removeLibraryItem(
  profileId: number,
  type: string,
  mediaId: string,
): boolean {
  const info = require_db()
    .prepare(
      "DELETE FROM library_items WHERE profile_id = ? AND type = ? AND media_id = ?",
    )
    .run(profileId, type, mediaId);
  return info.changes > 0;
}

export function getLibraryItem(
  profileId: number,
  type: string,
  mediaId: string,
): LibraryItem | null {
  const row = require_db()
    .prepare(`${LIBRARY_SELECT} WHERE profile_id = ? AND type = ? AND media_id = ?`)
    .get(profileId, type, mediaId) as LibraryItem | undefined;
  return row ?? null;
}

export function listLibrary(profileId: number): LibraryItem[] {
  return require_db()
    .prepare(`${LIBRARY_SELECT} WHERE profile_id = ? ORDER BY added_at DESC`)
    .all(profileId) as LibraryItem[];
}

// ----- App settings (global key-value) -------------------------------------

export type DefaultPlayerSetting = "browser" | "mpv";

export type PreferredSourceQuality =
  | "best"
  | "2160p"
  | "1080p"
  | "720p"
  | "first";

const PREFERRED_QUALITIES: PreferredSourceQuality[] = [
  "best",
  "2160p",
  "1080p",
  "720p",
  "first",
];

export interface AppSettings {
  defaultPlayer: DefaultPlayerSetting;
  mpvPath: string;
  /**
   * When true, try to turn subtitles ON after MPV starts (selecting the
   * preferred language if available). When false, all subtitle tracks are
   * still auto-loaded into MPV but start disabled.
   */
  autoEnableSubtitles: boolean;
  /**
   * Preferred subtitle language. Accepts loose values like "en", "eng",
   * "English". Empty string means "no preference" (MPV's default ordering).
   */
  subtitleLanguage: string;
  /**
   * Preferred audio language. Accepts loose values like "ja", "jpn",
   * "Japanese". Empty string means original/auto (MPV's default).
   */
  audioLanguage: string;
  /**
   * Anime-specific preferred audio language. "" = use the global default;
   * "auto"/"original" = keep MPV's default; otherwise a loose lang value
   * ("ja"/"jpn"/"Japanese"). Only applied when the media is classified anime.
   */
  animeAudioLanguage: string;
  /** When true, rank sources and surface a "Play Best Source" affordance. */
  autoSelectSource: boolean;
  /**
   * When true, automatically launch the best ranked source in MPV once sources
   * load for a movie/selected episode (no click needed). Depends on ranking.
   */
  autoPlayBestSource: boolean;
  /** Which quality the auto-selector targets. */
  preferredSourceQuality: PreferredSourceQuality;
  /** When true, CAM/TS sources are deprioritized (chosen only as a last resort). */
  hideCamSources: boolean;
  /**
   * EXPERIMENTAL: enables the embedded libmpv canvas player route. Default off.
   * Has no effect on the default external-MPV player; purely gates the
   * /experimental-embedded-player page + sidebar link.
   */
  experimentalEmbeddedPlayer: boolean;
  /**
   * UI theme. One of the built-in theme IDs ("default-dark", "oled-black",
   * "purple", "blue", "red") or "" for the default.
   */
  themeId: string;
  /**
   * Accent color override as a hex string (e.g. "#ff6b6b"). Empty string means
   * "use the theme's built-in accent colour".
   */
  accentColor: string;
  /**
   * User-supplied custom CSS injected after all built-in styles. Local only —
   * no remote imports are allowed. Applied via <style id="custom-user-css">.
   */
  customCss: string;
  /**
   * Poster/card corner radius preset.
   * "square" | "soft" | "rounded" | "pill". Default "soft".
   */
  posterRadius: string;
  /**
   * Background style override. "" | "oled-black" | "subtle-gradient" |
   * "neon-gradient" | "custom-solid". Default "" (use theme default).
   */
  backgroundStyle: string;
  /** Custom background solid color (hex). Used when backgroundStyle="custom-solid". */
  customBackgroundColor: string;
  /** Custom background gradient CSS value. Used when backgroundStyle="custom-gradient". */
  customBackgroundGradient: string;
  /** Gradient background color A (hex). Applied when backgroundStyle is subtle/neon-gradient. */
  bgGradientColorA: string;
  /** Gradient background color B (hex). Applied when backgroundStyle is subtle/neon-gradient. */
  bgGradientColorB: string;
  /** Gradient angle in degrees for the gradient background. Default 135. */
  bgGradientAngle: number;
  /** JSON-serialised CustomThemePreset[] -- user-defined named colour themes. */
  customThemes: string;
  /** ID of the currently applied custom theme preset (from customThemes), or empty. */
  activeCustomThemeId: string;
  /**
   * Home hero source mode.
   * "auto" = pick from first available catalogs (default).
   * "catalog" = use the addon/catalog identified by heroAddonId + heroCatalogType + heroCatalogId.
   */
  heroSourceMode: "auto" | "catalog";
  /** Addon ID for hero catalog mode. */
  heroAddonId: string;
  /** Catalog type for hero catalog mode ("movie" | "series" | …). */
  heroCatalogType: string;
  /** Catalog ID for hero catalog mode. */
  heroCatalogId: string;
  /** Absolute path to the copied custom background image in userData/backgrounds/. Empty = none. */
  customBackgroundImagePath: string;
  /** Background image fit mode: "cover" | "contain". Default "cover". */
  customBackgroundImageFit: string;
  /** Background image position: "center" | "top" | "bottom". Default "center". */
  customBackgroundImagePosition: string;
  /** Dim overlay opacity (0-0.85). Default 0.45. */
  customBackgroundImageDim: number;
  /** Blur radius in px (0-20). Default 0. */
  customBackgroundImageBlur: number;
  /** Autoplay a muted trailer preview in the media detail hero. Default true. */
  autoplayTrailers: boolean;
  /** Poster/card size preset: "compact" | "normal" | "large" | "xlarge". Default "normal". */
  posterScale: "compact" | "normal" | "large" | "xlarge";
  /** Poster/card layout: "portrait" | "landscape" | "auto". Default "portrait". */
  posterLayout: "portrait" | "landscape" | "auto";
  /** Card spacing density: "compact" | "comfortable" | "cinematic". Default "comfortable". */
  rowDensity: "compact" | "comfortable" | "cinematic";
  /** Prefer same source group for next-episode auto-selection. Default true. */
  preferBingeGroup: boolean;
  /** JSON map of catalog display-name overrides keyed by addonId::type::catalogId. Default "{}". */
  catalogNameOverrides: string;
  /** Whether first-launch onboarding has been completed. Default false (fresh installs). */
  hasCompletedOnboarding: boolean;
  /** Spoiler-blur mode: "off" | "episodes" | "all". Default "off". */
  spoilerBlurMode: "off" | "episodes" | "all";
}

const DEFAULTS: AppSettings = {
  defaultPlayer: "mpv",
  mpvPath: "mpv",
  autoEnableSubtitles: false,
  subtitleLanguage: "en",
  audioLanguage: "",
  animeAudioLanguage: "",
  autoSelectSource: false,
  autoPlayBestSource: false,
  preferredSourceQuality: "best",
  hideCamSources: true,
  experimentalEmbeddedPlayer: true,
  themeId: "",
  accentColor: "",
  customCss: "",
  posterRadius: "soft",
  backgroundStyle: "",
  bgGradientColorA: "#0a0d14",
  bgGradientColorB: "#111520",
  bgGradientAngle: 135,
  customBackgroundColor: "",
  customBackgroundGradient: "",
  customThemes: "[]",
  activeCustomThemeId: "",
  heroSourceMode: "auto",
  heroAddonId: "",
  heroCatalogType: "",
  heroCatalogId: "",
  customBackgroundImagePath: "",
  customBackgroundImageFit: "cover",
  customBackgroundImagePosition: "center",
  customBackgroundImageDim: 0.45,
  customBackgroundImageBlur: 0,
  autoplayTrailers: true,
  posterScale: "normal",
  posterLayout: "portrait",
  rowDensity: "comfortable",
  preferBingeGroup: true,
  catalogNameOverrides: "{}",
  hasCompletedOnboarding: false,
  spoilerBlurMode: "off",
};

export function getSetting(key: string): string | null {
  const row = require_db()
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  require_db()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')`,
    )
    .run(key, value);
}

export function getAppSettings(): AppSettings {
  const dp = getSetting("defaultPlayer");
  const mpv = getSetting("mpvPath");
  const autoSubs = getSetting("autoEnableSubtitles");
  const subLang = getSetting("subtitleLanguage");
  const audLang = getSetting("audioLanguage");
  const animeAud = getSetting("animeAudioLanguage");
  const autoSel = getSetting("autoSelectSource");
  const autoPlay = getSetting("autoPlayBestSource");
  const prefQ = getSetting("preferredSourceQuality");
  const hideCam = getSetting("hideCamSources");
  const embedded = getSetting("experimentalEmbeddedPlayer");
  return {
    defaultPlayer: dp === "browser" ? "browser" : DEFAULTS.defaultPlayer,
    mpvPath: mpv && mpv.trim().length > 0 ? mpv : DEFAULTS.mpvPath,
    // Stored as "true"/"false"; absent → default.
    autoEnableSubtitles:
      autoSubs === null ? DEFAULTS.autoEnableSubtitles : autoSubs === "true",
    // Empty string is a meaningful value (no preference), so only fall back to
    // the default when the key is entirely absent.
    subtitleLanguage: subLang === null ? DEFAULTS.subtitleLanguage : subLang,
    audioLanguage: audLang === null ? DEFAULTS.audioLanguage : audLang,
    animeAudioLanguage:
      animeAud === null ? DEFAULTS.animeAudioLanguage : animeAud,
    autoSelectSource:
      autoSel === null ? DEFAULTS.autoSelectSource : autoSel === "true",
    autoPlayBestSource:
      autoPlay === null ? DEFAULTS.autoPlayBestSource : autoPlay === "true",
    preferredSourceQuality: PREFERRED_QUALITIES.includes(
      prefQ as PreferredSourceQuality,
    )
      ? (prefQ as PreferredSourceQuality)
      : DEFAULTS.preferredSourceQuality,
    hideCamSources:
      hideCam === null ? DEFAULTS.hideCamSources : hideCam === "true",
    experimentalEmbeddedPlayer:
      embedded === null
        ? DEFAULTS.experimentalEmbeddedPlayer
        : embedded === "true",
    themeId:     getSetting("themeId")     ?? DEFAULTS.themeId,
    accentColor: getSetting("accentColor") ?? DEFAULTS.accentColor,
    customCss:   getSetting("customCss")   ?? DEFAULTS.customCss,
    posterRadius:            getSetting("posterRadius")            ?? DEFAULTS.posterRadius,
    backgroundStyle:         getSetting("backgroundStyle")         ?? DEFAULTS.backgroundStyle,
    bgGradientColorA:        getSetting("bgGradientColorA")        ?? DEFAULTS.bgGradientColorA,
    bgGradientColorB:        getSetting("bgGradientColorB")        ?? DEFAULTS.bgGradientColorB,
    bgGradientAngle:         Number(getSetting("bgGradientAngle")  ?? DEFAULTS.bgGradientAngle),
    customBackgroundColor:   getSetting("customBackgroundColor")   ?? DEFAULTS.customBackgroundColor,
    customBackgroundGradient: getSetting("customBackgroundGradient") ?? DEFAULTS.customBackgroundGradient,
    customThemes: getSetting("customThemes") ?? DEFAULTS.customThemes,
    activeCustomThemeId: getSetting("activeCustomThemeId") ?? DEFAULTS.activeCustomThemeId,
    heroSourceMode:
      getSetting("heroSourceMode") === "catalog" ? "catalog" : DEFAULTS.heroSourceMode,
    heroAddonId: getSetting("heroAddonId") ?? DEFAULTS.heroAddonId,
    heroCatalogType: getSetting("heroCatalogType") ?? DEFAULTS.heroCatalogType,
    heroCatalogId: getSetting("heroCatalogId") ?? DEFAULTS.heroCatalogId,
    customBackgroundImagePath: getSetting("customBackgroundImagePath") ?? DEFAULTS.customBackgroundImagePath,
    customBackgroundImageFit: getSetting("customBackgroundImageFit") ?? DEFAULTS.customBackgroundImageFit,
    customBackgroundImagePosition: getSetting("customBackgroundImagePosition") ?? DEFAULTS.customBackgroundImagePosition,
    customBackgroundImageDim: Number(getSetting("customBackgroundImageDim") ?? DEFAULTS.customBackgroundImageDim),
    customBackgroundImageBlur: Number(getSetting("customBackgroundImageBlur") ?? DEFAULTS.customBackgroundImageBlur),
    autoplayTrailers:
      getSetting("autoplayTrailers") === null
        ? DEFAULTS.autoplayTrailers
        : getSetting("autoplayTrailers") === "true",
    posterScale: (["compact", "normal", "large", "xlarge"].includes(
      getSetting("posterScale") ?? "",
    )
      ? getSetting("posterScale")
      : DEFAULTS.posterScale) as AppSettings["posterScale"],
    posterLayout: (["portrait", "landscape", "auto"].includes(
      getSetting("posterLayout") ?? "",
    )
      ? getSetting("posterLayout")
      : DEFAULTS.posterLayout) as AppSettings["posterLayout"],
    rowDensity: (["compact", "comfortable", "cinematic"].includes(
      getSetting("rowDensity") ?? "",
    )
      ? getSetting("rowDensity")
      : DEFAULTS.rowDensity) as AppSettings["rowDensity"],
    preferBingeGroup:
      getSetting("preferBingeGroup") === null
        ? DEFAULTS.preferBingeGroup
        : getSetting("preferBingeGroup") === "true",
    catalogNameOverrides: getSetting("catalogNameOverrides") ?? DEFAULTS.catalogNameOverrides,
    hasCompletedOnboarding: getSetting("hasCompletedOnboarding") === "true",
    spoilerBlurMode: (["off", "episodes", "all"].includes(getSetting("spoilerBlurMode") ?? "")
      ? getSetting("spoilerBlurMode")
      : DEFAULTS.spoilerBlurMode) as AppSettings["spoilerBlurMode"],
  };
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  if (patch.defaultPlayer !== undefined) {
    const v = patch.defaultPlayer === "browser" ? "browser" : "mpv";
    setSetting("defaultPlayer", v);
  }
  if (patch.mpvPath !== undefined) {
    setSetting("mpvPath", patch.mpvPath);
  }
  if (patch.autoEnableSubtitles !== undefined) {
    setSetting("autoEnableSubtitles", patch.autoEnableSubtitles ? "true" : "false");
  }
  if (patch.subtitleLanguage !== undefined) {
    setSetting("subtitleLanguage", patch.subtitleLanguage);
  }
  if (patch.audioLanguage !== undefined) {
    setSetting("audioLanguage", patch.audioLanguage);
  }
  if (patch.animeAudioLanguage !== undefined) {
    setSetting("animeAudioLanguage", patch.animeAudioLanguage);
  }
  if (patch.autoSelectSource !== undefined) {
    setSetting("autoSelectSource", patch.autoSelectSource ? "true" : "false");
  }
  if (patch.autoPlayBestSource !== undefined) {
    setSetting("autoPlayBestSource", patch.autoPlayBestSource ? "true" : "false");
  }
  if (patch.preferredSourceQuality !== undefined) {
    const v = PREFERRED_QUALITIES.includes(patch.preferredSourceQuality)
      ? patch.preferredSourceQuality
      : DEFAULTS.preferredSourceQuality;
    setSetting("preferredSourceQuality", v);
  }
  if (patch.experimentalEmbeddedPlayer !== undefined) {
    setSetting(
      "experimentalEmbeddedPlayer",
      patch.experimentalEmbeddedPlayer ? "true" : "false",
    );
  }
  if (patch.hideCamSources !== undefined) {
    setSetting("hideCamSources", patch.hideCamSources ? "true" : "false");
  }
  if (patch.themeId !== undefined) {
    setSetting("themeId", patch.themeId);
  }
  if (patch.accentColor !== undefined) {
    setSetting("accentColor", patch.accentColor);
  }
  if (patch.customCss !== undefined) {
    setSetting("customCss", patch.customCss);
  }
  if (patch.posterRadius !== undefined) {
    setSetting("posterRadius", patch.posterRadius);
  }
  if (patch.backgroundStyle !== undefined) {
    setSetting("backgroundStyle", patch.backgroundStyle);
  }
  if (patch.bgGradientColorA !== undefined) {
    setSetting("bgGradientColorA", patch.bgGradientColorA);
  }
  if (patch.bgGradientColorB !== undefined) {
    setSetting("bgGradientColorB", patch.bgGradientColorB);
  }
  if (patch.bgGradientAngle !== undefined) {
    setSetting("bgGradientAngle", String(patch.bgGradientAngle));
  }
  if (patch.customBackgroundColor !== undefined) {
    setSetting("customBackgroundColor", patch.customBackgroundColor);
  }
  if (patch.customBackgroundGradient !== undefined) {
    setSetting("customBackgroundGradient", patch.customBackgroundGradient);
  }
  if (patch.customThemes !== undefined) {
    setSetting("customThemes", patch.customThemes);
  }
  if (patch.activeCustomThemeId !== undefined) {
    setSetting("activeCustomThemeId", patch.activeCustomThemeId);
  }
  if (patch.heroSourceMode !== undefined) {
    setSetting("heroSourceMode", patch.heroSourceMode);
  }
  if (patch.heroAddonId !== undefined) {
    setSetting("heroAddonId", patch.heroAddonId);
  }
  if (patch.heroCatalogType !== undefined) {
    setSetting("heroCatalogType", patch.heroCatalogType);
  }
  if (patch.heroCatalogId !== undefined) {
    setSetting("heroCatalogId", patch.heroCatalogId);
  }
  if (patch.customBackgroundImagePath !== undefined) {
    setSetting("customBackgroundImagePath", patch.customBackgroundImagePath);
  }
  if (patch.customBackgroundImageFit !== undefined) {
    setSetting("customBackgroundImageFit", patch.customBackgroundImageFit);
  }
  if (patch.customBackgroundImagePosition !== undefined) {
    setSetting("customBackgroundImagePosition", patch.customBackgroundImagePosition);
  }
  if (patch.customBackgroundImageDim !== undefined) {
    setSetting("customBackgroundImageDim", String(patch.customBackgroundImageDim));
  }
  if (patch.customBackgroundImageBlur !== undefined) {
    setSetting("customBackgroundImageBlur", String(patch.customBackgroundImageBlur));
  }
  if (patch.autoplayTrailers !== undefined) {
    setSetting("autoplayTrailers", patch.autoplayTrailers ? "true" : "false");
  }
  if (patch.posterScale !== undefined) {
    setSetting("posterScale", patch.posterScale);
  }
  if (patch.posterLayout !== undefined) {
    setSetting("posterLayout", patch.posterLayout);
  }
  if (patch.rowDensity !== undefined) {
    setSetting("rowDensity", patch.rowDensity);
  }
  if (patch.preferBingeGroup !== undefined) {
    setSetting("preferBingeGroup", patch.preferBingeGroup ? "true" : "false");
  }
  if (patch.catalogNameOverrides !== undefined) {
    setSetting("catalogNameOverrides", patch.catalogNameOverrides);
  }
  if (patch.hasCompletedOnboarding !== undefined) {
    setSetting("hasCompletedOnboarding", patch.hasCompletedOnboarding ? "true" : "false");
  }
  if (patch.spoilerBlurMode !== undefined) {
    setSetting("spoilerBlurMode", patch.spoilerBlurMode);
  }
  return getAppSettings();
}

// ---- Source Preferences (Phase 3: remember last successful source) ----------

export interface SourcePref {
  profileId: number;
  type: string;
  mediaId: string;
  playableId: string;
  addonId: string;
  quality: string;
  sourceName: string;
}

export function saveSourcePref(input: SourcePref): void {
  require_db()
    .prepare(
      `INSERT INTO source_prefs (
         profile_id, type, media_id, playable_id, addon_id, quality, source_name, updated_at
       ) VALUES (
         @profileId, @type, @mediaId, @playableId, @addonId, @quality, @sourceName, datetime('now')
       )
       ON CONFLICT(profile_id, type, media_id, playable_id) DO UPDATE SET
         addon_id    = excluded.addon_id,
         quality     = excluded.quality,
         source_name = excluded.source_name,
         updated_at  = datetime('now')`,
    )
    .run({
      profileId:  input.profileId,
      type:       input.type,
      mediaId:    input.mediaId,
      playableId: input.playableId,
      addonId:    input.addonId,
      quality:    input.quality,
      sourceName: input.sourceName,
    });
}

export function getSourcePref(
  profileId: number,
  type: string,
  mediaId: string,
  playableId: string,
): SourcePref | null {
  const row = require_db()
    .prepare(
      `SELECT profile_id AS profileId, type, media_id AS mediaId,
              playable_id AS playableId, addon_id AS addonId,
              quality, source_name AS sourceName
       FROM source_prefs
       WHERE profile_id = ? AND type = ? AND media_id = ? AND playable_id = ?`,
    )
    .get(profileId, type, mediaId, playableId) as SourcePref | undefined;
  return row ?? null;
}
