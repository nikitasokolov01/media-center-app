// Global app settings (default player, MPV path). Loaded once at app boot,
// exposed via context, refreshed automatically after writes.
//
// Renderer components should NEVER write to the underlying SQLite directly —
// always go through `update` so the in-memory value stays consistent.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AppSettings } from "../core/player/types.js";

interface SettingsContextValue {
  settings: AppSettings;
  loading: boolean;
  error: string | null;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  refresh: () => Promise<void>;
}

// While settings are still loading the rest of the UI shouldn't crash —
// stand-in defaults match db.ts's `DEFAULTS`.
const FALLBACK: AppSettings = {
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
  experimentalEmbeddedPlayer: false,
};

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const fresh = await window.mediaCenter.settings.get();
      setSettings(fresh);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = useCallback(async (patch: Partial<AppSettings>) => {
    try {
      const fresh = await window.mediaCenter.settings.update(patch);
      setSettings(fresh);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, loading, error, update, refresh }),
    [settings, loading, error, update, refresh],
  );

  return (
    <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside SettingsProvider");
  return ctx;
}
