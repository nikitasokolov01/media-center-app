// Kino brand mark: widescreen cinema frame with a stylised K formed by
// three line strokes (stem + two diagonal arms). Supports compact icon-only
// mode and full wordmark mode (icon + "Kino" logotype).
//
// Uses CSS variables so the mark adapts to every built-in and custom theme:
//   --color-border  -> frame stroke (subtle)
//   --color-accent  -> K mark strokes (brand accent)
//   --color-text    -> wordmark text

interface KinoLogoProps {
  /** "icon" renders only the cinema-frame mark.
   *  "wordmark" renders icon + "Kino" text side by side. Default: "wordmark". */
  mode?: "icon" | "wordmark";
  /** Height of the icon mark in px. Width is computed from 30:20 aspect ratio.
   *  Default 20. */
  size?: number;
  className?: string;
}

function KinoIcon({ size = 20 }: { size: number }) {
  const w = Math.round((size * 30) / 20);
  return (
    <svg
      width={w}
      height={size}
      viewBox="0 0 30 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      {/* Widescreen cinema frame */}
      <rect
        x="0.75"
        y="0.75"
        width="28.5"
        height="18.5"
        rx="2.5"
        ry="2.5"
        stroke="var(--color-border)"
        strokeWidth="1.5"
        strokeOpacity="0.9"
        fill="none"
      />
      {/* K mark: vertical stem + upper diagonal arm + lower diagonal arm */}
      <path
        d="M10 5 L10 15 M10 10 L19 5 M10 10 L19 15"
        stroke="var(--color-accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function KinoLogo({
  mode = "wordmark",
  size = 20,
  className,
}: KinoLogoProps) {
  if (mode === "icon") {
    return <KinoIcon size={size} />;
  }
  return (
    <span className={`kino-logo${className ? ` ${className}` : ""}`}>
      <KinoIcon size={size} />
      <span className="kino-logo__text">Kino</span>
    </span>
  );
}
