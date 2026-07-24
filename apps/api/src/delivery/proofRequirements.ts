// Proof-of-delivery requirements + completion safeguards — PURE.
// Decides what proof a delivery needs and whether a completion may proceed. The service
// enforces these before writing DELIVERED (Gate 3 §14.2).

export type ProofMethod = "photo" | "signature" | "recipient_name" | "pin" | "gps" | "tap";

export type HandoverType =
  | "handed_to_customer" | "left_at_door" | "household_member" | "reception";

export interface OrderProofFlags {
  signatureRequired?: boolean;
  ageRestricted?: boolean;
}

export interface TenantProofPolicy {
  /** Default proof for standard orders when no per-order flag applies. */
  standard?: ProofMethod[];
}

/** The proof methods required for this order. */
export function requiredProof(flags: OrderProofFlags, policy: TenantProofPolicy = {}): ProofMethod[] {
  if (flags.ageRestricted) return ["pin", "photo"]; // strongest — verify + evidence
  if (flags.signatureRequired) return ["signature"];
  return policy.standard && policy.standard.length ? policy.standard : ["tap"];
}

export interface CompletionInput {
  requiredProof: ProofMethod[];
  providedProof: ProofMethod[];
  handover?: HandoverType;
  /** Driver is within an acceptable radius of the destination. */
  nearDestination: boolean;
  /** A location fix is available. */
  hasLocation: boolean;
  /** Reason supplied when overriding the proximity check (weak GPS etc.). */
  overrideReason?: string | null;
  /** True when this delivery was already submitted (idempotency guard). */
  alreadySubmitted: boolean;
}

export type CompletionBlock =
  | "already_submitted" | "missing_proof" | "not_near_destination" | "no_location";

export interface CompletionDecision {
  ok: boolean;
  blocks: CompletionBlock[];
  missingProof: ProofMethod[];
}

/** Pre-submit safeguards. Pure — returns every blocking reason (not just the first). */
export function decideCompletion(input: CompletionInput): CompletionDecision {
  const blocks: CompletionBlock[] = [];

  if (input.alreadySubmitted) blocks.push("already_submitted");

  const provided = new Set(input.providedProof);
  const missingProof = input.requiredProof.filter((m) => !provided.has(m));
  if (missingProof.length) blocks.push("missing_proof");

  // Proximity: require a location OR an explicit override reason.
  if (!input.nearDestination) {
    if (input.overrideReason && input.overrideReason.trim()) {
      // allowed with a logged reason
    } else if (!input.hasLocation) {
      blocks.push("no_location");
    } else {
      blocks.push("not_near_destination");
    }
  }

  return { ok: blocks.length === 0, blocks, missingProof };
}
