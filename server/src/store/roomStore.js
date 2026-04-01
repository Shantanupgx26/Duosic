import crypto from "node:crypto";
import mongoose from "mongoose";

import { sampleTracks, trackMap } from "../data/sampleTracks.js";

const roomSchema = new mongoose.Schema(
  {
    roomCode: { type: String, required: true, unique: true },
    ownerId: { type: String, required: true },
    participants: [
      {
        id: { type: String, required: true },
        displayName: { type: String, required: true },
        socketIds: [{ type: String }],
        joinedAt: { type: Date, required: true },
        isConnected: { type: Boolean, default: true }
      }
    ],
    queue: [{ type: String, required: true }],
    playback: {
      trackId: { type: String, required: true },
      isPlaying: { type: Boolean, default: false },
      positionMs: { type: Number, default: 0 },
      updatedAt: { type: Date, required: true }
    },
    messages: [
      {
        id: { type: String, required: true },
        userId: { type: String, required: true },
        displayName: { type: String, required: true },
        body: { type: String, required: true },
        createdAt: { type: Date, required: true }
      }
    ]
  },
  { timestamps: true }
);

roomSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });

const RoomModel = mongoose.models.Room || mongoose.model("Room", roomSchema);

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function createRoomCode() {
  return Array.from({ length: 6 }, () => {
    const index = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    return ROOM_CODE_ALPHABET[index];
  }).join("");
}

function clampPosition(positionMs, trackId) {
  const durationMs = trackMap.get(trackId)?.durationMs ?? positionMs;
  return Math.max(0, Math.min(positionMs, durationMs));
}

function getPositionAt(playback, nowMs = Date.now()) {
  const updatedAtMs = new Date(playback.updatedAt).getTime();
  const livePosition = playback.isPlaying
    ? playback.positionMs + (nowMs - updatedAtMs)
    : playback.positionMs;

  return clampPosition(livePosition, playback.trackId);
}

function toSerializableRoom(room) {
  const currentTrack = trackMap.get(room.playback.trackId) ?? sampleTracks[0];

  return {
    roomCode: room.roomCode,
    ownerId: room.ownerId,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    participants: room.participants.map(({ socketIds, ...participant }) => ({
      ...participant,
      isConnected: Array.isArray(socketIds) ? socketIds.length > 0 : Boolean(participant.isConnected)
    })),
    queue: room.queue
      .map((trackId) => trackMap.get(trackId))
      .filter(Boolean),
    currentTrack,
    playback: {
      ...room.playback,
      positionMs: clampPosition(room.playback.positionMs, room.playback.trackId)
    },
    messages: (room.messages ?? []).slice(-100)
  };
}

function makeNewRoom({ ownerId, displayName }) {
  const joinedAt = new Date();

  return {
    roomCode: "",
    ownerId,
    participants: [
      {
        id: ownerId,
        displayName,
        socketIds: [],
        joinedAt,
        isConnected: true
      }
    ],
    queue: sampleTracks.map((track) => track.id),
    playback: {
      trackId: sampleTracks[0].id,
      isPlaying: false,
      positionMs: 0,
      updatedAt: joinedAt
    },
    messages: [],
    createdAt: joinedAt,
    updatedAt: joinedAt
  };
}

export class RoomStore {
  constructor({ roomTtlMs = 1000 * 60 * 60 * 12 } = {}) {
    this.rooms = new Map();
    this.socketRoomIndex = new Map();
    this.mongoEnabled = false;
    this.roomTtlMs = roomTtlMs;
  }

