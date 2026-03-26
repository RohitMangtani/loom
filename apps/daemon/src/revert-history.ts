import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import type { RevertHistoryEntry } from "@hive/types";
import { homedir } from "os";

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();
const HISTORY_PATH = join(HOME, ".hive", "revert-history.json");
const MAX_ENTRIES = 32;

function makeId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export class RevertHistory {
  private entries = new Map<string, RevertHistoryEntry>();
  private path: string;
  private maxEntries: number;

  constructor(path = HISTORY_PATH, maxEntries = MAX_ENTRIES) {
    this.path = path;
    this.maxEntries = maxEntries;
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw) as RevertHistoryEntry[];
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        if (entry.id && entry.commit && entry.projectPath) {
          this.entries.set(entry.id, entry);
        }
      }
    } catch {
      // ignore corrupted file
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const payload = this.list();
      writeFileSync(this.path, JSON.stringify(payload, null, 2) + "\n", "utf-8");
    } catch {
      // best-effort
    }
  }

  private trim(): void {
    if (this.entries.size <= this.maxEntries) return;
    const sorted = this.list().sort((a, b) => a.timestamp - b.timestamp);
    while (this.entries.size > this.maxEntries && sorted.length > 0) {
      const oldest = sorted.shift();
      if (oldest) this.entries.delete(oldest.id);
    }
  }

  list(): RevertHistoryEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  get(id: string): RevertHistoryEntry | undefined {
    return this.entries.get(id);
  }

  add(entry: Omit<RevertHistoryEntry, "id" | "timestamp">): RevertHistoryEntry {
    const timestamp = Date.now();
    const payload: RevertHistoryEntry = {
      ...entry,
      id: makeId(),
      timestamp,
    };
    this.entries.set(payload.id, payload);
    this.trim();
    this.save();
    return payload;
  }
}
