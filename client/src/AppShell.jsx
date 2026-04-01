import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const BROWSER_ORIGIN = typeof window !== "undefined" ? window.location.origin : "";
const API_URL = import.meta.env.VITE_API_URL ?? "";
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? BROWSER_ORIGIN;
const AUTH_STORAGE_KEY = "duosic-auth-v1";

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

export default function AppShell() {
  const audioRef = useRef(null);
  const socketRef = useRef(null);
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
    "Create a room, invite someone in, and keep playback locked to the same shared clock."
  );
  const [busyAction, setBusyAction] = useState("");
  const [copyState, setCopyState] = useState("");

  const currentTrack = room?.currentTrack ?? null;
  const shareLink = room?.roomCode ? `${BROWSER_ORIGIN}?room=${room.roomCode}` : "";
  const currentUser = authSession?.user ?? null;
  const isHost = currentUser && room ? currentUser.id === room.ownerId : false;
  const canControlPlayback = Boolean(session?.roomCode && isHost);

  useEffect(() => {
    const initialRoomCode = new URLSearchParams(window.location.search).get("room");
    if (initialRoomCode) {
      setRoomCodeInput(initialRoomCode.toUpperCase());
    }
  }, []);

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
          setNotice("Your session expired. Sign in again to keep listening together.");
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
        `${nextRoom.ownerId === currentUser?.id ? "You are hosting" : "You are listening in"} room ${nextRoom.roomCode}.`
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
  const connectedListeners = room?.participants?.filter((participant) => participant.isConnected) ?? [];
  const messages = room?.messages ?? [];

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
      setNotice(`${payload.user.displayName} is signed in and ready to host or join a room.`);
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

      setSession({
        roomCode: payload.room.roomCode
      });
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
    <div className="shell">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Duosic</span>
          <h1>One host. One room. One shared playback clock.</h1>
          <p>
            Sign in, create a listening room, and let the host steer every play, pause, seek, and
            track switch while the room chat stays live beside the music.
          </p>

          <div className="hero-actions">
            <button
              className="primary-button"
              onClick={() => handleRoomAction("create")}
              disabled={busyAction !== "" || !authSession}
            >
              {busyAction === "create" ? "Creating..." : "Create room"}
            </button>
            <button
              className="ghost-button"
              onClick={() => handleRoomAction("join")}
              disabled={busyAction !== "" || !authSession}
            >
              {busyAction === "join" ? "Joining..." : "Join room"}
            </button>
          </div>

          {authSession ? (
            <div className="profile-panel">
              <div>
                <strong>{authSession.user.displayName}</strong>
                <span>{authSession.user.email}</span>
              </div>
              <button className="ghost-button profile-button" onClick={handleLogout}>
                Sign out
              </button>
            </div>
          ) : (
            <div className="auth-panel">
              <div className="auth-toggle">
                <button
                  className={authMode === "register" ? "auth-tab auth-tab-active" : "auth-tab"}
                  onClick={() => setAuthMode("register")}
                  type="button"
                >
                  Create account
                </button>
                <button
                  className={authMode === "login" ? "auth-tab auth-tab-active" : "auth-tab"}
                  onClick={() => setAuthMode("login")}
                  type="button"
                >
                  Sign in
                </button>
              </div>

              <div className="identity-panel">
                {authMode === "register" ? (
                  <label>
                    Display name
                    <input
                      value={authForm.displayName}
                      onChange={(event) =>
                        setAuthForm((current) => ({ ...current, displayName: event.target.value }))
                      }
                      placeholder="Your name"
                    />
                  </label>
                ) : null}
                <label>
                  Email
                  <input
                    value={authForm.email}
                    onChange={(event) =>
                      setAuthForm((current) => ({ ...current, email: event.target.value }))
                    }
                    placeholder="you@example.com"
                  />
                </label>
                <label>
                  Password
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

              <button className="primary-button auth-submit" onClick={handleAuthSubmit} disabled={authBusy}>
                {authBusy ? "Working..." : authMode === "register" ? "Create account" : "Sign in"}
              </button>
            </div>
          )}

          <div className="identity-panel room-code-panel">
            <label>
              Room code
              <input
                value={roomCodeInput}
                onChange={(event) => setRoomCodeInput(event.target.value.toUpperCase())}
                placeholder="ABC123"
                maxLength={6}
              />
            </label>
          </div>
        </div>

        <div className="hero-visual">
          <div className="sync-orb" />
          <div className="pulse pulse-one" />
          <div className="pulse pulse-two" />
          <div className="status-card">
            <span className="status-label">Session status</span>
            <strong>{room?.roomCode ? `Live room ${room.roomCode}` : "Awaiting room"}</strong>
            <p>{notice}</p>
            {room ? (
              <div className="status-grid">
                <div>
                  <span className="status-meta-label">Role</span>
                  <strong>{isHost ? "Host" : "Listener"}</strong>
                </div>
                <div>
                  <span className="status-meta-label">Listeners</span>
                  <strong>{connectedListeners.length}</strong>
                </div>
              </div>
            ) : null}
            {shareLink ? (
              <div className="share-row">
                <button className="ghost-button share-button" onClick={handleCopyInvite}>
                  Copy invite link
                </button>
                <span>{copyState || shareLink}</span>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="workspace">
        <div className="player-panel">
          <audio ref={audioRef} preload="metadata" />

          {currentTrack ? (
            <>
              <div
                className="artwork"
                style={{
                  backgroundImage: `linear-gradient(135deg, rgba(10, 14, 28, 0.2), rgba(10, 14, 28, 0.72)), url(${currentTrack.artwork})`
                }}
              />
              <div className="track-meta">
                <span className="track-kicker">{isHost ? "Host controls active" : "Listener mode"}</span>
                <h2>{currentTrack.title}</h2>
                <p>{currentTrack.artist}</p>
              </div>

              <div className="host-banner">
                {isHost
                  ? "You control transport for everyone in this room."
                  : "Only the host can control playback. You stay synced automatically."}
              </div>

              <div className="progress-block">
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

              <div className="control-row">
                <button
                  className="primary-button"
                  onClick={() => emitTransport("toggle-play")}
                  disabled={!canControlPlayback}
                >
                  {room?.playback?.isPlaying ? "Pause for everyone" : "Play for everyone"}
                </button>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <h2>No room active yet</h2>
              <p>Sign in, create a room, or join an invite link to bring the shared player online.</p>
            </div>
          )}
        </div>

        <div className="side-column">
          <div className="presence-panel">
            <div className="panel-header">
              <span>Listeners</span>
              <strong>{connectedListeners.length}</strong>
            </div>
            <div className="listener-list">
              {(room?.participants ?? []).map((participant) => (
                <div className="listener-row" key={participant.id}>
                  <span>
                    {participant.displayName}
                    {participant.id === room?.ownerId ? " (host)" : ""}
                  </span>
                  <span className={participant.isConnected ? "listener-live" : "listener-away"}>
                    {participant.isConnected ? "online" : "away"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="chat-panel">
            <div className="panel-header">
              <span>Room chat</span>
              <strong>{messages.length}</strong>
            </div>
            <div className="chat-list">
              {messages.length ? (
                messages.map((message) => (
                  <div className="chat-message" key={message.id}>
                    <strong>{message.displayName}</strong>
                    <p>{message.body}</p>
                  </div>
                ))
              ) : (
                <div className="chat-empty">Chat messages will appear here once the room starts talking.</div>
              )}
            </div>
            <div className="chat-compose">
              <input
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                placeholder="Send a message to the room"
                disabled={!session?.roomCode}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleSendMessage();
                  }
                }}
              />
              <button className="ghost-button" onClick={handleSendMessage} disabled={!session?.roomCode}>
                Send
              </button>
            </div>
          </div>

          <div className="queue-panel">
            <div className="panel-header">
              <span>Queue</span>
              <strong>{room?.queue?.length ?? 0} tracks</strong>
            </div>

            <div className="queue-list">
              {(room?.queue ?? []).map((track) => (
                <button
                  type="button"
                  className={`queue-item ${track.id === currentTrack?.id ? "queue-item-active" : ""}`}
                  key={track.id}
                  onClick={() => emitTransport("select-track", { trackId: track.id })}
                  disabled={!canControlPlayback}
                >
                  <span>{track.title}</span>
                  <small>{track.artist}</small>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
