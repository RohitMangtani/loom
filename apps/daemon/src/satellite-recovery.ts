export type SatelliteRecoveryAction = "none" | "repair" | "reinstall";

export interface SatelliteRecoveryDecisionInput {
  consecutiveFailures: number;
  shortLivedConnections: number;
  offlineMs: number;
  selfHealAttempts: number;
  msSinceLastSelfHeal: number;
}

export const SATELLITE_STABLE_CONNECTION_MS = 60_000;
export const SATELLITE_SELF_HEAL_COOLDOWN_MS = 120_000;
export const SATELLITE_REPAIR_FAILURE_THRESHOLD = 4;
export const SATELLITE_REPAIR_OFFLINE_MS = 90_000;

export function chooseSatelliteRecoveryAction(
  input: SatelliteRecoveryDecisionInput,
): SatelliteRecoveryAction {
  if (input.msSinceLastSelfHeal < SATELLITE_SELF_HEAL_COOLDOWN_MS) {
    return "none";
  }

  const shouldRepair =
    input.consecutiveFailures >= SATELLITE_REPAIR_FAILURE_THRESHOLD
    || input.shortLivedConnections >= SATELLITE_REPAIR_FAILURE_THRESHOLD
    || input.offlineMs >= SATELLITE_REPAIR_OFFLINE_MS;

  if (!shouldRepair) return "none";
  if (input.selfHealAttempts >= 2) return "none";
  return input.selfHealAttempts >= 1 ? "reinstall" : "repair";
}
