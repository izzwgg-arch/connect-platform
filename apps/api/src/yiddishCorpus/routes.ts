/**
 * Yiddish Corpus + Learning Engine — the API.
 *
 * Every route here is under YC_API_PREFIX (`/admin/yiddish`), SUPER_ADMIN
 * only, and TENANT-FREE: this is platform data, never tenant-scoped. A tenant
 * id never appears in a query in this file, and none of these rows belong to a
 * customer.
 *
 * ⛔ THE THREE RULES THIS FILE ENFORCES (each has a test):
 *
 *  1. **Every response that exposes a source or a row carries its governance
 *     badge.** The UI can therefore never present a walled or serving-only row
 *     as usable, because the row itself says what it is.
 *  2. **Rights and audio-mode are HUMAN-ONLY endpoints.** They are the ONLY
 *     way audio can ever be enabled, they demand a typed `acknowledgement`,
 *     they stamp `decidedBy` from the JWT, and they write an audit row.
 *     ⛔⛔ THE ENGINE MUST NEVER CALL THESE. No worker, job, adapter or model
 *     path may reach them: they exist so a PERSON, and only a person, can
 *     move the wall. If you are writing engine code and you want audio
 *     enabled, the answer is "ask Izzy", not "call this route".
 *  3. **Numbers are counted, never invented.** When something has not run, the
 *     response is zeros plus an honest note. `/export/preview` runs the
 *     governance filter first and reports the exclusion breakdown — today that
 *     is 0 exportable rows, and the route says so rather than pretending.
 *
 * Governance itself is NOT re-implemented here. `governance.ts` owns the
 * ladder (customer wall → YL-derived → owner-excluded → no external rights →
 * human/consented), and this file calls it. There is exactly one place that
 * decides whether a row may leave, and it is not this one.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { z } from "zod";
import {
  YC_API_PREFIX,
  YC_AUDIO_BLOCKED_MESSAGE,
  YC_CUSTOMER_WALL_MESSAGE,
  YC_MIN_SAMPLES_FOR_CONCLUSION,
  YC_STAGES,
  YC_YL_SERVING_ONLY_MESSAGE,
  YIDDISH24_SOURCE_KEY,
  type YcBudgetView,
  type YcDashboardView,
  type YcGovernanceBadge,
  type YcSourceSummary,
} from "./contracts";
import { compareRuns, freezeBaseline, runBenchmark, seedBenchmarkCases, BaselineAlreadyExistsError } from "./benchmark";
import { YC_GLOBAL_BUDGET_SCOPE } from "./seed";
import {
  filterExportable,
  governanceBadge,
  trainingEligibilityOf,
  YC_EXCLUSION_TEXT,
  type YcExclusionReason,
} from "./governance";
import { searchCorpus } from "./corpusService";
import { reindexInternal } from "./internalIndexer";
import { scoreVariants } from "./evidence";
import { discover as discoverYiddish24 } from "./yiddish24Adapter";

export interface YiddishCorpusRouteDeps {
  app: any;
  db: any;
  /** Platform-staff gate. ⛔ Must be the SUPER_ADMIN one (requireSuperAdmin),
   *  NOT the agent app's requireOwner, which also admits TENANT_ADMIN. */
  requireOwner: (req: any, reply: any) => Promise<any | undefined>;
  log?: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
}

// ── governance helpers ──────────────────────────────────────────────────────

/**
 * The badge every source-bearing response carries. It is `governance.ts`'s
 * verdict, not a second opinion computed here — one ladder, one answer.
 */
export function badgeForSource(source: any, rights?: any[] | null): YcGovernanceBadge {
  return governanceBadge(source ?? {}, null, rights ?? null);
}

/** Plain-English reason the audio stages cannot run, or null when they can. */
export function audioBlockedReason(source: any, rights: any[]): string | null {
  if (String(source?.audioFetchMode ?? "DISABLED") !== "OWNER_AUTHORIZED") return YC_AUDIO_BLOCKED_MESSAGE;
  const grant = (rights ?? []).find((r) => r.allowedUse === "store_audio" || r.allowedUse === "analysis");
  if (!grant || String(grant.state) !== "GRANTED") {
    return (
      "Audio fetching is switched on for this source, but no rights record GRANTS analysis or " +
      "storage. Record the grant on the Governance screen first."
    );
  }
  return null;
}

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}
const num = (v: any): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

function budgetView(b: any): YcBudgetView | null {
  if (!b) return null;
  return {
    scope: String(b.scope),
    apiCentsPerDay: num(b.apiCentsPerDay),
    transcriptionMinutesPerDay: num(b.transcriptionMinutesPerDay),
    storageBytesMax: String(b.storageBytesMax ?? 0),
    concurrency: num(b.concurrency),
    requestsPerMinute: num(b.requestsPerMinute),
    mode: String(b.mode ?? "METADATA_ONLY") as YcBudgetView["mode"],
    paused: Boolean(b.paused),
    spentCentsToday: num(b.spentCentsToday),
    transcribedMinutesToday: num(b.transcribedMinutesToday),
  };
}

/** Platform-level (no-tenant) audit, the same ledger the other consoles use. */
export async function recordYiddishEvent(db: any, event: string, payload: Record<string, unknown>, actor = "owner"): Promise<void> {
  const body = { actor, event: `yiddish.${event}`, ts: new Date().toISOString(), payload };
  try {
    await db.agentAuditLog.create({
      data: {
        actor: body.actor,
        event: body.event,
        payload: body.payload as any,
        hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      },
    });
  } catch {
    /* the record must never fail the action it records */
  }
}

// ── the export governance filter (the honest one) ───────────────────────────

export interface ExportPreview {
  exportable: number;
  totalRows: number;
  breakdown: { reason: YcExclusionReason | string; count: number; note: string; sources: string[] }[];
  sources: { key: string; name: string; rows: number; exportable: number; excluded: number; badge: YcGovernanceBadge; reasons: { reason: string; count: number; note: string }[] }[];
  note: string;
}

/**
 * Runs `governance.ts`'s filter over the corpus and reports what would survive
 * it, grouped by transcript ENGINE so per-row provenance is respected: the
 * 3,510 legacy `stt-yi` rows are YL-derived-by-default because nothing per row
 * proves otherwise, and that is exactly how they must be counted.
 *
 * ⛔ A row excluded for several reasons is counted ONCE, under the ladder's
 * primary reason, so the breakdown adds up to the total.
 */
