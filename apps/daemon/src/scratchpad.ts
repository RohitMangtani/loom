import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const HOME = process.env.HOME || `/Users/${process.env.USER}`;
const SCRATCHPAD_PATH = join(HOME, ".hive", "scratchpad.json");
const SCRATCHPAD_TTL = 60 * 60 * 1000; // 1 hour auto-expiry

export interface ScratchpadEntry {
  key: string;
  value: string;
  setBy: string;
  setAt: number;
}

export class Scratchpad {
  private entries = new Map<string, ScratchpadEntry>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(SCRATCHPAD_PATH)) {
        const items = JSON.parse(readFileSync(SCRATCHPAD_PATH, "utf-8")) as ScratchpadEntry[];
        const now = Date.now();
        for (const e of items) {
          if (now - e.setAt < SCRATCHPAD_TTL) {
            this.entries.set(e.key, e);
          }
        }
      }
    } catch { /* start fresh */ }
  }

  private save(): void {
    try {
      const dir = SCRATCHPAD_PATH.replace(/\/[^/]+$/, "");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(SCRATCHPAD_PATH, JSON.stringify([...this.entries.values()], null, 2));
    } catch { /* best-effort */ }
  }

  get(key: string): ScratchpadEntry | undefined {
    return this.entries.get(key);
  }

  getAll(): Record<string, ScratchpadEntry> {
    const all: Record<string, ScratchpadEntry> = {};
    for (const [k, v] of this.entries) all[k] = v;
    return all;
  }

  set(key: string, value: string, setBy: string): ScratchpadEntry {
    const entry: ScratchpadEntry = { key, value, setBy, setAt: Date.now() };
    this.entries.set(key, entry);
    this.save();
    return entry;
  }

  delete(key: string): boolean {
    const deleted = this.entries.delete(key);
    if (deleted) this.save();
    return deleted;
  }

  expire(): void {
    const now = Date.now();
    let expired = false;
    for (const [key, entry] of this.entries) {
      if (now - entry.setAt > SCRATCHPAD_TTL) {
        this.entries.delete(key);
        expired = true;
      }
    }
    if (expired) this.save();
  }
}