  async connectMongo(mongoUri) {
    if (!mongoUri) {
      return false;
    }

    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000
    });
    this.mongoEnabled = true;
    return true;
  }

  async createRoom({ participantId, displayName }) {
    const room = makeNewRoom({ ownerId: participantId, displayName });

    let roomCode = createRoomCode();
    while (await this.hasRoom(roomCode)) {
      roomCode = createRoomCode();
    }

    room.roomCode = roomCode;
    this.rooms.set(roomCode, room);
    await this.persistRoom(room);

    return toSerializableRoom(room);
  }

  async hasRoom(roomCode) {
    if (this.rooms.has(roomCode)) {
      return true;
    }

    if (!this.mongoEnabled) {
      return false;
    }

    const existingRoom = await RoomModel.exists({ roomCode });
    return Boolean(existingRoom);
  }

  async getRoom(roomCode) {
    const normalizedCode = roomCode.toUpperCase();
    if (this.rooms.has(normalizedCode)) {
      return this.rooms.get(normalizedCode);
    }

    if (!this.mongoEnabled) {
      return null;
    }

    const storedRoom = await RoomModel.findOne({ roomCode: normalizedCode }).lean();
    if (!storedRoom) {
      return null;
    }

    this.rooms.set(normalizedCode, storedRoom);
    return storedRoom;
  }

  async getSerializableRoom(roomCode) {
    const room = await this.getRoom(roomCode);
    return room ? toSerializableRoom(room) : null;
  }

  async joinRoom({ roomCode, participantId, displayName }) {
    const room = await this.getRoom(roomCode);
    if (!room) {
      throw new Error("Room not found");
    }

    const normalizedCode = roomCode.toUpperCase();
    const now = new Date();
    const existingParticipant = room.participants.find(
      (participant) => participant.id === participantId
    );

    if (existingParticipant) {
      existingParticipant.displayName = displayName;
      existingParticipant.socketIds = existingParticipant.socketIds ?? [];
      existingParticipant.isConnected = existingParticipant.socketIds.length > 0;
      existingParticipant.joinedAt = existingParticipant.joinedAt ?? now;
    } else {
      room.participants.push({
        id: participantId,
        displayName,
        socketIds: [],
        joinedAt: now,
        isConnected: true
      });
    }

    room.updatedAt = now;
    this.rooms.set(normalizedCode, room);
    await this.persistRoom(room);

    return toSerializableRoom(room);
  }

  async attachSocket({ roomCode, participantId, socketId }) {
    const room = await this.getRoom(roomCode);
    if (!room) {
      throw new Error("Room not found");
    }

    const participant = room.participants.find((entry) => entry.id === participantId);
    if (!participant) {
      throw new Error("Participant not found");
    }

    participant.socketIds = Array.from(new Set([...(participant.socketIds ?? []), socketId]));
    participant.isConnected = true;
    room.updatedAt = new Date();
    this.socketRoomIndex.set(socketId, { roomCode: room.roomCode, participantId });
    await this.persistRoom(room);

    return toSerializableRoom(room);
  }

  async assertParticipant(roomCode, participantId) {
    const room = await this.getRoom(roomCode);
    if (!room) {
      throw new Error("Room not found");
    }

    const participant = room.participants.find((entry) => entry.id === participantId);
    if (!participant) {
      throw new Error("Join the room before interacting with it.");
    }

    return room;
  }

  async detachSocket(socketId) {
    const lookup = this.socketRoomIndex.get(socketId);
    if (!lookup) {
      return null;
    }

    const room = await this.getRoom(lookup.roomCode);
    this.socketRoomIndex.delete(socketId);

    if (!room) {
      return null;
    }

    const participant = room.participants.find((entry) => entry.id === lookup.participantId);
    if (!participant) {
      return null;
    }

    participant.socketIds = (participant.socketIds ?? []).filter((currentSocketId) => currentSocketId !== socketId);
    participant.isConnected = participant.socketIds.length > 0;
    room.updatedAt = new Date();
    await this.persistRoom(room);

    return toSerializableRoom(room);
  }

  async updateTransport({ roomCode, actorId, type, payload = {} }) {
    const room = await this.assertParticipant(roomCode, actorId);

    if (room.ownerId !== actorId) {
      throw new Error("Only the host can control playback.");
    }

    const now = new Date();
    const livePosition = getPositionAt(room.playback, now.getTime());

    if (type === "toggle-play") {
      room.playback.positionMs = livePosition;
      room.playback.isPlaying = !room.playback.isPlaying;
      room.playback.updatedAt = now;
    }

    if (type === "seek") {
      room.playback.positionMs = clampPosition(payload.positionMs ?? 0, room.playback.trackId);
      room.playback.updatedAt = now;
    }

    if (type === "select-track") {
      const nextTrackId = payload.trackId;
      if (!trackMap.has(nextTrackId)) {
        throw new Error("Track not found");
      }

      room.playback.trackId = nextTrackId;
      room.playback.positionMs = 0;
      room.playback.updatedAt = now;
    }

    room.updatedAt = now;
    await this.persistRoom(room);

    return toSerializableRoom(room);
  }

  async addMessage({ roomCode, userId, displayName, body }) {
    const room = await this.assertParticipant(roomCode, userId);
    const now = new Date();

    room.messages = [
      ...(room.messages ?? []),
      {
        id: crypto.randomUUID(),
        userId,
        displayName,
        body,
        createdAt: now
      }
    ].slice(-100);

    room.updatedAt = now;
    await this.persistRoom(room);

    return toSerializableRoom(room);
  }

  async persistRoom(room) {
    this.rooms.set(room.roomCode, room);

    if (!this.mongoEnabled) {
      return;
    }

    await RoomModel.findOneAndUpdate(
      { roomCode: room.roomCode },
      {
        roomCode: room.roomCode,
        ownerId: room.ownerId,
        participants: room.participants,
        queue: room.queue,
        playback: room.playback,
        messages: room.messages ?? [],
        createdAt: room.createdAt,
        updatedAt: room.updatedAt
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  pruneInactiveRooms(nowMs = Date.now()) {
    for (const [roomCode, room] of this.rooms.entries()) {
      const updatedAtMs = new Date(room.updatedAt).getTime();
      const hasConnectedParticipants = room.participants.some(
        (participant) => (participant.socketIds ?? []).length > 0
      );

      if (!hasConnectedParticipants && nowMs - updatedAtMs > this.roomTtlMs) {
        this.rooms.delete(roomCode);
      }
    }
  }
}
