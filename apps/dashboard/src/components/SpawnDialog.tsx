"use client";

import { useState } from "react";
import type { AgentModel } from "@/lib/types";

interface SpawnDialogProps {
  models: AgentModel[];
  onSpawn: (project: string, task: string, model: string) => void;
  onClose: () => void;
}

export function SpawnDialog({ models, onSpawn, onClose }: SpawnDialogProps) {
  const [selectedModel, setSelectedModel] = useState(models[0]?.id || "claude");
  const [task, setTask] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-[rgba(2,6,23,0.72)] backdrop-blur-sm"
        onClick={onClose}
        role="presentation"
      />

      {/* Dialog */}
      <div className="relative w-full max-w-sm mx-4 rounded-[28px] border border-[var(--border)] bg-[linear-gradient(180deg,rgba(11,19,37,0.98),rgba(8,12,24,0.98))] p-6 shadow-[0_32px_80px_rgba(2,6,23,0.55)]">
        <div className="mb-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-light)]">Open Slot</p>
          <h2 className="mt-2 text-2xl font-semibold text-[var(--text)]">Spawn agent</h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Add another worker without changing the rest of the stack.</p>
        </div>

        {/* Model selector */}
        <div className={`flex gap-2 mb-4 ${models.length > 4 ? "flex-wrap" : ""}`}>
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setSelectedModel(m.id)}
              className={`
                ${models.length > 4 ? "px-3 py-1.5 text-xs" : "flex-1 px-3 py-2 text-sm"} rounded-md border font-medium transition-colors
                ${
                  selectedModel === m.id
                    ? "border-[var(--accent)] bg-[rgba(56,189,248,0.12)] text-[var(--text)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                    : "border-[var(--border)] bg-[rgba(8,12,24,0.6)] text-[var(--text-muted)] hover:border-[var(--border-light)]"
                }
              `}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Task textarea */}
        <div className="mb-4">
          <label
            htmlFor="spawn-task"
            className="block text-xs text-[var(--text-muted)] mb-1.5"
          >
            Task (optional)
          </label>
          <textarea
            id="spawn-task"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Describe what this worker should do..."
            rows={2}
            className="w-full rounded-2xl border border-[var(--border)] bg-[rgba(8,12,24,0.72)] px-3 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-light)] outline-none focus:border-[var(--accent)] transition-colors resize-none"
          />
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-4 py-2 rounded-full border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--border-light)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSpawn("~", task.trim(), selectedModel)}
            className="text-sm px-4 py-2 rounded-full bg-[var(--accent)] text-[#03111f] font-semibold hover:opacity-90 transition-opacity"
          >
            Spawn
          </button>
        </div>
      </div>
    </div>
  );
}
