/**
 * Tests for UserRegistry -- multiplayer user management with
 * role-based access and backwards-compatible legacy token support.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { UserRegistry } from "../user-registry.js";

// Mock fs so we don't touch real ~/.hive/
vi.mock("fs", () => ({
  existsSync: vi.fn((p: string) => {
    if (typeof p === "string" && p.includes("token")) return true;
    if (typeof p === "string" && p.includes("users.json")) return false;
    return false;
  }),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn((p: string) => {
    if (typeof p === "string" && p.includes("token")) return "test-admin-token-64chars-padded-to-be-long-enough-for-testing-ok";
    return "[]";
  }),
  writeFileSync: vi.fn(),
}));

describe("UserRegistry", () => {
  it("creates a bootstrap admin from legacy token on first load", () => {
    const registry = new UserRegistry();
    const users = registry.getAll();

    expect(users.length).toBeGreaterThanOrEqual(1);
    const admin = users.find(u => u.role === "admin");
    expect(admin).toBeDefined();
  });

  it("authenticates the legacy admin token", () => {
    const registry = new UserRegistry();
    const user = registry.authenticate("test-admin-token-64chars-padded-to-be-long-enough-for-testing-ok");

    expect(user).not.toBeNull();
    expect(user!.role).toBe("admin");
  });

  it("authenticates the legacy viewer token (SHA-256 derived)", () => {
    const registry = new UserRegistry();
    // The viewer token is SHA-256 of the admin token, first 32 chars
    const crypto = require("crypto");
    const viewerToken = crypto.createHash("sha256")
      .update("test-admin-token-64chars-padded-to-be-long-enough-for-testing-ok")
      .digest("hex")
      .slice(0, 32);

    const user = registry.authenticate(viewerToken);
    expect(user).not.toBeNull();
    expect(user!.role).toBe("viewer");
    expect(user!.id).toBe("legacy_viewer");
  });

  it("rejects invalid tokens", () => {
    const registry = new UserRegistry();
    expect(registry.authenticate("invalid-garbage-token")).toBeNull();
  });

  it("creates new users with unique tokens", () => {
    const registry = new UserRegistry();

    const alex = registry.createUser("Alex", "operator");
    expect(alex.name).toBe("Alex");
    expect(alex.role).toBe("operator");
    expect(alex.token).toHaveLength(64); // 32 bytes hex
    expect(alex.id).toMatch(/^u_/);

    const bob = registry.createUser("Bob", "viewer");
    expect(bob.token).not.toBe(alex.token);
  });

  it("authenticates newly created users", () => {
    const registry = new UserRegistry();
    const alex = registry.createUser("Alex", "operator");

    const found = registry.authenticate(alex.token);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Alex");
    expect(found!.role).toBe("operator");
  });

  it("removes users", () => {
    const registry = new UserRegistry();
    const alex = registry.createUser("Alex", "operator");

    expect(registry.removeUser(alex.id)).toBe(true);
    expect(registry.authenticate(alex.token)).toBeNull();
    expect(registry.get(alex.id)).toBeNull();
  });

  it("removeUser returns false for unknown ID", () => {
    const registry = new UserRegistry();
    expect(registry.removeUser("u_nonexistent")).toBe(false);
  });

  it("getAll does not expose tokens", () => {
    const registry = new UserRegistry();
    registry.createUser("Alex", "operator");

    const all = registry.getAll();
    for (const user of all) {
      expect(user).not.toHaveProperty("token");
    }
  });

  it("getInfo returns safe user data", () => {
    const registry = new UserRegistry();
    const alex = registry.createUser("Alex", "admin");

    const info = registry.getInfo(alex.id);
    expect(info).not.toBeNull();
    expect(info!.name).toBe("Alex");
    expect(info).not.toHaveProperty("token");
  });
});
