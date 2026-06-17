// Settings > Appearance: theme cards, circular accent swatches, poster
// roundness, background style, and custom CSS section.
// All changes apply immediately via ThemeProvider CSS variable injection.

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useSettings } from "../../../state/SettingsContext.js";
import { useProfile } from "../../../state/ProfileContext.js";
import { BUILT_IN_THEMES, ACCENT_PRESETS } from "../../../theme/themes.js";
import { catalogRequiresExtras } from "../../../core/stremio/catalog.js";
import CustomThemeBuilder from "./CustomThemeBuilder.js";
import type { AddonRow } from "../../../types/preload.js";
import type { StremioCatalog } from "../../../core/stremio/types.js";

// Poster radius presets
const POSTER_RADIUS_OPTIONS = [
  { id: "square",  label: "Square",  radius: "2px" },
  { id: "soft",    label: "Soft",    radius: "6px" },
  { id: "rounded", label: "Rounded", radius: "12px" },
  { id: "pill",    label: "Pill",    radius: "24px" },
] as const;

// Background style presets
const BG_STYLE_OPTIONS = [
  { id: "",               label: "Default",   preview: "var(--color-bg, #0f1115)" },
  { id: "oled-black",     label: "OLED Black",   preview: "#000000" },
  { id: "subtle-gradient", label: "Subtle\nGrad", preview: "linear-gradient(135deg, #0a0d14 0%, #111520 100%)" },
  { id: "neon-gradient",  label: "Neon\nGrad",  preview: "linear-gradient(135deg, #050713 0%, #0d0933 50%, #05130d 100%)" },
  { id: "custom-solid",   label: "Custom\nColor",  preview: "repeating-linear-gradient(45deg, #444 0px, #444 2px, #333 2px, #333 8px)" },
  { id: "custom-gradient", label: "Custom\nGrad",   preview: "repeating-linear-gradient(45deg, #226 0px, #226 2px, #113 2px, #113 8px)" },
  { id: "custom-image",    label: "Custom\nImage",  preview: "repeating-linear-gradient(45deg, #3a2a1a 0px, #3a2a1a 4px, #1a1008 4px, #1a1008 10px)" },
] as const;

const BG_FIT_OPTIONS = [
  { id: "cover",   label: "Cover"   },
  { id: "contain", label: "Contain" },
] as const;

const BG_POS_OPTIONS = [
  { id: "center", label: "Center" },
  { id: "top",    label: "Top"    },
  { id: "bottom", label: "Bottom" },
] as const;

// Catalog descriptor shape (mirrors HomePage.tsx, used for hero source selection)
interface CatalogOption {
  key: string;
  addonId: string;
  addonName: string;
  manifestUrl: string;
  type: string;
  catalogId: string;
  catalogName: string;
}

function catalogOptionsFromAddons(addons: AddonRow[]): CatalogOption[] {
  const out: CatalogOption[] = [];
  for (const a of addons) {
    const catalogs = (a.manifest.catalogs ?? []) as StremioCatalog[];
    if (!Array.isArray(catalogs)) continue;
    for (const c of catalogs) {
      if (!c || typeof c.type !== "string" || typeof c.id !== "string") continue;
      if (catalogRequiresExtras(c)) continue;
      out.push({
        key: `${a.id}:${c.type}:${c.id}`,
        addonId: a.id,
        addonName: a.manifest.name,
        manifestUrl: a.manifestUrl,
        type: c.type,
        catalogId: c.id,
        catalogName: c.name ?? `${c.type} / ${c.id}`,
      });
    }
  }
  return out;
}

