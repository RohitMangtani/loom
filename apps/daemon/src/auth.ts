import { randomBytes, timingSafeEqual, createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const TOKEN_DIR = join(homedir(), ".hive");
const TOKEN_PATH = join(TOKEN_DIR, "token");
const VIEWER_PATH = join(TOKEN_DIR, "viewer-token");
const TOKEN_BYTES = 32; // 64-char hex string

/**
 * Read the token from ~/.hive/token, or generate one if it doesn't exist.
 * Returns the 64-char hex token string.
 */
export function loadOrCreateToken(): string {
  try {
    const existing = readFileSync(TOKEN_PATH, "utf-8").trim();
    if (existing.length === TOKEN_BYTES * 2) return existing;
  } catch {
    // File doesn't exist or isn't readable — generate below
  }

  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  writeFileSync(TOKEN_PATH, token + "\n", { mode: 0o600 });
  return token;
}

/**
 * Derive a deterministic read-only viewer token from the admin token.
 * Saved to ~/.hive/viewer-token for easy reference.
 */
export function deriveViewerToken(adminToken: string): string {
  const viewer = createHash("sha256").update(adminToken + ":viewer").digest("hex");
  writeFileSync(VIEWER_PATH, viewer + "\n", { mode: 0o600 });
  return viewer;
}

/**
 * Constant-time comparison of a candidate token against the real token.
 * Returns true only if they match.
 */
export function validateToken(candidate: string, token: string): boolean {
  if (typeof candidate !== "string" || candidate.length !== token.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

/**
 * Patch ~/.claude/settings.json hook URLs to include ?token= for auth.
 * Claude Code HTTP hooks can't send custom headers, so the token goes in the URL.
 */
export function patchHookUrls(token: string): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (!existsSync(settingsPath)) return;

  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);
    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ type: string; url?: string }> }>> | undefined;
    if (!hooks) return;

    let changed = false;
    const baseUrl = "http://localhost:3001/hook";
    const authedUrl = `${baseUrl}?token=${token}`;

    for (const entries of Object.values(hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          if (hook.type === "http" && hook.url?.startsWith(baseUrl)) {
            if (hook.url !== authedUrl) {
              hook.url = authedUrl;
              changed = true;
            }
          }
        }
      }
    }

    if (changed) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      chmodSync(settingsPath, 0o600);
    }
  } catch {
    // Best effort — don't crash if settings.json is malformed
  }
}
