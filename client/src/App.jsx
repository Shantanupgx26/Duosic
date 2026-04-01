import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const BROWSER_ORIGIN = typeof window !== "undefined" ? window.location.origin : "";
const API_URL = import.meta.env.VITE_API_URL ?? "";
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? BROWSER_ORIGIN;
const IDENTITY_STORAGE_KEY = "duosic-identity-v1";

function createIdentity() {
  return {
    id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    displayName: `Listener ${Math.floor(Math.random() * 900 + 100)}`
  };
}

function loadIdentity() {
  try {
    const raw = localStorage.getItem(IDENTITY_STORAGE_KEY);
    if (!raw) {
      return createIdentity();
    }

    return JSON.parse(raw);
  } catch {
    return createIdentity();
  }
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

  return Math.max(0, Math.min(currentTimeMs, durationMs));
}

async function sendRequest(path, body) {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message ?? "Request failed");
  }

  return payload;
}

export default function App() {
  const initialIdentityRef = useRef(null);
  if (!initialIdentityRef.current) {
    initialIdentityRef.current = loadIdentity();
  }

  const audioRef = useRef(null);
  const socketRef = useRef(null);
  const [identity, setIdentity] = useState(initialIdentityRef.current);
  const [displayName, setDisplayName] = useState(initialIdentityRef.current.displayName);
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [session, setSession] = useState(null);
  const [room, setRoom] = useState(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());
  const [dragPositionMs, setDragPositionMs] = useState(null);
  const [notice, setNotice] = useState("Create a room, invite someone in, and start listening in sync.");
  const [busyAction, setBusyAction] = useState("");
  const [copyState, setCopyState] = useState("");

  const currentTrack = room?.currentTrack ?? null;
  const shareLink = room?.roomCode ? `${BROWSER_ORIGIN}?room=${room.roomCode}` : "";

  useEffect(() => {
    const initialRoomCode = new URLSearchParams(window.location.search).get("room");
    if (initialRoomCode) {
      setRoomCodeInput(initialRoomCode.toUpperCase());
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity));
  }, [identity]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 250);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!session?.roomCode || !session?.participant?.id) {
      return undefined;
    }

    const socket = io(SOCKET_URL, {
      transports: ["websocket"]
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("room:enter", {
        roomCode: session.roomCode,
        participant: session.participant
      });
    });

    socket.on("room:state", ({ room: nextRoom, serverNow }) => {
      setRoom(nextRoom);
      setClockOffsetMs(serverNow - Date.now());
      setNotice(`Room ${nextRoom.roomCode} is live with ${nextRoom.participants.length} listener(s).`);
    });

    socket.on("room:error", ({ message }) => {
      setNotice(message);
    });

    socket.on("connect_error", () => {
      setNotice("Unable to reach the live sync server right now.");
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [session]);

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

  async function handleRoomAction(mode) {
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setNotice("Choose a display name first.");
      return;
    }

    const nextIdentity = {
      ...identity,
      displayName: trimmedName
    };
    setIdentity(nextIdentity);
    setBusyAction(mode);

    try {
      const payload =
        mode === "create"
          ? await sendRequest("/api/rooms/create", {
              displayName: trimmedName,
              participantId: nextIdentity.id
            })
          : await sendRequest("/api/rooms/join", {
              roomCode: roomCodeInput,
              displayName: trimmedName,
              participantId: nextIdentity.id
            });

      setSession({
        roomCode: payload.room.roomCode,
        participant: payload.participant
      });
      setRoom(payload.room);
      setClockOffsetMs(0);
      window.history.replaceState({}, "", `?room=${payload.room.roomCode}`);
      setNotice(`Joined room ${payload.room.roomCode}.`);
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

  const connectedListeners = room?.participants?.filter((participant) => participant.isConnected) ?? [];

  return (
    <div className="shell">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Duosic</span>
          <h1>Shared playback that lands on the same beat.</h1>
          <p>
            Create a listening room, drop a code to a friend, and let the server keep every play,
            pause, and seek aligned across screens.
          </p>

          <div className="hero-actions">
            <button
              className="primary-button"
              onClick={() => handleRoomAction("create")}
              disabled={busyAction !== ""}
            >
              {busyAction === "create" ? "Creating..." : "Create room"}
            </button>
            <button
              className="ghost-button"
              onClick={() => handleRoomAction("join")}
              disabled={busyAction !== ""}
            >
              {busyAction === "join" ? "Joining..." : "Join room"}
            </button>
          </div>

          <div className="identity-panel">
            <label>
              Display name
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Your name"
              />
            </label>
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
            {shareLink ? (
              <div className="share-row">
                <button className="ghost-button share-button" onClick={handleCopyInvite}>
                  Copy invite link
                </button>
                <span>{copyState || shareLink.replace(`${BROWSER_ORIGIN}?room=`, "")}</span>
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
                <span className="track-kicker">{room?.playback?.isPlaying ? "Now syncing" : "Ready"}</span>
                <h2>{currentTrack.title}</h2>
                <p>{currentTrack.artist}</p>
              </div>

              <div className="progress-block">
                <input
                  type="range"
                  min="0"
                  max={currentTrack.durationMs}
                  value={progressMs}
                  onChange={(event) => setDragPositionMs(Number(event.target.value))}
                  onMouseUp={() => {
                    if (dragPositionMs !== null) {
                      emitTransport("seek", { positionMs: dragPositionMs });
                      setDragPositionMs(null);
                    }
                  }}
                  onTouchEnd={() => {
                    if (dragPositionMs !== null) {
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
                <button className="primary-button" onClick={() => emitTransport("toggle-play")}>
                  {room?.playback?.isPlaying ? "Pause for everyone" : "Play for everyone"}
                </button>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <h2>No room active yet</h2>
              <p>Create a room or join one to bring the shared player online.</p>
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
                  <span>{participant.displayName}</span>
                  <span className={participant.isConnected ? "listener-live" : "listener-away"}>
                    {participant.isConnected ? "online" : "away"}
                  </span>
                </div>
              ))}
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
