export type SatelliteRecoveryAction = "none" | "repair" | "reinstall";

export interface SatelliteRecoveryDecisionInput {
  consecutiveFailures: number;
  shortLivedConnections: number;
  offlineMs: number;
  selfHealAttempts: number;
  msSinceLastSelfHeal: number;
  /** True if the satellite has NEVER successfully connected since startup. */
  neverConnected?: boolean;
}

export const SATELLITE_STABLE_CONNECTION_MS = 60_000;
export const SATELLITE_SELF_HEAL_COOLDOWN_MS = 120_000;
export const SATELLITE_REPAIR_FAILURE_THRESHOLD = 4;
export const SATELLITE_REPAIR_OFFLINE_MS = 90_000;

/**
 * Decide whether to self-heal (repair/reinstall) or just keep reconnecting.
 *
 * Key insight: when the primary's tunnel is down, self-heal makes things worse
 * because repair/reinstall both call process.exit(0), causing launchd to
 * throttle and eventually stop the service. The satellite should only self-heal
 * for LOCAL issues (broken install, stale config). If we had a connection before
 * and now can't reconnect, the primary is likely just unreachable — keep trying.
 *
 * Self-heal triggers ONLY when:
 * - shortLivedConnections >= threshold (connects but immediately drops = local issue)
 * - AND we're past the cooldown
 *
 * Pure connection failures (never connected, or lost connection and can't get back)
 * are treated as "primary unreachable" — no self-heal, just exponential backoff.
 */
export function chooseSatelliteRecoveryAction(
  input: SatelliteRecoveryDecisionInput,
): SatelliteRecoveryAction {
  if (input.msSinceLastSelfHeal < SATELLITE_SELF_HEAL_COOLDOWN_MS) {
    return "none";
  }

  // Already tried twice — stop escalating
  if (input.selfHealAttempts >= 2) return "none";

  // Short-lived connections (connects then immediately drops) suggest a local issue
  // like version mismatch, broken dependencies, or corrupt state. Self-heal.
  if (input.shortLivedConnections >= SATELLITE_REPAIR_FAILURE_THRESHOLD) {
    return input.selfHealAttempts >= 1 ? "reinstall" : "repair";
  }

  // Pure connection failures (can't reach primary at all) — don't self-heal.
  // The primary tunnel is probably down. Keep reconnecting with backoff.
  // The primary's TunnelHealthMonitor will restart the tunnel, and URL rotation
  // + broadcast will eventually restore the connection.
  return "none";
}
