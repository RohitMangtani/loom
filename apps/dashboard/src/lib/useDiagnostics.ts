"use client";

import { useCallback, useRef, useState } from "react";

// ---- Response types matching daemon API shapes ----

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface SatelliteReport {
  machine: string;
  version: string;
  versionMatch: boolean;
  workers: number;
  connected: boolean;
}

export interface PipelineReport {
  ts: number;
  version: string;
  overall: "pass" | "fail" | "warn";
  checks: CheckResult[];
  satellites: SatelliteReport[];
}

export interface DebugState {
  sessionToWorker: Record<string, string>;
  sessionFiles: Record<string, string>;
  lastHookTime: Record<string, number>;
  signalCounts: Record<string, number>;
  pendingHookQueue: Record<string, number>;
}

export interface Signal {
  ts: number;
  signal: string;
  detail: string;
}

export type SignalsResponse = Record<string, Signal[]>;

// ---- Hook ----

interface DiagnosticsState {
  check: PipelineReport | null;
  debug: DebugState | null;
  signals: SignalsResponse | null;
  loading: boolean;
  error: string | null;
}

export function useDiagnostics(baseUrl: string, token: string) {
  const [state, setState] = useState<DiagnosticsState>({
    check: null,
    debug: null,
    signals: null,
    loading: false,
    error: null,
  });

  // Prevent concurrent fetches
  const inflightRef = useRef(false);

  const headers = useCallback((): HeadersInit => {
    const h: HeadersInit = { "Content-Type": "application/json" };
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  }, [token]);

  const runCheck = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch(`${baseUrl}/api/check`, { headers: headers() });
      if (!res.ok) throw new Error(`Check failed: ${res.status}`);
      const data: PipelineReport = await res.json();
      setState((s) => ({ ...s, check: data, loading: false }));
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      inflightRef.current = false;
    }
  }, [baseUrl, headers]);

  const getDebug = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch(`${baseUrl}/api/debug`, { headers: headers() });
      if (!res.ok) throw new Error(`Debug failed: ${res.status}`);
      const data: DebugState = await res.json();
      setState((s) => ({ ...s, debug: data, loading: false }));
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [baseUrl, headers]);

  const getSignals = useCallback(
    async (workerId: string) => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const res = await fetch(
          `${baseUrl}/api/signals?workerId=${encodeURIComponent(workerId)}`,
          { headers: headers() },
        );
        if (!res.ok) throw new Error(`Signals failed: ${res.status}`);
        const data: SignalsResponse = await res.json();
        setState((s) => ({ ...s, signals: data, loading: false }));
      } catch (err) {
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [baseUrl, headers],
  );

  return {
    ...state,
    runCheck,
    getDebug,
    getSignals,
  };
}
