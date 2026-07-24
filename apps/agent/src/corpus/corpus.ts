/**
 * Corpus service (YIDDISH_TUNING.md). Captures transcripts from all sources into
 * one labeled dataset, routes low-confidence samples to human correction, records
 * gold corrections, and exports (audio,text) pairs for fine-tuning.
 */
import { detectTerms, classifyLanguage, type DialectTerm } from "./glossary";
import type { AuditLog } from "../audit/audit";

export type CorpusSource = "live_call" | "news_hotline" | "bulk_import" | "correction";

export interface CaptureInput {
  tenantId?: string | null;
  recordingId: string;
  text: string;
  audioRef?: string;
  model?: string;
  confidence?: number;
  source?: CorpusSource;
  /** consent/retention gate; only true samples are used for tuning. */
  trainingEligible?: boolean;
}

/** Below this confidence, a transcript is queued for human review. */
export const REVIEW_THRESHOLD = 0.75;

/**
 * COMPLIANCE — Yiddish Labs is used for LIVE transcription/translation ONLY,
 * never for model training. Yiddish Labs' terms forbid training on their system,
 * so any transcript produced by them is PERMANENTLY barred from the training
 * corpus: it can never be marked trainingEligible and is excluded from every
 * export. This is enforced in code (capture + approve + export) and provable via
 * complianceReport(). See docs/ai-support-agent/YL_NO_TRAINING_POLICY.md.
 */
export const TRAINING_FORBIDDEN_MODELS = ["yiddishlabs", "yiddish-labs", "yiddish_labs", "yl"];
export function isTrainingForbidden(model?: string | null): boolean {
  const m = (model ?? "").toLowerCase().trim();
  return TRAINING_FORBIDDEN_MODELS.includes(m);
}

export class CorpusService {
  constructor(
    private prisma: any,
    private audit: AuditLog,
    private glossary: () => Promise<DialectTerm[]>,
  ) {}

  async capture(input: CaptureInput): Promise<{ id: string; reviewStatus: string; language: string }> {
    const terms = await this.glossary();
    const language = classifyLanguage(input.text);
    const hits = detectTerms(input.text, terms);
    const source = input.source ?? "live_call";
    const reviewStatus = (input.confidence ?? 1) < REVIEW_THRESHOLD ? "pending" : "none";
    // Yiddish Labs output is serving-only — force it training-ineligible at the door.
    const forbidden = isTrainingForbidden(input.model);
    const trainingEligible = forbidden ? false : (input.trainingEligible ?? false);

    const row = await this.prisma.agentTranscript.upsert({
      where: { recordingId: input.recordingId },
      update: {
        text: input.text, language, model: input.model, confidence: input.confidence,
        audioRef: input.audioRef, source, glossaryHits: hits as any,
        trainingEligible, reviewStatus,
      },
      create: {
        tenantId: input.tenantId ?? null, recordingId: input.recordingId, text: input.text,
        language, model: input.model, confidence: input.confidence, audioRef: input.audioRef,
        source, glossaryHits: hits as any, trainingEligible, reviewStatus,
      },
    });
    await this.audit.record({ actor: "agent", event: "corpus.captured", tenantId: input.tenantId ?? undefined, payload: { recordingId: input.recordingId, source, language, confidence: input.confidence, hits: hits.length, review: reviewStatus } });
    return { id: row.id, reviewStatus, language };
  }

  /** Native-speaker correction → creates the gold (audio,text) pair. */
  async correct(recordingId: string, correctedText: string, correctedBy: string): Promise<void> {
    await this.prisma.agentTranscript.update({
      where: { recordingId },
      data: { correctedText, correctedBy, correctedAt: new Date(), reviewStatus: "corrected", language: classifyLanguage(correctedText) },
    });
    await this.audit.record({ actor: "owner", event: "corpus.corrected", payload: { recordingId, correctedBy, chars: correctedText.length } });
  }

