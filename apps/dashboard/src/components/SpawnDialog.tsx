"use client";

import { useState } from "react";

interface SpawnDialogProps {
  onSpawn: (project: string, task: string, model: string) => void;
  onClose: () => void;
}

const MODELS = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "openclaw", label: "OpenClaw" },
];

export function SpawnDialog({ onSpawn, onClose }: SpawnDialogProps) {
  const [selectedModel, setSelectedModel] = useState("claude");
  const [task, setTask] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        role="presentation"
      />

      {/* Dialog */}
      <div className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-lg w-full max-w-sm mx-4 p-6">
        <h2 className="text-lg font-semibold mb-4">Spawn Agent</h2>

        {/* Model selector */}
        <div className="flex gap-2 mb-4">
          {MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setSelectedModel(m.id)}
              className={`
                flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors
                ${
                  selectedModel === m.id
                    ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:border-zinc-600"
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
            className="w-full bg-[var(--bg)] border border-[var(--border)] rounded px-3 py-2 text-sm text-[var(--text)] placeholder:text-zinc-600 outline-none focus:border-[var(--accent)] transition-colors resize-none"
          />
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-4 py-2 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-zinc-600 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSpawn("~", task.trim(), selectedModel)}
            className="text-sm px-4 py-2 rounded bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
          >
            Spawn
          </button>
        </div>
      </div>
    </div>
  );
}
