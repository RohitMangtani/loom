"use client";

import { useEffect, useRef, useState } from "react";

interface ChatPanelProps {
  workerId: string;
  projectName: string;
  messages: string[];
  onSend: (message: string) => void;
  onClose: () => void;
}

export function ChatPanel({
  workerId,
  projectName,
  messages,
  onSend,
  onClose,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setInput("");
  }

  return (
    <div className="flex flex-col h-full border-l border-[var(--border)] bg-[var(--bg-card)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div className="min-w-0">
          <h3 className="text-sm font-medium truncate">{projectName}</h3>
          <p className="text-xs text-[var(--text-muted)] truncate">
            {workerId}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-300 transition-colors ml-2 p-1"
          title="Close"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-[18px] leading-relaxed"
      >
        {messages.length === 0 ? (
          <p className="text-[var(--text-muted)]">No messages yet.</p>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className="text-[var(--text)] whitespace-pre-wrap break-words">
              {msg}
            </div>
          ))
        )}
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 px-4 py-3 border-t border-[var(--border)]"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Send a message to this worker..."
          className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded px-3 py-1.5 text-sm text-[var(--text)] placeholder:text-zinc-600 outline-none focus:border-[var(--accent)] transition-colors"
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className="text-sm px-3 py-1.5 rounded bg-[var(--accent)] text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          Send
        </button>
      </form>
    </div>
  );
}