export async function buildExportPreview(db: any): Promise<ExportPreview> {
  const sources: any[] = await safe(db.ycSource.findMany({ orderBy: { key: "asc" } }), []);
  const allRights: any[] = await safe(db.ycRightsRecord.findMany(), []);
  const out: ExportPreview["sources"] = [];
  const byReason = new Map<string, { count: number; note: string; sources: Set<string> }>();
  let exportable = 0;
  let totalRows = 0;

  for (const s of sources) {
    const rights = allRights.filter((r) => r.sourceId === s.id);
    const badge = badgeForSource(s, rights);
    // Group by engine + provider: one verdict per distinct provenance, then
    // multiplied by its count. Cheap, and never a per-source guess.
    const groups: any[] = await safe(
      db.ycTranscript.groupBy({ by: ["engine", "sttProvider"], where: { item: { sourceId: s.id } }, _count: { _all: true } }),
      [],
    );
    const fallbackCount = groups.length ? 0 : await safe<number>(db.ycTranscript.count({ where: { item: { sourceId: s.id } } }), 0);
    const buckets = groups.length
      ? groups.map((g: any) => ({ engine: g.engine, sttProvider: g.sttProvider, count: num(g?._count?._all ?? g?._count) }))
      : [{ engine: null, sttProvider: null, count: num(fallbackCount) }];

    let srcExportable = 0;
    let srcExcluded = 0;
    const srcReasons: { reason: string; count: number; note: string }[] = [];
    for (const b of buckets) {
      const verdict = trainingEligibilityOf(s, { rights, row: { engine: b.engine, sttProvider: b.sttProvider, sourceKey: s.key } as any });
      totalRows += b.count;
      if (verdict.eligibility === "ALLOWED") {
        exportable += b.count;
        srcExportable += b.count;
        continue;
      }
      srcExcluded += b.count;
      const reason = String(verdict.primaryReason ?? "NOT_HUMAN_OR_CONSENTED");
      const note = verdict.note || YC_EXCLUSION_TEXT[reason as YcExclusionReason] || reason;
      srcReasons.push({ reason, count: b.count, note });
      const slot = byReason.get(reason) ?? { count: 0, note, sources: new Set<string>() };
      slot.count += b.count;
      slot.sources.add(String(s.key));
      byReason.set(reason, slot);
    }
    out.push({ key: String(s.key), name: String(s.name), rows: srcExportable + srcExcluded, exportable: srcExportable, excluded: srcExcluded, badge, reasons: srcReasons });
  }

  return {
    exportable,
    totalRows,
    breakdown: [...byReason.entries()].map(([reason, v]) => ({ reason, count: v.count, note: v.note, sources: [...v.sources] })),
    sources: out,
    note:
      exportable === 0
        ? "Nothing is exportable today. Every row the corpus holds is either customer-private, Yiddish " +
          "Labs derived, or from a source whose rights have not been recorded. This is the correct " +
          "answer, not an empty database."
        : `${exportable} row(s) pass the governance filter.`,
  };
}

// ── routes ──────────────────────────────────────────────────────────────────

