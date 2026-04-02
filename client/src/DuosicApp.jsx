import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const BROWSER_ORIGIN = typeof window !== "undefined" ? window.location.origin : "";
const API_URL = import.meta.env.VITE_API_URL ?? "";
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? BROWSER_ORIGIN;
const AUTH_STORAGE_KEY = "duosic-auth-v1";
const THEME_STORAGE_KEY = "duosic-theme-v1";
const YOUTUBE_API_SRC = "https://www.youtube.com/iframe_api";
const APP_NAV_ITEMS = [
  { path: "/app/player", label: "Player" },
  { path: "/app/queue", label: "Queue" },
  { path: "/app/chat", label: "Chat" },
  { path: "/app/people", label: "People" }
];
let youtubeApiPromise = null;

function normalizePathname(pathname) {
  if (!pathname || pathname === "/") {
    return "/";
  }

  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function buildRoomSearch(roomCode) {
  return roomCode ? `?room=${roomCode}` : "";
}

function formatClock(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getExpectedPositionMs(playback, durationMs, clockOffsetMs, nowMs) {
  if (!playback) {
    return 0;
  }

  const updatedAtMs = new Date(playback.updatedAt).getTime();
  const currentTimeMs = playback.isPlaying
    ? playback.positionMs + (nowMs + clockOffsetMs - updatedAtMs)
    : playback.positionMs;

  if (!durationMs || durationMs < 1) {
    return Math.max(0, currentTimeMs);
  }

  return Math.max(0, Math.min(currentTimeMs, durationMs));
}

function loadStoredAuth() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) ?? "null");
  } catch {
    return null;
  }
}

function loadStoredTheme() {
  try {
    const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    return storedTheme === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function loadYouTubeIframeApi() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("YouTube API is only available in the browser."));
  }

  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  if (youtubeApiPromise) {
    return youtubeApiPromise;
  }

  youtubeApiPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      resolve(window.YT);
    };

    const existingScript = document.querySelector(`script[src="${YOUTUBE_API_SRC}"]`);
    if (existingScript) {
      return;
    }

    const script = document.createElement("script");
    script.src = YOUTUBE_API_SRC;
    script.async = true;
    script.onerror = () => reject(new Error("Failed to load the YouTube player."));
    document.head.appendChild(script);
  });

  return youtubeApiPromise;
}

async function sendRequest(path, { method = "GET", body, token } = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message ?? "Request failed");
  }

  return payload;
}

