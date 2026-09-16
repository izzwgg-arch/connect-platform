/**
 * Creative Studio — the service layer.
 *
 * One implementation of "make something", used by BOTH doors: the customer's
 * browser and the Coworker's internal door. That is deliberate — if the agent
 * had its own path it could drift into skipping the safety check, the quota
 * check or the brand kit, and nobody would notice until a customer was charged
 * for something we should have refused.
 */
import { buildPrompt, checkRequestSafety, describeRequest } from "./promptBuilder";
import { activeMemoryFor } from "./memory";
import { checkQuota, createJob } from "./jobs";
import { chooseEngine, Capability } from "./engines";
import { loadBrandKit } from "./helpers";

export interface GenerationRequest {
  tenantId: string;
  userId?: string | null;
  capability: Capability | string;
  /** What the person actually said. */
  request: string;
  projectId?: string | null;
  ratio?: string;
  quality?: "low" | "medium" | "high";
  count?: number;
  seconds?: number;
  hd?: boolean;
  styleHint?: string;
  negativeExtra?: string;
  referenceAssetIds?: string[];
  maskAssetId?: string;
  firstFrameAssetId?: string;
  text?: string;
  voiceId?: string;
  durationMs?: number;
  engineId?: string | null;
  seed?: string;
  turnId?: string | null;
  /** The storyboard shot this render belongs to, if any. */
  shotId?: string | null;
}

export type GenerationOutcome =
  | { ok: true; job: any; deduped: boolean; label: string; appliedMemory: string[]; estimate: { costMicros: number; engine: string } }
  | { ok: false; code: "refused" | "no_engine" | "quota" | "nothing_asked"; reason: string; kind?: string };

export async function startGeneration(db: any, input: GenerationRequest): Promise<GenerationOutcome> {
  const askedFor = String(input.request || input.text || "").trim();
  if (!askedFor && input.capability !== "audio.music") {
    return { ok: false, code: "nothing_asked", reason: "Tell me what to make." };
  }

  // 1. Safety, before anything costs money.
  const safety = checkRequestSafety(askedFor);
  if (!safety.ok) return { ok: false, code: "refused", reason: safety.reason, kind: safety.kind };

  // 2. An engine that exists, is on, and may be sold with.
  const engine = await chooseEngine(db, input.capability as Capability, input.engineId);
  if (!engine) return { ok: false, code: "no_engine", reason: "No engine is switched on for that yet." };

  // 3. The company's allowance.
  const quota = await checkQuota(db, input.tenantId, String(input.capability), input);
  if (!quota.ok) return { ok: false, code: "quota", reason: quota.reason };

  // 4. Brand kit + learned preferences → the prompt we actually send.
  const kit = await loadBrandKit(db, input.tenantId);
  const memory = await activeMemoryFor(db, input.tenantId, input.userId);
  const built = String(input.capability).startsWith("audio")
    ? { prompt: askedFor, negative: "", applied: [] as string[] }
    : buildPrompt({
        request: askedFor,
        kind: String(input.capability).startsWith("video") ? "video" : "image",
        brandKit: kit,
        memory,
        styleHint: input.styleHint,
        negativeExtra: input.negativeExtra,
        hasReferences: !!(input.referenceAssetIds?.length || input.firstFrameAssetId),
      });

  const { job, deduped, refused } = await createJob(db, {
    tenantId: input.tenantId,
    capability: input.capability,
    projectId: input.projectId || null,
    requestedByUserId: input.userId || null,
    turnId: input.turnId || null,
    engineId: engine.id,
    request: {
      request: askedFor,
      prompt: built.prompt,
      negative: built.negative,
      ratio: input.ratio,
      quality: input.quality || "low",
      count: input.count || 1,
      seconds: input.seconds,
      hd: input.hd,
      referenceAssetIds: input.referenceAssetIds || [],
      maskAssetId: input.maskAssetId,
      firstFrameAssetId: input.firstFrameAssetId,
      text: input.text,
      voiceId: input.voiceId,
      durationMs: input.durationMs,
      seed: input.seed,
      shotId: input.shotId || undefined,
      model: engine.model,
      appliedMemory: built.applied,
    },
  });
  if (!job) return { ok: false, code: "no_engine", reason: refused || "No engine is available." };

  return {
    ok: true,
    job,
    deduped,
    label: describeRequest(String(input.capability), askedFor),
    appliedMemory: built.applied,
    estimate: { costMicros: job.costMicros, engine: engine.label },
  };
}
