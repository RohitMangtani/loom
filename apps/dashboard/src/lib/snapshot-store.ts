export interface ActivitySnapshot {
  id: string;
  label: string;
  notes: string;
  timestamp: number;
  reviewSummary: string;
  context: string;
  agentSummary: string;
  workerId?: string;
  reviewIds: string[];
}

const STORAGE_KEY = "hive_activity_snapshots";

export function loadSnapshots(): ActivitySnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ActivitySnapshot[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function persistSnapshots(snapshots: ActivitySnapshot[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));
  } catch { /* ignore quota errors */ }
}

export function createSnapshotPayload(
  label: string,
  notes: string,
  workersSummary: string,
  context: string,
  reviewSummary: string,
  reviewIds: string[],
  workerId?: string,
): ActivitySnapshot {
  const baseLabel = label.trim() || reviewSummary || "Snapshot";
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label: baseLabel,
    notes: notes.trim(),
    timestamp: Date.now(),
    reviewSummary,
    context,
    agentSummary: workersSummary,
    workerId,
    reviewIds,
  };
}
