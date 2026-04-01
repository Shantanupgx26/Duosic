import "dotenv/config";

import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

import { extractBearerToken, signAuthToken, verifyAuthToken } from "./lib/auth.js";
import { sampleTracks } from "./data/sampleTracks.js";
import { RoomStore } from "./store/roomStore.js";
import { UserStore } from "./store/userStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);

const PORT = Number(process.env.PORT ?? 4000);
const ROOM_IDLE_TTL_HOURS = Number(process.env.ROOM_IDLE_TTL_HOURS ?? 12);
const CLIENT_DIST_PATH = resolve(__dirname, "../../client/dist");
const rawClientOrigins = [
  process.env.CLIENT_ORIGIN,
  process.env.CLIENT_ORIGINS,
  process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : "",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
]
  .filter(Boolean)
  .flatMap((value) => value.split(","))
  .map((value) => value.trim())
  .filter(Boolean);
const allowedOrigins = Array.from(new Set(rawClientOrigins));
const shouldServeClient = process.env.NODE_ENV === "production" || process.env.SERVE_STATIC === "true";

function isAllowedOrigin(origin) {
  return !origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin);
}

function normalizeDisplayName(input) {
  return String(input ?? "").trim().slice(0, 32);
}

function normalizeParticipantId(input) {
  return String(input ?? "").trim().slice(0, 120);
}

function normalizeEmail(input) {
  return String(input ?? "").trim().toLowerCase().slice(0, 160);
}

function normalizePassword(input) {
  return String(input ?? "");
}

function normalizeRoomCode(input) {
  return String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function normalizeMessageBody(input) {
  return String(input ?? "").trim().slice(0, 300);
}

function sendBadRequest(response, message) {
  return response.status(400).json({ message });
}

const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin not allowed by Socket.IO CORS"));
    },
    methods: ["GET", "POST"]
  }
});

const roomStore = new RoomStore({
  roomTtlMs: ROOM_IDLE_TTL_HOURS * 60 * 60 * 1000
});
const userStore = new UserStore();

async function resolveUserFromToken(token) {
  const payload = verifyAuthToken(token);
  const user = await userStore.getUserById(payload.sub);
  if (!user) {
    throw new Error("Session expired.");
  }

  return user;
}

async function requireAuth(request, response, next) {
  const token = extractBearerToken(request.headers.authorization);
  if (!token) {
    return response.status(401).json({ message: "Authentication required." });
  }

  try {
    request.user = await resolveUserFromToken(token);
    next();
  } catch (error) {
    return response.status(401).json({ message: error.message || "Authentication failed." });
  }
}

app.set("trust proxy", 1);
app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true
  })
);
app.use(express.json({ limit: "100kb" }));
app.use((_request, _response, next) => {
  roomStore.pruneInactiveRooms();
  next();
});

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    mode: roomStore.mongoEnabled ? "mongo" : "memory",
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get("/api/tracks", (_request, response) => {
  response.json({ tracks: sampleTracks });
});

app.post("/api/auth/register", async (request, response) => {
  try {
    const displayName = normalizeDisplayName(request.body.displayName);
    const email = normalizeEmail(request.body.email);
    const password = normalizePassword(request.body.password);

    if (!displayName || !email || password.length < 6) {
      return sendBadRequest(response, "Display name, email, and a password with at least 6 characters are required.");
    }

    const user = await userStore.createUser({ displayName, email, password });
    const token = signAuthToken(user);
    return response.status(201).json({ token, user });
  } catch (error) {
    const statusCode = error.message?.includes("already exists") ? 409 : 500;
    return response.status(statusCode).json({ message: error.message });
  }
});

app.post("/api/auth/login", async (request, response) => {
  try {
    const email = normalizeEmail(request.body.email);
    const password = normalizePassword(request.body.password);

    if (!email || !password) {
      return sendBadRequest(response, "Email and password are required.");
    }

    const user = await userStore.authenticateUser({ email, password });
    const token = signAuthToken(user);
    return response.json({ token, user });
  } catch (error) {
    return response.status(401).json({ message: error.message });
  }
});

app.get("/api/auth/me", requireAuth, async (request, response) => {
  response.json({ user: request.user });
});

app.post("/api/rooms/create", requireAuth, async (request, response) => {
  try {
    const room = await roomStore.createRoom({
      participantId: request.user.id,
      displayName: request.user.displayName
    });
    return response.status(201).json({
      room,
      participant: { id: request.user.id, displayName: request.user.displayName }
    });
  } catch (error) {
    return response.status(500).json({ message: error.message });
  }
});

