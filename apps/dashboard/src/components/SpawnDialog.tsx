"use client";

import { useState } from "react";

interface SpawnDialogProps {
  onSpawn: (project: string, task: string) => void;
  onClose: () => void;
}

const PROJECTS = [
  { name: "crawler", path: "~/factory/projects/crawler" },
  { name: "rmgtni-web", path: "~/factory/projects/rmgtni-web" },
  { name: "rohitmangtani-web", path: "~/factory/projects/rohitmangtani-web" },
  { name: "skillmap", path: "~/factory/projects/skillmap" },
  { name: "stotram", path: "~/factory/projects/stotram" },
  { name: "nudge", path: "~/factory/projects/nudge" },
  { name: "hive", path: "~/factory/projects/hive" },
];

export function SpawnDialog({ onSpawn, onClose }: SpawnDialogProps) {
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [task, setTask] = useState("");

  function handleSpawn() {
    if (!selectedProject) return;
    onSpawn(selectedProject, task.trim());
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        role="presentation"
      />

      {/* Dialog */}
      <div className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-lg w-full max-w-lg mx-4 p-6">
        <h2 className="text-lg font-semibold mb-4">Spawn Worker</h2>

        {/* Project grid */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          {PROJECTS.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => setSelectedProject(p.path)}
              className={`
                text-left rounded-md border px-3 py-2.5 transition-colors
                ${
                  selectedProject === p.path
                    ? "border-[var(--accent)] bg-[var(--accent)]/10"
                    : "border-[var(--border)] hover:border-zinc-600"
                }
              `}
            >
              <span className="text-sm font-medium">{p.name}</span>
              <span className="block text-xs text-[var(--text-muted)] mt-0.5 truncate">
                {p.path}
              </span>
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
            rows={3}
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
            onClick={handleSpawn}
            disabled={!selectedProject}
            className="text-sm px-4 py-2 rounded bg-[var(--accent)] text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
          >
            Spawn
          </button>
        </div>
      </div>
    </div>
  );
}
