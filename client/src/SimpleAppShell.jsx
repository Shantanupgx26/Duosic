import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const BROWSER_ORIGIN = typeof window !== "undefined" ? window.location.origin : "";
const API_URL = import.meta.env.VITE_API_URL ?? "";
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? BROWSER_ORIGIN;
const AUTH_STORAGE_KEY = "duosic-auth-v1";
const THEME_STORAGE_KEY = "duosic-theme-v1";

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

function PanelHeading({ label, title, description }) {
  return (
    <div className="section-head">
      <span className="section-label">{label}</span>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </div>
  );
}

export default function SimpleAppShell() {
  const audioRef = useRef(null);
  const socketRef = useRef(null);
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
  const [notice, setNotice] = useState(
    "Sign in, create a room, and keep everyone listening on the same shared clock."
  );
  const [busyAction, setBusyAction] = useState("");
  const [copyState, setCopyState] = useState("");

  const currentTrack = room?.currentTrack ?? null;
  const shareLink = room?.roomCode ? `${BROWSER_ORIGIN}?room=${room.roomCode}` : "";
  const currentUser = authSession?.user ?? null;
  const isHost = currentUser && room ? currentUser.id === room.ownerId : false;
  const canControlPlayback = Boolean(session?.roomCode && isHost);
  const connectedListeners = room?.participants?.filter((participant) => participant.isConnected) ?? [];
  const messages = room?.messages ?? [];
  const sectionLinks = [
    { id: "account", label: "Account" },
    { id: "player", label: "Player" },
    { id: "listeners", label: "People" },
    { id: "chat", label: "Chat" },
    { id: "queue", label: "Queue" }
  ];

  useEffect(() => {
    const initialRoomCode = new URLSearchParams(window.location.search).get("room");
    if (initialRoomCode) {
      setRoomCodeInput(initialRoomCode.toUpperCase());
    }
  }, []);

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
      setRoom(nextRoom);
      setClockOffsetMs(serverNow - Date.now());
      setNotice(
        `${nextRoom.ownerId === currentUser?.id ? "You are hosting" : "You joined"} room ${nextRoom.roomCode}.`
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
    const audio = audioRef.current;
    if (!audio || !currentTrack || !room?.playback) {
      return;
    }

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
        currentTrack.durationMs,
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
          setNotice("Playback is synced, but your browser blocked autoplay. Press play once to unlock audio.");
        });
      }

      if (!room.playback.isPlaying && !audio.paused) {
        audio.pause();
      }
    };

    syncAudio();
    const intervalId = window.setInterval(syncAudio, 700);

    return () => window.clearInterval(intervalId);
  }, [room, currentTrack, clockOffsetMs]);

  const progressMs = useMemo(() => {
    if (!room?.playback || !currentTrack) {
      return 0;
    }

    if (dragPositionMs !== null) {
      return dragPositionMs;
    }

    return getExpectedPositionMs(room.playback, currentTrack.durationMs, clockOffsetMs, nowMs);
  }, [room, currentTrack, dragPositionMs, clockOffsetMs, nowMs]);

  const progressLabel = currentTrack ? formatClock(progressMs / 1000) : "0:00";
  const durationLabel = currentTrack ? formatClock(currentTrack.durationMs / 1000) : "0:00";

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
      setNotice(`${payload.user.displayName} is signed in and ready to join a room.`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleRoomAction(mode) {
    if (!authSession?.token) {
      setNotice("Sign in before joining the shared session.");
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
      window.history.replaceState({}, "", `?room=${payload.room.roomCode}`);
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
      setCopyState("Invite link copied.");
    } catch {
      setCopyState("Could not copy the invite link.");
    }
  }

  function handleLogout() {
    setAuthSession(null);
    setSession(null);
    setRoom(null);
    setRoomCodeInput("");
    setNotice("Signed out. Come back with another room whenever you want.");
    window.history.replaceState({}, "", window.location.pathname);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-pill">Duosic</span>
          <div>
            <h1>Shared listening rooms</h1>
            <p>Simple, synced listening with clear controls, live chat, and easy room access.</p>
          </div>
        </div>

        <div className="topbar-actions">
          <button className="secondary-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "Light theme" : "Dark theme"}
          </button>
          {currentUser ? (
            <div className="user-chip">
              <strong>{currentUser.displayName}</strong>
              <span>{currentUser.email}</span>
            </div>
          ) : null}
        </div>
      </header>

      <div className="notice-banner">{notice}</div>

      <nav className="section-nav" aria-label="Section navigation">
        {sectionLinks.map((section) => (
          <a className="section-link" href={`#${section.id}`} key={section.id}>
            {section.label}
          </a>
        ))}
      </nav>

      <main className="layout-grid">
        <section className="panel account-panel" id="account">
          <PanelHeading
            label="Account"
            title={authSession ? "Signed in" : "Sign in to continue"}
            description="Use one account across rooms, devices, and future sessions."
          />

          {authSession ? (
            <div className="account-card">
              <div className="account-meta">
                <strong>{authSession.user.displayName}</strong>
                <span>{authSession.user.email}</span>
              </div>
              <button className="secondary-button full-width" onClick={handleLogout}>
                Sign out
              </button>
            </div>
          ) : (
            <div className="auth-card">
              <div className="tab-row">
                <button
                  className={authMode === "register" ? "tab-button tab-button-active" : "tab-button"}
                  onClick={() => setAuthMode("register")}
                  type="button"
                >
                  Create account
                </button>
                <button
                  className={authMode === "login" ? "tab-button tab-button-active" : "tab-button"}
                  onClick={() => setAuthMode("login")}
                  type="button"
                >
                  Sign in
                </button>
              </div>

              <div className="form-grid">
                {authMode === "register" ? (
                  <label className="field">
                    <span>Display name</span>
                    <input
                      value={authForm.displayName}
                      onChange={(event) =>
                        setAuthForm((current) => ({ ...current, displayName: event.target.value }))
                      }
                      placeholder="Your name"
                    />
                  </label>
                ) : null}

                <label className="field">
                  <span>Email</span>
                  <input
                    value={authForm.email}
                    onChange={(event) =>
                      setAuthForm((current) => ({ ...current, email: event.target.value }))
                    }
                    placeholder="you@example.com"
                  />
                </label>

                <label className="field">
                  <span>Password</span>
                  <input
                    type="password"
                    value={authForm.password}
                    onChange={(event) =>
                      setAuthForm((current) => ({ ...current, password: event.target.value }))
                    }
                    placeholder="At least 6 characters"
                  />
                </label>
              </div>

              <button className="primary-button full-width" onClick={handleAuthSubmit} disabled={authBusy}>
                {authBusy ? "Working..." : authMode === "register" ? "Create account" : "Sign in"}
              </button>
            </div>
          )}

          <div className="panel-divider" />

          <PanelHeading
            label="Rooms"
            title="Create or join"
            description="Paste a room code or create a fresh room in one tap."
          />

          <div className="form-grid">
            <label className="field">
              <span>Room code</span>
              <input
                value={roomCodeInput}
                onChange={(event) => setRoomCodeInput(event.target.value.toUpperCase())}
                placeholder="ABC123"
                maxLength={6}
              />
            </label>
          </div>

          <div className="action-row">
            <button
              className="primary-button"
              onClick={() => handleRoomAction("create")}
              disabled={busyAction !== "" || !authSession}
            >
              {busyAction === "create" ? "Creating..." : "Create room"}
            </button>
            <button
              className="secondary-button"
              onClick={() => handleRoomAction("join")}
              disabled={busyAction !== "" || !authSession}
            >
              {busyAction === "join" ? "Joining..." : "Join room"}
            </button>
          </div>

          {room ? (
            <div className="room-summary">
              <div className="meta-chip">Room {room.roomCode}</div>
              <div className="meta-chip">{isHost ? "Host" : "Listener"}</div>
              <div className="meta-chip">{connectedListeners.length} online</div>
              {shareLink ? (
                <button className="secondary-button full-width" onClick={handleCopyInvite}>
                  {copyState || "Copy invite link"}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="panel player-panel" id="player">
          <audio ref={audioRef} preload="metadata" />
          <PanelHeading
            label="Player"
            title={currentTrack ? currentTrack.title : "No room active yet"}
            description={
              currentTrack
                ? `${currentTrack.artist} - ${isHost ? "host controls enabled" : "synced listener mode"}`
                : "Join a room to load the shared player."
            }
          />

          {currentTrack ? (
            <>
              <div
                className="track-artwork"
                style={{ backgroundImage: `url(${currentTrack.artwork})` }}
              />

              <div className="meta-row">
                <span className="meta-chip">{isHost ? "Host controls" : "Listener mode"}</span>
                <span className="meta-chip">{room?.playback?.isPlaying ? "Playing" : "Paused"}</span>
              </div>

              <p className="helper-text">
                {isHost
                  ? "Your playback actions update the room for everyone."
                  : "The host controls playback. Your browser stays aligned automatically."}
              </p>

              <div className="progress-stack">
                <input
                  type="range"
                  min="0"
                  max={currentTrack.durationMs}
                  value={progressMs}
                  disabled={!canControlPlayback}
                  onChange={(event) => setDragPositionMs(Number(event.target.value))}
                  onMouseUp={() => {
                    if (dragPositionMs !== null && canControlPlayback) {
                      emitTransport("seek", { positionMs: dragPositionMs });
                      setDragPositionMs(null);
                    }
                  }}
                  onTouchEnd={() => {
                    if (dragPositionMs !== null && canControlPlayback) {
                      emitTransport("seek", { positionMs: dragPositionMs });
                      setDragPositionMs(null);
                    }
                  }}
                />
                <div className="time-row">
                  <span>{progressLabel}</span>
                  <span>{durationLabel}</span>
                </div>
              </div>

              <div className="action-row">
                <button
                  className="primary-button"
                  onClick={() => emitTransport("toggle-play")}
                  disabled={!canControlPlayback}
                >
                  {room?.playback?.isPlaying ? "Pause" : "Play"}
                </button>
              </div>
            </>
          ) : (
            <div className="empty-panel">
              <p>Sign in and create a room, or join an invite link, to start listening.</p>
            </div>
          )}
        </section>

        <section className="panel listeners-panel" id="listeners">
          <PanelHeading
            label="People"
            title="Listeners"
            description="See who is in the room and who currently has the host role."
          />

          <div className="list-stack">
            {(room?.participants ?? []).length ? (
              room.participants.map((participant) => (
                <div className="list-row" key={participant.id}>
                  <div>
                    <strong>{participant.displayName}</strong>
                    <span>{participant.id === room?.ownerId ? "Host" : "Listener"}</span>
                  </div>
                  <span className={participant.isConnected ? "status-live" : "status-away"}>
                    {participant.isConnected ? "online" : "away"}
                  </span>
                </div>
              ))
            ) : (
              <div className="empty-panel compact-empty">
                <p>No listeners yet.</p>
              </div>
            )}
          </div>
        </section>

        <section className="panel chat-panel" id="chat">
          <PanelHeading
            label="Chat"
            title="Room messages"
            description="Keep conversation close to the music without leaving the session."
          />

          <div className="chat-list">
            {messages.length ? (
              messages.map((message) => (
                <div className="chat-message" key={message.id}>
                  <strong>{message.displayName}</strong>
                  <p>{message.body}</p>
                </div>
              ))
            ) : (
              <div className="empty-panel compact-empty">
                <p>Messages will appear here once someone speaks up.</p>
              </div>
            )}
          </div>

          <div className="compose-row">
            <input
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Send a message"
              disabled={!session?.roomCode}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleSendMessage();
                }
              }}
            />
            <button className="secondary-button" onClick={handleSendMessage} disabled={!session?.roomCode}>
              Send
            </button>
          </div>
        </section>

        <section className="panel queue-panel" id="queue">
          <PanelHeading
            label="Queue"
            title="Tracks"
            description="Browse the current room queue and switch tracks if you are the host."
          />

          <div className="queue-list">
            {(room?.queue ?? []).length ? (
              room.queue.map((track) => (
                <button
                  type="button"
                  className={`queue-item ${track.id === currentTrack?.id ? "queue-item-active" : ""}`}
                  key={track.id}
                  onClick={() => emitTransport("select-track", { trackId: track.id })}
                  disabled={!canControlPlayback}
                >
                  <strong>{track.title}</strong>
                  <small>{track.artist}</small>
                </button>
              ))
            ) : (
              <div className="empty-panel compact-empty">
                <p>The queue will appear here when a room is active.</p>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
