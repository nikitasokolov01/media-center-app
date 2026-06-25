// Local, per-profile rating control. 5 half-step stars mapped to a 1-10 scale
// (full star = 2 points, half star = 1). Set / update / clear; persists in
// SQLite via window.mediaCenter.ratings. No playback/source interaction.

import { useEffect, useState } from "react";

interface RatingControlProps {
  profileId: number;
  mediaType: "movie" | "series" | "anime";
  mediaId: string;
  title: string;
  year?: string | null;
  poster?: string | null;
}

const STAR_COUNT = 5; // each star = 2 points on the 1-10 scale

function StarSvg({ fill }: { fill: "full" | "half" | "empty" }) {
  // Use a gradient for the half state.
  const id = `half-${Math.random().toString(36).slice(2, 8)}`;
  const fillColor =
    fill === "full" ? "var(--color-accent, #6aa3ff)" : "transparent";
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
      {fill === "half" && (
        <defs>
          <linearGradient id={id}>
            <stop offset="50%" stopColor="var(--color-accent, #6aa3ff)" />
            <stop offset="50%" stopColor="transparent" />
          </linearGradient>
        </defs>
      )}
      <polygon
        points="12 2 15 9 22 9.3 16.5 14 18.5 21 12 17 5.5 21 7.5 14 2 9.3 9 9"
        fill={fill === "half" ? `url(#${id})` : fillColor}
        stroke="var(--color-accent, #6aa3ff)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function RatingControl({
  profileId,
  mediaType,
  mediaId,
  title,
  year,
  poster,
}: RatingControlProps) {
  const [rating, setRating] = useState<number | null>(null); // 1-10, or null
  const [hover, setHover] = useState<number | null>(null); // 1-10 preview
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load existing rating for this profile/media.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRating(null);
    window.mediaCenter.ratings
      .get({ profileId, mediaType, mediaId })
      .then((r) => { if (!cancelled) setRating(r ? r.rating : null); })
      .catch(() => { if (!cancelled) setRating(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [profileId, mediaType, mediaId]);

  async function applyRating(value: number) {
    setSaving(true);
    const prev = rating;
    setRating(value); // optimistic
    try {
      const saved = await window.mediaCenter.ratings.set({
        profileId, mediaType, mediaId, title, year: year ?? null, poster: poster ?? null, rating: value,
      });
      setRating(saved.rating);
    } catch {
      setRating(prev);
    } finally {
      setSaving(false);
    }
  }

  async function clearRating() {
    setSaving(true);
    const prev = rating;
    setRating(null); // optimistic
    try {
      await window.mediaCenter.ratings.clear({ profileId, mediaType, mediaId });
    } catch {
      setRating(prev);
    } finally {
      setSaving(false);
    }
  }

  // The value currently shown (hover preview wins over saved).
  const shown = hover ?? rating ?? 0;

  return (
    <div className="rating-control" role="group" aria-label="Your rating">
      <div
        className="rating-control__stars"
        onMouseLeave={() => setHover(null)}
      >
        {Array.from({ length: STAR_COUNT }).map((_, i) => {
          const full = (i + 1) * 2;   // points for a full star
          const half = full - 1;      // points for a half star
          const fill = shown >= full ? "full" : shown >= half ? "half" : "empty";
          return (
            <span key={i} className="rating-control__star">
              {/* Left half = half-point, right half = full-point. */}
              <button
                type="button"
                className="rating-control__half rating-control__half--left"
                aria-label={`Rate ${half} out of 10`}
                disabled={loading || saving}
                onMouseEnter={() => setHover(half)}
                onClick={() => void applyRating(half)}
              />
              <button
                type="button"
                className="rating-control__half rating-control__half--right"
                aria-label={`Rate ${full} out of 10`}
                disabled={loading || saving}
                onMouseEnter={() => setHover(full)}
                onClick={() => void applyRating(full)}
              />
              <StarSvg fill={fill} />
            </span>
          );
        })}
      </div>
      <span className="rating-control__value">
        {loading
          ? "..."
          : rating != null
            ? `${rating}/10`
            : "Rate this"}
      </span>
      {rating != null && !loading && (
        <button
          type="button"
          className="rating-control__clear"
          onClick={() => void clearRating()}
          disabled={saving}
          title="Clear rating"
        >
          Clear
        </button>
      )}
    </div>
  );
}
