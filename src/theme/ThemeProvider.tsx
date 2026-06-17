// ThemeProvider reads settings from SettingsContext and applies them to
// document.documentElement so every component inherits the correct CSS
// variable values without extra re-renders.
//
// Channels:
//   1. data-theme attr on html -> CSS selectors in styles.css do the work.
//   2. Inline CSS variable overrides on html.style -> accent-color override.
//   3. style#custom-user-css injected into head -> custom CSS.
//   4. --poster-radius CSS variable -> card/poster corner radius.
//   5. --app-bg-override CSS variable -> background style override.
//   6. Custom theme vars -> user-built colour presets (authoritative override).
//
// Security: custom CSS is set via textContent (never innerHTML/eval).
// Remote @import is blocked in the UI. We do NOT evaluate it as code.

import { useEffect, type ReactNode } from "react";
import { useSettings } from "../state/SettingsContext.js";

const CUSTOM_STYLE_ID = "custom-user-css";

interface ThemeProviderProps {
  children: ReactNode;
}

// Poster radius values -> CSS radius values
const POSTER_RADIUS_MAP: Record<string, string> = {
  square: "2px",
  soft: "6px",
  rounded: "12px",
  pill: "24px",
};

// Background style -> CSS background value
function buildBackground(
  style: string,
  customColor: string,
  customGradient: string,
  gradientColorA: string,
  gradientColorB: string,
  gradientAngle: number,
): string | null {
  const validHex = (h: string) => /^#[0-9a-f]{3,8}$/i.test(h.trim());
  switch (style) {
    case "oled-black":
      return "#000000";
    case "subtle-gradient": {
      const a = validHex(gradientColorA) ? gradientColorA : "#0a0d14";
      const b = validHex(gradientColorB) ? gradientColorB : "#111520";
      return `linear-gradient(${gradientAngle}deg, ${a} 0%, ${b} 100%)`;
    }
    case "neon-gradient": {
      const a = validHex(gradientColorA) ? gradientColorA : "#050713";
      const b = validHex(gradientColorB) ? gradientColorB : "#0d0933";
      return `linear-gradient(${gradientAngle}deg, ${a} 0%, ${b} 60%, #05130d 100%)`;
    }
    case "custom-solid":
      return validHex(customColor) ? customColor.trim() : null;
    case "custom-gradient": {
      const g = customGradient.trim();
      return g.includes("gradient(") ? g : null;
    }
    case "custom-image":
      // Image layer rendered as fixed divs in ThemeProvider JSX; body must be transparent.
      return "transparent";
    default:
      return null;
  }
}

/** Convert an absolute OS path to a kino-local:// CSS url() for the custom background image.
 *  The kino-local:// protocol is registered in main.ts and serves userData/backgrounds/ files.
 *  This avoids file:// CORS restrictions when the renderer is at http://localhost in dev mode.
 */
function pathToKinoLocalUrl(p: string): string {
  if (!p) return "";
  const filename = p.replace(/\\/g, "/").split("/").pop() ?? "";
  if (!filename) return "";
  return `url("kino-local://bg/${encodeURIComponent(filename)}")`;
}

