import { test } from "node:test";
import assert from "node:assert/strict";
import { CorpusService, isTrainingForbidden } from "./corpus";
import { AuditLog } from "../audit/audit";

const audit = new AuditLog([{ async write() {} }]);
const glossary = async () => [];

function fakePrisma() {
  const rows = new Map<string, any>();
  return {
    rows,
    agentTranscript: {
      upsert: async ({ where, create, update }: any) => {
        const existing = rows.get(where.recordingId);
        const row = existing ? { ...existing, ...update } : { id: `t${rows.size + 1}`, ...create };
        rows.set(where.recordingId, row);
        return row;
      },
      findUnique: async ({ where }: any) => rows.get(where.recordingId) ?? null,
      update: async ({ where, data }: any) => { const r = { ...rows.get(where.recordingId), ...data }; rows.set(where.recordingId, r); return r; },
      count: async ({ where }: any = {}) => {
        const all = [...rows.values()];
        return all.filter((r) => matches(r, where)).length;
      },
      findMany: async ({ where }: any = {}) => [...rows.values()].filter((r) => matches(r, where)),
      groupBy: async ({ where }: any) => {
        const g = new Map<string, number>();
        for (const r of [...rows.values()].filter((x) => matches(x, where))) g.set(r.model ?? null, (g.get(r.model ?? null) ?? 0) + 1);
        return [...g].map(([model, n]) => ({ model, _count: { _all: n } }));
      },
    },
  };
}
function matches(r: any, where: any = {}): boolean {
  if (!where) return true;
  if (where.trainingEligible !== undefined && r.trainingEligible !== where.trainingEligible) return false;
  if (where.model?.in && !where.model.in.includes((r.model ?? "").toLowerCase())) return false;
  if (where.model?.notIn && where.model.notIn.includes((r.model ?? "").toLowerCase())) return false;
  if (where.audioRef?.not !== undefined && (r.audioRef == null)) return false;
  return true;
}

test("isTrainingForbidden matches Yiddish Labs provenance", () => {
  assert.ok(isTrainingForbidden("yiddishlabs"));
  assert.ok(isTrainingForbidden("YiddishLabs"));
  assert.ok(!isTrainingForbidden("everett"));
  assert.ok(!isTrainingForbidden("whisper"));
  assert.ok(!isTrainingForbidden("ivrit-ai/yi-whisper-large-v3"));
});

test("YL capture is training-ineligible even if caller asks for eligible", async () => {
  const prisma = fakePrisma();
  const c = new CorpusService(prisma as any, audit, glossary);
  await c.capture({ recordingId: "yl_1", text: "גוט מארגן", model: "yiddishlabs", trainingEligible: true });
  assert.equal(prisma.rows.get("yl_1").trainingEligible, false);
});

test("approving a YL transcript never makes it trainingEligible", async () => {
  const prisma = fakePrisma();
  const c = new CorpusService(prisma as any, audit, glossary);
  await c.capture({ recordingId: "yl_2", text: "שלום", model: "yiddishlabs", audioRef: "/a.wav" });
  const res = await c.approve("yl_2");
  assert.equal(res.trainingEligible, false);
  assert.equal(res.reason, "yiddish_labs_serving_only");
  assert.equal(prisma.rows.get("yl_2").trainingEligible, false);
});

test("a non-YL (own) transcript CAN be approved into training", async () => {
  const prisma = fakePrisma();
  const c = new CorpusService(prisma as any, audit, glossary);
  await c.capture({ recordingId: "own_1", text: "עפעס", model: "everett", audioRef: "/b.wav" });
  const res = await c.approve("own_1");
  assert.equal(res.trainingEligible, true);
});

test("export excludes YL even if a YL row were somehow eligible", async () => {
  const prisma = fakePrisma();
  const c = new CorpusService(prisma as any, audit, glossary);
  // force a bad state: YL row flagged eligible directly in the store
  prisma.rows.set("yl_bad", { recordingId: "yl_bad", model: "yiddishlabs", trainingEligible: true, audioRef: "/x.wav", text: "x" });
  await c.capture({ recordingId: "own_2", text: "גוט", model: "everett", audioRef: "/y.wav" });
  await c.approve("own_2");
  const manifest = await c.exportTrainingManifest();
  assert.ok(!manifest.some((m) => m.audio === "/x.wav")); // YL excluded
  assert.ok(manifest.some((m) => m.audio === "/y.wav")); // own included
});

test("compliance report: YL training-eligible count is 0", async () => {
  const prisma = fakePrisma();
  const c = new CorpusService(prisma as any, audit, glossary);
  await c.capture({ recordingId: "yl_3", text: "א", model: "yiddishlabs", audioRef: "/a" });
  await c.approve("yl_3");
  await c.capture({ recordingId: "own_3", text: "ב", model: "everett", audioRef: "/b" });
  await c.approve("own_3");
  const rep = await c.complianceReport();
  assert.equal(rep.yiddishLabsTrainingEligible, 0);
  assert.ok(rep.yiddishLabsTranscripts >= 1);
  assert.equal(rep.exportExcludesYiddishLabs, true);
});