app.post("/api/rooms/join", requireAuth, async (request, response) => {
  try {
    const roomCode = normalizeRoomCode(request.body.roomCode);

    if (!roomCode) {
      return sendBadRequest(response, "Room code is required.");
    }

    const room = await roomStore.joinRoom({
      roomCode,
      participantId: request.user.id,
      displayName: request.user.displayName
    });
    return response.json({
      room,
      participant: { id: request.user.id, displayName: request.user.displayName }
    });
  } catch (error) {
    const statusCode = error.message === "Room not found" ? 404 : 500;
    return response.status(statusCode).json({ message: error.message });
  }
});

app.get("/api/rooms/:roomCode", requireAuth, async (request, response) => {
  try {
    const room = await roomStore.getSerializableRoom(normalizeRoomCode(request.params.roomCode));
    if (!room) {
      return response.status(404).json({ message: "Room not found" });
    }

    return response.json({ room });
  } catch (error) {
    return response.status(500).json({ message: error.message });
  }
});

io.use(async (socket, next) => {
  try {
    const rawToken =
      socket.handshake.auth?.token ??
      extractBearerToken(socket.handshake.headers.authorization);

    if (!rawToken) {
      next(new Error("Authentication required."));
      return;
    }

    socket.data.user = await resolveUserFromToken(rawToken);
    next();
  } catch (error) {
    next(new Error(error.message || "Authentication failed."));
  }
});

io.on("connection", (socket) => {
  socket.on("room:enter", async ({ roomCode }) => {
    try {
      const normalizedCode = normalizeRoomCode(roomCode);
      const participantId = normalizeParticipantId(socket.data.user?.id);

      if (!normalizedCode || !participantId) {
        socket.emit("room:error", { message: "Room join payload is invalid." });
        return;
      }

      socket.join(normalizedCode);
      const room = await roomStore.attachSocket({
        roomCode: normalizedCode,
        participantId,
        socketId: socket.id
      });

      io.to(normalizedCode).emit("room:state", {
        room,
        serverNow: Date.now()
      });
    } catch (error) {
      socket.emit("room:error", { message: error.message });
    }
  });

  socket.on("transport:update", async ({ roomCode, type, payload }) => {
    try {
      const normalizedCode = normalizeRoomCode(roomCode);
      const room = await roomStore.updateTransport({
        roomCode: normalizedCode,
        actorId: socket.data.user.id,
        type,
        payload
      });

      io.to(normalizedCode).emit("room:state", {
        room,
        serverNow: Date.now()
      });
    } catch (error) {
      socket.emit("room:error", { message: error.message });
    }
  });

  socket.on("chat:send", async ({ roomCode, body }) => {
    try {
      const normalizedCode = normalizeRoomCode(roomCode);
      const messageBody = normalizeMessageBody(body);

      if (!normalizedCode || !messageBody) {
        socket.emit("room:error", { message: "Message text is required." });
        return;
      }

      const room = await roomStore.addMessage({
        roomCode: normalizedCode,
        userId: socket.data.user.id,
        displayName: socket.data.user.displayName,
        body: messageBody
      });

      io.to(normalizedCode).emit("room:state", {
        room,
        serverNow: Date.now()
      });
    } catch (error) {
      socket.emit("room:error", { message: error.message });
    }
  });

  socket.on("disconnect", async () => {
    const room = await roomStore.detachSocket(socket.id);
    if (!room) {
      return;
    }

    io.to(room.roomCode).emit("room:state", {
      room,
      serverNow: Date.now()
    });
  });
});

if (shouldServeClient && existsSync(CLIENT_DIST_PATH)) {
  app.use(express.static(CLIENT_DIST_PATH));
  app.get("*", (request, response, next) => {
    if (request.path.startsWith("/api")) {
      next();
      return;
    }

    response.sendFile(resolve(CLIENT_DIST_PATH, "index.html"));
  });
}

async function start() {
  try {
    if (process.env.MONGO_URI) {
      await roomStore.connectMongo(process.env.MONGO_URI);
      console.log("MongoDB connected.");
    } else {
      console.log("MONGO_URI not provided. Using in-memory room storage.");
    }
  } catch (error) {
    console.warn(`MongoDB unavailable, falling back to memory storage: ${error.message}`);
  }

  httpServer.listen(PORT, () => {
    console.log(`Duosic server listening on http://localhost:${PORT}`);
  });
}

async function shutdown(signal) {
  console.log(`${signal} received. Closing Duosic server.`);
  httpServer.close(async () => {
    await io.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

start();
