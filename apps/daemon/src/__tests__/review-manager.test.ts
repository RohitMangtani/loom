/**
 * Tests for ReviewManager  --  the extracted review lifecycle and
 * auto-detection module. Validates git push/PR/deploy detection,
 * dedup, and listener notification.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs and child_process before importing ReviewManager
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => "[]"),
  writeFileSync: vi.fn(),
  statSync: vi.fn(() => ({ isDirectory: () => true, mtimeMs: Date.now() })),
}));

vi.mock("child_process", () => ({
  execFileSync: vi.fn((cmd: string, args: string[]) => {
    if (args.includes("symbolic-ref")) return "main";
    if (args.includes("get-url")) return "https://github.com/User/repo.git";
    if (args.includes("--show-toplevel")) return "/Users/test/projects/myrepo";
    return "";
  }),
}));

import { ReviewManager } from "../review-manager.js";
import type { WorkerState } from "../types.js";

function createReviewManager() {
  const deps = {
    getQuadrant: vi.fn((id: string) => id === "w1" ? 1 : id === "w2" ? 2 : undefined),
    getRecentArtifacts: vi.fn(() => [
      { path: "/src/app.ts", action: "edited", ts: Date.now() },
    ]),
    onSatelliteUpdate: undefined as (() => void) | undefined,
  };
  return { manager: new ReviewManager(deps), deps };
}

function makeWorker(overrides: Partial<WorkerState> = {}): WorkerState {
  return {
    id: "w1",
    pid: 1234,
    project: "/Users/test/projects/myrepo",
    projectName: "myrepo",
    status: "working",
    currentAction: "Bash",
    lastAction: "Running command",
    lastActionAt: Date.now(),
    errorCount: 0,
    startedAt: Date.now() - 60000,
    task: null,
    managed: false,
    tty: "ttys001",
    ...overrides,
  };
}

describe("ReviewManager", () => {
  // ── Core CRUD ──────────────────────────────────────────────────────

  describe("review CRUD", () => {
    it("adds and retrieves reviews", () => {
      const { manager } = createReviewManager();
      const review = manager.addReview("Q1 pushed hive", "w1", "hive", { type: "push" });

      expect(review.summary).toBe("Q1 pushed hive");
      expect(review.type).toBe("push");
      expect(review.seen).toBe(false);

      const all = manager.getReviews();
      expect(all).toHaveLength(1);
    });

    it("marks reviews as seen", () => {
      const { manager } = createReviewManager();
      const review = manager.addReview("test", "w1", "proj");
      expect(manager.markReviewSeen(review.id)).toBe(true);
      expect(manager.getUnseenReviews()).toHaveLength(0);
    });

    it("dismisses reviews", () => {
      const { manager } = createReviewManager();
      const review = manager.addReview("test", "w1", "proj");
      expect(manager.dismissReview(review.id)).toBe(true);
      expect(manager.getReviews()).toHaveLength(0);
    });

    it("clears all reviews", () => {
      const { manager } = createReviewManager();
      manager.addReview("a", "w1", "proj");
      manager.addReview("b", "w2", "proj");
      expect(manager.clearAllReviews()).toBe(2);
      expect(manager.getReviews()).toHaveLength(0);
    });

    it("resolves quadrant from deps", () => {
      const { manager } = createReviewManager();
      const review = manager.addReview("test", "w1", "proj");
      expect(review.quadrant).toBe(1);
    });
  });

  // ── Listener notification ──────────────────────────────────────────

  describe("listeners", () => {
    it("notifies listeners on addReview", () => {
      const { manager } = createReviewManager();
      const listener = vi.fn();
      manager.onReviewAdded(listener);

      manager.addReview("test", "w1", "proj");
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0].summary).toBe("test");
    });
  });

  // ── Auto-detection ─────────────────────────────────────────────────

  describe("autoDetectReview", () => {
    it("detects git push", () => {
      const { manager } = createReviewManager();
      const listener = vi.fn();
      manager.onReviewAdded(listener);

      manager.autoDetectReview("w1", makeWorker(), {
        command: "git push origin main",
      });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0].type).toBe("push");
    });

    it("detects git commit + push combo", () => {
      const { manager } = createReviewManager();
      const listener = vi.fn();
      manager.onReviewAdded(listener);

      manager.autoDetectReview("w1", makeWorker(), {
        command: 'git add . && git commit -m "fix" && git push',
      });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0].summary).toContain("committed and pushed");
    });

    it("detects gh pr create", () => {
      const { manager } = createReviewManager();
      const listener = vi.fn();
      manager.onReviewAdded(listener);

      manager.autoDetectReview("w1", makeWorker(), {
        command: 'gh pr create --title "Fix auth" --body "..."',
      });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0].type).toBe("pr");
    });

    it("detects vercel deploy", () => {
      const { manager } = createReviewManager();
      const listener = vi.fn();
      manager.onReviewAdded(listener);

      manager.autoDetectReview("w1", makeWorker(), {
        command: "npx vercel deploy --prod",
      });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0].type).toBe("deploy");
    });

    it("ignores non-reviewable commands", () => {
      const { manager } = createReviewManager();
      const listener = vi.fn();
      manager.onReviewAdded(listener);

      manager.autoDetectReview("w1", makeWorker(), {
        command: "npm run build",
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it("deduplicates within 30s window", () => {
      const { manager } = createReviewManager();
      const listener = vi.fn();
      manager.onReviewAdded(listener);

      manager.autoDetectReview("w1", makeWorker(), { command: "git push" });
      manager.autoDetectReview("w1", makeWorker(), { command: "git push" });

      expect(listener).toHaveBeenCalledOnce(); // second push deduped
    });

    it("triggers satellite update on hive repo push", async () => {
      // Re-mock execFileSync to return "hive" repo name
      const cp = await import("child_process");
      vi.mocked(cp.execFileSync).mockImplementation((_cmd: unknown, args: unknown) => {
        const a = args as string[];
        if (a.includes("--show-toplevel")) return "/Users/test/projects/hive";
        if (a.includes("symbolic-ref")) return "main";
        if (a.includes("get-url")) return "https://github.com/User/hive.git";
        return "";
      });

      const { manager } = createReviewManager();
      const updateFn = vi.fn();
      manager.setSatelliteUpdateFn(updateFn);

      manager.autoDetectReview("w1", makeWorker({ project: "/Users/test/projects/hive" }), {
        command: "git push origin main",
      });

      expect(updateFn).toHaveBeenCalledOnce();
    });
  });
});
