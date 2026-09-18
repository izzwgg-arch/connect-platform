import type { Db } from "../db.js";

/** Stable string hash, mod 100 — same trick as core/routes.ts's evaluateFlag so a person never flips buckets. */
function bucket(key: string): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 100;
}

/**
 * The `treatment` field is the human description of the treatment arm (brief
 * requires it as free text). A rollout weight can optionally be embedded in
 * it, e.g. "Show the new ranking to 70%: treatment:70" — the last
 * `treatment:<0-99>` token wins; absent, it defaults to an even 50/50 split.
 */
export function treatmentWeight(treatmentText: string): number {
  const m = /treatment:(\d{1,3})(?!.*treatment:\d)/is.exec(treatmentText);
  if (!m) return 50;
  return Math.min(99, Math.max(1, Number(m[1])));
}

/**
 * Stable per-(experiment, person) bucket assignment, persisted so the variant
 * never changes once assigned. Guardrails: an experiment that isn't RUNNING
 * (DRAFT/PAUSED/DONE) or is outside its start/end window always resolves to
 * "control" — pausing an experiment must never keep serving treatment.
 */
export async function assignVariant(db: Db, experimentKey: string, personId: string): Promise<string> {
  const experiment = await db.experiment.findUnique({ where: { key: experimentKey } });
  if (!experiment) return "control";
  const now = new Date();
  if (experiment.status !== "RUNNING") return "control";
  if (experiment.startsAt && now < experiment.startsAt) return "control";
  if (experiment.endsAt && now > experiment.endsAt) return "control";

  const existing = await db.experimentAssignment.findUnique({ where: { experimentId_personId: { experimentId: experiment.id, personId } } });
  if (existing) return existing.variant;

  const weight = treatmentWeight(experiment.treatment);
  const variant = bucket(`${experimentKey}:${personId}`) < weight ? "treatment" : "control";
  try {
    await db.experimentAssignment.create({ data: { experimentId: experiment.id, personId, variant } });
  } catch {
    // Lost a race with a concurrent request assigning the same person — read back what won.
    const row = await db.experimentAssignment.findUnique({ where: { experimentId_personId: { experimentId: experiment.id, personId } } });
    if (row) return row.variant;
  }
  return variant;
}

export const EXPERIMENT_REQUIRED_FIELDS = ["key", "hypothesis", "population", "treatment", "control", "successMetrics", "guardrailMetrics", "minSample", "rollbackCriteria"] as const;
