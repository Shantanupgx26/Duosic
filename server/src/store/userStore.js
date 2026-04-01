import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import crypto from "node:crypto";

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    passwordHash: { type: String, required: true }
  },
  { timestamps: true }
);

const UserModel = mongoose.models.User || mongoose.model("User", userSchema);

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

function toPublicUser(user) {
  return {
    id: String(user._id ?? user.id),
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt
  };
}

export class UserStore {
  constructor() {
    this.usersById = new Map();
    this.userIdsByEmail = new Map();
  }

  async createUser({ email, displayName, password }) {
    const normalizedEmail = normalizeEmail(email);
    const passwordHash = await bcrypt.hash(password, 10);

    if (await this.findUserByEmail(normalizedEmail)) {
      throw new Error("An account with that email already exists.");
    }

    if (mongoose.connection.readyState === 1) {
      const createdUser = await UserModel.create({
        email: normalizedEmail,
        displayName,
        passwordHash
      });

      return toPublicUser(createdUser);
    }

    const id = crypto.randomUUID();
    const user = {
      id,
      email: normalizedEmail,
      displayName,
      passwordHash,
      createdAt: new Date()
    };
    this.usersById.set(id, user);
    this.userIdsByEmail.set(normalizedEmail, id);

    return toPublicUser(user);
  }

  async authenticateUser({ email, password }) {
    const normalizedEmail = normalizeEmail(email);
    const user = await this.findUserByEmail(normalizedEmail);
    if (!user) {
      throw new Error("Invalid email or password.");
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      throw new Error("Invalid email or password.");
    }

    return toPublicUser(user);
  }

  async getUserById(userId) {
    if (!userId) {
      return null;
    }

    if (mongoose.connection.readyState === 1) {
      const user = await UserModel.findById(userId).lean();
      return user ? toPublicUser(user) : null;
    }

    const user = this.usersById.get(String(userId));
    return user ? toPublicUser(user) : null;
  }

  async findUserByEmail(email) {
    if (mongoose.connection.readyState === 1) {
      return UserModel.findOne({ email }).lean();
    }

    const userId = this.userIdsByEmail.get(email);
    return userId ? this.usersById.get(userId) : null;
  }
}
