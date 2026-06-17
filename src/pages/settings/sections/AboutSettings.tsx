// Settings > About / Debug -- app info, paths, and alpha-testing actions.
// Shows version, paths, embedded-MPV availability, and action buttons
// (Clear Home Cache, Open userData folder, Copy debug info).

import { useCallback, useEffect, useState } from "react";
import { useProfile } from "../../../state/ProfileContext.js";
import { useSettings } from "../../../state/SettingsContext.js";
import { clearAllHomeCatalogCache } from "../../../core/catalog/homeCatalogCache.js";

interface AppInfo {
  appVersion: string;
  userDataPath: string;
  dbPath: string;
  nativeAddonDir: string;
  libmpvPath: string;
  libEglPath: string;
  libGlesPath: string;
  mpvPath: string;
  isDev: boolean;
}

export default function AboutSettings() {
  const { profile } = useProfile();
  const { settings } = useSettings();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy debug info");
  const [cacheCleared, setCacheCleared] = useState(false);
  const [folderMsg, setFolderMsg] = useState<string | null>(null);

  useEffect(() => {
    window.mediaCenter.app
      .getInfo()
      .then((i) => setInfo(i))
      .catch((e: unknown) =>
        setInfoError(e instanceof Error ? e.message : String(e)),
      );
  }, []);

  const handleClearCache = useCallback(() => {
    clearAllHomeCatalogCache();
    setCacheCleared(true);
    setTimeout(() => setCacheCleared(false), 2500);
  }, []);

  const handleOpenFolder = useCallback(async () => {
    if (!info) return;
    setFolderMsg(null);
    const res = await window.mediaCenter.system.openFolder(info.userDataPath);
    if (!res.ok) setFolderMsg(`Could not open folder: ${res.error}`);
  }, [info]);

  const handleCopyDebugInfo = useCallback(() => {
    if (!info) return;
    const lines = [
      `App version:     ${info.appVersion}`,
      `Dev mode:        ${info.isDev ? "yes" : "no"}`,
      `Profile:         ${profile ? `${profile.name} (id=${profile.id})` : "none"}`,
      `userData:        ${info.userDataPath}`,
      `DB path:         ${info.dbPath}`,
      `MPV path:        ${info.mpvPath}`,
      `Embedded addon:  ${info.nativeAddonDir}`,
      `libmpv:          ${info.libmpvPath}`,
      `libEGL:          ${info.libEglPath}`,
      `libGLES:         ${info.libGlesPath}`,
      `Embedded player: ${settings.experimentalEmbeddedPlayer ? "enabled" : "disabled"}`,
      `Default player:  ${settings.defaultPlayer}`,
      `Theme:           ${settings.themeId || "default-dark"}`,
    ];
    void navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setCopyLabel("Copied!");
      setTimeout(() => setCopyLabel("Copy debug info"), 2000);
    });
  }, [info, profile, settings]);

  return (
    <div className="settings-panel">
      <h2 className="settings-panel__title">About / Debug</h2>

      <section className="settings-section">
        <h3 className="settings-section__label">Kino</h3>
        <p className="muted small">
          A Stremio-compatible media center built with Electron, React,
          TypeScript, and Vite. Addons are installed from their manifest URLs
          and stream sources are fetched at playback time. No hardcoded providers.
        </p>
      </section>

      <section className="settings-section">
        <h3 className="settings-section__label">App info</h3>
        {infoError && (
          <div className="error-banner">{infoError}</div>
        )}
        {!info && !infoError && (
          <p className="muted small">Loading...</p>
        )}
        {info && (
          <table className="about-table">
            <tbody>
              <tr>
                <td className="about-table__key muted small">Version</td>
                <td className="about-table__val small">{info.appVersion}</td>
              </tr>
              <tr>
                <td className="about-table__key muted small">Mode</td>
                <td className="about-table__val small">{info.isDev ? "Development" : "Production"}</td>
              </tr>
              <tr>
                <td className="about-table__key muted small">Profile</td>
                <td className="about-table__val small">
                  {profile ? `${profile.name} (id=${profile.id})` : "None"}
                </td>
              </tr>
              <tr>
                <td className="about-table__key muted small">Embedded player</td>
                <td className="about-table__val small">
                  {settings.experimentalEmbeddedPlayer ? (
                    <span style={{ color: "var(--color-success, #6dd49e)" }}>Enabled</span>
                  ) : (
                    <span className="muted">Disabled</span>
                  )}
                </td>
              </tr>
              <tr>
                <td className="about-table__key muted small">Default player</td>
                <td className="about-table__val small">{settings.defaultPlayer}</td>
              </tr>
              <tr>
                <td className="about-table__key muted small">External MPV path</td>
                <td className="about-table__val small about-table__val--path">{info.mpvPath}</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <section className="settings-section">
        <h3 className="settings-section__label">Paths</h3>
        {info && (
          <table className="about-table">
            <tbody>
              <tr>
                <td className="about-table__key muted small">userData</td>
                <td className="about-table__val small about-table__val--path">{info.userDataPath}</td>
              </tr>
              <tr>
                <td className="about-table__key muted small">Database</td>
                <td className="about-table__val small about-table__val--path">{info.dbPath}</td>
              </tr>
              <tr>
                <td className="about-table__key muted small">Native addon dir</td>
                <td className="about-table__val small about-table__val--path">{info.nativeAddonDir}</td>
              </tr>
              <tr>
                <td className="about-table__key muted small">libmpv</td>
                <td className="about-table__val small about-table__val--path">{info.libmpvPath}</td>
              </tr>
              <tr>
                <td className="about-table__key muted small">libEGL</td>
                <td className="about-table__val small about-table__val--path">{info.libEglPath}</td>
              </tr>
              <tr>
                <td className="about-table__key muted small">libGLESv2</td>
                <td className="about-table__val small about-table__val--path">{info.libGlesPath}</td>
              </tr>
            </tbody>
          </table>
        )}
        {!info && !infoError && <p className="muted small">Loading...</p>}
      </section>

      <section className="settings-section">
        <h3 className="settings-section__label">Actions</h3>
        {folderMsg && (
          <div className="error-banner" style={{ marginBottom: 8 }}>{folderMsg}</div>
        )}
        <div className="about-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={handleClearCache}
          >
            {cacheCleared ? "Cache cleared!" : "Clear Home cache"}
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={!info}
            onClick={() => void handleOpenFolder()}
          >
            Open userData folder
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={!info}
            onClick={handleCopyDebugInfo}
          >
            {copyLabel}
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3 className="settings-section__label">Resources</h3>
        <div className="about-links">
          <button
            type="button"
            className="ghost-button"
            onClick={() =>
              void window.mediaCenter.system.openExternal(
                "https://mpv.io/installation/",
              )
            }
          >
            Install MPV
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() =>
              void window.mediaCenter.system.openExternal(
                "https://stremio.com/",
              )
            }
          >
            Stremio addon ecosystem
          </button>
        </div>
      </section>
    </div>
  );
}
