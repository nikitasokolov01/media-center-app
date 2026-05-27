import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import AddonsPage from "./pages/AddonsPage.js";
import HomePage from "./pages/HomePage.js";
import MediaPage from "./pages/MediaPage.js";
import ExpandedCatalogPage from "./pages/ExpandedCatalogPage.js";
import SearchPage from "./pages/SearchPage.js";
import PlayerPage from "./pages/PlayerPage.js";
import SettingsPage from "./pages/SettingsPage.js";
import LibraryPage from "./pages/LibraryPage.js";
import ProfilePicker from "./pages/ProfilePicker.js";
import ExperimentalEmbeddedPlayerPage from "./pages/ExperimentalEmbeddedPlayerPage.js";
import SearchBox from "./components/SearchBox.js";
import ProfileAvatar from "./components/ProfileAvatar.js";
import NowPlayingBar from "./components/NowPlayingBar.js";
import { ProfileProvider, useProfile } from "./state/ProfileContext.js";
import { SettingsProvider, useSettings } from "./state/SettingsContext.js";
import { LibraryProvider } from "./state/LibraryContext.js";
import { ToastProvider } from "./state/ToastContext.js";
import { ContextMenuProvider } from "./state/ContextMenuContext.js";

export default function App() {
  return (
    <ProfileProvider>
      <SettingsProvider>
        <LibraryProvider>
          <ToastProvider>
            <ContextMenuProvider>
              <AppInner />
            </ContextMenuProvider>
          </ToastProvider>
        </LibraryProvider>
      </SettingsProvider>
    </ProfileProvider>
  );
}

function AppInner() {
  const { profile, clearActiveProfile } = useProfile();
  const { settings } = useSettings();
  const embeddedEnabled = settings.experimentalEmbeddedPlayer;

  // No active profile → show the launch picker (Netflix-style).
  if (!profile) {
    return <ProfilePicker />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Media Center</div>
        <SearchBox />
        <nav>
          <NavLink to="/" end className="nav-item">
            Home
          </NavLink>
          <NavLink to="/search" className="nav-item">
            Search
          </NavLink>
          <NavLink to="/library" className="nav-item">
            Library
          </NavLink>
          <NavLink to="/addons" className="nav-item">
            Addons
          </NavLink>
          <NavLink to="/settings" className="nav-item">
            Settings
          </NavLink>
          {embeddedEnabled && (
            <NavLink to="/experimental-embedded-player" className="nav-item">
              Embedded (exp)
            </NavLink>
          )}
        </nav>

        <div className="sidebar__spacer" />

        <button
          type="button"
          className="profile-switcher"
          onClick={clearActiveProfile}
          title="Switch profile"
        >
          <ProfileAvatar profile={profile} size={32} />
          <span className="profile-switcher__meta">
            <span className="profile-switcher__name">{profile.name}</span>
            <span className="profile-switcher__action">Switch profile</span>
          </span>
        </button>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/addons" element={<AddonsPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route
            path="/catalog/:addonId/:type/:catalogId"
            element={<ExpandedCatalogPage />}
          />
          <Route path="/media/:type/:id" element={<MediaPage />} />
          <Route path="/watch/:type/:id" element={<PlayerPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {embeddedEnabled && (
            <Route
              path="/experimental-embedded-player"
              element={<ExperimentalEmbeddedPlayerPage />}
            />
          )}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <NowPlayingBar />
    </div>
  );
}
