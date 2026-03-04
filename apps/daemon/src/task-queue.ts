import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const HOME = process.env.HOME || `/Users/${process.env.USER}`;
const QUEUE_PATH = join(HOME, ".hive", "queue.json");

export interface QueuedTask {
  id: string;
  task: string;
  project?: string;
  priority: number;
  createdAt: number;
  blockedBy?: string;
  workflowId?: string;
}

export class TaskQueue {
  private tasks: QueuedTask[] = [];
  private completedIds = new Set<string>();
  private nextId = 1;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(QUEUE_PATH)) {
        const data = JSON.parse(readFileSync(QUEUE_PATH, "utf-8")) as {
          tasks: QueuedTask[];
          nextId: number;
          completedIds?: string[];
        };
        this.tasks = data.tasks || [];
        this.nextId = data.nextId || 1;
        for (const id of data.completedIds || []) this.completedIds.add(id);
      }
    } catch {
      this.tasks = [];
    }
  }

  private save(): void {
    try {
      const dir = QUEUE_PATH.replace(/\/[^/]+$/, "");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(QUEUE_PATH, JSON.stringify({
        tasks: this.tasks,
        nextId: this.nextId,
        completedIds: [...this.completedIds].slice(-100),
      }, null, 2));
    } catch { /* best-effort */ }
  }

  push(task: string, project?: string, priority = 10, blockedBy?: string, workflowId?: string): QueuedTask {
    const queued: QueuedTask = {
      id: `q${this.nextId++}`,
      task,
      project,
      priority,
      createdAt: Date.now(),
      blockedBy,
      workflowId,
    };
    this.tasks.push(queued);
    this.tasks.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    this.save();
    console.log(`[task-queue] Added ${queued.id}: "${task.slice(0, 80)}..." (priority ${priority})`);
    return queued;
  }

  remove(taskId: string): boolean {
    const idx = this.tasks.findIndex(t => t.id === taskId);
    if (idx === -1) return false;
    this.tasks.splice(idx, 1);
    this.save();
    return true;
  }

  markCompleted(taskId: string): void {
    this.completedIds.add(taskId);
    this.save();
  }

  isCompleted(taskId: string): boolean {
    return this.completedIds.has(taskId);
  }

  getAll(): QueuedTask[] {
    return [...this.tasks];
  }

  get length(): number {
    return this.tasks.length;
  }
}