export default function ThemeProvider({ children }: ThemeProviderProps) {
  const { settings } = useSettings();
  const {
    themeId,
    accentColor,
    customCss,
    posterRadius,
    backgroundStyle,
    customBackgroundColor,
    customBackgroundGradient,
    bgGradientColorA,
    bgGradientColorB,
    bgGradientAngle,
    customThemes,
    activeCustomThemeId,
    customBackgroundImagePath,
    customBackgroundImageFit,
    customBackgroundImagePosition,
    customBackgroundImageDim,
    customBackgroundImageBlur,
  } = settings;

  // 1. Apply data-theme attribute
  useEffect(() => {
    const root = document.documentElement;
    const validThemes = [
      "default-dark",
      "oled-black",
      "purple",
      "blue",
      "red",
      "neon-midnight",
      "emerald-noir",
      "amber-theater",
      "arctic-blue",
      "royal-violet",
    ];
    if (themeId && validThemes.includes(themeId)) {
      root.setAttribute("data-theme", themeId);
    } else {
      root.removeAttribute("data-theme");
    }
  }, [themeId]);

  // 2. Apply accent colour override as inline CSS variables on <html>.
  // When a custom theme is active, the custom theme controls accent -- skip.
  useEffect(() => {
    const root = document.documentElement;
    if (activeCustomThemeId) {
      root.style.removeProperty("--color-accent");
      root.style.removeProperty("--color-accent-hover");
      root.style.removeProperty("--accent");
      return;
    }
    const hex = accentColor.trim();
    if (hex && /^#[0-9a-f]{3,8}$/i.test(hex)) {
      root.style.setProperty("--color-accent", hex);
      root.style.setProperty("--color-accent-hover", hex);
      root.style.setProperty("--accent", hex);
    } else {
      root.style.removeProperty("--color-accent");
      root.style.removeProperty("--color-accent-hover");
      root.style.removeProperty("--accent");
    }
  }, [accentColor, activeCustomThemeId]);

  // 3. Apply poster radius
  useEffect(() => {
    const root = document.documentElement;
    const radius = POSTER_RADIUS_MAP[posterRadius] ?? POSTER_RADIUS_MAP["soft"];
    root.style.setProperty("--poster-radius", radius);
  }, [posterRadius]);

  // 4. Apply background style.
  // When a custom theme is active, the custom theme controls background -- skip.
  useEffect(() => {
    const root = document.documentElement;
    if (activeCustomThemeId) {
      root.style.removeProperty("--app-bg-override");
      return;
    }
    const bg = buildBackground(backgroundStyle, customBackgroundColor, customBackgroundGradient, bgGradientColorA, bgGradientColorB, bgGradientAngle);
    if (bg) {
      root.style.setProperty("--app-bg-override", bg);
    } else {
      root.style.removeProperty("--app-bg-override");
    }
  }, [backgroundStyle, customBackgroundColor, customBackgroundGradient, bgGradientColorA, bgGradientColorB, bgGradientAngle, activeCustomThemeId]);

  // 5. Inject / update custom CSS
  useEffect(() => {
    let el = document.getElementById(CUSTOM_STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = CUSTOM_STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = customCss ?? "";
  }, [customCss]);

  // 6. Apply custom theme variable overrides (user-built colour presets).
  // This runs AFTER Effects 2 and 4 in React's effect order, so when a custom
  // theme is active those effects have already cleared accent/background
  // overrides. This effect applies the full custom palette and also clears
  // --app-bg-override so the body uses --color-bg from the custom theme.
  useEffect(() => {
    const root = document.documentElement;
    if (!activeCustomThemeId || !customThemes) {
      // Remove any previously applied custom vars
      root.removeAttribute("data-custom-theme");
      return;
    }
    try {
      const presets = JSON.parse(customThemes) as Array<{ id: string; vars: Record<string, string> }>;
      const preset = presets.find((p) => p.id === activeCustomThemeId);
      if (preset) {
        for (const [k, v] of Object.entries(preset.vars)) {
          if (k.startsWith("--color-") && typeof v === "string") {
            root.style.setProperty(k, v);
          }
        }
        // Let the body background follow --color-bg from the custom theme.
        root.style.removeProperty("--app-bg-override");
        root.setAttribute("data-custom-theme", activeCustomThemeId);
      }
    } catch {
      // malformed JSON -- ignore
    }
    return () => {
      // On change/unmount, remove all previously set custom vars so stale
      // values do not linger when switching themes or deactivating.
      const vars = [
        "--color-bg", "--color-bg-elevated", "--color-surface",
        "--color-surface-hover", "--color-border", "--color-text",
        "--color-text-muted", "--color-accent", "--color-accent-hover",
        "--color-success", "--color-danger",
      ];
      for (const v of vars) root.style.removeProperty(v);
      root.style.removeProperty("--app-bg-override");
      root.removeAttribute("data-custom-theme");
    };
  }, [activeCustomThemeId, customThemes]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      document.getElementById(CUSTOM_STYLE_ID)?.remove();
      document.documentElement.removeAttribute("data-theme");
    };
  }, []);

  // Effect 7: Apply custom background image via CSS variables on <html>.
  // Adds/removes the "has-bg-image" class which enables body::before/::after rules
  // defined in styles.css. Uses kino-local:// protocol to avoid file:// CORS issues.
  // Custom themes and built-in themes are both compatible with image backgrounds.
  const showImageBg = backgroundStyle === "custom-image" && !!customBackgroundImagePath;
  useEffect(() => {
    const root = document.documentElement;
    const vars = ["--bg-img-url", "--bg-img-fit", "--bg-img-pos", "--bg-img-dim", "--bg-img-blur", "--bg-img-margin"];
    if (!showImageBg) {
      root.classList.remove("has-bg-image");
      for (const v of vars) root.style.removeProperty(v);
      return;
    }
    const url = pathToKinoLocalUrl(customBackgroundImagePath);
    if (!url) {
      root.classList.remove("has-bg-image");
      for (const v of vars) root.style.removeProperty(v);
      return;
    }
    const fit = customBackgroundImageFit || "cover";
    const pos = customBackgroundImagePosition || "center";
    const dim = typeof customBackgroundImageDim === "number" ? customBackgroundImageDim : 0.45;
    const blur = typeof customBackgroundImageBlur === "number" ? customBackgroundImageBlur : 0;
    root.style.setProperty("--bg-img-url", url);
    root.style.setProperty("--bg-img-fit", fit);
    root.style.setProperty("--bg-img-pos", pos);
    root.style.setProperty("--bg-img-dim", String(dim));
    root.style.setProperty("--bg-img-blur", blur > 0 ? `blur(${blur}px)` : "none");
    root.style.setProperty("--bg-img-margin", blur > 0 ? `-${blur * 2}px` : "0");
    root.classList.add("has-bg-image");
    return () => {
      root.classList.remove("has-bg-image");
      for (const v of vars) root.style.removeProperty(v);
    };
  }, [showImageBg, customBackgroundImagePath, customBackgroundImageFit,
      customBackgroundImagePosition, customBackgroundImageDim, customBackgroundImageBlur]);

  return <>{children}</>;
}
