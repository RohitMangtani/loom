import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { acquireRuntimeSingleton } from "../runtime-singleton.js";

describe("acquireRuntimeSingleton", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("claims and releases a new runtime lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-runtime-lock-"));
    dirs.push(dir);

    const result = acquireRuntimeSingleton("satellite", { baseDir: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.claim.release();

    const second = acquireRuntimeSingleton("satellite", { baseDir: dir });
    expect(second.ok).toBe(true);
  });

  it("replaces a stale lock file automatically", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-runtime-lock-"));
    dirs.push(dir);

    writeFileSync(join(dir, "satellite.json"), JSON.stringify({
      role: "satellite",
      pid: 999999,
      acquiredAt: Date.now() - 60_000,
      cwd: "/tmp/stale",
    }) + "\n");

    const result = acquireRuntimeSingleton("satellite", { baseDir: dir });
    expect(result.ok).toBe(true);
  });

  it("refuses to claim a live lock owned by another process", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-runtime-lock-"));
    dirs.push(dir);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });

    try {
      writeFileSync(join(dir, "satellite.json"), JSON.stringify({
        role: "satellite",
        pid: child.pid,
        acquiredAt: Date.now(),
        cwd: "/tmp/live",
      }) + "\n");

      const result = acquireRuntimeSingleton("satellite", { baseDir: dir });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.conflict.metadata?.pid).toBe(child.pid);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
