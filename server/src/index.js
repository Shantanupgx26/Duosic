import "dotenv/config";

import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

import { sampleTracks } from "./data/sampleTracks.js";
import { RoomStore } from "./store/roomStore.js";

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

function normalizeRoomCode(input) {
  return String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
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

app.post("/api/rooms/create", async (request, response) => {
  try {
    const displayName = normalizeDisplayName(request.body.displayName);
    const participantId = normalizeParticipantId(request.body.participantId);

    if (!displayName || !participantId) {
      return sendBadRequest(response, "Display name and participant id are required.");
    }

    const room = await roomStore.createRoom({ participantId, displayName });
    return response.status(201).json({
      room,
      participant: { id: participantId, displayName }
    });
  } catch (error) {
    return response.status(500).json({ message: error.message });
  }
});

app.post("/api/rooms/join", async (request, response) => {
  try {
    const displayName = normalizeDisplayName(request.body.displayName);
    const participantId = normalizeParticipantId(request.body.participantId);
    const roomCode = normalizeRoomCode(request.body.roomCode);

    if (!displayName || !participantId || !roomCode) {
      return sendBadRequest(response, "Room code, display name, and participant id are required.");
    }

    const room = await roomStore.joinRoom({ roomCode, participantId, displayName });
    return response.json({
      room,
      participant: { id: participantId, displayName }
    });
  } catch (error) {
    const statusCode = error.message === "Room not found" ? 404 : 500;
    return response.status(statusCode).json({ message: error.message });
  }
});

app.get("/api/rooms/:roomCode", async (request, response) => {
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

io.on("connection", (socket) => {
  socket.on("room:enter", async ({ roomCode, participant }) => {
    try {
      const normalizedCode = normalizeRoomCode(roomCode);
      const participantId = normalizeParticipantId(participant?.id);

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
