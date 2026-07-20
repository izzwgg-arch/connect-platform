import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLanguage, codeSwitchRatio, detectTerms, boostPhrases, SEED_GLOSSARY } from "./glossary";
import { CorpusService, REVIEW_THRESHOLD } from "./corpus";
import { AuditLog } from "../audit/audit";

const audit = new AuditLog([{ async write() {} }]);
const glossary = async () => SEED_GLOSSARY;

test("language classification: en / yi / code-switched yi-en", () => {
  assert.equal(classifyLanguage("please transfer my call"), "en");
  assert.equal(classifyLanguage("איך וויל רעדן מיט משה"), "yi");
  // mostly Yiddish with English words dropped in → yi-en
  assert.equal(classifyLanguage("איך דארף מאכן אן appointment אין the office"), "yi-en");
});

test("code-switch ratio rises with mixed English tokens", () => {
  assert.ok(codeSwitchRatio("איך דארף an appointment") > 0.15);
  assert.equal(codeSwitchRatio("איך וויל רעדן"), 0);
});

test("glossary detects yinglish + loshn-koydesh terms", () => {
  const hits = detectTerms("איך דארף מאכן אן appointment בעזראת השם", SEED_GLOSSARY);
  assert.ok(hits.some((h) => h.category === "yinglish"));
  assert.ok(hits.some((h) => h.category === "loshn_koydesh"));
});

test("boost phrases include canonical + variants for provider keyword-boost", () => {
  const p = boostPhrases(SEED_GLOSSARY);
  assert.ok(p.includes("appointment"));
  assert.ok(p.length > SEED_GLOSSARY.length); // variants add entries
});

// --- corpus capture / correction ---
function makePrisma() {
  const rows: any[] = [];
  return {
    rows,
    agentTranscript: {
      upsert: async ({ where, create, update }: any) => {
        const ex = rows.find((r) => r.recordingId === where.recordingId);
        if (ex) { Object.assign(ex, update); return ex; }
        const row = { id: `t${rows.length + 1}`, createdAt: new Date(), ...create };
        rows.push(row); return row;
      },
      update: async ({ where, data }: any) => { const r = rows.find((x) => x.recordingId === where.recordingId); Object.assign(r, data); return r; },
      findMany: async ({ where }: any) => rows.filter((r) => (!where?.reviewStatus || r.reviewStatus === where.reviewStatus)),
      count: async ({ where }: any = {}) => rows.filter((r) => !where || Object.entries(where).every(([k, v]: any) => (v && typeof v === "object" && "not" in v) ? r[k] != null : r[k] === v)).length,
    },
  };
}

test("low-confidence transcript is queued for review; high-confidence is not", async () => {
  const prisma = makePrisma();
  const c = new CorpusService(prisma as any, audit, glossary);
  const low = await c.capture({ recordingId: "r1", text: "איך וויל רעדן", confidence: 0.5, source: "live_call" });
  assert.equal(low.reviewStatus, "pending");
  const hi = await c.capture({ recordingId: "r2", text: "hello there", confidence: 0.95 });
  assert.equal(hi.reviewStatus, "none");
  assert.ok(REVIEW_THRESHOLD > 0.5);
});

test("correction records gold text + reclassifies language", async () => {
  const prisma = makePrisma();
  const c = new CorpusService(prisma as any, audit, glossary);
  await c.capture({ recordingId: "r1", text: "garbled", confidence: 0.4 });
  await c.correct("r1", "איך דארף אן appointment", "reviewer1");
  const row = prisma.rows.find((r) => r.recordingId === "r1");
  assert.equal(row.correctedText, "איך דארף אן appointment");
  assert.equal(row.reviewStatus, "corrected");
  assert.equal(row.language, "yi-en");
});

test("hotline bulk source is captured + counted separately", async () => {
  const prisma = makePrisma();
  const c = new CorpusService(prisma as any, audit, glossary);
  await c.capture({ recordingId: "h1", text: "היינטיגע נייעס", source: "news_hotline", confidence: 0.9, audioRef: "/hotline/h1.wav", trainingEligible: true });
  const stats = await c.stats();
  assert.equal(stats.from_hotline, 1);
});

test("export manifest yields (audio,text) pairs, preferring corrected text", async () => {
  const prisma = makePrisma();
  const c = new CorpusService(prisma as any, audit, glossary);
  await c.capture({ recordingId: "r1", text: "raw", audioRef: "/a/r1.wav", confidence: 0.4, trainingEligible: true });
  await c.correct("r1", "corrected gold", "rev");
  await c.approve("r1");
  const manifest = await c.exportTrainingManifest();
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].text, "corrected gold");
  assert.equal(manifest[0].audio, "/a/r1.wav");
});
