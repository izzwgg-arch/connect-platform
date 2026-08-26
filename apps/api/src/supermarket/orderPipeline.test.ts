/**
 * The YL + brain order pipeline (Izzy, 2026-08-26): Yiddish Labs ONLY for
 * transcription/translation, then the OpenAI brain fills the items honouring
 * constraints ("corn cakes, but not this brand" → a DIFFERENT brand or a
 * refusal into notes). Offline — every provider is an injected fake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prepareOrderText, hasHebrewScript, voicemailLocalAudioFile } from "./orderYiddish";
import { runOrderBrain } from "./orderBrain";
import { composeDraftContent, YL_TRANSCRIPTIONS_PER_RUN } from "./draftBuilder";
import { buildCatalogIndex, type CatalogEntry } from "./draftMatcher";

const YIDDISH = "איך ויל קארן קוכן"; // "I want corn cakes"

function fakeYlDeps(overrides: any = {}) {
  return {
    db: {},
    keyLoader: async () => "yl-test-key",
    transcribe: async () => YIDDISH,
    translate: async () => "two corn cakes, but not the Paskesz brand",
    readAudio: async () => Buffer.from("RIFF"),
    ...overrides,
  };
}

test("hasHebrewScript separates Yiddish from English", () => {
  assert.equal(hasHebrewScript(YIDDISH), true);
  assert.equal(hasHebrewScript("two corn cakes please"), false);
  assert.equal(hasHebrewScript(""), false);
});

test("voicemailLocalAudioFile refuses traversal and path separators", () => {
  process.env.VOICEMAIL_AUDIO_STORAGE_DIR = "/var/lib/vm";
  assert.equal(voicemailLocalAudioFile("../etc/passwd"), null);
  assert.equal(voicemailLocalAudioFile("a/b.wav"), null);
  assert.equal(voicemailLocalAudioFile("a\\b.wav"), null);
  assert.ok(voicemailLocalAudioFile("vm123.wav")?.endsWith("vm123.wav"));
  delete process.env.VOICEMAIL_AUDIO_STORAGE_DIR;
});

test("voicemail with audio rides YL transcribe then YL translate", async () => {
  process.env.VOICEMAIL_AUDIO_STORAGE_DIR = "/var/lib/vm";
  const out = await prepareOrderText(fakeYlDeps(), {
    kind: "voicemail",
    text: "old worse transcript",
    localAudioPath: "vm1.wav",
    voicemailId: "vm1",
  });
  delete process.env.VOICEMAIL_AUDIO_STORAGE_DIR;
  assert.equal(out.engine, "yiddishlabs");
  assert.equal(out.transcript, YIDDISH);
  assert.match(out.translation, /corn cakes/);
});

test("Yiddish TEXT message goes straight to YL translate", async () => {
  const out = await prepareOrderText(fakeYlDeps(), { kind: "text", text: YIDDISH });
  assert.equal(out.engine, "yiddishlabs_text");
  assert.equal(out.transcript, YIDDISH);
  assert.match(out.translation, /corn cakes/);
});

test("English input passes through without spending YL credits", async () => {
  let translateCalls = 0;
  const out = await prepareOrderText(
    fakeYlDeps({
      translate: async () => {
        translateCalls++;
        return "x";
      },
    }),
    { kind: "text", text: "two corn cakes please" },
  );
  assert.equal(out.engine, "passthrough");
  assert.equal(translateCalls, 0);
  assert.equal(out.translation, "");
});

test("YL transcribe failure degrades to the stored transcript, ONCE, never blocks", async () => {
  process.env.VOICEMAIL_AUDIO_STORAGE_DIR = "/var/lib/vm";
  let attempts = 0;
  const out = await prepareOrderText(
    fakeYlDeps({
      transcribe: async () => {
        attempts++;
        throw Object.assign(new Error("yl_out_of_credits"), { code: "yl_out_of_credits" });
      },
    }),
    { kind: "voicemail", text: "stored transcript", localAudioPath: "vm1.wav", voicemailId: "vm1" },
  );
  delete process.env.VOICEMAIL_AUDIO_STORAGE_DIR;
  assert.equal(attempts, 1);
  assert.equal(out.transcript, "stored transcript");
  assert.equal(out.error, "yl_out_of_credits");
});

test("no YL key → fallback with the raw text, error set", async () => {
  const out = await prepareOrderText(fakeYlDeps({ keyLoader: async () => null }), { kind: "text", text: "hello" });
  assert.equal(out.engine, "fallback");
  assert.equal(out.error, "yl_not_configured");
  assert.equal(out.transcript, "hello");
});

// ── the brain ─────────────────────────────────────────────────────────────

const CATALOG = [
  { posProductId: "p1", code: "111", name: "Corn Cakes", brand: "Paskesz", sizeText: "3.1 oz", unitPriceCents: 299, isActive: true },
  { posProductId: "p2", code: "222", name: "Corn Cakes Thin", brand: "Galil", sizeText: "3.5 oz", unitPriceCents: 349, isActive: true },
  { posProductId: "p3", code: "333", name: "Whole Milk", brand: "Golden Flow", sizeText: "64 oz", unitPriceCents: 429, isActive: true },
];

function fakeBrainDb() {
  return {
    posCatalogItem: {
      findMany: async ({ where, take }: any) => {
        let rows = CATALOG.filter((r) => r.isActive);
        const nameFilters: string[] = [];
        const collect = (w: any) => {
          if (w?.name?.contains) nameFilters.push(String(w.name.contains).toLowerCase());
          if (Array.isArray(w?.AND)) w.AND.forEach(collect);
        };
        collect(where);
        if (where?.code?.startsWith) rows = rows.filter((r) => r.code.startsWith(where.code.startsWith));
        else if (nameFilters.length) rows = rows.filter((r) => nameFilters.every((t) => r.name.toLowerCase().includes(t)));
        return rows.slice(0, take ?? 6);
      },
    },
  };
}

const fakeKey = async () => ({ apiKey: "sk-test" }) as any;

test("the brain honours a not-this-brand constraint via the resolve pass", async () => {
  const calls: string[] = [];
  const llm = async (_k: string, _m: string, system: string, user: string) => {
    calls.push(system.slice(0, 20));
    if (calls.length === 1) {
      return {
        lines: [{ phrase: "corn cakes", qty: 2, constraints: "not the Paskesz brand" }],
        remarks: ["leave by the side door"],
      };
    }
    // the resolve pass sees BOTH corn-cake candidates; a faithful model picks
    // the non-Paskesz one — the test proves the pick round-trips into items
    const parsed = JSON.parse(user);
    const line = parsed.lines[0];
    const pick = line.candidates.find((c: any) => c.brand !== "Paskesz");
    return { picks: [{ line: 0, id: pick.id, qty: line.qty }], refused: [] };
  };
  const out = await runOrderBrain(
    { db: fakeBrainDb(), llm: llm as any, keyResolver: fakeKey } as any,
    "t1",
    "two corn cakes, but not the Paskesz brand",
  );
  assert.ok(out);
  assert.equal(out!.items.length, 1);
  assert.equal(out!.items[0].posProductId, "p2");
  assert.equal(out!.items[0].qty, 2);
  assert.deepEqual(out!.notes, ["leave by the side door"]);
});

test("a hallucinated product id is dropped and the line reaches notes", async () => {
  let call = 0;
  const llm = async () => {
    call++;
    if (call === 1) return { lines: [{ phrase: "corn cakes", qty: 1, constraints: "" }], remarks: [] };
    return { picks: [{ line: 0, id: "invented-id", qty: 1 }], refused: [] };
  };
  const out = await runOrderBrain({ db: fakeBrainDb(), llm: llm as any, keyResolver: fakeKey } as any, "t1", "corn cakes");
  assert.ok(out);
  assert.equal(out!.items.length, 0);
  assert.ok(out!.notes.some((n) => n.includes("corn cakes") && n.includes("not matched")));
});

test("a refused line carries the model's reason into notes", async () => {
  let call = 0;
  const llm = async () => {
    call++;
    if (call === 1) return { lines: [{ phrase: "corn cakes", qty: 3, constraints: "not Paskesz, not Galil" }], remarks: [] };
    return { picks: [], refused: [{ line: 0, reason: "Only Paskesz and Galil in stock." }] };
  };
  const out = await runOrderBrain({ db: fakeBrainDb(), llm: llm as any, keyResolver: fakeKey } as any, "t1", "corn cakes");
  assert.ok(out);
  assert.equal(out!.items.length, 0);
  assert.ok(out!.notes.some((n) => n.includes("3x corn cakes") && n.includes("Only Paskesz and Galil in stock.")));
});

test("brain returns null on LLM failure (caller falls back to the matcher)", async () => {
  const out = await runOrderBrain({ db: fakeBrainDb(), llm: (async () => null) as any, keyResolver: fakeKey } as any, "t1", "corn cakes");
  assert.equal(out, null);
});

test("brain returns null with no tenant OpenAI key", async () => {
  const out = await runOrderBrain({ db: fakeBrainDb(), keyResolver: (async () => null) as any } as any, "t1", "corn cakes");
  assert.equal(out, null);
});

test("a complaint is NOT an order — one LLM call, no resolve pass, reason kept", async () => {
  let calls = 0;
  const llm = async () => {
    calls++;
    return { isOrder: false, reason: "Complaint about a wrong delivery, not a new order." };
  };
  const out = await runOrderBrain({ db: fakeBrainDb(), llm: llm as any, keyResolver: fakeKey } as any, "t1", "you sent me the square tissues and lettuce instead of tomatoes");
  assert.ok(out);
  assert.equal(calls, 1, "the resolve pass must be skipped for a non-order");
  assert.equal(out!.notAnOrder?.reason, "Complaint about a wrong delivery, not a new order.");
  assert.equal(out!.items.length, 0);
});

test("the customer's SPOKEN phone number is captured, 845-defaulted at 7 digits", async () => {
  let call = 0;
  const llm = async () => {
    call++;
    if (call === 1) return { isOrder: true, customerPhone: "2815596", lines: [{ phrase: "corn cakes", qty: 1, constraints: "" }], remarks: [] };
    return { picks: [], refused: [] };
  };
  const out = await runOrderBrain({ db: fakeBrainDb(), llm: llm as any, keyResolver: fakeKey } as any, "t1", "this is 281-5596, corn cakes please");
  assert.ok(out);
  assert.equal(out!.customerPhone, "8452815596");
});

// ── composeDraftContent glue ─────────────────────────────────────────────

const INDEX_ENTRIES: CatalogEntry[] = CATALOG.map((c) => ({
  posProductId: c.posProductId,
  code: c.code,
  name: c.name,
  unitPriceCents: c.unitPriceCents,
}));

test("composeDraftContent: YL + brain path stamps engine and translation", async () => {
  const index = buildCatalogIndex(INDEX_ENTRIES);
  const content = await composeDraftContent(
    {
      db: {},
      prepareText: (async () => ({
        transcript: YIDDISH,
        translation: "two corn cakes",
        engine: "yiddishlabs_text",
      })) as any,
      brain: (async () => ({
        items: [{ posProductId: "p2", code: "222", name: "Corn Cakes Thin", qty: 2, unitPriceCents: 349, matchedFrom: "name" }],
        comments: [],
        notes: [],
        model: "gpt-5",
      })) as any,
    },
    "t1",
    index,
    { kind: "text", text: YIDDISH },
  );
  assert.equal(content.engine, "brain:gpt-5+yl");
  assert.equal(content.transcript, YIDDISH);
  assert.equal(content.translation, "two corn cakes");
  assert.equal(content.items.length, 1);
});

test("composeDraftContent: brain failure falls back to the regex matcher over the ENGLISH text", async () => {
  const index = buildCatalogIndex(INDEX_ENTRIES);
  const content = await composeDraftContent(
    {
      db: {},
      prepareText: (async () => ({
        transcript: YIDDISH,
        translation: "2 corn cakes",
        engine: "yiddishlabs_text",
        error: "yl_partial",
      })) as any,
      brain: (async () => null) as any,
    },
    "t1",
    index,
    { kind: "text", text: YIDDISH },
  );
  assert.equal(content.engine, "matcher+yl");
  assert.ok(content.notes.includes("transcription: yl_partial"));
  // the matcher must have been fed the English, not the Yiddish
  assert.ok(content.items.some((i: any) => i.name.startsWith("Corn Cakes")));
});

test("YL per-run transcription budget is at least 1 and env-tunable", () => {
  assert.ok(YL_TRANSCRIPTIONS_PER_RUN >= 1);
});

// ── source guards (the defect shape here is always a CALLER) ─────────────

function src(rel: string): string {
  return readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
}

test("the sweep's voicemail and text blocks both go through composeDraftContent", () => {
  const s = src("draftBuilder.ts");
  const calls = s.split("composeDraftContent(deps, tenant.id, index,").length - 1;
  assert.equal(calls, 2, "voicemail AND text blocks must ride the one pipeline");
  // the old direct-matcher create path must be gone from the sweep body
  const body = s.slice(s.indexOf("async function sweepInner"));
  assert.ok(!body.includes("matchDraftText(text, index)"), "sweep must not call the matcher directly any more");
  assert.ok(body.includes("ylSpent >= YL_TRANSCRIPTIONS_PER_RUN"), "the YL audio budget gate must exist");
  assert.ok(body.includes("translation: content.translation"), "drafts must store the translation");
});

test("the reprocess door only touches NEEDS_REVIEW drafts", () => {
  const s = src("supermarketRoutes.ts");
  const i = s.indexOf("/admin/integrations/reprocess-drafts");
  assert.ok(i > 0);
  const block = s.slice(i, i + 5000);
  assert.ok(block.includes('status: "NEEDS_REVIEW"'), "reprocess must filter NEEDS_REVIEW");
  assert.ok(!block.includes('"SUBMITTED"'), "reprocess must never name SUBMITTED");
});

test("a non-order verdict lands as DISMISSED — sweep create AND reprocess update", () => {
  const sweep = src("draftBuilder.ts");
  const dismissed = sweep.split('content.notAnOrder ? { status: "DISMISSED" }').length - 1;
  assert.equal(dismissed, 2, "both sweep create blocks must auto-dismiss a non-order");
  const routes = src("supermarketRoutes.ts");
  const i = routes.indexOf("/admin/integrations/reprocess-drafts");
  const block = routes.slice(i, i + 5000);
  assert.ok(block.includes('content.notAnOrder ? { status: "DISMISSED" }'), "reprocess must clear a non-order off the review queue");
});

test("posPhoneDigits defaults a 7-digit number to area code 845", async () => {
  const { posPhoneDigits } = await import("./posWithLogic");
  assert.equal(posPhoneDigits("2815596"), "8452815596");
  assert.equal(posPhoneDigits("845-281-5596"), "8452815596");
  assert.equal(posPhoneDigits("+1 845 281 5596"), "8452815596");
  assert.equal(posPhoneDigits("12345"), null);
});

test("extractPosCustomer pulls id, name, address and email from common shapes", async () => {
  const { extractPosCustomer } = await import("./posWithLogic");
  const ext = extractPosCustomer({ id: 771, firstName: "Chaim", lastName: "Stern", address1: "12 Forest Rd", city: "Monroe", state: "NY", zip: "10950", email: "cs@example.com", phoneNumber: "8452815596" });
  assert.ok(ext);
  assert.equal(ext!.posCustomerId, "771");
  assert.equal(ext!.name, "Chaim Stern");
  assert.equal(ext!.address, "12 Forest Rd, Monroe NY, 10950");
  assert.equal(ext!.email, "cs@example.com");
  assert.equal(extractPosCustomer({ foo: 1 }), null);
});
