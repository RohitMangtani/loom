import { describe, expect, it } from "vitest";
import { chooseSatelliteRecoveryAction } from "../satellite-recovery.js";

describe("chooseSatelliteRecoveryAction", () => {
  it("does nothing for a normal reconnect blip", () => {
    expect(chooseSatelliteRecoveryAction({
      consecutiveFailures: 1,
      shortLivedConnections: 0,
      offlineMs: 10_000,
      selfHealAttempts: 0,
      msSinceLastSelfHeal: Number.POSITIVE_INFINITY,
    })).toBe("none");
  });

  it("triggers repair after repeated short-lived failures", () => {
    expect(chooseSatelliteRecoveryAction({
      consecutiveFailures: 4,
      shortLivedConnections: 4,
      offlineMs: 30_000,
      selfHealAttempts: 0,
      msSinceLastSelfHeal: Number.POSITIVE_INFINITY,
    })).toBe("repair");
  });

  it("escalates to reinstall after a prior self-heal failed to stabilize the satellite", () => {
    expect(chooseSatelliteRecoveryAction({
      consecutiveFailures: 5,
      shortLivedConnections: 4,
      offlineMs: 120_000,
      selfHealAttempts: 1,
      msSinceLastSelfHeal: 300_000,
    })).toBe("reinstall");
  });

  it("respects the self-heal cooldown", () => {
    expect(chooseSatelliteRecoveryAction({
      consecutiveFailures: 8,
      shortLivedConnections: 8,
      offlineMs: 180_000,
      selfHealAttempts: 1,
      msSinceLastSelfHeal: 30_000,
    })).toBe("none");
  });

  it("stops escalating forever once repair and reinstall were both attempted", () => {
    expect(chooseSatelliteRecoveryAction({
      consecutiveFailures: 12,
      shortLivedConnections: 12,
      offlineMs: 600_000,
      selfHealAttempts: 2,
      msSinceLastSelfHeal: 600_000,
    })).toBe("none");
  });
});
