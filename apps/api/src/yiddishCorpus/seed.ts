/**
 * Yiddish Corpus — source + budget seed (idempotent, runs at api boot).
 *
 * This file writes the GOVERNANCE STATE THAT WAS ACTUALLY VERIFIED, and
 * nothing more optimistic than that. Three rules shape every row here:
 *
 *  1. Customer sources (voicemail, call recordings, supermarket drafts,
 *     assistant chat, Connect chat) are CUSTOMER_PRIVATE with
 *     `contentAllowed: false`. The engine may COUNT them. Nothing reads their
 *     content until the owner records a basis. (YC_CUSTOMER_WALL_MESSAGE)
 *  2. The Yiddish Labs translation cache is PLATFORM but
 *     `trainingExportEligibility: "EXCLUDED"` — serving only, forever.
 *     (docs/ai-support-agent/YL_NO_TRAINING_POLICY.md)
 *  3. Yiddish24 is EXTERNAL with eligibility UNKNOWN, `audioFetchMode
 *     DISABLED` and `termsUrl: null` — because the live inspection on
 *     2026-09-15 found NO terms page at all, a footer reading "All Rights
 *     Reserved", and a CDN that returns 403 to any request that does not come
 *     from the site's own pages. We do not forge that header. Metadata only.
 *     (§2 of AGENT_HANDOFF_YIDDISH_LEARNING_ENGINE_2026-09-15.md)
 *
 * ⛔ RE-SEEDING NEVER OVERWRITES A HUMAN DECISION. On an existing row this
 * only refreshes identity fields (name, kind, adapterKey, governanceClass).
 * `audioFetchMode`, `contentAllowed`, `trainingExportEligibility`, `enabled`,
 * `termsUrl` and `rightsNote` are written ONLY when the row is created, so a
 * grant recorded on the Governance screen survives every deploy and every
 * boot. The same holds for budgets: `paused` and `mode` are create-only.
 */

import {
  YC_INTERNAL_SOURCES,
  YIDDISH24_SOURCE_KEY,
  type YcAudioFetchMode,
  type YcGovernanceClass,
  type YcRunMode,
  type YcTrainingEligibility,
} from "./contracts";

export const YC_GLOBAL_BUDGET_SCOPE = "global";
export const yiddish24BudgetScope = (): string => `source:${YIDDISH24_SOURCE_KEY}`;

/** The verified rights note for Yiddish24, kept as one string so the UI, the
 *  audit trail and this seed can never drift apart. */
export const YIDDISH24_RIGHTS_NOTE =
  "Inspected read-only 2026-09-15. There is no terms-of-use page (every variant 404s). " +
  "The footer reads \"Copyright 2026 Yiddish24. All Rights Reserved.\" robots.txt carries no " +
  "directives and no ai-train signal. The media CDN (cloudfront.yiddish24.com) returns 403 to " +
  "requests that do not come from the site's own pages — a hotlink restriction we do NOT work " +
  "around. Metadata catalog only until the owner grants permission in writing (Info@yiddish24.com).";

interface SeedSourceSpec {
  key: string;
  name: string;
  kind: "INTERNAL_TABLE" | "VOICE_LAB" | "EXTERNAL_ADAPTER";
  adapterKey: string | null;
  governanceClass: YcGovernanceClass;
  trainingExportEligibility: YcTrainingEligibility;
  contentAllowed: boolean;
  audioFetchMode: YcAudioFetchMode;
  enabled: boolean;
  termsUrl: string | null;
  rightsNote: string | null;
}

/** Built from the contract's own list, so a source added there cannot be
 *  silently missed here. */
export function yiddishSourceSpecs(): SeedSourceSpec[] {
  const internal: SeedSourceSpec[] = YC_INTERNAL_SOURCES.map((s) => {
    const governanceClass = s.governanceClass as YcGovernanceClass;
    if (s.key === "yiddishlabs_cache") {
      return {
        key: s.key,
        name: s.name,
        kind: "INTERNAL_TABLE",
        adapterKey: null,
        governanceClass,
        // ⛔ Serving only. This is the whole point of the YL policy.
        trainingExportEligibility: "EXCLUDED",
        contentAllowed: true,
        audioFetchMode: "DISABLED",
        enabled: true,
        termsUrl: null,
        rightsNote:
          "Yiddish Labs output is serving-only: it may inform spelling and meaning and is " +
          "excluded from every training export, together with anything derived from it alone.",
      };
    }
    if (s.key === "voicelab") {
      return {
        key: s.key,
        name: s.name,
        kind: "VOICE_LAB",
        adapterKey: null,
        governanceClass,
        // Our own generations and our own humans' corrections. Eligibility is
        // still UNKNOWN until the owner says what a generated clip may be used
        // for — it is never assumed.
        trainingExportEligibility: "UNKNOWN",
        contentAllowed: true,
        audioFetchMode: "DISABLED",
        enabled: true,
        termsUrl: null,
        rightsNote:
          "Loopcom's own Voice Lab generations and human ratings/corrections. Generated audio is " +
          "provider output; export eligibility stays UNKNOWN until the owner records a decision.",
      };
    }
    return {
      key: s.key,
      name: s.name,
      kind: "INTERNAL_TABLE",
      adapterKey: null,
      governanceClass,
      trainingExportEligibility: "EXCLUDED",
      // ⛔ THE CUSTOMER WALL. Counted, never read.
      contentAllowed: false,
      audioFetchMode: "DISABLED",
      // Counting is allowed, so the source is on; the wall is contentAllowed.
      enabled: true,
      termsUrl: null,
      rightsNote:
        "Customer voicemails, calls and chats are private tenant data. Counted, never read. " +
        "No consent flag and no per-tenant training opt-in exists yet — Izzy's decision.",
    };
  });

  const yiddish24: SeedSourceSpec = {
    key: YIDDISH24_SOURCE_KEY,
    name: "Yiddish24",
    kind: "EXTERNAL_ADAPTER",
    adapterKey: YIDDISH24_SOURCE_KEY,
    governanceClass: "EXTERNAL",
    trainingExportEligibility: "UNKNOWN",
    // Public listing metadata may be catalogued; audio may not be fetched.
    contentAllowed: true,
    audioFetchMode: "DISABLED",
    enabled: true,
    termsUrl: null,
    rightsNote: YIDDISH24_RIGHTS_NOTE,
  };

  return [...internal, yiddish24];
}