  async approve(recordingId: string): Promise<{ approved: boolean; trainingEligible: boolean; reason?: string }> {
    const row = await this.prisma.agentTranscript.findUnique({ where: { recordingId }, select: { model: true } });
    // COMPLIANCE: never let a Yiddish Labs transcript become training-eligible,
    // even if an owner approves it. It's marked reviewed but stays out of training.
    if (isTrainingForbidden(row?.model)) {
      await this.prisma.agentTranscript.update({ where: { recordingId }, data: { reviewStatus: "approved", trainingEligible: false } });
      await this.audit.record({ actor: "owner", event: "corpus.yl_excluded_from_training", payload: { recordingId, model: row?.model, note: "Yiddish Labs output is serving-only; barred from training." } });
      return { approved: true, trainingEligible: false, reason: "yiddish_labs_serving_only" };
    }
    await this.prisma.agentTranscript.update({ where: { recordingId }, data: { reviewStatus: "approved", trainingEligible: true } });
    await this.audit.record({ actor: "owner", event: "corpus.approved", payload: { recordingId } });
    return { approved: true, trainingEligible: true };
  }

  async reviewQueue(limit = 50): Promise<any[]> {
    return this.prisma.agentTranscript.findMany({ where: { reviewStatus: "pending" }, orderBy: { createdAt: "asc" }, take: limit });
  }

  /** Corpus stats for the dashboard — how the flywheel is filling up. */
  async stats(): Promise<Record<string, number>> {
    const [total, corrected, approved, eligible, hotline, calls] = await Promise.all([
      this.prisma.agentTranscript.count(),
      this.prisma.agentTranscript.count({ where: { reviewStatus: "corrected" } }),
      this.prisma.agentTranscript.count({ where: { reviewStatus: "approved" } }),
      this.prisma.agentTranscript.count({ where: { trainingEligible: true } }),
      this.prisma.agentTranscript.count({ where: { source: "news_hotline" } }),
      this.prisma.agentTranscript.count({ where: { source: "live_call" } }),
    ]);
    return { total, corrected, approved, trainingEligible: eligible, from_hotline: hotline, from_calls: calls };
  }

  /** Export gold pairs for a fine-tune run (Whisper-format manifest rows).
   *  Belt-and-suspenders: excludes Yiddish Labs provenance even if a row were
   *  somehow flagged eligible — no YL data can ever reach a training run. */
  async exportTrainingManifest(limit = 100000): Promise<Array<{ audio: string; text: string; language: string }>> {
    const rows = await this.prisma.agentTranscript.findMany({
      where: { trainingEligible: true, audioRef: { not: null }, model: { notIn: TRAINING_FORBIDDEN_MODELS } },
      select: { audioRef: true, correctedText: true, text: true, language: true },
      take: limit,
    });
    return rows
      .filter((r: any) => r.audioRef && (r.correctedText || r.text))
      .map((r: any) => ({ audio: r.audioRef, text: r.correctedText ?? r.text, language: r.language ?? "yi" }));
  }

  /**
   * Compliance evidence: proves Yiddish Labs was used for transcription only,
   * never training. Returns the counts an auditor would want — the critical one,
   * `yiddishLabsTrainingEligible`, must always be 0.
   */
  async complianceReport(): Promise<{
    generatedAt: string;
    yiddishLabsTranscripts: number;
    yiddishLabsTrainingEligible: number;
    trainingEligibleTotal: number;
    trainingEligibleByModel: Record<string, number>;
    exportExcludesYiddishLabs: true;
    policy: string;
  }> {
    const [ylTotal, ylEligible, eligibleTotal, eligibleRows] = await Promise.all([
      this.prisma.agentTranscript.count({ where: { model: { in: TRAINING_FORBIDDEN_MODELS } } }),
      this.prisma.agentTranscript.count({ where: { model: { in: TRAINING_FORBIDDEN_MODELS }, trainingEligible: true } }),
      this.prisma.agentTranscript.count({ where: { trainingEligible: true } }),
      this.prisma.agentTranscript.groupBy({ by: ["model"], where: { trainingEligible: true }, _count: { _all: true } }).catch(() => []),
    ]);
    const byModel: Record<string, number> = {};
    for (const r of eligibleRows as any[]) byModel[r.model ?? "(none)"] = r._count?._all ?? 0;
    return {
      generatedAt: new Date().toISOString(),
      yiddishLabsTranscripts: ylTotal,
      yiddishLabsTrainingEligible: ylEligible, // MUST be 0
      trainingEligibleTotal: eligibleTotal,
      trainingEligibleByModel: byModel,
      exportExcludesYiddishLabs: true,
      policy: "Yiddish Labs is used for live transcription/translation only; its output is permanently barred from model training (enforced at capture, approve, and export).",
    };
  }
}
