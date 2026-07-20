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

    const row = await this.prisma.agentTranscript.upsert({
      where: { recordingId: input.recordingId },
      update: {
        text: input.text, language, model: input.model, confidence: input.confidence,
        audioRef: input.audioRef, source, glossaryHits: hits as any,
        trainingEligible: input.trainingEligible ?? false, reviewStatus,
      },
      create: {
        tenantId: input.tenantId ?? null, recordingId: input.recordingId, text: input.text,
        language, model: input.model, confidence: input.confidence, audioRef: input.audioRef,
        source, glossaryHits: hits as any, trainingEligible: input.trainingEligible ?? false, reviewStatus,
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

  async approve(recordingId: string): Promise<void> {
    await this.prisma.agentTranscript.update({ where: { recordingId }, data: { reviewStatus: "approved", trainingEligible: true } });
    await this.audit.record({ actor: "owner", event: "corpus.approved", payload: { recordingId } });
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

  /** Export gold pairs for a fine-tune run (Whisper-format manifest rows). */
  async exportTrainingManifest(limit = 100000): Promise<Array<{ audio: string; text: string; language: string }>> {
    const rows = await this.prisma.agentTranscript.findMany({
      where: { trainingEligible: true, audioRef: { not: null } },
      select: { audioRef: true, correctedText: true, text: true, language: true },
      take: limit,
    });
    return rows
      .filter((r: any) => r.audioRef && (r.correctedText || r.text))
      .map((r: any) => ({ audio: r.audioRef, text: r.correctedText ?? r.text, language: r.language ?? "yi" }));
  }
}
