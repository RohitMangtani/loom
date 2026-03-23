import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_UPLOAD_BYTES, storeUploadedFile } from "../upload-store.js";

const homes: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (homes.length > 0) {
    const dir = homes.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("storeUploadedFile", () => {
  it("writes a sanitized upload into ~/.hive/uploads", () => {
    const home = mkdtempSync(join(tmpdir(), "hive-upload-test-"));
    homes.push(home);
    vi.stubEnv("HOME", home);

    const data = Buffer.from("hello upload\n", "utf-8");
    const upload = storeUploadedFile({
      fileName: "../../weird name?.txt",
      mimeType: "text/plain",
      dataBase64: data.toString("base64"),
      size: data.length,
      machine: "local",
    });

    expect(upload.name).toBe("weird name-.txt");
    expect(upload.machine).toBe("local");
    expect(upload.path.startsWith(join(home, ".hive", "uploads"))).toBe(true);
    expect(readFileSync(upload.path, "utf-8")).toBe("hello upload\n");
  });

  it("rejects oversized uploads", () => {
    const home = mkdtempSync(join(tmpdir(), "hive-upload-test-"));
    homes.push(home);
    vi.stubEnv("HOME", home);

    const data = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1);
    expect(() => storeUploadedFile({
      fileName: "big.bin",
      dataBase64: data.toString("base64"),
      size: data.length,
    })).toThrow(/limit/i);
  });
});
