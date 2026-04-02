import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const BROWSER_ORIGIN = typeof window !== "undefined" ? window.location.origin : "";
const API_URL = import.meta.env.VITE_API_URL ?? "";
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? BROWSER_ORIGIN;
const AUTH_STORAGE_KEY = "duosic-auth-v1";
const THEME_STORAGE_KEY = "duosic-theme-v1";
const YOUTUBE_API_SRC = "https://www.youtube.com/iframe_api";
let youtubeApiPromise = null;

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

function SectionHeader({ eyebrow, title, description }) {
  return (
    <div className="section-header">
      <span className="section-eyebrow">{eyebrow}</span>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
    </div>
  );
}

export default function PremiumAppShell() {
  const audioRef = useRef(null);
  const socketRef = useRef(null);
  const youtubeMountRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const youtubeVideoIdRef = useRef("");
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
  const [youtubeReady, setYoutubeReady] = useState(false);
  const [youtubeDurationMs, setYoutubeDurationMs] = useState(0);
  const [notice, setNotice] = useState(
    "Sign in, open a room, and keep every listener on the same clock."
  );
  const [busyAction, setBusyAction] = useState("");
  const [copyState, setCopyState] = useState("");

  const currentTrack = room?.currentTrack ?? null;
  const currentUser = authSession?.user ?? null;
  const shareLink = room?.roomCode ? `${BROWSER_ORIGIN}?room=${room.roomCode}` : "";
  const isHost = currentUser && room ? currentUser.id === room.ownerId : false;
  const canControlPlayback = Boolean(session?.roomCode && isHost);
  const participants = room?.participants ?? [];
  const connectedListeners = participants.filter((participant) => participant.isConnected);
  const messages = room?.messages ?? [];
  const queue = room?.queue ?? [];
  const roomCode = room?.roomCode ?? session?.roomCode ?? "------";
  const playerState = room?.playback?.isPlaying ? "Playing" : "Paused";
  const isYouTubeTrack = Boolean(currentTrack?.sourceType === "youtube" && currentTrack?.videoId);
  const effectiveDurationMs = Math.max(currentTrack?.durationMs ?? 0, youtubeDurationMs);
  const navLinks = [
    { id: "player", label: "Player" },
    { id: "account", label: "Access" },
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
        `${nextRoom.ownerId === currentUser?.id ? "Hosting" : "Joined"} room ${nextRoom.roomCode}.`
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
                  setNotice("The YouTube track ended. Pick the next song from the queue.");
                }
              },
              onError: () => {
                setNotice("This YouTube video could not be played in the embedded room player.");
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
  }, [isYouTubeTrack, currentTrack?.videoId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (isYouTubeTrack || !audio || !currentTrack || !room?.playback) {
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
          setNotice("Playback is synced, but autoplay is blocked. Press play once to unlock audio.");
        });
      }

      if (!room.playback.isPlaying && !audio.paused) {
        audio.pause();
      }
    };

    syncAudio();
    const intervalId = window.setInterval(syncAudio, 700);

    return () => window.clearInterval(intervalId);
  }, [room, currentTrack, clockOffsetMs, isYouTubeTrack]);

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

      const playerState = player.getPlayerState?.();
      const playingState = window.YT?.PlayerState?.PLAYING;

      if (room.playback.isPlaying && playerState !== playingState) {
        player.playVideo?.();
      }

      if (!room.playback.isPlaying && playerState === playingState) {
        player.pauseVideo?.();
      }
    };

    syncYouTubePlayer();
    const intervalId = window.setInterval(syncYouTubePlayer, 900);

    return () => window.clearInterval(intervalId);
  }, [isYouTubeTrack, youtubeReady, currentTrack, room, clockOffsetMs, effectiveDurationMs]);

  const progressMs = useMemo(() => {
    if (!room?.playback || !currentTrack) {
      return 0;
    }

    if (dragPositionMs !== null) {
      return dragPositionMs;
    }

    return getExpectedPositionMs(room.playback, effectiveDurationMs, clockOffsetMs, nowMs);
  }, [room, currentTrack, dragPositionMs, clockOffsetMs, nowMs, effectiveDurationMs]);

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
    } catch (error) {
      setNotice(error.message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleRoomAction(mode) {
    if (!authSession?.token) {
      setNotice("Sign in before joining a room.");
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

  function handleLogout() {
    setAuthSession(null);
    setSession(null);
    setRoom(null);
    setRoomCodeInput("");
    setNotice("Signed out.");
    window.history.replaceState({}, "", window.location.pathname);
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-a" aria-hidden="true" />
      <div className="ambient ambient-b" aria-hidden="true" />

      <header className="site-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true" />
          <div>
            <span className="brand-kicker">Realtime sync music</span>
            <h1>Duosic</h1>
          </div>
        </div>

        <nav className="site-nav" aria-label="Sections">
          {navLinks.map((section) => (
            <a className="site-nav-link" href={`#${section.id}`} key={section.id}>
              {section.label}
            </a>
          ))}
        </nav>

        <div className="header-actions">
          <button
            className="ghost-button"
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          {currentUser ? (
            <div className="identity-chip">
              <strong>{currentUser.displayName}</strong>
              <span>{currentUser.email}</span>
            </div>
          ) : null}
        </div>
      </header>

      <div className="status-strip">{notice}</div>

      <section className="hero-stage" id="player">
        <div className="hero-copy">
          <span className="hero-kicker">Shared playback</span>
          <h2>{currentTrack ? currentTrack.title : "A sharper way to listen together."}</h2>
          <p>
            {currentTrack
              ? `${currentTrack.artist} with ${isHost ? "host control" : "listener sync"} active.`
              : "One room, one timeline, one clean place for playback, chat, and people."}
          </p>

          <div className="hero-meta">
            <span>{`Room ${roomCode}`}</span>
            <span>{isHost ? "Host" : session?.roomCode ? "Listener" : "Idle"}</span>
            <span>{`${connectedListeners.length} online`}</span>
            <span>{playerState}</span>
          </div>

          <div className="hero-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => handleRoomAction("create")}
              disabled={busyAction !== "" || !authSession}
            >
              {busyAction === "create" ? "Creating" : "Create room"}
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => handleRoomAction("join")}
              disabled={busyAction !== "" || !authSession}
            >
              {busyAction === "join" ? "Joining" : "Join room"}
            </button>
            {shareLink ? (
              <button className="ghost-button" type="button" onClick={handleCopyInvite}>
                {copyState || "Copy invite"}
              </button>
            ) : null}
          </div>
        </div>

        <div className="hero-player">
          <audio ref={audioRef} preload="metadata" />

          <div
            className={isYouTubeTrack ? "cover-frame cover-frame-video" : "cover-frame"}
            style={currentTrack ? { backgroundImage: `url(${currentTrack.artwork})` } : undefined}
          >
            {isYouTubeTrack ? <div className="youtube-player-shell" ref={youtubeMountRef} /> : null}
            {!currentTrack ? <div className="cover-placeholder">No track loaded</div> : null}
          </div>

          <div className="transport-block">
            <div className="transport-head">
              <div>
                <span className="transport-label">Current state</span>
                <strong>{currentTrack ? currentTrack.title : "Waiting for a room"}</strong>
              </div>
              <span className="transport-status">{playerState}</span>
            </div>

            <div className="progress-shell">
              <input
                type="range"
                min="0"
                max={Math.max(currentTrack?.durationMs ?? 0, progressMs, 1)}
                value={progressMs}
                disabled={!canControlPlayback || !currentTrack}
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
              <div className="progress-meta">
                <span>{progressLabel}</span>
                <span>{durationLabel}</span>
              </div>
            </div>

            <div className="transport-actions">
              <button
                className="primary-button transport-button"
                type="button"
                onClick={() => emitTransport("toggle-play")}
                disabled={!canControlPlayback}
              >
                {room?.playback?.isPlaying ? "Pause" : "Play"}
              </button>
              <p className="transport-note">
                {isHost
                  ? "Your controls drive the room."
                  : "Playback stays aligned to the host timeline."}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="workspace-grid">
        <aside className="workspace-column workspace-column-left">
          <section className="workspace-section" id="account">
            <SectionHeader
              eyebrow="Access"
              title={authSession ? "Account" : "Sign in"}
              description="Use one account to open, rejoin, and manage shared rooms."
            />

            {authSession ? (
              <div className="account-summary">
                <div className="account-block">
                  <strong>{authSession.user.displayName}</strong>
                  <span>{authSession.user.email}</span>
                </div>
                <button className="ghost-button full-width" type="button" onClick={handleLogout}>
                  Sign out
                </button>
              </div>
            ) : (
              <div className="stack-block">
                <div className="mode-switch">
                  <button
                    className={authMode === "register" ? "mode-chip mode-chip-active" : "mode-chip"}
                    type="button"
                    onClick={() => setAuthMode("register")}
                  >
                    Create account
                  </button>
                  <button
                    className={authMode === "login" ? "mode-chip mode-chip-active" : "mode-chip"}
                    type="button"
                    onClick={() => setAuthMode("login")}
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

                <button
                  className="primary-button full-width"
                  type="button"
                  onClick={handleAuthSubmit}
                  disabled={authBusy}
                >
                  {authBusy ? "Working" : authMode === "register" ? "Create account" : "Sign in"}
                </button>
              </div>
            )}
          </section>

          <section className="workspace-section">
            <SectionHeader
              eyebrow="Room access"
              title="Session controls"
              description="Enter a code or spin up a new room instantly."
            />

            <div className="form-stack">
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

            <div className="stack-inline">
              <button
                className="primary-button"
                type="button"
                onClick={() => handleRoomAction("create")}
                disabled={busyAction !== "" || !authSession}
              >
                {busyAction === "create" ? "Creating" : "Create"}
              </button>
              <button
                className="ghost-button"
                type="button"
                onClick={() => handleRoomAction("join")}
                disabled={busyAction !== "" || !authSession}
              >
                {busyAction === "join" ? "Joining" : "Join"}
              </button>
            </div>

            <div className="data-grid">
              <div>
                <span>Room</span>
                <strong>{roomCode}</strong>
              </div>
              <div>
                <span>Role</span>
                <strong>{isHost ? "Host" : session?.roomCode ? "Listener" : "Idle"}</strong>
              </div>
              <div>
                <span>Online</span>
                <strong>{connectedListeners.length}</strong>
              </div>
              <div>
                <span>Queue</span>
                <strong>{queue.length}</strong>
              </div>
            </div>
          </section>
        </aside>

        <div className="workspace-column workspace-column-main">
          <section className="workspace-section" id="listeners">
            <SectionHeader
              eyebrow="People"
              title="Room listeners"
              description="Presence updates are live. The host is pinned by role."
            />

            <div className="presence-list">
              {participants.length ? (
                participants.map((participant) => (
                  <div className="presence-row" key={participant.id}>
                    <div className="presence-copy">
                      <strong>{participant.displayName}</strong>
                      <span>{participant.id === room?.ownerId ? "Host" : "Listener"}</span>
                    </div>
                    <span className={participant.isConnected ? "presence-state live" : "presence-state away"}>
                      {participant.isConnected ? "Online" : "Away"}
                    </span>
                  </div>
                ))
              ) : (
                <div className="empty-state">
                  <p>No one is in the room yet.</p>
                </div>
              )}
            </div>
          </section>

          <section className="workspace-section" id="queue">
            <SectionHeader
              eyebrow="Queue"
              title="Track list"
              description="Select the next track if you have host control, or add your own direct audio link."
            />

            {isHost ? (
              <div className="stack-block">
                <div className="form-stack">
                  <label className="field">
                    <span>Track title</span>
                    <input
                      value={trackForm.title}
                      onChange={(event) =>
                        setTrackForm((current) => ({ ...current, title: event.target.value }))
                      }
                      placeholder="Song title"
                    />
                  </label>
                  <label className="field">
                    <span>Artist</span>
                    <input
                      value={trackForm.artist}
                      onChange={(event) =>
                        setTrackForm((current) => ({ ...current, artist: event.target.value }))
                      }
                      placeholder="Artist name"
                    />
                  </label>
                  <label className="field">
                    <span>Media URL</span>
                    <input
                      value={trackForm.streamUrl}
                      onChange={(event) =>
                        setTrackForm((current) => ({ ...current, streamUrl: event.target.value }))
                      }
                      placeholder="https://youtube.com/watch?v=... or https://example.com/song.mp3"
                    />
                  </label>
                  <label className="field">
                    <span>Artwork URL</span>
                    <input
                      value={trackForm.artwork}
                      onChange={(event) =>
                        setTrackForm((current) => ({ ...current, artwork: event.target.value }))
                      }
                      placeholder="https://example.com/cover.jpg"
                    />
                  </label>
                  <label className="field">
                    <span>Duration in ms optional</span>
                    <input
                      value={trackForm.durationMs}
                      onChange={(event) =>
                        setTrackForm((current) => ({ ...current, durationMs: event.target.value }))
                      }
                      placeholder="Used for direct audio. YouTube can stay blank."
                    />
                  </label>
                </div>

                <button
                  type="button"
                  className="primary-button full-width"
                  onClick={handleAddTrack}
                  disabled={trackBusy || !session?.roomCode}
                >
                  {trackBusy ? "Adding track" : "Add track to queue"}
                </button>
              </div>
            ) : null}

            <div className="queue-list">
              {queue.length ? (
                queue.map((track) => (
                  <button
                    type="button"
                    className={`queue-row ${track.id === currentTrack?.id ? "queue-row-active" : ""}`}
                    key={track.id}
                    onClick={() => emitTransport("select-track", { trackId: track.id })}
                    disabled={!canControlPlayback}
                  >
                    <div>
                      <strong>{track.title}</strong>
                      <span>{track.artist}</span>
                    </div>
                    <small>{track.durationMs > 0 ? formatClock(track.durationMs / 1000) : "Unknown"}</small>
                  </button>
                ))
              ) : (
                <div className="empty-state">
                  <p>The room queue will appear here.</p>
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="workspace-column workspace-column-right">
          <section className="workspace-section" id="chat">
            <SectionHeader
              eyebrow="Chat"
              title="Room messages"
              description="Conversation stays close to the playback surface."
            />

            <div className="chat-stream">
              {messages.length ? (
                messages.map((message) => (
                  <div className="chat-row" key={message.id}>
                    <strong>{message.displayName}</strong>
                    <p>{message.body}</p>
                  </div>
                ))
              ) : (
                <div className="empty-state">
                  <p>Messages show up here once the room starts talking.</p>
                </div>
              )}
            </div>

            <div className="composer">
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
              <button
                className="primary-button"
                type="button"
                onClick={handleSendMessage}
                disabled={!session?.roomCode}
              >
                Send
              </button>
            </div>
          </section>
        </aside>
      </section>
    </div>
  );
}
