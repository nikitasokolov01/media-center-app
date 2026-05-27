// /settings — global app settings.
//
// Fields:
//   - Default player (Browser vs MPV)
//   - MPV executable path (defaults to "mpv", looked up on PATH)
//   - Test MPV button that runs `mpv --version` via IPC and shows the result.

import { useEffect, useState } from "react";
import { useSettings } from "../state/SettingsContext.js";
import { checkMpvAvailable } from "../core/player/mpvExternal.js";
import { BACKENDS } from "../core/player/playerBackends.js";
import type {
  DefaultPlayerSetting,
  MpvAvailability,
  PreferredSourceQuality,
} from "../core/player/types.js";

const QUALITY_OPTIONS: { value: PreferredSourceQuality; label: string }[] = [
  { value: "best", label: "Best available" },
  { value: "2160p", label: "4K / 2160p" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "first", label: "First available" },
];

const ANIME_AUDIO_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "Use global default" },
  { value: "ja", label: "Japanese" },
  { value: "en", label: "English" },
  { value: "auto", label: "Original / Auto" },
];

export default function SettingsPage() {
  const { settings, loading, error, update } = useSettings();

  // Local form state, synced from `settings` once loaded.
  const [mpvPathInput, setMpvPathInput] = useState(settings.mpvPath);
  useEffect(() => {
    setMpvPathInput(settings.mpvPath);
  }, [settings.mpvPath]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<MpvAvailability | null>(null);
  const [testing, setTesting] = useState(false);

  // Local inputs for the language fields (debounced save on blur / Enter).
  const [subLangInput, setSubLangInput] = useState(settings.subtitleLanguage);
  const [audioLangInput, setAudioLangInput] = useState(settings.audioLanguage);
  const [animeAudioInput, setAnimeAudioInput] = useState(
    settings.animeAudioLanguage,
  );
  useEffect(() => {
    setSubLangInput(settings.subtitleLanguage);
  }, [settings.subtitleLanguage]);
  useEffect(() => {
    setAudioLangInput(settings.audioLanguage);
  }, [settings.audioLanguage]);
  useEffect(() => {
    setAnimeAudioInput(settings.animeAudioLanguage);
  }, [settings.animeAudioLanguage]);

  async function saveSetting(patch: Parameters<typeof update>[0]) {
    setSaveError(null);
    try {
      await update(patch);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDefaultPlayerChange(v: DefaultPlayerSetting) {
    setSaveError(null);
    try {
      await update({ defaultPlayer: v });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSaveMpvPath() {
    setSaving(true);
    setSaveError(null);
    try {
      const next = mpvPathInput.trim() || "mpv";
      await update({ mpvPath: next });
      setMpvPathInput(next);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleTestMpv() {
    setTesting(true);
    setTestResult(null);
    // If the user typed a new path but didn't save, save it first so the
    // probe runs against what they actually want to verify.
    const desired = mpvPathInput.trim() || "mpv";
    try {
      if (desired !== settings.mpvPath) {
        await update({ mpvPath: desired });
      }
      const res = await checkMpvAvailable();
      setTestResult(res);
    } catch (e) {
      setTestResult({
        available: false,
        path: desired,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="page">
      <h1>Settings</h1>

      {loading && <p className="muted">Loading settings…</p>}
      {error && <div className="error-banner">Could not load settings: {error}</div>}
      {saveError && <div className="error-banner">Could not save: {saveError}</div>}

      <section className="settings-section">
        <h2>Default player</h2>
        <p className="muted small">
          Used when a stream has a direct HTTP/HTTPS URL and both backends are
          viable. MPV plays nearly any container; the browser is faster to
          start but struggles with .mkv and many CDN streams.
        </p>
        <div className="radio-row">
          {(["mpv", "browser"] as DefaultPlayerSetting[]).map((v) => (
            <label key={v} className="radio-card">
              <input
                type="radio"
                name="defaultPlayer"
                value={v}
                checked={settings.defaultPlayer === v}
                onChange={() => handleDefaultPlayerChange(v)}
              />
              <div>
                <div className="radio-card__title">
                  {v === "mpv" ? "MPV (external)" : "Browser"}
                </div>
                <div className="radio-card__desc muted small">
                  {v === "mpv" ? BACKENDS["mpv-external"].description : BACKENDS.browser.description}
                </div>
              </div>
            </label>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h2>MPV path</h2>
        <p className="muted small">
          Path to the MPV executable. Defaults to <code>mpv</code> (looked up
          on PATH). On Windows you'll typically enter
          <code> C:\Program Files\mpv\mpv.exe</code>.
        </p>
        <div className="form-row">
          <input
            type="text"
            value={mpvPathInput}
            onChange={(e) => setMpvPathInput(e.target.value)}
            placeholder="mpv"
            spellCheck={false}
            autoComplete="off"
            className="text-input"
          />
          <button
            type="button"
            className="primary-button"
            onClick={handleSaveMpvPath}
            disabled={saving || mpvPathInput.trim() === settings.mpvPath}
          >
            {saving ? "Saving…" : "Save path"}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={handleTestMpv}
            disabled={testing}
          >
            {testing ? "Testing…" : "Test MPV"}
          </button>
        </div>

        {testResult && (
          testResult.available ? (
            <div className="success-banner">
              MPV is available at <code>{testResult.path}</code>
              {testResult.version && <> · version <strong>{testResult.version}</strong></>}.
            </div>
          ) : (
            <div className="error-banner">
              MPV was not found at <code>{testResult.path}</code>.
              {testResult.error && <div className="muted small" style={{ marginTop: 4 }}>{testResult.error}</div>}
              <p className="small" style={{ marginTop: 6 }}>
                Install MPV from <a
                  href="https://mpv.io/installation/"
                  onClick={(e) => {
                    e.preventDefault();
                    void window.mediaCenter.system.openExternal("https://mpv.io/installation/");
                  }}
                  rel="noreferrer"
                >mpv.io/installation</a>, or enter its full path above and press Save.
              </p>
            </div>
          )
        )}
      </section>

      <section className="settings-section">
        <h2>Subtitles &amp; audio</h2>
        <p className="muted small">
          All available subtitle tracks are always auto-loaded into MPV when you
          press Play — you pick which one to show from the player controls after
          playback starts. These settings control what's selected by default.
        </p>

        <div className="radio-row">
          {([
            { v: false, title: "Subtitles off by default", desc: "Tracks are loaded but start hidden. Turn them on from the player's Subs menu." },
            { v: true, title: "Auto-enable subtitles", desc: "After MPV starts, try to turn on subtitles in your preferred language (below)." },
          ] as { v: boolean; title: string; desc: string }[]).map((opt) => (
            <label key={String(opt.v)} className="radio-card">
              <input
                type="radio"
                name="autoEnableSubtitles"
                checked={settings.autoEnableSubtitles === opt.v}
                onChange={() => void saveSetting({ autoEnableSubtitles: opt.v })}
              />
              <div>
                <div className="radio-card__title">{opt.title}</div>
                <div className="radio-card__desc muted small">{opt.desc}</div>
              </div>
            </label>
          ))}
        </div>

        <div className="form-row" style={{ marginTop: 12 }}>
          <label className="field-label">
            Preferred subtitle language
            <input
              type="text"
              value={subLangInput}
              onChange={(e) => setSubLangInput(e.target.value)}
              onBlur={() => {
                const next = subLangInput.trim();
                if (next !== settings.subtitleLanguage) {
                  void saveSetting({ subtitleLanguage: next });
                }
              }}
              placeholder="en / eng / English"
              spellCheck={false}
              autoComplete="off"
              className="text-input"
            />
          </label>
        </div>
        <p className="muted small">
          Used only when auto-enable is on. Accepts <code>en</code>,{" "}
          <code>eng</code>, or <code>English</code>. Leave blank for no
          preference.
        </p>

        <div className="form-row" style={{ marginTop: 12 }}>
          <label className="field-label">
            Preferred audio language
            <input
              type="text"
              value={audioLangInput}
              onChange={(e) => setAudioLangInput(e.target.value)}
              onBlur={() => {
                const next = audioLangInput.trim();
                if (next !== settings.audioLanguage) {
                  void saveSetting({ audioLanguage: next });
                }
              }}
              placeholder="Original / Auto (e.g. ja, jpn, Japanese)"
              spellCheck={false}
              autoComplete="off"
              className="text-input"
            />
          </label>
        </div>
        <p className="muted small">
          After MPV starts, the app tries to switch to this audio language if a
          matching track exists. Leave blank to keep the original/default audio.
        </p>

        <div className="form-row" style={{ marginTop: 12 }}>
          <label className="field-label">
            Anime default audio language
            <input
              type="text"
              value={animeAudioInput}
              onChange={(e) => setAnimeAudioInput(e.target.value)}
              onBlur={() => {
                const next = animeAudioInput.trim();
                if (next !== settings.animeAudioLanguage) {
                  void saveSetting({ animeAudioLanguage: next });
                }
              }}
              placeholder="Use global default (blank), or ja / jpn / Japanese"
              spellCheck={false}
              autoComplete="off"
              className="text-input"
            />
          </label>
        </div>
        <div className="preset-row">
          {ANIME_AUDIO_PRESETS.map((p) => (
            <button
              key={p.value || "global"}
              type="button"
              className={`chip${
                (settings.animeAudioLanguage || "") === p.value ? " chip--active" : ""
              }`}
              onClick={() => {
                setAnimeAudioInput(p.value);
                void saveSetting({ animeAudioLanguage: p.value });
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="muted small">
          Anime is detected from Kitsu/provider signals first, then an explicit
          "Anime" genre — western animation (e.g. Arcane, The Simpsons) is not
          treated as anime. When an item is anime, this overrides the global
          audio language. "Use global default" defers to the setting above;
          "Original / Auto" keeps MPV's default audio.
        </p>
      </section>

      <section className="settings-section">
        <h2>Source selection</h2>
        <p className="muted small">
          When on, the app ranks the fetched sources and marks the best one with
          an "Auto-selected" badge, plus a "Play Best Source" button. Manual
          source selection always remains available; playback never starts on
          its own.
        </p>

        <div className="radio-row">
          {([
            { v: false, title: "Manual (off)", desc: "Pick a source yourself from the list, as before." },
            { v: true, title: "Auto-select best source", desc: "Rank sources and surface a Play Best Source button." },
          ] as { v: boolean; title: string; desc: string }[]).map((opt) => (
            <label key={String(opt.v)} className="radio-card">
              <input
                type="radio"
                name="autoSelectSource"
                checked={settings.autoSelectSource === opt.v}
                onChange={() => void saveSetting({ autoSelectSource: opt.v })}
              />
              <div>
                <div className="radio-card__title">{opt.title}</div>
                <div className="radio-card__desc muted small">{opt.desc}</div>
              </div>
            </label>
          ))}
        </div>

        <label className="checkbox-row" style={{ marginTop: 12 }}>
          <input
            type="checkbox"
            checked={settings.autoPlayBestSource}
            onChange={(e) =>
              void saveSetting({ autoPlayBestSource: e.target.checked })
            }
          />
          <span>
            Auto-play best source
            <span className="muted small">
              {" "}
              — Automatically start playback using the best available direct
              source when opening a movie or selecting an episode.
            </span>
          </span>
        </label>

        <div className="form-row" style={{ marginTop: 12 }}>
          <label className="field-label">
            Preferred source quality
            <select
              className="text-input"
              value={settings.preferredSourceQuality}
              onChange={(e) =>
                void saveSetting({
                  preferredSourceQuality: e.target.value as PreferredSourceQuality,
                })
              }
            >
              {QUALITY_OPTIONS.map((q) => (
                <option key={q.value} value={q.value}>
                  {q.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted small">
          Only direct HTTP/HTTPS sources are considered (MPV requirement).
          Fallback: if the preferred quality isn't available, the next best
          lower quality is used, then higher, then anything detectable, then a
          first direct playable source. "First available" just takes the first
          direct source in addon order.
        </p>

        <label className="checkbox-row" style={{ marginTop: 12 }}>
          <input
            type="checkbox"
            checked={settings.hideCamSources}
            onChange={(e) =>
              void saveSetting({ hideCamSources: e.target.checked })
            }
          />
          <span>
            Hide / deprioritize CAM &amp; TS sources
            <span className="muted small">
              {" "}
              — low-quality captures are only auto-selected if nothing else is
              playable.
            </span>
          </span>
        </label>
      </section>

      <section className="settings-section">
        <h2>Experimental</h2>
        <p className="muted small">
          Work-in-progress features. These do not affect normal playback — the
          external MPV player remains the default.
        </p>

        <label className="checkbox-row" style={{ marginTop: 12 }}>
          <input
            type="checkbox"
            checked={settings.experimentalEmbeddedPlayer}
            onChange={(e) =>
              void saveSetting({ experimentalEmbeddedPlayer: e.target.checked })
            }
          />
          <span>
            Embedded player (experimental)
            <span className="muted small">
              {" "}
              — adds an{" "}
              <strong>Embedded (experimental)</strong> page that renders libmpv
              video into an in-app canvas. Copy-based and unoptimized; requires
              the native addon to be built. Does not replace external MPV.
            </span>
          </span>
        </label>
      </section>
    </div>
  );
}
