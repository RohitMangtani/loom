"use client";

import { useCallback, useEffect, useState } from "react";

interface InviteDialogProps {
  daemonUrl: string;
  onClose: () => void;
}

type Role = "admin" | "operator" | "viewer";
type View = "members" | "invite" | "invite-ready";

interface UserInfo {
  id: string;
  name: string;
  role: Role;
  createdAt: number;
}

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: "Full control",
  operator: "Message and manage tasks",
  viewer: "Read-only",
};

const ROLE_COLORS: Record<Role, string> = {
  admin: "#a78bfa",
  operator: "#4ade80",
  viewer: "#94a3b8",
};

function getHttpBase(daemonUrl: string): string {
  return daemonUrl
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://")
    .replace(/:3002/, ":3001");
}

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("hive_token") || "";
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
  };
}

export function InviteDialog({ daemonUrl, onClose }: InviteDialogProps) {
  const [view, setView] = useState<View>("members");
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Invite form state
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("operator");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ token: string; name: string; role: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Confirm delete
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const httpBase = getHttpBase(daemonUrl);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch(`${httpBase}/api/users`, { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        setUsers(Array.isArray(data) ? data : []);
      }
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [httpBase]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const handleInvite = async () => {
    if (!inviteName.trim()) return;
    setInviteLoading(true);
    setError(null);
    try {
      const res = await fetch(`${httpBase}/api/users`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ name: inviteName.trim(), role: inviteRole }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Request failed" }));
        setError(data.error || `Error ${res.status}`);
        return;
      }
      const user = await res.json();
      setInviteResult({ token: user.token, name: user.name, role: user.role });
      setView("invite-ready");
      fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create invite");
    } finally {
      setInviteLoading(false);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await fetch(`${httpBase}/api/users/${id}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      setUsers((prev) => prev.filter((u) => u.id !== id));
      setConfirmDeleteId(null);
    } catch { /* silent */ }
  };

  const handleCopy = () => {
    if (!inviteResult) return;
    const dashboardUrl = typeof window !== "undefined" ? window.location.origin : "";
    const text = `Join my Hive dashboard:\n${dashboardUrl}\n\nYour token: ${inviteResult.token}\n\nPaste the token when the dashboard asks for it.`;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const resetInvite = () => {
    setInviteName("");
    setInviteRole("operator");
    setInviteResult(null);
    setError(null);
    setCopied(false);
    setView("invite");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} role="presentation" />

      <div className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-lg w-full max-w-sm mx-4 overflow-hidden">

        {/* ── Members list ── */}
        {view === "members" && (
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Team</h2>
              <button
                type="button"
                onClick={resetInvite}
                className="px-3 py-1 text-xs rounded-md bg-[var(--accent)] text-white font-medium"
              >
                + Invite
              </button>
            </div>

            {loading ? (
              <p className="text-sm text-[var(--text-muted)]">Loading...</p>
            ) : users.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">No team members yet. Invite someone to get started.</p>
            ) : (
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {users.map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-[var(--bg-secondary)] transition-colors group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: ROLE_COLORS[user.role] }}
                      />
                      <span className="text-sm font-medium truncate">{user.name}</span>
                      <span className="text-xs text-[var(--text-muted)] capitalize">{user.role}</span>
                    </div>

                    {confirmDeleteId === user.id ? (
                      <div className="flex gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleRemove(user.id)}
                          className="px-2 py-0.5 text-xs rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
                        >
                          Remove
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-2 py-0.5 text-xs rounded border border-[var(--border)] text-[var(--text-muted)]"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(user.id)}
                        className="text-xs text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity hover:text-red-400"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={onClose}
              className="w-full mt-4 px-3 py-2 text-sm rounded-md border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] transition-colors"
            >
              Done
            </button>
          </div>
        )}

        {/* ── Invite form ── */}
        {view === "invite" && (
          <div className="p-6">
            <h2 className="text-lg font-semibold mb-4">Invite to Hive</h2>

            <div className="mb-4">
              <label className="block text-xs text-[var(--text-muted)] mb-1.5">Name</label>
              <input
                type="text"
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                placeholder="Alex"
                className="w-full px-3 py-2 text-sm rounded-md border border-[var(--border)] bg-[var(--bg)] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-zinc-500"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleInvite()}
              />
            </div>

            <div className="mb-4">
              <label className="block text-xs text-[var(--text-muted)] mb-1.5">Role</label>
              <div className="space-y-2">
                {(["operator", "viewer", "admin"] as Role[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setInviteRole(r)}
                    className={`w-full text-left px-3 py-2 text-sm rounded-md border transition-colors ${
                      inviteRole === r
                        ? "border-[var(--accent)] bg-[var(--accent)]/10"
                        : "border-[var(--border)] hover:border-zinc-600"
                    }`}
                  >
                    <span className="font-medium capitalize">{r}</span>
                    <span className="block text-xs text-[var(--text-muted)] mt-0.5">{ROLE_DESCRIPTIONS[r]}</span>
                  </button>
                ))}
              </div>
            </div>

            {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setView("members")}
                className="flex-1 px-3 py-2 text-sm rounded-md border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] transition-colors"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleInvite}
                disabled={!inviteName.trim() || inviteLoading}
                className="flex-1 px-3 py-2 text-sm rounded-md bg-[var(--accent)] text-white font-medium disabled:opacity-40 transition-opacity"
              >
                {inviteLoading ? "Creating..." : "Create Invite"}
              </button>
            </div>
          </div>
        )}

        {/* ── Invite ready ── */}
        {view === "invite-ready" && inviteResult && (
          <div className="p-6">
            <h2 className="text-lg font-semibold mb-1">Invite Ready</h2>
            <p className="text-xs text-[var(--text-muted)] mb-4">
              Send this to {inviteResult.name}. The token is shown once.
            </p>

            <div className="p-3 rounded-md bg-[var(--bg)] border border-[var(--border)] mb-4">
              <p className="text-xs text-[var(--text-muted)] mb-1">Dashboard</p>
              <p className="text-sm font-mono break-all">{typeof window !== "undefined" ? window.location.origin : ""}</p>

              <p className="text-xs text-[var(--text-muted)] mt-3 mb-1">Token</p>
              <p className="text-sm font-mono break-all select-all">{inviteResult.token}</p>

              <p className="text-xs text-[var(--text-muted)] mt-3 mb-1">Role</p>
              <p className="text-sm capitalize">{inviteResult.role}</p>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setView("members"); setInviteResult(null); }}
                className="flex-1 px-3 py-2 text-sm rounded-md border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] transition-colors"
              >
                Back to Team
              </button>
              <button
                type="button"
                onClick={handleCopy}
                className="flex-1 px-3 py-2 text-sm rounded-md bg-[var(--accent)] text-white font-medium transition-opacity"
              >
                {copied ? "Copied!" : "Copy Invite"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