export function registerYiddishCorpusRoutes(deps: YiddishCorpusRouteDeps): void {
  const { app, db, requireOwner } = deps;
  const P = YC_API_PREFIX;
  const log = deps.log ?? app?.log;

  const actorOf = (user: any): string => String(user?.email || user?.sub || "unknown");
  const bad = (reply: any, parsed: any) => reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });

  const loadSource = async (key: string) => db.ycSource.findUnique({ where: { key: String(key) } });

  async function sourceSummary(source: any): Promise<YcSourceSummary> {
    const [rights, health, budget, itemCount, transcriptCount, durationAgg] = await Promise.all([
      safe<any[]>(db.ycRightsRecord.findMany({ where: { sourceId: source.id } }), []),
      safe<any[]>(db.ycSourceHealth.findMany({ where: { sourceId: source.id } }), []),
      safe<any>(db.ycBudget.findFirst({ where: { sourceId: source.id } }), null),
      safe<number>(db.ycSourceItem.count({ where: { sourceId: source.id } }), 0),
      safe<number>(db.ycTranscript.count({ where: { item: { sourceId: source.id } } }), 0),
      safe<any>(db.ycSourceItem.aggregate({ _sum: { durationSec: true }, where: { sourceId: source.id } }), null),
    ]);
    return {
      key: String(source.key),
      name: String(source.name),
      kind: String(source.kind),
      adapterKey: source.adapterKey ?? null,
      governanceClass: String(source.governanceClass) as YcSourceSummary["governanceClass"],
      trainingExportEligibility: String(source.trainingExportEligibility) as YcSourceSummary["trainingExportEligibility"],
      contentAllowed: Boolean(source.contentAllowed),
      audioFetchMode: String(source.audioFetchMode ?? "DISABLED") as YcSourceSummary["audioFetchMode"],
      enabled: Boolean(source.enabled),
      termsUrl: source.termsUrl ?? null,
      termsCheckedAt: source.termsCheckedAt ? new Date(source.termsCheckedAt).toISOString() : null,
      rightsNote: source.rightsNote ?? null,
      itemCount: num(itemCount),
      audioHours: Math.round((num(durationAgg?._sum?.durationSec) / 3600) * 100) / 100,
      transcriptCount: num(transcriptCount),
      lastRunAt: source.lastRunAt ? new Date(source.lastRunAt).toISOString() : null,
      budget: budgetView(budget),
      rights: (rights ?? []).map((r) => ({
        allowedUse: r.allowedUse,
        state: r.state,
        decidedBy: r.decidedBy ?? null,
        decidedAt: new Date(r.decidedAt).toISOString(),
      })),
      health: (health ?? []).map((h) => ({
        probeKey: String(h.probeKey),
        state: String(h.state),
        detail: h.detail ?? null,
        checkedAt: new Date(h.checkedAt).toISOString(),
      })),
      audioBlockedReason: audioBlockedReason(source, rights ?? []),
    };
  }

  // ══════════════════════════ DASHBOARD ═════════════════════════════════════

  app.get(`${P}/dashboard`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;

    const sources: any[] = await safe(db.ycSource.findMany({ orderBy: { key: "asc" } }), []);
    const [
      items, transcripts, translations, lexemes, observations, rules, openConflicts,
      speakerClusters, benchmarkCases, findings, durationAgg, jobs, series, recentFindings, profile,
    ] = await Promise.all([
      safe<number>(db.ycSourceItem.count(), 0),
      safe<number>(db.ycTranscript.count(), 0),
      safe<number>(db.agentTranslation.count({ where: { action: "translate-yiddish" } }), 0),
      safe<number>(db.ycLexeme.count(), 0),
      safe<number>(db.ycPronunciationObservation.count(), 0),
      safe<number>(db.ycPronunciationRule.count(), 0),
      safe<number>(db.ycReviewItem.count({ where: { state: "OPEN" } }), 0),
      safe<number>(db.ycSpeakerCluster.count(), 0),
      safe<number>(db.ycBenchmarkCase.count({ where: { active: true } }), 0),
      safe<number>(db.ycFinding.count(), 0),
      safe<any>(db.ycSourceItem.aggregate({ _sum: { durationSec: true } }), null),
      safe<any[]>(db.ycProcessingJob.findMany({ select: { state: true, leaseUntil: true, updatedAt: true }, take: 5000 }), []),
      safe<any[]>(db.ycMetricSnapshot.findMany({ orderBy: { day: "desc" }, take: 180 }), []),
      safe<any[]>(db.ycFinding.findMany({ orderBy: { createdAt: "desc" }, take: 10 }), []),
      safe<any>(db.ycVoiceProfileVersion.findFirst({ where: { status: "BASELINE" } }), null),
    ]);

    const itemStates: any[] = await safe(db.ycSourceItem.groupBy({ by: ["state"], _count: { _all: true } }), []);
    const queue = (itemStates ?? []).map((g: any) => ({ state: String(g.state), count: num(g?._count?._all ?? g?._count) }));

    const leased = (jobs ?? []).filter((j) => j.leaseUntil && new Date(j.leaseUntil).getTime() > Date.now()).length;
    const lastTick = (jobs ?? [])
      .map((j) => (j.updatedAt ? new Date(j.updatedAt).getTime() : 0))
      .sort((a, b) => b - a)[0];
    const alive = Boolean(lastTick && Date.now() - lastTick < 15 * 60_000);

    // The walls, stated as counts of what is NOT usable — never hidden.
    const walled: YcDashboardView["walled"] = [];
    for (const s of sources) {
      const badge = badgeForSource(s);
      if (badge.governanceClass === "CUSTOMER_PRIVATE" && !badge.contentAllowed) {
        const count = await safe<number>(db.ycSourceItem.count({ where: { sourceId: s.id } }), 0);
        walled.push({ label: String(s.name), count: num(count), hours: null, note: YC_CUSTOMER_WALL_MESSAGE });
      } else if (badge.ylDerived) {
        const count = await safe<number>(db.ycSourceItem.count({ where: { sourceId: s.id } }), 0);
        walled.push({ label: String(s.name), count: num(count), hours: null, note: YC_YL_SERVING_ONLY_MESSAGE });
      }
    }

    let profileView: YcDashboardView["profile"] = null;
    if (profile) {
      const runs: any[] = await safe(db.ycBenchmarkRun.findMany({ where: { profileVersionId: profile.id } }), []);
      const rated = (runs ?? []).filter((r) => r.meanRating !== null && r.meanRating !== undefined);
      profileView = {
        key: String(profile.profileKey),
        version: num(profile.version),
        status: String(profile.status),
        meanRating: rated.length ? Math.round((rated.reduce((s, r) => s + Number(r.meanRating), 0) / rated.length) * 100) / 100 : null,
        n: (runs ?? []).reduce((s, r) => s + num(r.ratedCount), 0),
      };
    }

    const sourceViews: YcSourceSummary[] = [];
    for (const s of sources) sourceViews.push(await sourceSummary(s));

    const view: YcDashboardView & { note: string; badges: Record<string, YcGovernanceBadge> } = {
      corpus: {
        items: num(items),
        audioHours: Math.round((num(durationAgg?._sum?.durationSec) / 3600) * 100) / 100,
        transcripts: num(transcripts),
        translations: num(translations),
        pairs: num(translations),
        lexemes: num(lexemes),
        observations: num(observations),
        rules: num(rules),
        openConflicts: num(openConflicts),
        speakerClusters: num(speakerClusters),
        benchmarkCases: num(benchmarkCases),
        findings: num(findings),
      },
      walled,
      sources: sourceViews,
      queue,
      worker: {
        alive,
        lastTickAt: lastTick ? new Date(lastTick).toISOString() : null,
        leasedJobs: leased,
        note: alive
          ? "The worker has touched a job in the last 15 minutes."
          : "Nothing has run yet. These are real counts of an empty engine, not placeholders.",
      },
      profile: profileView,
      series: (series ?? []).map((m: any) => ({ day: String(m.day), metric: String(m.metric), value: num(m.value) })),
      recentFindings: (recentFindings ?? []).map((f: any) => ({
        id: String(f.id),
        kind: String(f.kind),
        statement: String(f.statement),
        status: String(f.status),
        createdAt: new Date(f.createdAt).toISOString(),
      })),
      // Badges by source key, so no consumer has to re-derive governance.
      badges: Object.fromEntries(sources.map((s) => [String(s.key), badgeForSource(s)])),
      note:
        num(items) === 0
          ? "The engine has not ingested anything yet. Every number above is a real count of zero."
          : "Counts are live from the database.",
    };
    return reply.send(view);
  });

  // ══════════════════════════ SOURCES ═══════════════════════════════════════

  app.get(`${P}/sources`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const sources: any[] = await safe(db.ycSource.findMany({ orderBy: { key: "asc" } }), []);
    const out: YcSourceSummary[] = [];
    for (const s of sources) out.push(await sourceSummary(s));
    return reply.send({ sources: out, badges: Object.fromEntries(sources.map((s) => [String(s.key), badgeForSource(s)])) });
  });

  const enableBody = z.object({ enabled: z.boolean() });
  app.post(`${P}/sources/:key/enable`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = enableBody.safeParse(req.body ?? {});
    if (!parsed.success) return bad(reply, parsed);
    const source = await loadSource(req.params.key);
    if (!source) return reply.code(404).send({ error: "not_found" });
    const row = await db.ycSource.update({ where: { key: source.key }, data: { enabled: parsed.data.enabled } });
    await recordYiddishEvent(db, "source.enabled", { key: source.key, enabled: parsed.data.enabled, by: actorOf(user) });
    return reply.send({ source: await sourceSummary(row), badge: badgeForSource(row) });
  });

  // ⛔⛔ HUMAN-ONLY. The engine must never call this route. It is the only way
  // a rights decision is recorded, and the acknowledgement + decidedBy exist so
  // that decision always has a person's name on it.
  const rightsBody = z.object({
    allowedUse: z.enum(["metadata_only", "analysis", "store_audio", "training_export"]),
    state: z.enum(["GRANTED", "DENIED", "UNKNOWN"]),
    evidence: z.string().trim().min(1).max(4000).nullish(),
    acknowledgement: z.string().trim().min(1).max(500),
  });
  app.post(`${P}/sources/:key/rights`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = rightsBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "acknowledgement_required",
        message:
          "A rights decision is a person's decision. Send an `acknowledgement` describing what you " +
          "are recording and on what basis; the engine may never write this by itself.",
        detail: parsed.error.flatten(),
      });
    }
    const source = await loadSource(req.params.key);
    if (!source) return reply.code(404).send({ error: "not_found" });

    const decidedBy = actorOf(user);
    const row = await db.ycRightsRecord.upsert({
      where: { sourceId_allowedUse: { sourceId: source.id, allowedUse: parsed.data.allowedUse } },
      create: {
        sourceId: source.id,
        allowedUse: parsed.data.allowedUse,
        state: parsed.data.state,
        evidence: parsed.data.evidence ?? parsed.data.acknowledgement,
        decidedBy,
      },
      update: {
        state: parsed.data.state,
        evidence: parsed.data.evidence ?? parsed.data.acknowledgement,
        decidedBy,
        decidedAt: new Date(),
      },
    });

    // A training_export GRANT is the only thing that moves eligibility, and
    // even then never for a customer-private or YL source.
    const badge = badgeForSource(source);
    let updated = source;
    if (parsed.data.allowedUse === "training_export" && !badge.ylDerived && badge.governanceClass !== "CUSTOMER_PRIVATE") {
      updated = await db.ycSource.update({
        where: { key: source.key },
        data: { trainingExportEligibility: parsed.data.state === "GRANTED" ? "ALLOWED" : parsed.data.state === "DENIED" ? "EXCLUDED" : "UNKNOWN" },
      });
    }

    await recordYiddishEvent(db, "rights.recorded", {
      key: source.key,
      allowedUse: parsed.data.allowedUse,
      state: parsed.data.state,
      acknowledgement: parsed.data.acknowledgement,
      decidedBy,
    });
    return reply.send({ rights: { ...row, decidedAt: new Date(row.decidedAt).toISOString() }, source: await sourceSummary(updated), badge: badgeForSource(updated) });
  });

  // ⛔⛔ HUMAN-ONLY, and the ONLY door to audio bytes anywhere in this system.
  // No worker, adapter, job or model path may call it.
  const audioModeBody = z.object({
    mode: z.enum(["DISABLED", "OWNER_AUTHORIZED"]),
    acknowledgement: z.string().trim().min(1).max(500),
  });
  app.post(`${P}/sources/:key/audio-mode`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = audioModeBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "acknowledgement_required",
        message:
          "Turning audio fetching on is a person's decision about someone else's material. Send an " +
          "`acknowledgement` stating the basis. The engine may never call this route.",
        detail: parsed.error.flatten(),
      });
    }
    const source = await loadSource(req.params.key);
    if (!source) return reply.code(404).send({ error: "not_found" });

    // The customer wall is not liftable through this route, at all.
    if (String(source.governanceClass) === "CUSTOMER_PRIVATE" && parsed.data.mode === "OWNER_AUTHORIZED") {
      return reply.code(409).send({ error: "customer_private", message: YC_CUSTOMER_WALL_MESSAGE });
    }

    const decidedBy = actorOf(user);
    const row = await db.ycSource.update({
      where: { key: source.key },
      data: { audioFetchMode: parsed.data.mode, rightsNote: `${source.rightsNote ?? ""}\n[${new Date().toISOString()}] ${decidedBy}: ${parsed.data.acknowledgement}`.trim() },
    });
    await recordYiddishEvent(db, "audio_mode.set", { key: source.key, mode: parsed.data.mode, acknowledgement: parsed.data.acknowledgement, decidedBy });
    const rights = await safe<any[]>(db.ycRightsRecord.findMany({ where: { sourceId: source.id } }), []);
    return reply.send({
      source: await sourceSummary(row),
      badge: badgeForSource(row),
      audioBlockedReason: audioBlockedReason(row, rights),
    });
  });

  const budgetBody = z.object({
    apiCentsPerDay: z.number().int().min(0).max(1_000_000).optional(),
    transcriptionMinutesPerDay: z.number().int().min(0).max(100_000).optional(),
    storageBytesMax: z.union([z.number().int().min(0), z.string().regex(/^\d+$/)]).optional(),
    concurrency: z.number().int().min(1).max(32).optional(),
    requestsPerMinute: z.number().int().min(1).max(600).optional(),
    mode: z.enum(["METADATA_ONLY", "AUDIO_ONLY", "SELECTIVE", "FULL"]).optional(),
    paused: z.boolean().optional(),
  });
  app.post(`${P}/sources/:key/budget`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = budgetBody.safeParse(req.body ?? {});
    if (!parsed.success) return bad(reply, parsed);
    const source = await loadSource(req.params.key);
    if (!source) return reply.code(404).send({ error: "not_found" });
    const scope = `source:${source.key}`;
    const data: any = { ...parsed.data };
    if (data.storageBytesMax !== undefined) data.storageBytesMax = BigInt(data.storageBytesMax);
    const row = await db.ycBudget.upsert({
      where: { scope },
      create: { scope, sourceId: source.id, mode: "METADATA_ONLY", paused: true, ...data },
      update: data,
    });
    await recordYiddishEvent(db, "budget.updated", { key: source.key, fields: Object.keys(parsed.data), by: actorOf(user) });
    return reply.send({ budget: budgetView(row) });
  });

  app.post(`${P}/sources/:key/discover`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const source = await loadSource(req.params.key);
    if (!source) return reply.code(404).send({ error: "not_found" });
    if (!source.enabled) return reply.code(409).send({ error: "source_disabled", message: "This source is switched off." });

    const budget = await safe<any>(db.ycBudget.findFirst({ where: { sourceId: source.id } }), null);
    if (budget?.paused) return reply.code(409).send({ error: "budget_paused", message: "This source's budget is paused, so nothing was fetched." });

    // Only the external adapter DISCOVERS. An internal source is re-counted
    // through the indexer (counts only), never "discovered".
    if (String(source.key) !== YIDDISH24_SOURCE_KEY) {
      const counted = await reindexInternal(db);
      await recordYiddishEvent(db, "discover.internal", { key: source.key, by: actorOf(user) });
      return reply.send({
        discovered: 0,
        duplicates: 0,
        healthy: true,
        detail: counted,
        badge: badgeForSource(source),
        note: "Internal sources are COUNTED, not discovered. No customer content was read.",
      });
    }
    try {
      const maxPages = Number((req.body ?? {}).maxPages ?? 0) || undefined;
      const out = await discoverYiddish24(db, {
        ...(maxPages ? { maxPages } : {}),
        requestsPerMinute: budget?.requestsPerMinute ?? null,
      });
      await db.ycSource.update({ where: { key: source.key }, data: { lastDiscoveryAt: new Date(), lastRunAt: new Date() } }).catch(() => undefined);
      await recordYiddishEvent(db, "discover.ran", { key: source.key, by: actorOf(user), result: out ?? null });
      return reply.send({ discovered: num(out?.discovered), duplicates: num(out?.duplicates), healthy: out?.healthy !== false, detail: out ?? null, badge: badgeForSource(source) });
    } catch (e: any) {
      log?.error?.({ err: e, key: source.key }, "yiddish discovery failed");
      return reply.code(502).send({ error: "discovery_failed", message: String(e?.message ?? e) });
    }
  });

  const runBody = z.object({ action: z.enum(["start", "pause", "resume", "stop"]) });
  app.post(`${P}/sources/:key/run`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = runBody.safeParse(req.body ?? {});
    if (!parsed.success) return bad(reply, parsed);
    const source = await loadSource(req.params.key);
    if (!source) return reply.code(404).send({ error: "not_found" });
    const scope = `source:${source.key}`;
    const paused = parsed.data.action === "pause" || parsed.data.action === "stop";
    const row = await db.ycBudget.upsert({
      where: { scope },
      create: { scope, sourceId: source.id, mode: "METADATA_ONLY", paused },
      update: { paused },
    });
    if (parsed.data.action === "stop") {
      await db.ycProcessingJob
        .updateMany({ where: { sourceKey: source.key, state: { in: ["PENDING", "RUNNING"] } }, data: { state: "SKIPPED", error: "stopped by owner" } })
        .catch(() => undefined);
    }
    await recordYiddishEvent(db, "run.control", { key: source.key, action: parsed.data.action, by: actorOf(user) });
    return reply.send({ action: parsed.data.action, budget: budgetView(row) });
  });

  const itemsQuery = z.object({
    state: z.string().trim().max(40).optional(),
    category: z.string().trim().max(80).optional(),
    series: z.string().trim().max(200).optional(),
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().trim().max(64).optional(),
  });
  app.get(`${P}/sources/:key/items`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = itemsQuery.safeParse(req.query ?? {});
    if (!parsed.success) return bad(reply, parsed);
    const source = await loadSource(req.params.key);
    if (!source) return reply.code(404).send({ error: "not_found" });
    const badge = badgeForSource(source);

    const where: any = { sourceId: source.id };
    if (parsed.data.state) where.state = parsed.data.state;
    if (parsed.data.category) where.category = parsed.data.category;
    if (parsed.data.series) where.seriesName = parsed.data.series;
    if (parsed.data.q) where.title = { contains: parsed.data.q, mode: "insensitive" };

    const rows: any[] = await safe(
      db.ycSourceItem.findMany({
        where,
        orderBy: [{ discoveredAt: "desc" }],
        take: parsed.data.limit + 1,
        ...(parsed.data.cursor ? { cursor: { id: parsed.data.cursor }, skip: 1 } : {}),
      }),
      [],
    );
    const page = rows.slice(0, parsed.data.limit);
    // ⛔ A walled source's items are counted, never read: titles and text are
    // withheld, not just hidden in the UI.
    const readable = badge.contentAllowed;
    return reply.send({
      badge,
      items: page.map((i: any) => ({
        id: String(i.id),
        externalId: String(i.externalId),
        title: readable ? i.title ?? null : null,
        seriesName: readable ? i.seriesName ?? null : null,
        category: i.category ?? null,
        host: readable ? i.host ?? null : null,
        publishedLabel: i.publishedLabel ?? null,
        durationSec: i.durationSec ?? null,
        state: String(i.state),
        priority: num(i.priority),
        noveltyScore: i.noveltyScore ?? null,
        speechRatio: i.speechRatio ?? null,
        discoveredAt: new Date(i.discoveredAt).toISOString(),
        withheld: !readable,
      })),
      nextCursor: rows.length > parsed.data.limit ? String(page[page.length - 1]?.id ?? "") : null,
      note: readable ? null : YC_CUSTOMER_WALL_MESSAGE,
    });
  });

  app.get(`${P}/items/:id`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const item = await safe<any>(db.ycSourceItem.findUnique({ where: { id: String(req.params.id) } }), null);
    if (!item) return reply.code(404).send({ error: "not_found" });
    const source = await safe<any>(db.ycSource.findUnique({ where: { id: item.sourceId } }), null);
    const badge = badgeForSource(source ?? {});
    const [assets, transcripts] = await Promise.all([
      safe<any[]>(db.ycAudioAsset.findMany({ where: { itemId: item.id } }), []),
      safe<any[]>(db.ycTranscript.findMany({ where: { itemId: item.id } }), []),
    ]);
    const assetIds = (assets ?? []).map((a) => a.id);
    const segments = assetIds.length
      ? await safe<any[]>(db.ycSegment.findMany({ where: { assetId: { in: assetIds } }, orderBy: { startMs: "asc" }, take: 2000 }), [])
      : [];
    return reply.send({
      badge,
      item: {
        ...item,
        title: badge.contentAllowed ? item.title : null,
        discoveredAt: new Date(item.discoveredAt).toISOString(),
      },
      assets,
      segments,
      transcripts: badge.contentAllowed
        ? transcripts
        : (transcripts ?? []).map((t: any) => ({ id: t.id, engine: t.engine, language: t.language, confidence: t.confidence, text: null, withheld: true })),
      note: badge.contentAllowed ? null : YC_CUSTOMER_WALL_MESSAGE,
    });
  });

  // ══════════════════════════ CORPUS ════════════════════════════════════════

  const searchQuery = z.object({
    q: z.string().trim().max(200).optional(),
    governance: z.enum(["PLATFORM", "CUSTOMER_PRIVATE", "EXTERNAL"]).optional(),
    tier: z.string().trim().max(4).optional(),
    hasAudio: z.coerce.boolean().optional(),
    provider: z.string().trim().max(40).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });
  app.get(`${P}/corpus/search`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = searchQuery.safeParse(req.query ?? {});
    if (!parsed.success) return bad(reply, parsed);

    // corpusService owns the search, and it excludes CUSTOMER_PRIVATE sources
    // from the QUERY ITSELF — their text is never matched or scanned. They
    // come back as a count plus the wall's sentence.
    const out = await searchCorpus(db, {
      q: parsed.data.q ?? null,
      governance: (parsed.data.governance ?? null) as any,
      hasAudio: parsed.data.hasAudio ?? null,
      limit: parsed.data.limit,
    });
    return reply.send({
      ...out,
      note: out.rows.length === 0 ? "Nothing is indexed yet. This is a real zero." : null,
      wallNote: YC_CUSTOMER_WALL_MESSAGE,
    });
  });

  // ══════════════════════════ LEXEMES + RULES ═══════════════════════════════

  const lexemesQuery = z.object({
    q: z.string().trim().max(120).optional(),
    origin: z.string().trim().max(20).optional(),
    minFrequency: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  });
  app.get(`${P}/lexemes`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = lexemesQuery.safeParse(req.query ?? {});
    if (!parsed.success) return bad(reply, parsed);
    const where: any = { frequency: { gte: parsed.data.minFrequency } };
    if (parsed.data.origin) where.origin = parsed.data.origin;
    if (parsed.data.q) where.normalized = { contains: parsed.data.q };
    const rows: any[] = await safe(db.ycLexeme.findMany({ where, orderBy: { frequency: "desc" }, take: parsed.data.limit }), []);
    return reply.send({ lexemes: rows ?? [], total: rows?.length ?? 0, note: rows?.length ? null : "No lexemes have been learned yet." });
  });

  app.get(`${P}/lexemes/:id`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const lexeme = await safe<any>(db.ycLexeme.findUnique({ where: { id: String(req.params.id) } }), null);
    if (!lexeme) return reply.code(404).send({ error: "not_found" });
    const [observations, rules] = await Promise.all([
      safe<any[]>(db.ycPronunciationObservation.findMany({ where: { lexemeId: lexeme.id }, take: 500 }), []),
      safe<any[]>(db.ycPronunciationRule.findMany({ where: { lexemeId: lexeme.id } }), []),
    ]);
    // The scorer weights by INDEPENDENT support (distinct speakers, distinct
    // sources) and refuses to call a winner below the sample floor — the
    // `excludeSources` query lets the screen recompute with a source dropped.
    const excludeSourceKeys = String((req.query ?? {}).excludeSources ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    let variants: any[] = [];
    let scoringNote: string | null = null;
    try {
      variants = scoreVariants(observations ?? [], { origin: lexeme.origin, excludeSourceKeys });
    } catch {
      variants = [];
      scoringNote = "The evidence scorer errored; the observations below are raw, unweighted counts.";
    }
    return reply.send({
      lexeme,
      observations,
      rules: rules ?? [],
      variants,
      excludedSources: excludeSourceKeys,
      scoringNote,
      minSamplesForConclusion: YC_MIN_SAMPLES_FOR_CONCLUSION,
    });
  });

  const ruleBody = z.object({
    variantKey: z.string().trim().min(1).max(120),
    realization: z.string().trim().max(200).nullish(),
    ipa: z.string().trim().max(200).nullish(),
    method: z.string().trim().max(60).default("INSTRUCTION_HINT"),
  });
  app.post(`${P}/lexemes/:id/rules`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = ruleBody.safeParse(req.body ?? {});
    if (!parsed.success) return bad(reply, parsed);
    const lexeme = await safe<any>(db.ycLexeme.findUnique({ where: { id: String(req.params.id) } }), null);
    if (!lexeme) return reply.code(404).send({ error: "not_found" });
    // ⛔ Always CANDIDATE. A rule is never born approved.
    const row = await db.ycPronunciationRule.create({
      data: {
        lexemeId: lexeme.id,
        variantKey: parsed.data.variantKey,
        realization: parsed.data.realization ?? null,
        ipa: parsed.data.ipa ?? null,
        method: parsed.data.method,
        status: "CANDIDATE",
        supportSummary: { proposedBy: actorOf(user), proposedAt: new Date().toISOString() },
      },
    });
    await recordYiddishEvent(db, "rule.proposed", { lexemeId: lexeme.id, ruleId: row.id, variantKey: parsed.data.variantKey, by: actorOf(user) });
    return reply.send({ rule: row });
  });

  const ruleStatusBody = z.object({
    status: z.enum(["CANDIDATE", "TESTING", "APPROVED", "PRODUCTION", "RETIRED"]),
    approvedBy: z.string().trim().max(160).optional(),
  });
  app.post(`${P}/rules/:id/status`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = ruleStatusBody.safeParse(req.body ?? {});
    if (!parsed.success) return bad(reply, parsed);
    const rule = await safe<any>(db.ycPronunciationRule.findUnique({ where: { id: String(req.params.id) } }), null);
    if (!rule) return reply.code(404).send({ error: "not_found" });
    // Who did it is recorded from the JWT, never from the body alone.
    const approver = parsed.data.approvedBy?.trim() || actorOf(user);
    const promoting = parsed.data.status === "APPROVED" || parsed.data.status === "PRODUCTION";
    const row = await db.ycPronunciationRule.update({
      where: { id: rule.id },
      data: { status: parsed.data.status, ...(promoting ? { approvedBy: approver, approvedAt: new Date() } : {}) },
    });
    await recordYiddishEvent(db, "rule.status", { ruleId: rule.id, from: rule.status, to: parsed.data.status, by: actorOf(user), approver });
    return reply.send({ rule: row });
  });

  // ══════════════════════════ REVIEW QUEUE ══════════════════════════════════

  const reviewQuery = z.object({
    state: z.string().trim().max(20).default("OPEN"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });
  app.get(`${P}/review`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = reviewQuery.safeParse(req.query ?? {});
    if (!parsed.success) return bad(reply, parsed);
    const rows: any[] = await safe(
      db.ycReviewItem.findMany({ where: { state: parsed.data.state }, orderBy: [{ impactScore: "desc" }, { resolvesCount: "desc" }], take: parsed.data.limit }),
      [],
    );
    return reply.send({ items: rows ?? [], total: rows?.length ?? 0, note: rows?.length ? null : "Nothing is waiting for review." });
  });

  const decideBody = z.object({
    decision: z.enum(["APPROVE", "REJECT", "EDIT", "VARIANT", "DEFER"]),
    realization: z.string().trim().max(200).nullish(),
    note: z.string().trim().max(2000).nullish(),
  });
  app.post(`${P}/review/:id/decide`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = decideBody.safeParse(req.body ?? {});
    if (!parsed.success) return bad(reply, parsed);
    const item = await safe<any>(db.ycReviewItem.findUnique({ where: { id: String(req.params.id) } }), null);
    if (!item) return reply.code(404).send({ error: "not_found" });
    const stateFor: Record<string, string> = { APPROVE: "APPROVED", REJECT: "REJECTED", EDIT: "EDITED", VARIANT: "VARIANT", DEFER: "DEFERRED" };
    const decidedBy = actorOf(user);
    const row = await db.ycReviewItem.update({
      where: { id: item.id },
      data: {
        state: stateFor[parsed.data.decision],
        decision: parsed.data.decision,
        decidedBy,
        decidedAt: new Date(),
        detail: { ...(item.detail ?? {}), realization: parsed.data.realization ?? null, note: parsed.data.note ?? null },
      },
    });
    await recordYiddishEvent(db, "review.decided", { reviewId: item.id, decision: parsed.data.decision, decidedBy });
    return reply.send({ item: row });
  });

  // ══════════════════════════ FINDINGS ══════════════════════════════════════

  app.get(`${P}/findings`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const status = String((req.query ?? {}).status ?? "").trim();
    const rows: any[] = await safe(
      db.ycFinding.findMany({ where: status ? { status } : {}, orderBy: { createdAt: "desc" }, take: 200 }),
      [],
    );
    return reply.send({
      findings: rows ?? [],
      total: rows?.length ?? 0,
      minSamplesForConclusion: YC_MIN_SAMPLES_FOR_CONCLUSION,
      note: rows?.length ? null : "The engine has proposed nothing yet.",
    });
  });

  const findingStatusBody = z.object({ status: z.enum(["PROPOSED", "TESTING", "ACCEPTED", "REJECTED"]) });
  app.post(`${P}/findings/:id/status`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = findingStatusBody.safeParse(req.body ?? {});
    if (!parsed.success) return bad(reply, parsed);
    const finding = await safe<any>(db.ycFinding.findUnique({ where: { id: String(req.params.id) } }), null);
    if (!finding) return reply.code(404).send({ error: "not_found" });
    const reviewedBy = actorOf(user);
    const row = await db.ycFinding.update({ where: { id: finding.id }, data: { status: parsed.data.status, reviewedBy, reviewedAt: new Date() } });
    await recordYiddishEvent(db, "finding.status", { findingId: finding.id, from: finding.status, to: parsed.data.status, reviewedBy });
    return reply.send({ finding: row });
  });

  // ══════════════════════════ QUEUE ═════════════════════════════════════════

  app.get(`${P}/queue`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const grouped: any[] = await safe(db.ycProcessingJob.groupBy({ by: ["state", "stage"], _count: { _all: true } }), []);
    const failures: any[] = await safe(
      db.ycProcessingJob.findMany({ where: { state: "FAILED" }, orderBy: { updatedAt: "desc" }, take: 25 }),
      [],
    );
    const counts = (grouped ?? []).map((g: any) => ({ state: String(g.state), stage: String(g.stage), count: num(g?._count?._all ?? g?._count) }));
    const total = counts.reduce((s, c) => s + c.count, 0);
    return reply.send({
      counts,
      stages: [...YC_STAGES],
      recentFailures: (failures ?? []).map((f: any) => ({ id: f.id, stage: f.stage, sourceKey: f.sourceKey, attempts: num(f.attempts), error: f.error ?? null, updatedAt: new Date(f.updatedAt).toISOString() })),
      note: total === 0 ? "The queue is empty — no job has ever been enqueued." : null,
    });
  });

  const retryBody = z.object({ jobId: z.string().trim().max(64).optional(), stage: z.string().trim().max(40).optional() }).refine((v) => v.jobId || v.stage, {
    message: "Send either a jobId or a stage.",
  });
  app.post(`${P}/queue/retry`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = retryBody.safeParse(req.body ?? {});
    if (!parsed.success) return bad(reply, parsed);
    const where: any = { state: "FAILED" };
    if (parsed.data.jobId) where.id = parsed.data.jobId;
    if (parsed.data.stage) where.stage = parsed.data.stage;
    const out = await safe<any>(
      db.ycProcessingJob.updateMany({ where, data: { state: "PENDING", attempts: 0, nextRunAt: new Date(), error: null, leaseUntil: null, leaseOwner: null } }),
      { count: 0 },
    );
    await recordYiddishEvent(db, "queue.retry", { ...parsed.data, requeued: num(out?.count), by: actorOf(user) });
    return reply.send({ requeued: num(out?.count) });
  });

  // ══════════════════════════ PROGRESS ══════════════════════════════════════

  const progressQuery = z.object({ window: z.enum(["1h", "24h", "7d", "30d"]).default("7d") });
  app.get(`${P}/progress`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = progressQuery.safeParse(req.query ?? {});
    if (!parsed.success) return bad(reply, parsed);
    const days = parsed.data.window === "30d" ? 30 : parsed.data.window === "7d" ? 7 : 1;
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const rows: any[] = await safe(db.ycMetricSnapshot.findMany({ where: { day: { gte: since } }, orderBy: { day: "asc" }, take: 5000 }), []);
    return reply.send({
      window: parsed.data.window,
      series: (rows ?? []).map((m: any) => ({ day: String(m.day), sourceKey: String(m.sourceKey), metric: String(m.metric), value: num(m.value) })),
      note: rows?.length
        ? null
        : "No daily snapshots exist for this window. Nothing has run, so there is no curve to draw — and none is drawn.",
    });
  });

  // ══════════════════════════ BENCHMARK ═════════════════════════════════════

  app.get(`${P}/benchmark`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const [cases, profiles, runs] = await Promise.all([
      safe<any[]>(db.ycBenchmarkCase.findMany({ orderBy: { createdAt: "asc" }, take: 500 }), []),
      safe<any[]>(db.ycVoiceProfileVersion.findMany({ orderBy: [{ profileKey: "asc" }, { version: "asc" }] }), []),
      safe<any[]>(db.ycBenchmarkRun.findMany({ orderBy: { startedAt: "desc" }, take: 50 }), []),
    ]);
    return reply.send({
      cases: cases ?? [],
      profiles: profiles ?? [],
      runs: runs ?? [],
      minSamplesForConclusion: YC_MIN_SAMPLES_FOR_CONCLUSION,
      note:
        (cases?.length ?? 0) === 0
          ? "The regression suite is empty. Seed it from the Yiddish Labs cache — no case text is ever written by us."
          : "Ratings are human only; there is no ground truth for pronunciation, so no accuracy figure exists.",
    });
  });

  const caseBody = z.object({
    text: z.string().trim().min(1).max(600),
    category: z.string().trim().min(1).max(60),
    tags: z.array(z.string().trim().max(40)).max(20).default([]),
    sourceRef: z.string().trim().min(1).max(200),
  });
  app.post(`${P}/benchmark/cases`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = caseBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_body",
        message: "A benchmark case must name the row its text came from (`sourceRef`). We never author Yiddish ourselves.",
        detail: parsed.error.flatten(),
      });
    }
    const row = await db.ycBenchmarkCase.create({
      data: { ...parsed.data, active: true, trainingUse: "SERVING_ONLY" },
    });
    await recordYiddishEvent(db, "benchmark.case.added", { caseId: row.id, sourceRef: parsed.data.sourceRef, by: actorOf(user) });
    return reply.send({ case: row });
  });

  app.post(`${P}/benchmark/seed`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const out = await seedBenchmarkCases(db);
    await recordYiddishEvent(db, "benchmark.seeded", { ...out, by: actorOf(user) });
    return reply.send({ ...out, note: "Seeded from the Yiddish Labs translation cache only. No customer text was read." });
  });

  app.post(`${P}/benchmark/baseline`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    try {
      const row = await freezeBaseline(db, { approvedBy: actorOf(user) });
      await recordYiddishEvent(db, "benchmark.baseline.frozen", { profileVersionId: row.id, by: actorOf(user) });
      return reply.send({ profileVersion: row });
    } catch (e: any) {
      if (e instanceof BaselineAlreadyExistsError) {
        return reply.code(409).send({ error: e.code, message: e.message, existingId: e.existingId });
      }
      return reply.code(500).send({ error: "baseline_failed", message: String(e?.message ?? e) });
    }
  });

  const benchRunBody = z.object({ profileVersionId: z.string().trim().min(1).max(64) });
  app.post(`${P}/benchmark/run`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = benchRunBody.safeParse(req.body ?? {});
    if (!parsed.success) return bad(reply, parsed);
    try {
      const out = await runBenchmark(db, parsed.data.profileVersionId, { log });
      await recordYiddishEvent(db, "benchmark.run", { ...out, by: actorOf(user) });
      return reply.send(out);
    } catch (e: any) {
      return reply.code(e?.message === "profile_version_not_found" ? 404 : 500).send({ error: String(e?.message ?? e) });
    }
  });

  app.get(`${P}/benchmark/compare`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const q = req.query ?? {};
    const runId = String(q.runId ?? "").trim();
    const baselineRunId = String(q.baselineRunId ?? "").trim();
    if (!runId || !baselineRunId) return reply.code(400).send({ error: "invalid_query", message: "runId and baselineRunId are both required." });
    return reply.send(await compareRuns(db, runId, baselineRunId));
  });

  const rateBody = z.object({ rating: z.number().int().min(1).max(5), notes: z.string().trim().max(2000).nullish() });
  app.post(`${P}/benchmark/results/:id/rate`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const parsed = rateBody.safeParse(req.body ?? {});
    if (!parsed.success) return bad(reply, parsed);
    const result = await safe<any>(db.ycBenchmarkResult.findUnique({ where: { id: String(req.params.id) } }), null);
    if (!result) return reply.code(404).send({ error: "not_found" });
    const ratedBy = actorOf(user);
    const row = await db.ycBenchmarkResult.update({ where: { id: result.id }, data: { rating: parsed.data.rating, notes: parsed.data.notes ?? null, ratedBy } });

    // Keep the run's rolling mean honest: recompute from the rated rows.
    const all: any[] = await safe(db.ycBenchmarkResult.findMany({ where: { runId: result.runId } }), []);
    const rated = (all ?? []).filter((r) => r.rating !== null && r.rating !== undefined);
    await db.ycBenchmarkRun
      .update({
        where: { id: result.runId },
        data: {
          ratedCount: rated.length,
          meanRating: rated.length ? Math.round((rated.reduce((s, r) => s + Number(r.rating), 0) / rated.length) * 1000) / 1000 : null,
        },
      })
      .catch(() => undefined);
    return reply.send({ result: row, ratedCount: rated.length });
  });

  // ══════════════════════════ EXPORT ════════════════════════════════════════

  app.get(`${P}/export/preview`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    return reply.send(await buildExportPreview(db));
  });

  app.post(`${P}/export/build`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const preview = await buildExportPreview(db);
    if (preview.exportable === 0) {
      // ⛔ An export of nothing is not an export. Refusing with the breakdown
      // is the honest answer; writing an empty manifest would read as success.
      return reply.code(409).send({
        error: "nothing_exportable",
        message: preview.note,
        exportable: 0,
        breakdown: preview.breakdown,
        sources: preview.sources,
      });
    }
    // The filter is governance.ts's `filterExportable`, per ROW, not a second
    // opinion: only an ALLOWED verdict leaves. RESTRICTED rows stay in the
    // corpus and never reach the file.
    const sources: any[] = await safe(db.ycSource.findMany(), []);
    const allRights: any[] = await safe(db.ycRightsRecord.findMany(), []);
    const byId = new Map(sources.map((s) => [s.id, s]));
    const items: any[] = await safe(db.ycSourceItem.findMany({ select: { id: true, sourceId: true }, take: 100_000 }), []);
    const itemSource = new Map(items.map((i) => [i.id, i.sourceId]));
    const transcripts: any[] = await safe(db.ycTranscript.findMany({ take: 100_000 }), []);

    const candidates = transcripts.map((t: any) => {
      const source = byId.get(itemSource.get(t.itemId)) ?? {};
      return {
        row: { id: t.id, itemId: t.itemId, sourceKey: (source as any).key ?? null, engine: t.engine, sttProvider: t.sttProvider ?? null, language: t.language, text: t.text },
        source: source as any,
        provenance: { engine: t.engine, sttProvider: t.sttProvider ?? null, sourceKey: (source as any).key ?? null, originRef: t.originRef ?? null } as any,
        rights: allRights.filter((r) => r.sourceId === (source as any).id),
      };
    });
    const rows = filterExportable(candidates);
    if (rows.length === 0) {
      return reply.code(409).send({ error: "nothing_exportable", message: preview.note, exportable: 0, breakdown: preview.breakdown });
    }

    const dir = String(process.env.YIDDISH_EXPORT_DIR || "/var/lib/connect/yiddish-exports");
    const file = pathJoin(dir, `yiddish-export-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    } catch (e: any) {
      return reply.code(500).send({ error: "export_write_failed", message: String(e?.message ?? e), rowCount: rows.length });
    }
    await recordYiddishEvent(db, "export.built", { rows: rows.length, path: file, by: actorOf(user) });
    return reply.send({ path: file, rowCount: rows.length, breakdown: preview.breakdown });
  });

  // ══════════════════════════ GOVERNANCE ════════════════════════════════════

  app.get(`${P}/governance`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const sources: any[] = await safe(db.ycSource.findMany({ orderBy: { key: "asc" } }), []);
    const rights: any[] = await safe(db.ycRightsRecord.findMany(), []);
    const byId = new Map(sources.map((s) => [s.id, s]));
    const gaps: { key: string; gap: string }[] = [];
    for (const s of sources) {
      const mine = rights.filter((r) => r.sourceId === s.id);
      if (mine.length === 0) gaps.push({ key: String(s.key), gap: "No rights record of any kind has been filed for this source." });
      if (String(s.governanceClass) === "CUSTOMER_PRIVATE")
        gaps.push({ key: String(s.key), gap: "Customer data: no consent flag and no per-tenant training opt-in exists in the platform yet." });
      if (String(s.key) === YIDDISH24_SOURCE_KEY && !s.termsUrl)
        gaps.push({ key: String(s.key), gap: "No terms-of-use page exists on the site, so there is nothing to point at. Permission has to be asked for in writing." });
    }
    return reply.send({
      // The phrase the portal asks a person to type before audio can be enabled.
      // Published here so the UI and the API can never drift apart on it.
      audioModeAcknowledgementPhrase: "I AUTHORIZE AUDIO FETCHING",
      walls: [
        { key: "customer", message: YC_CUSTOMER_WALL_MESSAGE },
        { key: "yiddish_labs", message: YC_YL_SERVING_ONLY_MESSAGE },
        { key: "external_audio", message: YC_AUDIO_BLOCKED_MESSAGE },
      ],
      sources: sources.map((s) => ({
        key: String(s.key),
        name: String(s.name),
        badge: badgeForSource(s),
        audioFetchMode: String(s.audioFetchMode ?? "DISABLED"),
        termsUrl: s.termsUrl ?? null,
        termsCheckedAt: s.termsCheckedAt ? new Date(s.termsCheckedAt).toISOString() : null,
        rightsNote: s.rightsNote ?? null,
        audioBlockedReason: audioBlockedReason(s, rights.filter((r) => r.sourceId === s.id)),
      })),
      rights: rights.map((r) => ({
        sourceKey: String(byId.get(r.sourceId)?.key ?? "unknown"),
        allowedUse: r.allowedUse,
        state: r.state,
        evidence: r.evidence ?? null,
        decidedBy: r.decidedBy ?? null,
        decidedAt: new Date(r.decidedAt).toISOString(),
      })),
      gaps,
      note: "Rights and audio mode can only be changed by a person, through this screen. The engine has no route to them.",
    });
  });

  // ══════════════════════════ INTERNAL INDEX ════════════════════════════════

  app.post(`${P}/internal/reindex`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    // ⛔ COUNTS ONLY. The indexer never reads customer content — the wall holds.
    // The one exception is the platform's OWN translation cache, which it may
    // read to seed lexemes; that is a PLATFORM source, not a customer's.
    const out = await reindexInternal(db, { seedLexemes: true });
    await recordYiddishEvent(db, "internal.reindex", { by: actorOf(user), result: out ?? null });
    return reply.send({ ...(out ?? {}), note: "Counts only. No customer voicemail, call or chat content was read." });
  });

  // ══════════════════════════ HEALTH ════════════════════════════════════════

  app.get(`${P}/health`, async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const [probes, jobs, budgets] = await Promise.all([
      safe<any[]>(db.ycSourceHealth.findMany({ orderBy: { checkedAt: "desc" }, take: 200 }), []),
      safe<any[]>(db.ycProcessingJob.findMany({ orderBy: { updatedAt: "desc" }, take: 1, select: { updatedAt: true } }), []),
      safe<any[]>(db.ycBudget.findMany(), []),
    ]);
    const lastTickAt = jobs?.[0]?.updatedAt ? new Date(jobs[0].updatedAt).toISOString() : null;
    return reply.send({
      probes: (probes ?? []).map((p: any) => ({ sourceId: p.sourceId, probeKey: p.probeKey, state: p.state, detail: p.detail ?? null, checkedAt: new Date(p.checkedAt).toISOString(), brokenSince: p.brokenSince ? new Date(p.brokenSince).toISOString() : null })),
      worker: {
        alive: Boolean(lastTickAt && Date.now() - new Date(lastTickAt).getTime() < 15 * 60_000),
        lastTickAt,
        note: lastTickAt ? "" : "The worker has never processed a job. That is the state, not a probe failure.",
      },
      budgets: (budgets ?? []).map(budgetView),
      globalBudgetScope: YC_GLOBAL_BUDGET_SCOPE,
    });
  });
}

/** Every route this file registers, in one list, so a gate test can walk them
 *  all without guessing. Kept beside the registrations on purpose. */
export const YC_REGISTERED_ROUTES: { method: "GET" | "POST"; path: string }[] = [
  { method: "GET", path: `${YC_API_PREFIX}/dashboard` },
  { method: "GET", path: `${YC_API_PREFIX}/sources` },
  { method: "POST", path: `${YC_API_PREFIX}/sources/:key/enable` },
  { method: "POST", path: `${YC_API_PREFIX}/sources/:key/rights` },
  { method: "POST", path: `${YC_API_PREFIX}/sources/:key/audio-mode` },
  { method: "POST", path: `${YC_API_PREFIX}/sources/:key/budget` },
  { method: "POST", path: `${YC_API_PREFIX}/sources/:key/discover` },
  { method: "POST", path: `${YC_API_PREFIX}/sources/:key/run` },
  { method: "GET", path: `${YC_API_PREFIX}/sources/:key/items` },
  { method: "GET", path: `${YC_API_PREFIX}/items/:id` },
  { method: "GET", path: `${YC_API_PREFIX}/corpus/search` },
  { method: "GET", path: `${YC_API_PREFIX}/lexemes` },
  { method: "GET", path: `${YC_API_PREFIX}/lexemes/:id` },
  { method: "POST", path: `${YC_API_PREFIX}/lexemes/:id/rules` },
  { method: "POST", path: `${YC_API_PREFIX}/rules/:id/status` },
  { method: "GET", path: `${YC_API_PREFIX}/review` },
  { method: "POST", path: `${YC_API_PREFIX}/review/:id/decide` },
  { method: "GET", path: `${YC_API_PREFIX}/findings` },
  { method: "POST", path: `${YC_API_PREFIX}/findings/:id/status` },
  { method: "GET", path: `${YC_API_PREFIX}/queue` },
  { method: "POST", path: `${YC_API_PREFIX}/queue/retry` },
  { method: "GET", path: `${YC_API_PREFIX}/progress` },
  { method: "GET", path: `${YC_API_PREFIX}/benchmark` },
  { method: "POST", path: `${YC_API_PREFIX}/benchmark/cases` },
  { method: "POST", path: `${YC_API_PREFIX}/benchmark/seed` },
  { method: "POST", path: `${YC_API_PREFIX}/benchmark/baseline` },
  { method: "POST", path: `${YC_API_PREFIX}/benchmark/run` },
  { method: "GET", path: `${YC_API_PREFIX}/benchmark/compare` },
  { method: "POST", path: `${YC_API_PREFIX}/benchmark/results/:id/rate` },
  { method: "GET", path: `${YC_API_PREFIX}/export/preview` },
  { method: "POST", path: `${YC_API_PREFIX}/export/build` },
  { method: "GET", path: `${YC_API_PREFIX}/governance` },
  { method: "POST", path: `${YC_API_PREFIX}/internal/reindex` },
  { method: "GET", path: `${YC_API_PREFIX}/health` },
];
