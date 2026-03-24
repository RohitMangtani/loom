'use client';

import { useState, useEffect, ReactNode } from 'react';

const TOKEN_KEY = 'hive_token';
const MODE_KEY = 'hive_mode'; // "admin" | "viewer"

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
 * No longer a gate  --  always renders children.
 * Just handles ?viewer= param cleanup for backward compat.
 */
export function SitePasswordGate({ children }: SitePasswordGateProps) {
  const [ready, setReady] = useState(false);

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
      localStorage.setItem('hive_daemon_url', wsParam);
    }
    // Clean URL so tokens aren't visible in the address bar
    if (tokenParam || wsParam) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    // Clean ?viewer= from URL if present (backward compat with old share links)
    if (params.has('viewer')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    setReady(true);
  }, []);

  if (!ready) return <div className="min-h-screen bg-[var(--bg)]" />;
  return <>{children}</>;
}