export interface SeedResult {
  created: string[];
  refreshed: string[];
  budgetsCreated: string[];
  errors: { key: string; error: string }[];
}

/**
 * Idempotent. Safe to call on every boot; safe to call twice.
 * Never throws — a seed failure must not stop the api from starting.
 */
export async function seedYiddishSources(db: any): Promise<SeedResult> {
  const result: SeedResult = { created: [], refreshed: [], budgetsCreated: [], errors: [] };

  for (const spec of yiddishSourceSpecs()) {
    try {
      const existing = await db.ycSource.findUnique({ where: { key: spec.key } });
      if (existing) {
        // Identity only — a human's governance decision is never re-written.
        await db.ycSource.update({
          where: { key: spec.key },
          data: {
            name: spec.name,
            kind: spec.kind,
            adapterKey: spec.adapterKey,
            governanceClass: spec.governanceClass,
          },
        });
        result.refreshed.push(spec.key);
      } else {
        await db.ycSource.create({
          data: {
            key: spec.key,
            name: spec.name,
            kind: spec.kind,
            adapterKey: spec.adapterKey,
            governanceClass: spec.governanceClass,
            trainingExportEligibility: spec.trainingExportEligibility,
            contentAllowed: spec.contentAllowed,
            audioFetchMode: spec.audioFetchMode,
            enabled: spec.enabled,
            termsUrl: spec.termsUrl,
            termsCheckedAt: spec.key === YIDDISH24_SOURCE_KEY ? new Date("2026-09-15T22:40:00Z") : null,
            rightsNote: spec.rightsNote,
          },
        });
        result.created.push(spec.key);
      }
    } catch (e: any) {
      result.errors.push({ key: spec.key, error: String(e?.message ?? e) });
    }
  }

  // ── Budgets ───────────────────────────────────────────────────────────────
  // The GLOBAL budget starts PAUSED and METADATA_ONLY: the engine spends
  // nothing and fetches no audio until a person turns it on.
  try {
    const global = await db.ycBudget.findUnique({ where: { scope: YC_GLOBAL_BUDGET_SCOPE } });
    if (!global) {
      await db.ycBudget.create({
        data: {
          scope: YC_GLOBAL_BUDGET_SCOPE,
          sourceId: null,
          apiCentsPerDay: 0,
          transcriptionMinutesPerDay: 0,
          storageBytesMax: BigInt(0),
          concurrency: 2,
          requestsPerMinute: 30,
          mode: "METADATA_ONLY" as YcRunMode,
          paused: true,
        },
      });
      result.budgetsCreated.push(YC_GLOBAL_BUDGET_SCOPE);
    }
  } catch (e: any) {
    result.errors.push({ key: YC_GLOBAL_BUDGET_SCOPE, error: String(e?.message ?? e) });
  }

  // Yiddish24's own budget is NOT paused — the metadata catalog is allowed to
  // run. It is METADATA_ONLY, so no audio byte can be fetched through it, and
  // 30 requests/minute is the polite rate the live inspection used.
  try {
    const scope = yiddish24BudgetScope();
    const existing = await db.ycBudget.findUnique({ where: { scope } });
    if (!existing) {
      const source = await db.ycSource.findUnique({ where: { key: YIDDISH24_SOURCE_KEY } });
      await db.ycBudget.create({
        data: {
          scope,
          sourceId: source?.id ?? null,
          apiCentsPerDay: 0,
          transcriptionMinutesPerDay: 0,
          storageBytesMax: BigInt(0),
          concurrency: 1,
          requestsPerMinute: 30,
          mode: "METADATA_ONLY" as YcRunMode,
          paused: false,
        },
      });
      result.budgetsCreated.push(scope);
    }
  } catch (e: any) {
    result.errors.push({ key: yiddish24BudgetScope(), error: String(e?.message ?? e) });
  }

  return result;
}
