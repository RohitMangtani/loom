"use client";

import { useState } from "react";
import type { AgentModel, ConnectedMachine } from "@/lib/types";

interface SpawnDialogProps {
  models: AgentModel[];
  machines: ConnectedMachine[];
  onSpawn: (project: string, task: string, model: string, machine?: string) => void;
  onClose: () => void;
}

export function SpawnDialog({ models, machines, onSpawn, onClose }: SpawnDialogProps) {
  const [selectedModel, setSelectedModel] = useState(models[0]?.id || "claude");
  const [selectedMachine, setSelectedMachine] = useState<string>("local");
  const [task, setTask] = useState("");

  const hasSatellites = machines.length > 0;

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

        {/* Machine selector — only shown when satellites are connected */}
        {hasSatellites && (
          <div className="mb-4">
            <label className="block text-xs text-[var(--text-muted)] mb-1.5">
              Machine
            </label>
            <div className="flex gap-2 flex-wrap">
              <button
                key="local"
                type="button"
                onClick={() => setSelectedMachine("local")}
                className={`
                  px-3 py-1.5 text-xs rounded-md border font-medium transition-colors
                  ${
                    selectedMachine === "local"
                      ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:border-zinc-600"
                  }
                `}
              >
                This Mac
              </button>
              {machines.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelectedMachine(m.id)}
                  className={`
                    px-3 py-1.5 text-xs rounded-md border font-medium transition-colors
                    ${
                      selectedMachine === m.id
                        ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]"
                        : "border-[var(--border)] text-[var(--text-muted)] hover:border-zinc-600"
                    }
                  `}
                >
                  {m.hostname}
                  {m.workerCount > 0 && (
                    <span className="ml-1 opacity-50">({m.workerCount})</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

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
            onClick={() => onSpawn(
              "~",
              task.trim(),
              selectedModel,
              selectedMachine === "local" ? undefined : selectedMachine,
            )}
            className="text-sm px-4 py-2 rounded bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
          >
            Spawn{selectedMachine !== "local" ? ` on ${machines.find(m => m.id === selectedMachine)?.hostname || selectedMachine}` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
