import { randomBytes, createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { hostname } from "os";

const HOME = process.env.HOME || `/Users/${process.env.USER}`;
const HIVE_DIR = join(HOME, ".hive");
const USERS_PATH = join(HIVE_DIR, "users.json");
const LEGACY_TOKEN_PATH = join(HIVE_DIR, "token");

/**
 * Hive user with role-based access.
 *
 * Roles:
 * - admin: full control (spawn, kill, message, manage users)
 * - operator: can message agents and manage tasks, cannot kill/spawn/manage users
 * - viewer: read-only dashboard access
 */
export interface HiveUser {
  id: string;
  name: string;
  role: "admin" | "operator" | "viewer";
  token: string;
  createdAt: number;
}

/** Safe user info (no token) for API responses and presence broadcasts. */
export interface HiveUserInfo {
  id: string;
  name: string;
  role: "admin" | "operator" | "viewer";
  createdAt: number;
}

export class UserRegistry {
  private users = new Map<string, HiveUser>();
  private tokenIndex = new Map<string, string>(); // token -> userId
  private legacyAdminToken: string | null = null;
  private legacyViewerToken: string | null = null;

  constructor() {
    this.loadLegacyTokens();
    this.load();
  }

  private loadLegacyTokens(): void {
    try {
      if (existsSync(LEGACY_TOKEN_PATH)) {
        this.legacyAdminToken = readFileSync(LEGACY_TOKEN_PATH, "utf-8").trim();
        // Viewer token is SHA-256 of admin token (same derivation as auth.ts)
        this.legacyViewerToken = createHash("sha256")
          .update(this.legacyAdminToken)
          .digest("hex")
          .slice(0, 32);
      }
    } catch { /* no legacy token */ }
  }

  private load(): void {
    try {
      if (existsSync(USERS_PATH)) {
        const raw = JSON.parse(readFileSync(USERS_PATH, "utf-8")) as HiveUser[];
        for (const user of raw) {
          this.users.set(user.id, user);
          this.tokenIndex.set(user.token, user.id);
        }
      }
    } catch { /* start fresh */ }

    // If no admin user exists and we have a legacy token, create the bootstrap admin
    const hasAdmin = [...this.users.values()].some(u => u.role === "admin");
    if (!hasAdmin && this.legacyAdminToken) {
      const admin: HiveUser = {
        id: `u_${randomBytes(6).toString("hex")}`,
        name: hostname().split(".")[0] || "admin",
        role: "admin",
        token: this.legacyAdminToken,
        createdAt: Date.now(),
      };
      this.users.set(admin.id, admin);
      this.tokenIndex.set(admin.token, admin.id);
      this.save();
    }
  }

  private save(): void {
    try {
      if (!existsSync(HIVE_DIR)) mkdirSync(HIVE_DIR, { recursive: true });
      writeFileSync(USERS_PATH, JSON.stringify([...this.users.values()], null, 2));
    } catch { /* best-effort */ }
  }

  /** Create a new user with a generated token. */
  createUser(name: string, role: "admin" | "operator" | "viewer"): HiveUser {
    const user: HiveUser = {
      id: `u_${randomBytes(6).toString("hex")}`,
      name,
      role,
      token: randomBytes(32).toString("hex"),
      createdAt: Date.now(),
    };
    this.users.set(user.id, user);
    this.tokenIndex.set(user.token, user.id);
    this.save();
    return user;
  }

  /** Remove a user by ID. */
  removeUser(id: string): boolean {
    const user = this.users.get(id);
    if (!user) return false;
    this.tokenIndex.delete(user.token);
    this.users.delete(id);
    this.save();
    return true;
  }

  /** List all users (safe info, no tokens). */
  getAll(): HiveUserInfo[] {
    return [...this.users.values()].map(u => ({
      id: u.id,
      name: u.name,
      role: u.role,
      createdAt: u.createdAt,
    }));
  }

  /** Authenticate a token. Returns the user or null. Also handles legacy tokens. */
  authenticate(token: string): HiveUser | null {
    // Check registered users first
    const userId = this.tokenIndex.get(token);
    if (userId) return this.users.get(userId) || null;

    // Legacy admin token (backwards compat)
    if (this.legacyAdminToken && token === this.legacyAdminToken) {
      // Find the bootstrap admin
      for (const user of this.users.values()) {
        if (user.token === this.legacyAdminToken) return user;
      }
    }

    // Legacy viewer token (backwards compat)
    if (this.legacyViewerToken && token === this.legacyViewerToken) {
      return {
        id: "legacy_viewer",
        name: "Viewer",
        role: "viewer",
        token,
        createdAt: 0,
      };
    }

    return null;
  }

  /** Get user by ID. */
  get(id: string): HiveUser | null {
    return this.users.get(id) || null;
  }

  /** Get safe user info (no token) by ID. */
  getInfo(id: string): HiveUserInfo | null {
    const user = this.users.get(id);
    if (!user) return null;
    return { id: user.id, name: user.name, role: user.role, createdAt: user.createdAt };
  }
}
