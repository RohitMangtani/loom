import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type RuntimeRole = "daemon" | "satellite";

export interface RuntimeLockMetadata {
  role: RuntimeRole;
  pid: number;
  acquiredAt: number;
  cwd: string;
  primaryUrl?: string;
}

export interface RuntimeSingletonClaim {
  path: string;
  metadata: RuntimeLockMetadata;
  release: () => void;
}

export interface RuntimeSingletonConflict {
  path: string;
  metadata: RuntimeLockMetadata | null;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readMetadata(path: string): RuntimeLockMetadata | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as RuntimeLockMetadata;
    return parsed && typeof parsed.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export function acquireRuntimeSingleton(
  role: RuntimeRole,
  options?: { primaryUrl?: string; cwd?: string; baseDir?: string },
): { ok: true; claim: RuntimeSingletonClaim } | { ok: false; conflict: RuntimeSingletonConflict } {
  const baseDir = options?.baseDir || join(homedir(), ".hive", "runtime");
  mkdirSync(baseDir, { recursive: true });

  const path = join(baseDir, `${role}.json`);
  const metadata: RuntimeLockMetadata = {
    role,
    pid: process.pid,
    acquiredAt: Date.now(),
    cwd: options?.cwd || process.cwd(),
    ...(options?.primaryUrl ? { primaryUrl: options.primaryUrl } : {}),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(metadata, null, 2) + "\n");
      } finally {
        closeSync(fd);
      }

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          const current = readMetadata(path);
          if (current?.pid === process.pid && current.role === role) {
            unlinkSync(path);
          }
        } catch {
          // Best-effort cleanup only.
        }
      };

      return { ok: true, claim: { path, metadata, release } };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw err;

      const existing = readMetadata(path);
      if (existing?.pid === process.pid && existing.role === role) {
        return { ok: true, claim: { path, metadata: existing, release: () => undefined } };
      }

      if (!existing || !isPidAlive(existing.pid)) {
        try {
          unlinkSync(path);
          continue;
        } catch {
          // Another process may have replaced it. Fall through to conflict.
        }
      }

      return { ok: false, conflict: { path, metadata: existing } };
    }
  }

  return { ok: false, conflict: { path, metadata: existsSync(path) ? readMetadata(path) : null } };
}
