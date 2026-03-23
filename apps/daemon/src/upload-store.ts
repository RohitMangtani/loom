import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, extname, join } from "path";
import { randomBytes } from "crypto";
import type { UploadedFileRef } from "./types.js";

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

function sanitizeFileName(fileName: string): string {
  const base = basename(fileName || "upload.bin").replace(/[^\w.\-()+ ]+/g, "-").trim() || "upload";
  const ext = extname(base).slice(0, 16);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const trimmedStem = stem.slice(0, 64).replace(/\.+$/g, "") || "upload";
  return `${trimmedStem}${ext}`;
}

export function storeUploadedFile(params: {
  fileName: string;
  mimeType?: string;
  dataBase64: string;
  size?: number;
  machine?: string;
}): UploadedFileRef {
  const raw = (params.dataBase64 || "").trim();
  if (!raw) {
    throw new Error("Missing file payload");
  }

  let data: Buffer;
  try {
    data = Buffer.from(raw, "base64");
  } catch {
    throw new Error("Invalid base64 payload");
  }

  if (!data.length) {
    throw new Error("Uploaded file is empty");
  }
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new Error(`File exceeds ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB limit`);
  }
  if (typeof params.size === "number" && params.size > 0 && params.size !== data.length) {
    throw new Error("Uploaded file size mismatch");
  }

  const safeName = sanitizeFileName(params.fileName);
  const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const uploadDir = join(homedir(), ".hive", "uploads");
  mkdirSync(uploadDir, { recursive: true });
  const path = join(uploadDir, `${id}-${safeName}`);
  writeFileSync(path, data);

  return {
    id,
    name: safeName,
    mimeType: params.mimeType?.trim() || "application/octet-stream",
    size: data.length,
    path,
    ...(params.machine ? { machine: params.machine } : {}),
  };
}
