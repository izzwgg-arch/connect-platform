// Tracking-token + verification-tier policy — PURE. Decides token validity and what a
// given verification tier is allowed to see. No DB/crypto here (the service hashes/looks up).

export interface TokenState {
  expiresAt: number | null; // ms epoch; null = no expiry
  revokedAt: number | null; // ms epoch; null = not revoked
  orderTerminal: boolean; // order delivered/canceled
  graceMsAfterTerminal?: number; // link stays valid briefly after completion
}

export type TokenInvalidReason = "expired" | "revoked" | "terminal_grace_passed";

export interface TokenValidity {
  valid: boolean;
  reason?: TokenInvalidReason;
}

export function checkTokenValidity(state: TokenState, nowMs: number, terminalAtMs: number | null = null): TokenValidity {
  if (state.revokedAt != null && nowMs >= state.revokedAt) return { valid: false, reason: "revoked" };
  if (state.expiresAt != null && nowMs >= state.expiresAt) return { valid: false, reason: "expired" };
  if (state.orderTerminal && terminalAtMs != null) {
    const grace = state.graceMsAfterTerminal ?? 24 * 3_600_000; // default 24h receipt window
    if (nowMs - terminalAtMs > grace) return { valid: false, reason: "terminal_grace_passed" };
  }
  return { valid: true };
}

// ── Verification tiers (decision 4) ─────────────────────────────────────────────
// Tier 0: invalid link — reveal nothing.
// Tier 1: valid link (or caller-ID/sender match) — status + ETA + coarse map.
// Tier 2: OTP verified (or order# + partial address) — sensitive detail (full address, proof).

export interface TierInputs {
  tokenValid: boolean;
  otpVerified: boolean;
}

export function resolveTier(inputs: TierInputs): 0 | 1 | 2 {
  if (!inputs.tokenValid) return 0;
  return inputs.otpVerified ? 2 : 1;
}

export interface VisibleFields {
  status: boolean;
  eta: boolean;
  map: boolean;
  fullAddress: boolean;
  proof: boolean;
}

export function visibleFields(tier: 0 | 1 | 2): VisibleFields {
  return {
    status: tier >= 1,
    eta: tier >= 1,
    map: tier >= 1,
    fullAddress: tier >= 2,
    proof: tier >= 2,
  };
}