export default function AppearanceSettings() {
  const { settings, update } = useSettings();
  const { profile } = useProfile();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [customCssInput, setCustomCssInput] = useState(settings.customCss);
  const [accentHexInput, setAccentHexInput] = useState(settings.accentColor);
  const [bgColorInput, setBgColorInput] = useState(settings.customBackgroundColor);
  const [bgGradientInput, setBgGradientInput] = useState(settings.customBackgroundGradient);
  const [gradientColorA, setGradientColorA] = useState(settings.bgGradientColorA || "#0a0d14");
  const [gradientColorB, setGradientColorB] = useState(settings.bgGradientColorB || "#111520");
  const [gradientAngle, setGradientAngle] = useState(settings.bgGradientAngle ?? 135);
  const [exportIncludeCss, setExportIncludeCss] = useState(false);
  const [bgImageStatus, setBgImageStatus] = useState<"idle" | "picking" | "error">("idle");
  const [bgImageMissing, setBgImageMissing] = useState(false);
  const [bgImageError, setBgImageError] = useState<string | null>(null);
  const [bgImageDim, setBgImageDim] = useState(settings.customBackgroundImageDim ?? 0.45);
  const [bgImageBlur, setBgImageBlur] = useState(settings.customBackgroundImageBlur ?? 0);
  const bgImageDimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bgImageBlurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const customCssSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);
  const [copyLabel, setCopyLabel] = useState("Copy example CSS");

  // Addon list for hero source selection
  const [heroAddons, setHeroAddons] = useState<AddonRow[]>([]);
  useEffect(() => {
    if (!profile) return;
    window.mediaCenter.addons.list(profile.id).then(setHeroAddons).catch(() => {});
  }, [profile]);

  const heroCatalogOptions = useMemo(() => catalogOptionsFromAddons(heroAddons), [heroAddons]);

  // Current hero catalog selection (combined key: "addonId:type:catalogId")
  const heroCatalogKey = settings.heroAddonId && settings.heroCatalogType && settings.heroCatalogId
    ? `${settings.heroAddonId}:${settings.heroCatalogType}:${settings.heroCatalogId}`
    : "";

  useEffect(() => { setCustomCssInput(settings.customCss); }, [settings.customCss]);
  useEffect(() => { setAccentHexInput(settings.accentColor); }, [settings.accentColor]);
  useEffect(() => { setBgColorInput(settings.customBackgroundColor); }, [settings.customBackgroundColor]);
  useEffect(() => { setBgGradientInput(settings.customBackgroundGradient); }, [settings.customBackgroundGradient]);
  useEffect(() => { setGradientColorA(settings.bgGradientColorA || "#0a0d14"); }, [settings.bgGradientColorA]);
  useEffect(() => { setGradientColorB(settings.bgGradientColorB || "#111520"); }, [settings.bgGradientColorB]);
  useEffect(() => { setGradientAngle(settings.bgGradientAngle ?? 135); }, [settings.bgGradientAngle]);
  useEffect(() => { setBgImageDim(settings.customBackgroundImageDim ?? 0.45); }, [settings.customBackgroundImageDim]);
  useEffect(() => { setBgImageBlur(settings.customBackgroundImageBlur ?? 0); }, [settings.customBackgroundImageBlur]);

  async function save(patch: Parameters<typeof update>[0]) {
    setSaveError(null);
    try {
      await update(patch);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }

  // --- Custom background image ---
  const handleChooseImage = useCallback(async () => {
    setBgImageStatus("picking");
    setBgImageError(null);
    try {
      const result = await window.mediaCenter.bg.chooseImage();
      if (!result) { setBgImageStatus("idle"); return; } // cancelled
      if (!result.ok) { setBgImageError(result.error); setBgImageStatus("error"); return; }
      await save({ backgroundStyle: "custom-image", customBackgroundImagePath: result.path });
      setBgImageMissing(false);
      setBgImageStatus("idle");
    } catch (e) {
      setBgImageError(e instanceof Error ? e.message : String(e));
      setBgImageStatus("error");
    }
  }, [save]);

  const handleRemoveImage = useCallback(async () => {
    const imgPath = settings.customBackgroundImagePath;
    await save({ backgroundStyle: "", customBackgroundImagePath: "" });
    if (imgPath) {
      try { await window.mediaCenter.bg.removeImage({ imagePath: imgPath }); } catch {}
    }
  }, [save, settings.customBackgroundImagePath]);

  const currentTheme = settings.themeId || "default-dark";

  // --- Export theme as JSON file ---
  const handleExportTheme = useCallback(() => {
    // Note: custom-image background style is not exported because the image file is local-only.
    const exportBgStyle = settings.backgroundStyle === "custom-image" ? "" : (settings.backgroundStyle || "");
    const payload: Record<string, string> = {
      themeId: settings.themeId || "default-dark",
      accentColor: settings.accentColor || "",
      posterRadius: settings.posterRadius || "soft",
      backgroundStyle: exportBgStyle,
      customBackgroundColor: settings.customBackgroundColor || "",
      customBackgroundGradient: settings.customBackgroundGradient || "",
    };
    if (exportIncludeCss) payload.customCss = settings.customCss || "";
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "media-center-theme.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [settings, exportIncludeCss]);

  // --- Import theme from JSON file ---
  const handleImportFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setImportError(null);
      setImportSuccess(false);
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const raw = JSON.parse(reader.result as string) as Record<string, unknown>;
          // Basic shape validation -- no remote CSS or URL fields accepted.
          const allowed = new Set([
            "themeId", "accentColor", "posterRadius",
            "backgroundStyle", "customBackgroundColor",
            "customBackgroundGradient", "customCss",
          ]);
          const patch: Partial<typeof settings> = {};
          for (const key of allowed) {
            if (typeof raw[key] === "string") {
              (patch as Record<string, string>)[key] = raw[key] as string;
            }
          }
          // Validate themeId against known themes (or empty = default)
          const validIds = new Set(["", "default-dark", "oled-black", "purple", "blue", "red", "neon-midnight"]);
          if (patch.themeId !== undefined && !validIds.has(patch.themeId)) {
            patch.themeId = "default-dark";
          }
          // Validate backgroundStyle against known values.
          const validBgStyles = new Set(["", "oled-black", "subtle-gradient",
            "neon-gradient", "custom-solid", "custom-gradient"]);
          if (patch.backgroundStyle !== undefined && !validBgStyles.has(patch.backgroundStyle)) {
            delete patch.backgroundStyle;
          }
          void save(patch).then(() => {
            setImportSuccess(true);
            setTimeout(() => setImportSuccess(false), 2500);
          });
        } catch {
          setImportError("Invalid theme file. Expected a JSON file exported from this app.");
        }
        // Reset input so the same file can be re-imported if needed.
        if (importFileRef.current) importFileRef.current.value = "";
      };
      reader.readAsText(file);
    },
    [save, settings],
  );

  // --- Copy example CSS ---
  const EXAMPLE_CSS = `:root {
  --color-accent: #ff9f6b;
  --color-bg: #0f1115;
  --color-surface: #1a1e27;
}

.catalog-row__title { letter-spacing: 0.04em; }`;

  const handleCopyExampleCss = useCallback(() => {
    void navigator.clipboard.writeText(EXAMPLE_CSS).then(() => {
      setCopyLabel("Copied!");
      setTimeout(() => setCopyLabel("Copy example CSS"), 2000);
    });
  }, [EXAMPLE_CSS]);
  const currentRadius = settings.posterRadius || "soft";
  const currentBgStyle = settings.backgroundStyle ?? "";

  // Custom theme state
  const customThemeActive = !!settings.activeCustomThemeId;
  const activePresetName: string = (() => {
    if (!customThemeActive || !settings.customThemes) return "";
    try {
      const presets = JSON.parse(settings.customThemes) as Array<{ id: string; name: string }>;
      return presets.find((p) => p.id === settings.activeCustomThemeId)?.name ?? "Custom Theme";
    } catch { return "Custom Theme"; }
  })();

  return (
    <div className="settings-panel">
      <h2 className="settings-panel__title">Appearance</h2>
      <p className="muted small">
        Changes apply instantly without a restart.
      </p>

      {saveError && (
        <div className="error-banner">Could not save: {saveError}</div>
      )}

      {/* --- Active custom theme banner --- */}
      {customThemeActive && (
        <div className="custom-theme-active-banner">
          <div className="custom-theme-active-banner__info">
            <span className="custom-theme-active-banner__icon">&#10003;</span>
            <div>
              <strong>Custom theme active: {activePresetName}</strong>
              <p className="muted small" style={{ margin: "2px 0 0" }}>
                Built-in theme, accent colour, and background controls are
                overridden by your custom theme. Edit or deactivate it in the
                Custom Theme Builder below.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="ghost-button"
            style={{ flexShrink: 0 }}
            onClick={() => void save({ activeCustomThemeId: "" })}
          >
            Deactivate
          </button>
        </div>
      )}

      {/* --- A. Theme Presets --- */}
      <section className="settings-section">
        <h3 className="settings-section__label">Theme</h3>
        <div
          className="appearance-themes"
          style={customThemeActive ? { opacity: 0.4, pointerEvents: "none", userSelect: "none" } : undefined}
          aria-disabled={customThemeActive}
        >
          {BUILT_IN_THEMES.map((theme) => {
            const isActive = currentTheme === theme.id;
            return (
              <button
                key={theme.id}
                type="button"
                className={"theme-card" + (isActive ? " theme-card--active" : "")}
                onClick={() =>
                  void save({ themeId: theme.id === "default-dark" ? "" : theme.id })
                }
                title={theme.label}
              >
                <div className="theme-card__preview">
                  <div
                    className="theme-card__preview-bg"
                    style={{ background: theme.preview.bg }}
                  />
                  <div
                    className="theme-card__preview-sidebar"
                    style={{ background: theme.preview.sidebar }}
                  />
                  <div className="theme-card__preview-main">
                    <div
                      className="theme-card__preview-accent"
                      style={{ background: theme.preview.accent }}
                    />
                    <div
                      className="theme-card__preview-text"
                      style={{ background: theme.preview.text, width: "80%" }}
                    />
                    <div
                      className="theme-card__preview-text"
                      style={{ background: theme.preview.text, width: "60%" }}
                    />
                  </div>
                  {isActive && (
                    <div className="theme-card__check">
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                        <polyline points="2,6 5,9 10,3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                  )}
                </div>
                <span className="theme-card__label">{theme.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* --- B. Accent Color --- */}
      <section
        className="settings-section"
        style={customThemeActive ? { opacity: 0.4, pointerEvents: "none", userSelect: "none" } : undefined}
        aria-disabled={customThemeActive}
      >
        <h3 className="settings-section__label">Accent colour</h3>
        <div className="accent-row">
          {ACCENT_PRESETS.map((preset) => {
            const isActive =
              settings.accentColor === preset.hex ||
              (!settings.accentColor && preset.id === "blue");
            return (
              <button
                key={preset.id}
                type="button"
                className={"accent-swatch-circle" + (isActive ? " accent-swatch-circle--active" : "")}
                style={{ background: preset.hex }}
                title={preset.label}
                onClick={() =>
                  void save({ accentColor: preset.id === "blue" ? "" : preset.hex })
                }
              />
            );
          })}

          {/* Custom hex input */}
          <div className="accent-custom">
            <div
              className="accent-custom__preview"
              style={{
                background: /^#[0-9a-f]{3,8}$/i.test(accentHexInput)
                  ? accentHexInput
                  : "transparent",
              }}
            />
            <input
              type="text"
              className="accent-custom__input"
              value={accentHexInput}
              placeholder="#rrggbb"
              spellCheck={false}
              maxLength={9}
              onChange={(e) => setAccentHexInput(e.target.value)}
              onBlur={() => {
                const val = accentHexInput.trim();
                if (val === "" || /^#[0-9a-f]{3,8}$/i.test(val)) {
                  void save({ accentColor: val });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          </div>
        </div>
      </section>

      {/* --- C. Poster Roundness --- */}
      <section className="settings-section">
        <h3 className="settings-section__label">Poster roundness</h3>
        <div className="poster-radius-options">
          {POSTER_RADIUS_OPTIONS.map((opt) => {
            const isActive = currentRadius === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                className={"poster-radius-card" + (isActive ? " poster-radius-card--active" : "")}
                onClick={() => void save({ posterRadius: opt.id })}
                title={opt.label}
              >
                <div
                  className="poster-radius-card__preview"
                  style={{ borderRadius: opt.radius }}
                />
                <span className="poster-radius-card__label">{opt.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* --- D. Background Style --- */}
      <section
        className="settings-section"
        style={customThemeActive ? { opacity: 0.4, pointerEvents: "none", userSelect: "none" } : undefined}
        aria-disabled={customThemeActive}
      >
        <h3 className="settings-section__label">Background</h3>
        <div className="bg-style-options">
          {BG_STYLE_OPTIONS.map((opt) => {
            const isActive = currentBgStyle === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                className={"bg-style-card" + (isActive ? " bg-style-card--active" : "")}
                onClick={() => void save({ backgroundStyle: opt.id })}
                title={opt.label}
              >
                <div
                  className="bg-style-card__preview"
                  style={{ background: opt.preview }}
                />
                <span className="bg-style-card__label">{opt.label}</span>
              </button>
            );
          })}
        </div>

        {currentBgStyle === "custom-solid" && (
          <div className="bg-custom-color-row">
            <div
              className="bg-custom-color-preview"
              style={{
                background: /^#[0-9a-f]{3,8}$/i.test(bgColorInput)
                  ? bgColorInput
                  : "transparent",
              }}
            />
            <input
              type="text"
              className="bg-custom-color-input accent-custom__input"
              value={bgColorInput}
              placeholder="#rrggbb"
              spellCheck={false}
              maxLength={9}
              onChange={(e) => setBgColorInput(e.target.value)}
              onBlur={() => {
                const val = bgColorInput.trim();
                if (val === "" || /^#[0-9a-f]{3,8}$/i.test(val)) {
                  void save({ customBackgroundColor: val });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <span className="muted small">Solid background color</span>
          </div>
        )}

        {(currentBgStyle === "subtle-gradient" || currentBgStyle === "neon-gradient") && (
          <div className="bg-gradient-controls">
            <div className="bg-gradient-preview" style={{
              background: `linear-gradient(${gradientAngle}deg, ${gradientColorA} 0%, ${gradientColorB} 100%)`,
            }} />
            <div className="bg-gradient-pickers">
              <label className="bg-gradient-picker-label">
                <span className="muted small">Color A</span>
                <div className="bg-gradient-picker-row">
                  <input
                    type="color"
                    value={gradientColorA}
                    onChange={(e) => {
                      setGradientColorA(e.target.value);
                      void save({ bgGradientColorA: e.target.value });
                    }}
                    className="bg-gradient-color-input"
                  />
                  <input
                    type="text"
                    className="bg-custom-color-input accent-custom__input"
                    value={gradientColorA}
                    maxLength={7}
                    spellCheck={false}
                    onChange={(e) => setGradientColorA(e.target.value)}
                    onBlur={() => {
                      if (/^#[0-9a-f]{3,8}$/i.test(gradientColorA.trim())) {
                        void save({ bgGradientColorA: gradientColorA.trim() });
                      }
                    }}
                  />
                </div>
              </label>
              <label className="bg-gradient-picker-label">
                <span className="muted small">Color B</span>
                <div className="bg-gradient-picker-row">
                  <input
                    type="color"
                    value={gradientColorB}
                    onChange={(e) => {
                      setGradientColorB(e.target.value);
                      void save({ bgGradientColorB: e.target.value });
                    }}
                    className="bg-gradient-color-input"
                  />
                  <input
                    type="text"
                    className="bg-custom-color-input accent-custom__input"
                    value={gradientColorB}
                    maxLength={7}
                    spellCheck={false}
                    onChange={(e) => setGradientColorB(e.target.value)}
                    onBlur={() => {
                      if (/^#[0-9a-f]{3,8}$/i.test(gradientColorB.trim())) {
                        void save({ bgGradientColorB: gradientColorB.trim() });
                      }
                    }}
                  />
                </div>
              </label>
              <label className="bg-gradient-picker-label bg-gradient-picker-label--angle">
                <span className="muted small">Angle: {gradientAngle}deg</span>
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={5}
                  value={gradientAngle}
                  className="bg-gradient-angle-slider"
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setGradientAngle(v);
                    void save({ bgGradientAngle: v });
                  }}
                />
              </label>
            </div>
          </div>
        )}

        {currentBgStyle === "custom-gradient" && (
          <div className="bg-custom-gradient-row">
            <textarea
              className="custom-css-textarea"
              style={{ minHeight: 60, marginTop: 8 }}
              value={bgGradientInput}
              placeholder="linear-gradient(135deg, #0a0d14 0%, #1a0a2e 50%, #0a1428 100%)"
              spellCheck={false}
              rows={2}
              onChange={(e) => setBgGradientInput(e.target.value)}
              onBlur={() => {
                const val = bgGradientInput.trim();
                void save({ customBackgroundGradient: val });
              }}
            />
            <span className="muted small" style={{ marginTop: 4 }}>
              Any valid CSS background value, e.g. <code>linear-gradient(...)</code>
            </span>
          </div>
        )}

        {/* --- Custom Image panel --- */}
        {currentBgStyle === "custom-image" && (
          <div className="bg-image-panel">
            {bgImageError && (
              <div className="error-banner" style={{ marginBottom: 8 }}>{bgImageError}</div>
            )}
            <div className="bg-image-actions">
              <button
                type="button"
                className="ghost-button"
                disabled={bgImageStatus === "picking"}
                onClick={() => void handleChooseImage()}
              >
                {bgImageStatus === "picking" ? "Choosing..." : "Choose Image"}
              </button>
              {settings.customBackgroundImagePath && (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void handleRemoveImage()}
                >
                  Remove Image
                </button>
              )}
            </div>
            {settings.customBackgroundImagePath ? (
              <div style={{ marginTop: 8 }}>
                {bgImageMissing && (
                  <div className="error-banner" style={{ marginBottom: 6 }}>
                    Image file not found. Please choose a new image.
                  </div>
                )}
                <img
                  src={`kino-local://bg/${encodeURIComponent(
                    settings.customBackgroundImagePath.replace(/\\/g, "/").split("/").pop() ?? ""
                  )}`}
                  alt="Background preview"
                  style={{
                    display: "block",
                    width: 160,
                    height: 90,
                    objectFit: "cover",
                    borderRadius: 4,
                    border: "1px solid var(--color-border)",
                  }}
                  onLoad={() => setBgImageMissing(false)}
                  onError={() => setBgImageMissing(true)}
                />
                <p className="muted small" style={{ marginTop: 4, wordBreak: "break-all" }}>
                  {settings.customBackgroundImagePath.split(/[\\/]/).pop()}
                </p>
              </div>
            ) : (
              <p className="muted small" style={{ marginTop: 6 }}>
                No image selected. Only .jpg, .png, .webp files are supported.
              </p>
            )}

            {settings.customBackgroundImagePath && (
              <>
                {/* Fit */}
                <div className="bg-image-control-row" style={{ marginTop: 14 }}>
                  <span className="muted small" style={{ minWidth: 60 }}>Fit</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    {BG_FIT_OPTIONS.map((opt) => (
                      <label key={opt.id} style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 13 }}>
                        <input
                          type="radio"
                          name="bgImageFit"
                          value={opt.id}
                          checked={(settings.customBackgroundImageFit || "cover") === opt.id}
                          onChange={() => void save({ customBackgroundImageFit: opt.id })}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                </div>

                {/* Position */}
                <div className="bg-image-control-row" style={{ marginTop: 8 }}>
                  <span className="muted small" style={{ minWidth: 60 }}>Position</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    {BG_POS_OPTIONS.map((opt) => (
                      <label key={opt.id} style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 13 }}>
                        <input
                          type="radio"
                          name="bgImagePos"
                          value={opt.id}
                          checked={(settings.customBackgroundImagePosition || "center") === opt.id}
                          onChange={() => void save({ customBackgroundImagePosition: opt.id })}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                </div>

                {/* Dim */}
                <div className="bg-image-control-row" style={{ marginTop: 8 }}>
                  <span className="muted small" style={{ minWidth: 60 }}>Dim: {Math.round(bgImageDim * 100)}%</span>
                  <input
                    type="range"
                    min={0}
                    max={0.85}
                    step={0.01}
                    value={bgImageDim}
                    className="bg-gradient-angle-slider"
                    style={{ flex: 1 }}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setBgImageDim(v);
                      if (bgImageDimTimer.current) clearTimeout(bgImageDimTimer.current);
                      bgImageDimTimer.current = setTimeout(() => { void save({ customBackgroundImageDim: v }); }, 150);
                    }}
                  />
                </div>

                {/* Blur */}
                <div className="bg-image-control-row" style={{ marginTop: 8 }}>
                  <span className="muted small" style={{ minWidth: 60 }}>Blur: {Math.round(bgImageBlur)}px</span>
                  <input
                    type="range"
                    min={0}
                    max={20}
                    step={1}
                    value={bgImageBlur}
                    className="bg-gradient-angle-slider"
                    style={{ flex: 1 }}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setBgImageBlur(v);
                      if (bgImageBlurTimer.current) clearTimeout(bgImageBlurTimer.current);
                      bgImageBlurTimer.current = setTimeout(() => { void save({ customBackgroundImageBlur: v }); }, 150);
                    }}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {/* --- E. Custom CSS --- */}
      <section className="settings-section">
        <h3 className="settings-section__label">
          Custom CSS{" "}
          <span style={{ opacity: 0.55, fontWeight: 400, fontSize: "11px" }}>
            (optional)
          </span>
        </h3>
        <div className="warning-banner warning-banner--small" style={{ marginBottom: 8 }}>
          Local only -- do not paste remote @import rules. Reset if the UI breaks.
        </div>
        <textarea
          className="custom-css-textarea"
          value={customCssInput}
          placeholder=":root { --color-accent: #ff9f6b; }"
          spellCheck={false}
          onChange={(e) => {
            const val = e.target.value;
            setCustomCssInput(val);
            if (customCssSaveTimer.current) clearTimeout(customCssSaveTimer.current);
            customCssSaveTimer.current = setTimeout(() => {
              void save({ customCss: val });
            }, 600);
          }}
        />
        <div className="appearance-css-actions">
          <button
            type="button"
            className="primary-button"
            style={{ fontSize: 12, padding: "5px 14px" }}
            onClick={() => void save({ customCss: customCssInput })}
          >
            Apply CSS
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              setCustomCssInput("");
              void save({ customCss: "" });
            }}
          >
            Clear CSS
          </button>
        </div>
      </section>

      {/* --- F. Custom Theme Builder --- */}
      <section className="settings-section">
        <h3 className="settings-section__label">Custom theme builder</h3>
        <p className="muted small" style={{ marginBottom: 12 }}>
          Build a named colour theme from scratch. Saved themes can be applied
          on top of any built-in base theme.
        </p>
        <CustomThemeBuilder />
      </section>

      {/* Import / Export theme */}
      <section className="settings-section" style={{ borderTop: "1px solid var(--color-border, var(--border))", paddingTop: 16 }}>
        <h3 className="settings-section__label">Import / Export theme</h3>
        <p className="muted small" style={{ marginBottom: 10 }}>
          Export saves your current theme preset, accent colour, poster roundness,
          and background style as a JSON file (custom CSS is not included for
          safety). Import reads it back and applies each field instantly.
        </p>

        {importError && (
          <div className="error-banner" style={{ marginBottom: 8 }}>{importError}</div>
        )}
        {importSuccess && (
          <div className="success-banner" style={{ marginBottom: 8 }}>Theme imported!</div>
        )}

        <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, cursor: "pointer", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={exportIncludeCss}
            onChange={(e) => setExportIncludeCss(e.target.checked)}
          />
          Include custom CSS in export
        </label>
        <div className="appearance-actions-row">
          <button type="button" className="ghost-button" onClick={handleExportTheme}>
            Export theme
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => importFileRef.current?.click()}
          >
            Import theme
          </button>
          <input
            ref={importFileRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={handleImportFile}
          />
          <button type="button" className="ghost-button" onClick={handleCopyExampleCss}>
            {copyLabel}
          </button>
        </div>
      </section>

      {/* --- G. Home Hero Source --- */}
      <section className="settings-section">
        <h3 className="settings-section__label">Home hero source</h3>
        <p className="muted small" style={{ marginBottom: 12 }}>
          Choose which catalog populates the rotating banner at the top of the
          Home page. &quot;Auto&quot; picks the first available catalogs from
          your installed addons.
        </p>
        <div className="setting-row" style={{ marginBottom: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14 }}>
            <input
              type="radio"
              name="heroSourceMode"
              value="auto"
              checked={settings.heroSourceMode !== "catalog"}
              onChange={() => void save({ heroSourceMode: "auto" })}
            />
            Auto (first available catalogs)
          </label>
        </div>
        <div className="setting-row" style={{ marginBottom: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14 }}>
            <input
              type="radio"
              name="heroSourceMode"
              value="catalog"
              checked={settings.heroSourceMode === "catalog"}
              onChange={() => void save({ heroSourceMode: "catalog" })}
            />
            Specific catalog
          </label>
        </div>
        {settings.heroSourceMode === "catalog" && (
          <div style={{ marginTop: 8 }}>
            {heroCatalogOptions.length === 0 ? (
              <p className="muted small">No browsable catalogs found. Install an addon with a catalog first.</p>
            ) : (
              <>
                <label style={{ display: "block", fontSize: 12, color: "var(--color-text-muted)", marginBottom: 4 }}>
                  Catalog
                </label>
                <select
                  className="select-input"
                  value={heroCatalogKey}
                  onChange={(e) => {
                    const opt = heroCatalogOptions.find((o) => o.key === e.target.value);
                    if (!opt) {
                      void save({ heroAddonId: "", heroCatalogType: "", heroCatalogId: "" });
                    } else {
                      void save({
                        heroAddonId: opt.addonId,
                        heroCatalogType: opt.type,
                        heroCatalogId: opt.catalogId,
                      });
                    }
                  }}
                  style={{ minWidth: 320 }}
                >
                  <option value="">-- Select a catalog --</option>
                  {heroCatalogOptions.map((opt) => (
                    <option key={opt.key} value={opt.key}>
                      {opt.addonName} - {opt.catalogName} ({opt.type})
                    </option>
                  ))}
                </select>
                {heroCatalogKey && !heroCatalogOptions.find((o) => o.key === heroCatalogKey) && (
                  <p className="muted small" style={{ marginTop: 6 }}>
                    Previously selected catalog is no longer available. Please pick another.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </section>

      {/* Reset all appearance */}
      <section className="settings-section">
        <h3 className="settings-section__label">Reset</h3>
        <div className="appearance-actions-row">
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              const oldPath = settings.customBackgroundImagePath;
              void save({
                themeId: "",
                accentColor: "",
                customCss: "",
                posterRadius: "soft",
                backgroundStyle: "",
                customBackgroundColor: "",
                customBackgroundGradient: "",
                activeCustomThemeId: "",
                customBackgroundImagePath: "",
                customBackgroundImageFit: "cover",
                customBackgroundImagePosition: "center",
                customBackgroundImageDim: 0.45,
                customBackgroundImageBlur: 0,
              });
              setCustomCssInput("");
              setAccentHexInput("");
              setBgColorInput("");
              setBgGradientInput("");
              // Try to delete the copied bg image file; ignore errors
              if (oldPath) {
                void window.mediaCenter.bg.removeImage({ imagePath: oldPath }).catch(() => {});
              }
            }}
          >
            Reset all appearance
          </button>
        </div>
      </section>
    </div>
  );
}
