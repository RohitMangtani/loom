'use client';

import { useState, useEffect, ReactNode } from 'react';

const TOKEN_KEY = 'hive_token';
const MODE_KEY = 'hive_mode'; // "admin" | "viewer"
const DAEMON_URL_KEY = 'hive_daemon_url';

interface SitePasswordGateProps {
  children: ReactNode;
}

/**
 * Returns the current auth mode: "admin" or "viewer".
 * Default is "viewer"  --  everyone can see the cards.
 * Admin is unlocked by entering the token once (stored forever).
 */
export function getAuthMode(): "admin" | "viewer" {
  if (typeof window === "undefined") return "viewer";
  return (localStorage.getItem(MODE_KEY) as "admin" | "viewer") || "viewer";
}

/** Get the stored admin token (if any) for WS auth */
export function getStoredToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(TOKEN_KEY) || "";
}

/** Unlock admin mode  --  called from the settings UI */
export function unlockAdmin(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(MODE_KEY, "admin");
}

/** Lock back to viewer mode */
export function lockAdmin(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(MODE_KEY);
}

/**
 * Detect if this is a remote session (not on the host machine).
 * On the host machine, DEFAULT_URL (ws://localhost:3002) works.
 * Remote users need a daemon URL configured.
 */
function isRemoteSession(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host !== "localhost" && host !== "127.0.0.1" && host !== "0.0.0.0";
}

/** Check if the connection is already configured (has token) */
function isConnectionConfigured(): boolean {
  if (typeof window === "undefined") return false;
  return !!localStorage.getItem(TOKEN_KEY);
}

/** Try to parse an invite link and extract token + ws params */
function parseInviteLink(input: string): { token?: string; ws?: string } | null {
  const trimmed = input.trim();
  // Could be a full URL with params, or just the params portion
  try {
    let url: URL;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      url = new URL(trimmed);
    } else if (trimmed.includes("token=") || trimmed.includes("ws=")) {
      url = new URL(`https://placeholder.com?${trimmed}`);
    } else {
      return null;
    }
    const token = url.searchParams.get("token") || undefined;
    const ws = url.searchParams.get("ws") || undefined;
    if (token || ws) return { token, ws };
  } catch {
    // Not a URL
  }
  return null;
}

/**
 * Connection setup screen for remote users.
 * Shows when: remote session + no token stored.
 * Just paste your token - same as the original dashboard experience.
 */
function ConnectionSetup({ onComplete }: { onComplete: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleConnect = () => {
    setError(null);
    const trimmed = token.trim();
    if (!trimmed) { setError("Paste your token from the host machine."); return; }

    // Try to parse as invite link first (backward compat)
    const parsed = parseInviteLink(trimmed);
    if (parsed?.token) {
      localStorage.setItem(TOKEN_KEY, parsed.token);
      localStorage.setItem(MODE_KEY, "admin");
      if (parsed.ws) localStorage.setItem(DAEMON_URL_KEY, parsed.ws);
      onComplete();
      return;
    }

    // Raw token (64-char hex or viewer token)
    localStorage.setItem(TOKEN_KEY, trimmed);
    localStorage.setItem(MODE_KEY, "admin");
    onComplete();
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a0b",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "400px",
          background: "#141416",
          border: "1.5px solid #27272a",
          borderRadius: "12px",
          padding: "32px 28px",
        }}
      >
        <h1
          style={{
            fontSize: "20px",
            fontWeight: 600,
            color: "#f0f0f0",
            marginBottom: "4px",
            letterSpacing: "-0.02em",
          }}
        >
          Hive
        </h1>
        <p
          style={{
            fontSize: "13px",
            color: "#71717a",
            marginBottom: "24px",
            lineHeight: 1.5,
          }}
        >
          Paste your token to connect.
        </p>

        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && token.trim() && handleConnect()}
          placeholder="Paste token here"
          autoFocus
          style={{
            width: "100%",
            padding: "10px 12px",
            fontSize: "13px",
            fontFamily: "var(--font-geist-mono), monospace",
            background: "#0a0a0b",
            border: "1px solid #27272a",
            borderRadius: "8px",
            color: "#f0f0f0",
            outline: "none",
            marginBottom: "12px",
            boxSizing: "border-box",
          }}
        />
        <button
          type="button"
          onClick={handleConnect}
          disabled={!token.trim()}
          style={{
            width: "100%",
            padding: "10px",
            fontSize: "13px",
            fontWeight: 500,
            background: token.trim() ? "#3b82f6" : "#27272a",
            color: token.trim() ? "#fff" : "#71717a",
            border: "none",
            borderRadius: "8px",
            cursor: token.trim() ? "pointer" : "default",
            transition: "background 0.15s, color 0.15s",
          }}
        >
          Connect
        </button>

        {error && (
          <p
            style={{
              fontSize: "12px",
              color: "#f87171",
              marginTop: "12px",
              lineHeight: 1.4,
            }}
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Gate component — wraps the entire app.
 *
 * For LOCAL sessions (localhost): always renders children (original behavior).
 * For REMOTE sessions: shows ConnectionSetup if daemon URL + token aren't configured.
 * Invite links (?token=&ws=) still auto-authenticate and skip the setup screen.
 */
export function SitePasswordGate({ children }: SitePasswordGateProps) {
  const [ready, setReady] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    // Auto-authenticate from ?token= parameter (invite links)
    const tokenParam = params.get('token');
    if (tokenParam && tokenParam.length >= 32) {
      localStorage.setItem(TOKEN_KEY, tokenParam);
      localStorage.setItem(MODE_KEY, 'admin');
    }
    // Auto-save daemon WS URL from ?ws= parameter (invite links)
    const wsParam = params.get('ws');
    if (wsParam && (wsParam.startsWith('ws://') || wsParam.startsWith('wss://'))) {
      localStorage.setItem(DAEMON_URL_KEY, wsParam);
    }
    // Clean URL so tokens aren't visible in the address bar
    if (tokenParam || wsParam) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    // Clean ?viewer= from URL if present (backward compat with old share links)
    if (params.has('viewer')) {
      window.history.replaceState({}, '', window.location.pathname);
    }

    // For remote sessions without credentials, show setup screen
    if (isRemoteSession() && !isConnectionConfigured()) {
      setNeedsSetup(true);
    }

    setReady(true);
  }, []);

  if (!ready) return <div style={{ minHeight: "100vh", background: "#0a0a0b" }} />;

  if (needsSetup) {
    return (
      <ConnectionSetup
        onComplete={() => {
          setNeedsSetup(false);
        }}
      />
    );
  }

  return <>{children}</>;
}
