"use client";

import { useState } from "react";

interface OrchestratorBarProps {
  onSend: (message: string) => void;
  connected: boolean;
}

export function OrchestratorBar({ onSend, connected }: OrchestratorBarProps) {
  const [input, setInput] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setInput("");
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="fixed bottom-0 left-0 right-0 flex items-center gap-3 px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-card)]"
    >
      <span
        className={`
          flex-shrink-0 w-2.5 h-2.5 rounded-full
          ${connected ? "bg-[var(--success)]" : "bg-[var(--error)]"}
        `}
        title={connected ? "Connected" : "Disconnected"}
      />
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={
          connected
            ? "Message the orchestrator..."
            : "Disconnected. Reconnecting..."
        }
        disabled={!connected}
        className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded px-3 py-2 text-sm text-[var(--text)] placeholder:text-zinc-600 outline-none focus:border-[var(--accent)] transition-colors disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={!connected || !input.trim()}
        className="text-sm px-4 py-2 rounded bg-[var(--accent)] text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
      >
        Send
      </button>
    </form>
  );
}
