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

/** Check if the connection is already configured (has daemon URL + token) */
function isConnectionConfigured(): boolean {
  if (typeof window === "undefined") return false;
  return !!(localStorage.getItem(DAEMON_URL_KEY) && localStorage.getItem(TOKEN_KEY));
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
 * Shows when: remote session + no daemon URL + no token stored.
 * Accepts: invite link (auto-parses), or manual token + WS URL entry.
 */
function ConnectionSetup({ onComplete }: { onComplete: () => void }) {
  const [input, setInput] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [manualWs, setManualWs] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleInviteLink = () => {
    setError(null);
    const parsed = parseInviteLink(input);
    if (!parsed || (!parsed.token && !parsed.ws)) {
      // Maybe it's a raw token (64-char hex)
      if (/^[a-f0-9]{64}$/i.test(input.trim())) {
        setError("That looks like a token. You also need the WebSocket URL. Click \"Enter manually\" below.");
        setShowManual(true);
        setManualToken(input.trim());
        return;
      }
      setError("Couldn't parse that link. Ask the host for an invite link, or enter details manually.");
      return;
    }
    if (parsed.token) {
      localStorage.setItem(TOKEN_KEY, parsed.token);
      localStorage.setItem(MODE_KEY, "admin");
    }
    if (parsed.ws) {
      localStorage.setItem(DAEMON_URL_KEY, parsed.ws);
    }
    if (!parsed.ws) {
      setError("That link is missing the WebSocket URL. Enter it manually below.");
      setShowManual(true);
      if (parsed.token) setManualToken(parsed.token);
      return;
    }
    if (!parsed.token) {
      setError("That link is missing the auth token. Enter it manually below.");
      setShowManual(true);
      if (parsed.ws) setManualWs(parsed.ws);
      return;
    }
    onComplete();
  };

  const handleManualConnect = () => {
    setError(null);
    const token = manualToken.trim();
    const ws = manualWs.trim();
    if (!token) { setError("Token is required."); return; }
    if (!ws) { setError("WebSocket URL is required."); return; }
    if (!ws.startsWith("ws://") && !ws.startsWith("wss://")) {
      setError("WebSocket URL must start with ws:// or wss://");
      return;
    }
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(MODE_KEY, "admin");
    localStorage.setItem(DAEMON_URL_KEY, ws);
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
          Connect to Hive
        </h1>
        <p
          style={{
            fontSize: "13px",
            color: "#71717a",
            marginBottom: "24px",
            lineHeight: 1.5,
          }}
        >
          Paste the invite link from the host machine to connect.
        </p>

        {!showManual ? (
          <>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && input.trim() && handleInviteLink()}
              placeholder="Paste invite link here"
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
              onClick={handleInviteLink}
              disabled={!input.trim()}
              style={{
                width: "100%",
                padding: "10px",
                fontSize: "13px",
                fontWeight: 500,
                background: input.trim() ? "#3b82f6" : "#27272a",
                color: input.trim() ? "#fff" : "#71717a",
                border: "none",
                borderRadius: "8px",
                cursor: input.trim() ? "pointer" : "default",
                marginBottom: "12px",
                transition: "background 0.15s, color 0.15s",
              }}
            >
              Connect
            </button>
            <button
              type="button"
              onClick={() => setShowManual(true)}
              style={{
                width: "100%",
                padding: "8px",
                fontSize: "12px",
                background: "transparent",
                color: "#71717a",
                border: "1px solid #27272a",
                borderRadius: "8px",
                cursor: "pointer",
              }}
            >
              Enter manually
            </button>
          </>
        ) : (
          <>
            <label
              style={{
                display: "block",
                fontSize: "11px",
                color: "#71717a",
                marginBottom: "6px",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              WebSocket URL
            </label>
            <input
              type="text"
              value={manualWs}
              onChange={(e) => setManualWs(e.target.value)}
              placeholder="wss://your-tunnel.ngrok-free.dev"
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
                marginBottom: "14px",
                boxSizing: "border-box",
              }}
            />
            <label
              style={{
                display: "block",
                fontSize: "11px",
                color: "#71717a",
                marginBottom: "6px",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Auth Token
            </label>
            <input
              type="password"
              value={manualToken}
              onChange={(e) => setManualToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleManualConnect()}
              placeholder="Paste token"
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
                marginBottom: "14px",
                boxSizing: "border-box",
              }}
            />
            <button
              type="button"
              onClick={handleManualConnect}
              disabled={!manualToken.trim() || !manualWs.trim()}
              style={{
                width: "100%",
                padding: "10px",
                fontSize: "13px",
                fontWeight: 500,
                background: manualToken.trim() && manualWs.trim() ? "#3b82f6" : "#27272a",
                color: manualToken.trim() && manualWs.trim() ? "#fff" : "#71717a",
                border: "none",
                borderRadius: "8px",
                cursor: manualToken.trim() && manualWs.trim() ? "pointer" : "default",
                marginBottom: "12px",
                transition: "background 0.15s, color 0.15s",
              }}
            >
              Connect
            </button>
            <button
              type="button"
              onClick={() => setShowManual(false)}
              style={{
                width: "100%",
                padding: "8px",
                fontSize: "12px",
                background: "transparent",
                color: "#71717a",
                border: "1px solid #27272a",
                borderRadius: "8px",
                cursor: "pointer",
              }}
            >
              Back
            </button>
          </>
        )}

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
