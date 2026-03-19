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
  verify?: boolean;
  maxVerifyAttempts?: number;
  autoCommit?: boolean;
}

export interface RunningTask {
  task: QueuedTask;
  workerId: string;
  startedAt: number;
}

export class TaskQueue {
  private tasks: QueuedTask[] = [];
  private runningTasks = new Map<string, RunningTask>();
  private runningByWorker = new Map<string, string>();
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
          runningTasks?: RunningTask[];
          completedIds?: string[];
        };
        this.tasks = data.tasks || [];
        this.nextId = data.nextId || 1;
        this.runningTasks.clear();
        this.runningByWorker.clear();
        for (const running of data.runningTasks || []) {
          this.runningTasks.set(running.task.id, running);
          this.runningByWorker.set(running.workerId, running.task.id);
        }
        for (const id of data.completedIds || []) this.completedIds.add(id);
      }
    } catch {
      this.tasks = [];
      this.runningTasks.clear();
      this.runningByWorker.clear();
    }
  }

  private save(): void {
    try {
      const dir = QUEUE_PATH.replace(/\/[^/]+$/, "");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(QUEUE_PATH, JSON.stringify({
        tasks: this.tasks,
        nextId: this.nextId,
        runningTasks: [...this.runningTasks.values()],
        completedIds: [...this.completedIds].slice(-100),
      }, null, 2));
    } catch { /* best-effort */ }
  }

  push(task: string, project?: string, priority = 10, blockedBy?: string, workflowId?: string, verify?: boolean, maxVerifyAttempts?: number, autoCommit?: boolean): QueuedTask {
    const queued: QueuedTask = {
      id: `q${this.nextId++}`,
      task,
      project,
      priority,
      createdAt: Date.now(),
      blockedBy,
      workflowId,
      verify,
      maxVerifyAttempts,
      autoCommit,
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

  markRunning(taskId: string, workerId: string): RunningTask | undefined {
    const idx = this.tasks.findIndex(t => t.id === taskId);
    if (idx === -1) return undefined;
    const [task] = this.tasks.splice(idx, 1);
    const running: RunningTask = { task, workerId, startedAt: Date.now() };
    this.runningTasks.set(taskId, running);
    this.runningByWorker.set(workerId, taskId);
    this.save();
    return running;
  }

  markCompleted(taskId: string): RunningTask | undefined {
    const running = this.runningTasks.get(taskId);
    if (running) {
      this.runningTasks.delete(taskId);
      this.runningByWorker.delete(running.workerId);
    }
    this.completedIds.add(taskId);
    this.save();
    return running;
  }

  isCompleted(taskId: string): boolean {
    return this.completedIds.has(taskId);
  }

  requeueRunningTask(workerId: string): QueuedTask | undefined {
    const taskId = this.runningByWorker.get(workerId);
    if (!taskId) return undefined;
    const running = this.runningTasks.get(taskId);
    if (!running) {
      this.runningByWorker.delete(workerId);
      return undefined;
    }
    this.runningTasks.delete(taskId);
    this.runningByWorker.delete(workerId);
    this.tasks.push(running.task);
    this.tasks.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    this.save();
    return running.task;
  }

  getRunningTaskForWorker(workerId: string): RunningTask | undefined {
    const taskId = this.runningByWorker.get(workerId);
    return taskId ? this.runningTasks.get(taskId) : undefined;
  }

  getAll(): QueuedTask[] {
    return [...this.tasks];
  }

  get length(): number {
    return this.tasks.length;
  }
}
