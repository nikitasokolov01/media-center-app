import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useProfile } from "../state/ProfileContext.js";
import KinoLogo from "./KinoLogo.js";
import ProfileAvatar from "./ProfileAvatar.js";
import { MaximizeIcon, MinimizeIcon } from "./PlayerIcons.js";

function FullscreenButton() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // Read initial state.
    void window.mediaCenter?.system
      ?.getFullscreen()
      .then((v) => { if (mounted.current) setIsFullscreen(v); })
      .catch(() => {});

    // Stay in sync with BrowserWindow fullscreen changes.
    // EmbeddedPlayerOverlay fires embedded:fullscreen-changed; that same
    // event is also triggered when the user presses F11 in Electron.
    // We listen for it here too so the button icon stays accurate.
    const handler = (_e: Event) => {
      void window.mediaCenter?.system
        ?.getFullscreen()
        .then((v) => { if (mounted.current) setIsFullscreen(v); })
        .catch(() => {});
    };
    window.addEventListener("resize", handler);
    return () => {
      mounted.current = false;
      window.removeEventListener("resize", handler);
    };
  }, []);

  const toggle = useCallback(async () => {
    const next = !isFullscreen;
    setIsFullscreen(next); // optimistic
    try {
      await window.mediaCenter.system.setFullscreen(next);
    } catch {
      setIsFullscreen(isFullscreen); // revert
    }
  }, [isFullscreen]);

  if (!window.mediaCenter?.system?.getFullscreen) return null;

  return (
    <button
      type="button"
      className="top-nav__icon-btn"
      onClick={() => { void toggle(); }}
      title={isFullscreen ? "Exit fullscreen (F11)" : "Fullscreen (F11)"}
      aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
    >
      {isFullscreen
        ? <MinimizeIcon size={16} />
        : <MaximizeIcon size={16} />
      }
    </button>
  );
}

export default function TopNav() {
  const { profile, clearActiveProfile } = useProfile();
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    void navigate(`/search?q=${encodeURIComponent(q)}`);
    setQuery("");
  }

  if (!profile) return null;

  return (
    <header className="top-nav">
      <div className="top-nav__inner">

        {/* Left: brand + nav links */}
        <div className="top-nav__left">
          <NavLink
            to="/"
            end
            className="top-nav__brand"
          >
            <KinoLogo mode="wordmark" size={18} />
          </NavLink>
          <nav className="top-nav__nav">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                isActive ? "top-nav__link top-nav__link--active" : "top-nav__link"
              }
            >
              Home
            </NavLink>
            <NavLink
              to="/library"
              className={({ isActive }) =>
                isActive ? "top-nav__link top-nav__link--active" : "top-nav__link"
              }
            >
              Library
            </NavLink>
          </nav>
        </div>

        {/* Center: search */}
        <form className="top-nav__search" onSubmit={handleSearch} role="search">
          <svg
            className="top-nav__search-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            className="top-nav__search-input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search movies, shows, anime..."
            autoComplete="off"
            spellCheck={false}
          />
        </form>

        {/* Right: fullscreen + settings + profile */}
        <div className="top-nav__right">
          <FullscreenButton />
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `top-nav__icon-btn${isActive ? " top-nav__icon-btn--active" : ""}`
            }
            title="Settings"
            aria-label="Settings"
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </NavLink>
          <button
            type="button"
            className="top-nav__profile-btn"
            onClick={clearActiveProfile}
            title="Switch profile"
          >
            <ProfileAvatar profile={profile} size={26} />
            <span className="top-nav__profile-name">{profile.name}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