function EmptyState({ title, detail }) {
  return (
    <div className="empty-state-block">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function PublicHeader({ currentUser, theme, onNavigate, onToggleTheme }) {
  return (
    <header className="marketing-header">
      <button className="brand-lockup-button" type="button" onClick={() => onNavigate("/")}>
        <span className="brand-lock" />
        <span>Duosic</span>
      </button>

      <nav className="marketing-nav" aria-label="Primary">
        <button type="button" onClick={() => onNavigate("/")}>
          Home
        </button>
        <button type="button" onClick={() => onNavigate("/app/player")}>
          App
        </button>
      </nav>

      <div className="marketing-actions">
        <button className="ghost-button" type="button" onClick={onToggleTheme}>
          {theme === "dark" ? "Light" : "Dark"}
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={() => onNavigate(currentUser ? "/app/player" : "/login")}
        >
          {currentUser ? "Open app" : "Log in"}
        </button>
      </div>
    </header>
  );
}

function LandingPage({ currentUser, theme, onNavigate, onToggleTheme }) {
  return (
    <div className="marketing-shell">
      <PublicHeader
        currentUser={currentUser}
        theme={theme}
        onNavigate={onNavigate}
        onToggleTheme={onToggleTheme}
      />

      <section className="marketing-hero">
        <div className="marketing-copy">
          <span className="eyebrow">Listen together in real time</span>
          <h1>Music rooms that feel instant, focused, and built as a real product.</h1>
          <p>
            Duosic keeps playback, queue changes, and room chat aligned across devices with a
            cleaner flow than a typical single-page demo.
          </p>

          <div className="marketing-cta">
            <button
              className="primary-button"
              type="button"
              onClick={() => onNavigate(currentUser ? "/app/player" : "/login")}
            >
              {currentUser ? "Continue to app" : "Start listening"}
            </button>
            <button className="ghost-button" type="button" onClick={() => onNavigate("/app/queue")}>
              Explore the app
            </button>
          </div>
        </div>

        <div className="marketing-showcase">
          <div className="showcase-card showcase-card-primary">
            <span className="eyebrow">Current room</span>
            <strong>Shared playback</strong>
            <p>Host-led sync, live queue updates, and presence that feels immediate.</p>
          </div>
          <div className="showcase-card">
            <span className="eyebrow">Queue flexibility</span>
            <strong>Audio URLs and YouTube links</strong>
            <p>Add your own tracks instead of being limited to demo songs.</p>
          </div>
          <div className="showcase-card">
            <span className="eyebrow">Room context</span>
            <strong>Chat, people, and controls</strong>
            <p>Split into dedicated views so the app reads like a product, not a stacked mockup.</p>
          </div>
        </div>
      </section>

      <section className="marketing-grid">
        <article>
          <span className="eyebrow">Realtime rooms</span>
          <h2>Playback stays on one shared timeline.</h2>
          <p>The host can play, pause, seek, and switch tracks while listeners stay synced.</p>
        </article>
        <article>
          <span className="eyebrow">Premium app flow</span>
          <h2>Landing page first. Product workspace after login.</h2>
          <p>No more forcing authentication and playback into the same screen.</p>
        </article>
        <article>
          <span className="eyebrow">Flexible media</span>
          <h2>Bring your own songs through direct audio or YouTube.</h2>
          <p>Keep iterating from here into search, provider integrations, and smarter metadata.</p>
        </article>
      </section>
    </div>
  );
}

function AuthPage({
  authMode,
  authForm,
  authBusy,
  theme,
  onAuthModeChange,
  onAuthFormChange,
  onBack,
  onSubmit,
  onToggleTheme
}) {
  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <div className="auth-head">
          <button className="brand-lockup-button" type="button" onClick={onBack}>
            <span className="brand-lock" />
            <span>Duosic</span>
          </button>
          <button className="ghost-button" type="button" onClick={onToggleTheme}>
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>

        <div className="auth-copy">
          <span className="eyebrow">Account access</span>
          <h1>{authMode === "register" ? "Create your room identity." : "Sign back into your rooms."}</h1>
          <p>Once you are in, the app opens into the workspace instead of keeping auth on the main screen.</p>
        </div>

        <div className="mode-switch">
          <button
            className={authMode === "register" ? "mode-chip mode-chip-active" : "mode-chip"}
            type="button"
            onClick={() => onAuthModeChange("register")}
          >
            Create account
          </button>
          <button
            className={authMode === "login" ? "mode-chip mode-chip-active" : "mode-chip"}
            type="button"
            onClick={() => onAuthModeChange("login")}
          >
            Sign in
          </button>
        </div>

        <div className="form-stack">
          {authMode === "register" ? (
            <label className="field">
              <span>Display name</span>
              <input
                value={authForm.displayName}
                onChange={(event) => onAuthFormChange("displayName", event.target.value)}
                placeholder="Your name"
              />
            </label>
          ) : null}

          <label className="field">
            <span>Email</span>
            <input
              value={authForm.email}
              onChange={(event) => onAuthFormChange("email", event.target.value)}
              placeholder="you@example.com"
            />
          </label>

          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={authForm.password}
              onChange={(event) => onAuthFormChange("password", event.target.value)}
              placeholder="At least 6 characters"
            />
          </label>
        </div>

        <button className="primary-button full-width" type="button" onClick={onSubmit} disabled={authBusy}>
          {authBusy ? "Working" : authMode === "register" ? "Create account" : "Sign in"}
        </button>
      </div>
    </div>
  );
}

function AppSidebar({
  authSession,
  roomCode,
  roomCodeInput,
  queueCount,
  onlineCount,
  isHost,
  busyAction,
  currentTrack,
  pathname,
  onLogout,
  onNavigate,
  onRoomCodeChange,
  onRoomAction
}) {
  return (
    <aside className="app-sidebar">
      <button className="brand-lockup-button brand-lockup-button-wide" type="button" onClick={() => onNavigate("/app/player")}>
        <span className="brand-lock" />
        <span>Duosic</span>
      </button>

      <div className="sidebar-user">
        <strong>{authSession?.user?.displayName ?? "Guest"}</strong>
        <span>{authSession?.user?.email ?? "No account"}</span>
      </div>

      <nav className="sidebar-nav" aria-label="App navigation">
        {APP_NAV_ITEMS.map((item) => (
          <button
            key={item.path}
            className={pathname === item.path ? "sidebar-link sidebar-link-active" : "sidebar-link"}
            type="button"
            onClick={() => onNavigate(item.path)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="sidebar-room">
        <span className="eyebrow">Room access</span>
        <label className="field">
          <span>Room code</span>
          <input
            value={roomCodeInput}
            onChange={(event) => onRoomCodeChange(event.target.value.toUpperCase())}
            placeholder="ABC123"
            maxLength={6}
          />
        </label>

        <div className="sidebar-actions">
          <button
            className="primary-button"
            type="button"
            onClick={() => onRoomAction("create")}
            disabled={busyAction !== ""}
          >
            {busyAction === "create" ? "Creating" : "Create"}
          </button>
          <button
            className="ghost-button"
            type="button"
            onClick={() => onRoomAction("join")}
            disabled={busyAction !== ""}
          >
            {busyAction === "join" ? "Joining" : "Join"}
          </button>
        </div>
      </div>

      <div className="sidebar-now-playing">
        <span className="eyebrow">Current room</span>
        <strong>{roomCode || "No room yet"}</strong>
        <p>{currentTrack ? `${currentTrack.title} by ${currentTrack.artist}` : "Open or join a room to start."}</p>
      </div>

      <div className="sidebar-stats">
        <div>
          <span>Role</span>
          <strong>{roomCode ? (isHost ? "Host" : "Listener") : "Idle"}</strong>
        </div>
        <div>
          <span>Online</span>
          <strong>{onlineCount}</strong>
        </div>
        <div>
          <span>Queue</span>
          <strong>{queueCount}</strong>
        </div>
      </div>

      <button className="ghost-button full-width" type="button" onClick={onLogout}>
        Sign out
      </button>
    </aside>
  );
}

function AppTopbar({ notice, theme, onToggleTheme }) {
  return (
    <div className="app-topbar">
      <div>
        <span className="eyebrow">Workspace</span>
        <p>{notice}</p>
      </div>
      <button className="ghost-button" type="button" onClick={onToggleTheme}>
        {theme === "dark" ? "Light" : "Dark"}
      </button>
    </div>
  );
}

function PlayerView({
  currentTrack,
  roomCode,
  isHost,
  playerState,
  onlineCount,
  shareLink,
  copyState,
  effectiveDurationMs,
  progressMs,
  progressLabel,
  durationLabel,
  canControlPlayback,
  onCopyInvite,
  onNextTrack,
  onEmitTransport,
  onPreviousTrack,
  onSeekDraft
}) {
  return (
    <section className="page-grid page-grid-player">
      <div className="hero-player-card">
        <span className="eyebrow">Now playing</span>
        <h1>{currentTrack ? currentTrack.title : "Your synced room starts here."}</h1>
        <p>
          {currentTrack
            ? `${currentTrack.artist} is live in room ${roomCode}.`
            : "Create a room or join one from the sidebar, then control playback from here."}
        </p>

        <div className="hero-pill-row">
          <span>{roomCode || "No room"}</span>
          <span>{isHost ? "Host" : roomCode ? "Listener" : "Idle"}</span>
          <span>{onlineCount} online</span>
          <span>{playerState}</span>
        </div>

        <div className="player-cover" style={currentTrack ? { backgroundImage: `url(${currentTrack.artwork})` } : undefined}>
          {!currentTrack ? <span>No track loaded</span> : null}
          {currentTrack?.sourceType === "youtube" ? <small>YouTube source</small> : null}
        </div>

        <div className="transport-panel">
          <input
            type="range"
            min="0"
            max={Math.max(effectiveDurationMs, progressMs, 1)}
            value={progressMs}
            disabled={!canControlPlayback || !currentTrack}
            onChange={(event) => onSeekDraft(Number(event.target.value))}
            onMouseUp={(event) => onSeekDraft(Number(event.currentTarget.value), true)}
            onTouchEnd={(event) => onSeekDraft(Number(event.currentTarget.value), true)}
          />
          <div className="progress-meta">
            <span>{progressLabel}</span>
            <span>{durationLabel}</span>
          </div>

          <div className="transport-actions">
            <button
              className="ghost-button"
              type="button"
              onClick={onPreviousTrack}
              disabled={!canControlPlayback}
            >
              Previous
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => onEmitTransport("toggle-play")}
              disabled={!canControlPlayback}
            >
              {playerState === "Playing" ? "Pause" : "Play"}
            </button>
            <button className="ghost-button" type="button" onClick={onCopyInvite} disabled={!shareLink}>
              {copyState || "Copy invite"}
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={onNextTrack}
              disabled={!canControlPlayback}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      <div className="detail-column">
        <div className="detail-block">
          <span className="eyebrow">Host controls</span>
          <strong>{isHost ? "You control the room timeline." : "The host controls playback."}</strong>
          <p>
            {isHost
              ? "Play, pause, seek, and switch tracks for every listener in the room."
              : "You stay synced automatically while the host drives the room."}
          </p>
        </div>

        <div className="detail-block">
          <span className="eyebrow">Media source</span>
          <strong>{currentTrack ? (currentTrack.sourceType === "youtube" ? "YouTube" : "Direct audio") : "Not loaded"}</strong>
          <p>
            Add your own direct audio URLs or YouTube links from the queue page to expand beyond demo songs.
          </p>
        </div>
      </div>
    </section>
  );
}

function QueueView({
  isHost,
  sessionRoomCode,
  trackBusy,
  trackForm,
  youtubeSearchQuery,
  youtubeSearchBusy,
  youtubeSearchResults,
  queue,
  currentTrackId,
  canControlPlayback,
  onTrackFormChange,
  onYouTubeSearchQueryChange,
  onYouTubeSearch,
  onAddSearchResult,
  onAddTrack,
  onEmitTransport
}) {
  return (
    <section className="page-grid">
      <div className="content-card">
        <div className="page-head">
          <span className="eyebrow">Queue</span>
          <h1>Room queue</h1>
          <p>Switch tracks here, or add a new song by direct audio URL or YouTube link.</p>
        </div>

        {isHost ? (
          <div className="search-card">
            <div className="page-head compact-page-head">
              <span className="eyebrow">YouTube search</span>
              <h2>Find a video inside the app</h2>
              <p>Requires `YOUTUBE_API_KEY` on the server.</p>
            </div>

            <div className="search-row">
              <input
                value={youtubeSearchQuery}
                onChange={(event) => onYouTubeSearchQueryChange(event.target.value)}
                placeholder="Search YouTube"
              />
              <button
                className="ghost-button"
                type="button"
                onClick={onYouTubeSearch}
                disabled={youtubeSearchBusy}
              >
                {youtubeSearchBusy ? "Searching" : "Search"}
              </button>
            </div>

            {youtubeSearchResults.length ? (
              <div className="search-results">
                {youtubeSearchResults.map((result) => (
                  <div className="search-result-row" key={result.videoId}>
                    <img alt="" src={result.artwork} />
                    <div>
                      <strong>{result.title}</strong>
                      <span>{result.artist}</span>
                    </div>
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => onAddSearchResult(result)}
                    >
                      Add
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {isHost ? (
          <div className="form-grid-two">
            <label className="field">
              <span>Track title</span>
              <input
                value={trackForm.title}
                onChange={(event) => onTrackFormChange("title", event.target.value)}
                placeholder="Song title"
              />
            </label>
            <label className="field">
              <span>Artist</span>
              <input
                value={trackForm.artist}
                onChange={(event) => onTrackFormChange("artist", event.target.value)}
                placeholder="Artist name"
              />
            </label>
            <label className="field field-wide">
              <span>Media URL</span>
              <input
                value={trackForm.streamUrl}
                onChange={(event) => onTrackFormChange("streamUrl", event.target.value)}
                placeholder="https://youtube.com/watch?v=... or https://example.com/song.mp3"
              />
            </label>
            <label className="field">
              <span>Artwork URL</span>
              <input
                value={trackForm.artwork}
                onChange={(event) => onTrackFormChange("artwork", event.target.value)}
                placeholder="Optional cover image"
              />
            </label>
            <label className="field">
              <span>Duration in ms</span>
              <input
                value={trackForm.durationMs}
                onChange={(event) => onTrackFormChange("durationMs", event.target.value)}
                placeholder="Optional for YouTube"
              />
            </label>
          </div>
        ) : null}

        {isHost ? (
          <button
            className="primary-button queue-submit"
            type="button"
            onClick={onAddTrack}
            disabled={trackBusy || !sessionRoomCode}
          >
            {trackBusy ? "Adding track" : "Add track to queue"}
          </button>
        ) : null}

        <div className="queue-stack">
          {queue.length ? (
            queue.map((track) => (
              <button
                key={track.id}
                className={track.id === currentTrackId ? "queue-list-row queue-list-row-active" : "queue-list-row"}
                type="button"
                disabled={!canControlPlayback}
                onClick={() => onEmitTransport("select-track", { trackId: track.id })}
              >
                <div>
                  <strong>{track.title}</strong>
                  <span>{track.artist}</span>
                </div>
                <small>{track.durationMs > 0 ? formatClock(track.durationMs / 1000) : track.sourceType === "youtube" ? "YouTube" : "Unknown"}</small>
              </button>
            ))
          ) : (
            <EmptyState title="No queue yet." detail="Create or join a room to see the track list." />
          )}
        </div>
      </div>
    </section>
  );
}

function ChatView({ messages, chatInput, sessionRoomCode, onChatInputChange, onSendMessage }) {
  return (
    <section className="page-grid">
      <div className="content-card">
        <div className="page-head">
          <span className="eyebrow">Chat</span>
          <h1>Room conversation</h1>
          <p>Keep the room talking without mixing chat and playback into the same screen.</p>
        </div>

        <div className="chat-stream">
          {messages.length ? (
            messages.map((message) => (
              <div className="chat-bubble" key={message.id}>
                <strong>{message.displayName}</strong>
                <p>{message.body}</p>
              </div>
            ))
          ) : (
            <EmptyState title="No messages yet." detail="Room chat will appear here once someone sends a message." />
          )}
        </div>

        <div className="composer">
          <input
            value={chatInput}
            onChange={(event) => onChatInputChange(event.target.value)}
            placeholder="Send a message"
            disabled={!sessionRoomCode}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onSendMessage();
              }
            }}
          />
          <button className="primary-button" type="button" onClick={onSendMessage} disabled={!sessionRoomCode}>
            Send
          </button>
        </div>
      </div>
    </section>
  );
}

function PeopleView({ participants, roomOwnerId }) {
  return (
    <section className="page-grid">
      <div className="content-card">
        <div className="page-head">
          <span className="eyebrow">People</span>
          <h1>Room listeners</h1>
          <p>Presence stays live, and the host remains clear even as multiple devices connect.</p>
        </div>

        <div className="people-stack">
          {participants.length ? (
            participants.map((participant) => (
              <div className="people-row" key={participant.id}>
                <div>
                  <strong>{participant.displayName}</strong>
                  <span>{participant.id === roomOwnerId ? "Host" : "Listener"}</span>
                </div>
                <small className={participant.isConnected ? "presence-indicator presence-indicator-live" : "presence-indicator"}>
                  {participant.isConnected ? "Online" : "Away"}
                </small>
              </div>
            ))
          ) : (
            <EmptyState title="Nobody is here yet." detail="Once people join the room, they appear here." />
          )}
        </div>
      </div>
    </section>
  );
}

export default function DuosicApp() {
  const audioRef = useRef(null);
  const socketRef = useRef(null);
  const youtubeMountRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const youtubeVideoIdRef = useRef("");
  const [locationState, setLocationState] = useState(() => ({
    pathname: normalizePathname(window.location.pathname),
    search: window.location.search
  }));
  const [theme, setTheme] = useState(() => loadStoredTheme());
  const [authSession, setAuthSession] = useState(() => loadStoredAuth());
  const [authMode, setAuthMode] = useState("register");
  const [authForm, setAuthForm] = useState({
    displayName: "",
    email: "",
    password: ""
  });
  const [authBusy, setAuthBusy] = useState(false);
  const [session, setSession] = useState(null);
  const [room, setRoom] = useState(null);
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());
  const [dragPositionMs, setDragPositionMs] = useState(null);
  const [chatInput, setChatInput] = useState("");
  const [trackForm, setTrackForm] = useState({
    title: "",
    artist: "",
    streamUrl: "",
    artwork: "",
    durationMs: ""
  });
  const [trackBusy, setTrackBusy] = useState(false);
  const [youtubeSearchQuery, setYouTubeSearchQuery] = useState("");
  const [youtubeSearchBusy, setYouTubeSearchBusy] = useState(false);
  const [youtubeSearchResults, setYouTubeSearchResults] = useState([]);
  const [youtubeReady, setYoutubeReady] = useState(false);
  const [youtubeDurationMs, setYoutubeDurationMs] = useState(0);
  const [notice, setNotice] = useState(
    "Open a room from the sidebar and keep everyone on one shared timeline."
  );
  const [busyAction, setBusyAction] = useState("");
  const [copyState, setCopyState] = useState("");

  const pathname = locationState.pathname;
  const roomQuery = new URLSearchParams(locationState.search).get("room");
  const currentTrack = room?.currentTrack ?? null;
  const currentUser = authSession?.user ?? null;
  const roomCode = room?.roomCode ?? session?.roomCode ?? roomQuery ?? "";
  const shareLink = roomCode ? `${BROWSER_ORIGIN}/app/player${buildRoomSearch(roomCode)}` : "";
  const isHost = Boolean(currentUser && room && currentUser.id === room.ownerId);
  const canControlPlayback = Boolean(session?.roomCode && isHost);
  const participants = room?.participants ?? [];
  const connectedListeners = participants.filter((participant) => participant.isConnected);
  const messages = room?.messages ?? [];
  const queue = room?.queue ?? [];
  const playerState = room?.playback?.isPlaying ? "Playing" : "Paused";
  const isYouTubeTrack = Boolean(currentTrack?.sourceType === "youtube" && currentTrack?.videoId);
  const effectiveDurationMs = Math.max(currentTrack?.durationMs ?? 0, youtubeDurationMs);
  const isAppPath = pathname.startsWith("/app");

  function navigate(nextPathname, { replace = false, search = locationState.search } = {}) {
    const normalizedPath = normalizePathname(nextPathname);
    const nextUrl = `${normalizedPath}${search}`;

    startTransition(() => {
      setLocationState({
        pathname: normalizedPath,
        search
      });
    });

    window.history[replace ? "replaceState" : "pushState"]({}, "", nextUrl);
  }

  useEffect(() => {
    const handlePopState = () => {
      startTransition(() => {
        setLocationState({
          pathname: normalizePathname(window.location.pathname),
          search: window.location.search
        });
      });
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (roomQuery) {
      setRoomCodeInput(roomQuery.toUpperCase());
    }
  }, [roomQuery]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (authSession) {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authSession));
    } else {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  }, [authSession]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 250);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (pathname === "/app") {
      navigate(authSession ? "/app/player" : "/login", {
        replace: true,
        search: locationState.search
      });
      return;
    }

    if (isAppPath && !authSession) {
      navigate("/login", {
        replace: true,
        search: locationState.search
      });
      return;
    }

    if (pathname === "/login" && authSession) {
      navigate("/app/player", {
        replace: true,
        search: locationState.search
      });
    }
  }, [authSession, isAppPath, locationState.search, pathname]);

  useEffect(() => {
    if (!authSession?.token) {
      return;
    }

    let cancelled = false;

    sendRequest("/api/auth/me", { token: authSession.token })
      .then((payload) => {
        if (!cancelled) {
          setAuthSession((current) => (current ? { ...current, user: payload.user } : current));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAuthSession(null);
          setSession(null);
          setRoom(null);
          setNotice("Your session expired. Sign in again to keep using your rooms.");
          navigate("/login", { replace: true });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authSession?.token]);

  useEffect(() => {
    if (!session?.roomCode || !authSession?.token) {
      return undefined;
    }

    const socket = io(SOCKET_URL, {
      transports: ["websocket"],
      auth: {
        token: authSession.token
      }
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("room:enter", {
        roomCode: session.roomCode
      });
    });

    socket.on("room:state", ({ room: nextRoom, serverNow }) => {
      startTransition(() => {
        setRoom(nextRoom);
        setClockOffsetMs(serverNow - Date.now());
      });
      setNotice(
        `${nextRoom.ownerId === currentUser?.id ? "Hosting" : "Connected to"} room ${nextRoom.roomCode}.`
      );
    });

    socket.on("room:error", ({ message }) => {
      setNotice(message);
    });

    socket.on("connect_error", ({ message }) => {
      setNotice(message || "Unable to reach the live sync server right now.");
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [authSession?.token, currentUser?.id, session]);

  useEffect(() => {
    if (!isYouTubeTrack) {
      setYoutubeDurationMs(0);
      setYoutubeReady(false);
      youtubeVideoIdRef.current = "";
      youtubePlayerRef.current?.pauseVideo?.();
      return;
    }

    audioRef.current?.pause();
    let isActive = true;

    loadYouTubeIframeApi()
      .then((YT) => {
        if (!isActive || !youtubeMountRef.current) {
          return;
        }

        if (!youtubePlayerRef.current) {
          youtubePlayerRef.current = new YT.Player(youtubeMountRef.current, {
            videoId: currentTrack.videoId,
            playerVars: {
              playsinline: 1,
              rel: 0,
              origin: BROWSER_ORIGIN || window.location.origin
            },
            events: {
              onReady: (event) => {
                if (!isActive) {
                  return;
                }

                youtubeVideoIdRef.current = currentTrack.videoId;
                setYoutubeReady(true);
                const nextDurationMs = Math.round((event.target.getDuration?.() ?? 0) * 1000);
                if (nextDurationMs > 0) {
                  setYoutubeDurationMs(nextDurationMs);
                }
              },
              onStateChange: (event) => {
                const nextDurationMs = Math.round((event.target.getDuration?.() ?? 0) * 1000);
                if (nextDurationMs > 0) {
                  setYoutubeDurationMs(nextDurationMs);
                }

                if (window.YT && event.data === window.YT.PlayerState.ENDED) {
                  if (isHost && queue.length > 1) {
                    emitTransport("next-track");
                  } else {
                    setNotice("The YouTube track ended. Pick the next song from the queue.");
                  }
                }
              },
              onError: () => {
                setNotice("This YouTube video could not be played in the room player.");
              }
            }
          });
        }
      })
      .catch((error) => {
        if (isActive) {
          setNotice(error.message);
        }
      });

    return () => {
      isActive = false;
    };
  }, [currentTrack?.videoId, isHost, isYouTubeTrack, queue.length]);

  useEffect(() => {
    const audio = audioRef.current;
    if (isYouTubeTrack || !audio || !currentTrack || !room?.playback) {
      return;
    }

    youtubePlayerRef.current?.pauseVideo?.();

    const ensureTrack = () => {
      if (audio.dataset.trackId !== currentTrack.id) {
        audio.dataset.trackId = currentTrack.id;
        audio.src = currentTrack.streamUrl;
        audio.load();
      }
    };

    const syncAudio = () => {
      ensureTrack();

      const expectedPositionMs = getExpectedPositionMs(
        room.playback,
        effectiveDurationMs,
        clockOffsetMs,
        Date.now()
      );
      const expectedSeconds = expectedPositionMs / 1000;
      const driftSeconds = Math.abs(audio.currentTime - expectedSeconds);

      if (driftSeconds > 0.35) {
        audio.currentTime = expectedSeconds;
      }

      if (room.playback.isPlaying && audio.paused) {
        audio.play().catch(() => {
          setNotice("Playback is synced, but autoplay is blocked. Press play once to unlock audio.");
        });
      }

      if (!room.playback.isPlaying && !audio.paused) {
        audio.pause();
      }
    };

    syncAudio();
    const handleEnded = () => {
      if (isHost && queue.length > 1) {
        emitTransport("next-track");
      } else {
        setNotice("The track ended. Pick the next song from the queue.");
      }
    };

    audio.addEventListener("ended", handleEnded);
    const intervalId = window.setInterval(syncAudio, 700);

    return () => {
      audio.removeEventListener("ended", handleEnded);
      window.clearInterval(intervalId);
    };
  }, [clockOffsetMs, currentTrack, effectiveDurationMs, isHost, isYouTubeTrack, queue.length, room]);

  useEffect(() => {
    if (!isYouTubeTrack || !youtubeReady || !youtubePlayerRef.current || !currentTrack || !room?.playback) {
      return;
    }

    const syncYouTubePlayer = () => {
      const player = youtubePlayerRef.current;
      const expectedPositionMs = getExpectedPositionMs(
        room.playback,
        effectiveDurationMs,
        clockOffsetMs,
        Date.now()
      );

      if (youtubeVideoIdRef.current !== currentTrack.videoId) {
        youtubeVideoIdRef.current = currentTrack.videoId;
        const loadArgs = {
          videoId: currentTrack.videoId,
          startSeconds: expectedPositionMs / 1000
        };

        if (room.playback.isPlaying) {
          player.loadVideoById(loadArgs);
        } else {
          player.cueVideoById(loadArgs);
        }
        return;
      }

      const currentPositionMs = Math.round((player.getCurrentTime?.() ?? 0) * 1000);
      if (Math.abs(currentPositionMs - expectedPositionMs) > 1200) {
        player.seekTo(expectedPositionMs / 1000, true);
      }

      const nextDurationMs = Math.round((player.getDuration?.() ?? 0) * 1000);
      if (nextDurationMs > 0) {
        setYoutubeDurationMs(nextDurationMs);
      }

      const currentState = player.getPlayerState?.();
      const playingState = window.YT?.PlayerState?.PLAYING;

      if (room.playback.isPlaying && currentState !== playingState) {
        player.playVideo?.();
      }

      if (!room.playback.isPlaying && currentState === playingState) {
        player.pauseVideo?.();
      }
    };

    syncYouTubePlayer();
    const intervalId = window.setInterval(syncYouTubePlayer, 900);

    return () => window.clearInterval(intervalId);
  }, [clockOffsetMs, currentTrack, effectiveDurationMs, isYouTubeTrack, room, youtubeReady]);

  useEffect(() => {
    return () => {
      youtubePlayerRef.current?.destroy?.();
    };
  }, []);

  const progressMs = useMemo(() => {
    if (!room?.playback || !currentTrack) {
      return 0;
    }

    if (dragPositionMs !== null) {
      return dragPositionMs;
    }

    return getExpectedPositionMs(room.playback, effectiveDurationMs, clockOffsetMs, nowMs);
  }, [clockOffsetMs, currentTrack, dragPositionMs, effectiveDurationMs, nowMs, room]);

  const progressLabel = currentTrack ? formatClock(progressMs / 1000) : "0:00";
  const durationLabel =
    currentTrack && effectiveDurationMs > 0 ? formatClock(effectiveDurationMs / 1000) : "--:--";

  async function handleAuthSubmit() {
    setAuthBusy(true);

    try {
      const path = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
      const payload = await sendRequest(path, {
        method: "POST",
        body: authForm
      });

      setAuthSession(payload);
      setAuthForm((current) => ({
        ...current,
        password: ""
      }));
      setNotice(`${payload.user.displayName} is signed in and ready.`);
      navigate("/app/player", {
        replace: true,
        search: locationState.search
      });
    } catch (error) {
      setNotice(error.message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleRoomAction(mode) {
    if (!authSession?.token) {
      setNotice("Sign in before joining a room.");
      navigate("/login", {
        replace: false,
        search: locationState.search
      });
      return;
    }

    setBusyAction(mode);

    try {
      const payload =
        mode === "create"
          ? await sendRequest("/api/rooms/create", {
              method: "POST",
              token: authSession.token
            })
          : await sendRequest("/api/rooms/join", {
              method: "POST",
              token: authSession.token,
              body: { roomCode: roomCodeInput }
            });

      setSession({ roomCode: payload.room.roomCode });
      setRoom(payload.room);
      setClockOffsetMs(0);
      navigate("/app/player", {
        replace: true,
        search: buildRoomSearch(payload.room.roomCode)
      });
      setNotice(
        mode === "create"
          ? `Room ${payload.room.roomCode} created. You are the host.`
          : `Joined room ${payload.room.roomCode}.`
      );
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusyAction("");
    }
  }

  function emitTransport(type, payload = {}) {
    if (!session?.roomCode || !socketRef.current) {
      return;
    }

    socketRef.current.emit("transport:update", {
      roomCode: session.roomCode,
      type,
      payload
    });
  }

  function handleSeekDraft(value, commit = false) {
    setDragPositionMs(value);

    if (commit && canControlPlayback) {
      emitTransport("seek", { positionMs: value });
      setDragPositionMs(null);
    }
  }

  function handleSendMessage() {
    if (!chatInput.trim() || !socketRef.current || !session?.roomCode) {
      return;
    }

    socketRef.current.emit("chat:send", {
      roomCode: session.roomCode,
      body: chatInput
    });
    setChatInput("");
  }

  async function handleCopyInvite() {
    if (!shareLink) {
      return;
    }

    try {
      await navigator.clipboard.writeText(shareLink);
      setCopyState("Copied");
    } catch {
      setCopyState("Copy failed");
    }
  }

  async function handleAddTrack() {
    if (!session?.roomCode || !authSession?.token) {
      setNotice("Create or join a room before adding tracks.");
      return;
    }

    setTrackBusy(true);

    try {
      const payload = await sendRequest(`/api/rooms/${session.roomCode}/tracks`, {
        method: "POST",
        token: authSession.token,
        body: {
          title: trackForm.title,
          artist: trackForm.artist,
          streamUrl: trackForm.streamUrl,
          artwork: trackForm.artwork,
          durationMs: trackForm.durationMs ? Number(trackForm.durationMs) : 0
        }
      });

      setRoom(payload.room);
      setTrackForm({
        title: "",
        artist: "",
        streamUrl: "",
        artwork: "",
        durationMs: ""
      });
      setNotice("Track added to the queue.");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setTrackBusy(false);
    }
  }

  async function handleYouTubeSearch() {
    if (!youtubeSearchQuery.trim() || !authSession?.token) {
      return;
    }

    setYouTubeSearchBusy(true);

    try {
      const payload = await sendRequest(
        `/api/youtube/search?q=${encodeURIComponent(youtubeSearchQuery.trim())}`,
        {
          token: authSession.token
        }
      );
      setYouTubeSearchResults(payload.results ?? []);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setYouTubeSearchBusy(false);
    }
  }

  async function handleAddSearchResult(result) {
    if (!session?.roomCode || !authSession?.token) {
      setNotice("Create or join a room before adding tracks.");
      return;
    }

    setTrackForm({
      title: result.title,
      artist: result.artist,
      streamUrl: result.streamUrl,
      artwork: result.artwork,
      durationMs: result.durationMs ? String(result.durationMs) : ""
    });

    try {
      const payload = await sendRequest(`/api/rooms/${session.roomCode}/tracks`, {
        method: "POST",
        token: authSession.token,
        body: {
          title: result.title,
          artist: result.artist,
          streamUrl: result.streamUrl,
          artwork: result.artwork,
          durationMs: result.durationMs
        }
      });

      setRoom(payload.room);
      setNotice("YouTube result added to the queue.");
    } catch (error) {
      setNotice(error.message);
    }
  }

  function handleLogout() {
    setAuthSession(null);
    setSession(null);
    setRoom(null);
    setRoomCodeInput("");
    setNotice("Signed out.");
    navigate("/", { replace: true, search: "" });
  }

  function renderAppView() {
    if (pathname === "/app/queue") {
      return (
        <QueueView
          isHost={isHost}
          sessionRoomCode={session?.roomCode}
          trackBusy={trackBusy}
          trackForm={trackForm}
          youtubeSearchQuery={youtubeSearchQuery}
          youtubeSearchBusy={youtubeSearchBusy}
          youtubeSearchResults={youtubeSearchResults}
          queue={queue}
          currentTrackId={currentTrack?.id}
          canControlPlayback={canControlPlayback}
          onTrackFormChange={(field, value) =>
            setTrackForm((current) => ({
              ...current,
              [field]: value
            }))
          }
          onYouTubeSearchQueryChange={setYouTubeSearchQuery}
          onYouTubeSearch={handleYouTubeSearch}
          onAddSearchResult={handleAddSearchResult}
          onAddTrack={handleAddTrack}
          onEmitTransport={emitTransport}
        />
      );
    }

    if (pathname === "/app/chat") {
      return (
        <ChatView
          messages={messages}
          chatInput={chatInput}
          sessionRoomCode={session?.roomCode}
          onChatInputChange={setChatInput}
          onSendMessage={handleSendMessage}
        />
      );
    }

    if (pathname === "/app/people") {
      return <PeopleView participants={participants} roomOwnerId={room?.ownerId} />;
    }

    return (
      <PlayerView
        currentTrack={currentTrack}
        roomCode={roomCode}
        isHost={isHost}
        playerState={playerState}
        onlineCount={connectedListeners.length}
        shareLink={shareLink}
        copyState={copyState}
        effectiveDurationMs={effectiveDurationMs}
        progressMs={progressMs}
        progressLabel={progressLabel}
        durationLabel={durationLabel}
        canControlPlayback={canControlPlayback}
        onCopyInvite={handleCopyInvite}
        onNextTrack={() => emitTransport("next-track")}
        onEmitTransport={emitTransport}
        onPreviousTrack={() => emitTransport("previous-track")}
        onSeekDraft={handleSeekDraft}
      />
    );
  }

  return (
    <div className="duosic-shell">
      <div className="surface-blur surface-blur-a" aria-hidden="true" />
      <div className="surface-blur surface-blur-b" aria-hidden="true" />

      <div className="media-hosts" aria-hidden="true">
        <audio ref={audioRef} preload="metadata" />
        <div className="youtube-hidden-host" ref={youtubeMountRef} />
      </div>

      {pathname === "/" ? (
        <LandingPage
          currentUser={currentUser}
          theme={theme}
          onNavigate={navigate}
          onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        />
      ) : null}

      {pathname === "/login" ? (
        <AuthPage
          authMode={authMode}
          authForm={authForm}
          authBusy={authBusy}
          theme={theme}
          onAuthModeChange={setAuthMode}
          onAuthFormChange={(field, value) =>
            setAuthForm((current) => ({
              ...current,
              [field]: value
            }))
          }
          onBack={() => navigate("/")}
          onSubmit={handleAuthSubmit}
          onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        />
      ) : null}

      {isAppPath && authSession ? (
        <div className="app-shell">
          <AppSidebar
            authSession={authSession}
            roomCode={roomCode}
            roomCodeInput={roomCodeInput}
            queueCount={queue.length}
            onlineCount={connectedListeners.length}
            isHost={isHost}
            busyAction={busyAction}
            currentTrack={currentTrack}
            pathname={pathname}
            onLogout={handleLogout}
            onNavigate={(nextPath) =>
              navigate(nextPath, {
                search: buildRoomSearch(roomCode)
              })
            }
            onRoomCodeChange={setRoomCodeInput}
            onRoomAction={handleRoomAction}
          />

          <main className="app-main">
            <AppTopbar
              notice={notice}
              theme={theme}
              onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
            />
            {renderAppView()}
          </main>
        </div>
      ) : null}
    </div>
  );
}
