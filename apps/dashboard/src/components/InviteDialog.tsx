"use client";

import { useState } from "react";

interface InviteDialogProps {
  daemonUrl: string;
  onClose: () => void;
}

type Role = "admin" | "operator" | "viewer";

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: "Full control: spawn, kill, message, manage users",
  operator: "Can message agents and manage tasks",
  viewer: "Read-only dashboard access",
};

export function InviteDialog({ daemonUrl, onClose }: InviteDialogProps) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("operator");
  const [result, setResult] = useState<{ token: string; name: string; role: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleInvite = async () => {
    if (!name.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const token = localStorage.getItem("hive_token") || "";
      // Derive HTTP URL from WebSocket URL
      const httpBase = daemonUrl
        .replace(/^wss:\/\//, "https://")
        .replace(/^ws:\/\//, "http://")
        .replace(/:3002/, ":3001");

      const res = await fetch(`${httpBase}/api/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ name: name.trim(), role }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Request failed" }));
        setError(data.error || `Error ${res.status}`);
        return;
      }

      const user = await res.json();
      setResult({ token: user.token, name: user.name, role: user.role });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create invite");
    } finally {
      setLoading(false);
    }
  };

  const dashboardUrl = typeof window !== "undefined" ? window.location.origin : "";

  const handleCopy = () => {
    if (!result) return;
    const text = `Join my Hive dashboard:\n${dashboardUrl}\n\nYour token: ${result.token}\n\nPaste the token when the dashboard asks for it.`;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        role="presentation"
      />

      <div className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-lg w-full max-w-sm mx-4 p-6">
        {!result ? (
          <>
            <h2 className="text-lg font-semibold mb-4">Invite to Hive</h2>

            <div className="mb-4">
              <label className="block text-xs text-[var(--text-muted)] mb-1.5">
                Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Alex"
                className="w-full px-3 py-2 text-sm rounded-md border border-[var(--border)] bg-[var(--bg)] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-zinc-500"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleInvite()}
              />
            </div>

            <div className="mb-4">
              <label className="block text-xs text-[var(--text-muted)] mb-1.5">
                Role
              </label>
              <div className="space-y-2">
                {(["operator", "viewer", "admin"] as Role[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRole(r)}
                    className={`
                      w-full text-left px-3 py-2 text-sm rounded-md border transition-colors
                      ${role === r
                        ? "border-[var(--accent)] bg-[var(--accent)]/10"
                        : "border-[var(--border)] hover:border-zinc-600"
                      }
                    `}
                  >
                    <span className="font-medium capitalize">{r}</span>
                    <span className="block text-xs text-[var(--text-muted)] mt-0.5">
                      {ROLE_DESCRIPTIONS[r]}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <p className="text-xs text-red-400 mb-3">{error}</p>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-3 py-2 text-sm rounded-md border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleInvite}
                disabled={!name.trim() || loading}
                className="flex-1 px-3 py-2 text-sm rounded-md bg-[var(--accent)] text-white font-medium disabled:opacity-40 transition-opacity"
              >
                {loading ? "Creating..." : "Create Invite"}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold mb-1">Invite Ready</h2>
            <p className="text-xs text-[var(--text-muted)] mb-4">
              Send this to {result.name}. The token is shown once.
            </p>

            <div className="p-3 rounded-md bg-[var(--bg)] border border-[var(--border)] mb-4">
              <p className="text-xs text-[var(--text-muted)] mb-1">Dashboard</p>
              <p className="text-sm font-mono break-all">{dashboardUrl}</p>

              <p className="text-xs text-[var(--text-muted)] mt-3 mb-1">Token</p>
              <p className="text-sm font-mono break-all select-all">{result.token}</p>

              <p className="text-xs text-[var(--text-muted)] mt-3 mb-1">Role</p>
              <p className="text-sm capitalize">{result.role}</p>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-3 py-2 text-sm rounded-md border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] transition-colors"
              >
                Done
              </button>
              <button
                type="button"
                onClick={handleCopy}
                className="flex-1 px-3 py-2 text-sm rounded-md bg-[var(--accent)] text-white font-medium transition-opacity"
              >
                {copied ? "Copied!" : "Copy Invite"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
