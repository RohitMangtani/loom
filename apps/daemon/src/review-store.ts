import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { homedir } from "os";

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();
const REVIEWS_PATH = join(HOME, ".hive", "reviews.json");
const REVIEW_TTL = 48 * 60 * 60 * 1000; // 48 hours auto-expiry
const MAX_REVIEWS = 50;

export interface ReviewItem {
  id: string;
  summary: string;
  url?: string;
  type: "deploy" | "commit" | "pr" | "push" | "review-needed" | "general";
  workerId: string;
  quadrant?: number;
  projectName: string;
  createdAt: number;
  seen: boolean;
  /** Recent file changes by this worker at review time */
  artifacts?: Array<{ path: string; action: string }>;
}

export class ReviewStore {
  private items = new Map<string, ReviewItem>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(REVIEWS_PATH)) {
        const raw = JSON.parse(readFileSync(REVIEWS_PATH, "utf-8")) as ReviewItem[];
        const now = Date.now();
        for (const item of raw) {
          if (now - item.createdAt < REVIEW_TTL) {
            this.items.set(item.id, item);
          }
        }
      }
    } catch { /* start fresh */ }
  }

  private save(): void {
    try {
      const dir = REVIEWS_PATH.replace(/\/[^/]+$/, "");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(REVIEWS_PATH, JSON.stringify([...this.items.values()], null, 2));
    } catch { /* best-effort */ }
  }

  add(
    summary: string,
    workerId: string,
    projectName: string,
    opts?: { url?: string; type?: ReviewItem["type"]; quadrant?: number; artifacts?: Array<{ path: string; action: string }> },
  ): ReviewItem {
    const item: ReviewItem = {
      id: randomBytes(8).toString("hex"),
      summary,
      url: opts?.url,
      type: opts?.type || "general",
      workerId,
      quadrant: opts?.quadrant,
      projectName,
      createdAt: Date.now(),
      seen: false,
      artifacts: opts?.artifacts,
    };
    this.items.set(item.id, item);

    // Cap at MAX_REVIEWS  --  drop oldest
    if (this.items.size > MAX_REVIEWS) {
      const sorted = [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
      while (this.items.size > MAX_REVIEWS) {
        const oldest = sorted.shift();
        if (oldest) this.items.delete(oldest.id);
      }
    }

    this.save();
    return item;
  }

  get(id: string): ReviewItem | undefined {
    return this.items.get(id);
  }

  getAll(): ReviewItem[] {
    return [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getUnseen(): ReviewItem[] {
    return this.getAll().filter(item => !item.seen);
  }

  markSeen(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    item.seen = true;
    this.save();
    return true;
  }

  markAllSeen(): number {
    let count = 0;
    for (const item of this.items.values()) {
      if (!item.seen) {
        item.seen = true;
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  dismiss(id: string): boolean {
    const deleted = this.items.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  clearAll(): number {
    const count = this.items.size;
    this.items.clear();
    this.save();
    return count;
  }

  expire(): void {
    const now = Date.now();
    let expired = false;
    for (const [id, item] of this.items) {
      if (now - item.createdAt > REVIEW_TTL) {
        this.items.delete(id);
        expired = true;
      }
    }
    if (expired) this.save();
  }
}
