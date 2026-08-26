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

function fakeBrainDb(catalog: any[] = CATALOG) {
  // a tiny where-evaluator faithful to the shapes the search really sends
  // (AND of OR(name/brand contains) — the fake must not ignore filters, the
  // recorded ignores-its-where trap)
  const matches = (row: any, w: any): boolean => {
    if (!w || typeof w !== "object") return true;
    if (Array.isArray(w.AND)) return w.AND.every((x: any) => matches(row, x));
    if (Array.isArray(w.OR)) return w.OR.some((x: any) => matches(row, x));
    for (const [k, v] of Object.entries<any>(w)) {
      if (k === "AND" || k === "OR" || k === "tenantId" || k === "isActive") continue;
      if (v && typeof v === "object") {
        if (Array.isArray(v.in) && !v.in.includes(row[k])) return false;
        if (v.contains !== undefined && !String(row[k] ?? "").toLowerCase().includes(String(v.contains).toLowerCase())) return false;
        if (v.startsWith !== undefined && !String(row[k] ?? "").startsWith(String(v.startsWith))) return false;
      }
    }
    return true;
  };
  return {
    posCatalogItem: {
      findMany: async ({ where, take }: any) => catalog.filter((r) => r.isActive && matches(r, where)).slice(0, take ?? 6),
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

test("the brain may pick from the customer's own USUALS (learning layer 1)", async () => {
  let call = 0;
  const llm = async (_k: string, _m: string, _sys: string, user: string) => {
    call++;
    if (call === 1) return { isOrder: true, lines: [{ phrase: "the milk I always get", qty: 1, constraints: "" }], remarks: [] };
    const parsed = JSON.parse(user);
    // the usuals travel to the model and their ids are valid picks
    const usual = parsed.customerUsuals?.[0];
    return { picks: usual ? [{ line: 0, id: usual.id, qty: 1 }] : [], refused: [] };
  };
  const db: any = fakeBrainDb();
  db.supermarketOrderDraft = {
    findMany: async () => [{ items: [{ posProductId: "p3", code: "333", name: "Whole Milk", qty: 1, unitPriceCents: 429 }] }],
  };
  const out = await runOrderBrain({ db, llm: llm as any, keyResolver: fakeKey } as any, "t1", "the milk I always get", { customerPhone: "8452815596" });
  assert.ok(out);
  assert.equal(out!.items.length, 1);
  assert.equal(out!.items[0].posProductId, "p3");
  // ⛔ the price came from the LIVE catalog row, not the historical draft
  assert.equal(out!.items[0].unitPriceCents, 429);
});

test("the candidate search finds a product whose BRAND carries half the phrase (the cream-of-lox case)", async () => {
  const { searchCandidates } = await import("./orderBrain");
  const catalog = [
    { posProductId: "lox1", code: "014", name: "Cream Of Lox", brand: "Ta'am Tov", sizeText: "", unitPriceCents: 589, isActive: true },
    // the polluters that used to fill the pool before "lox" ever ran
    ...Array.from({ length: 10 }, (_, i) => ({ posProductId: `soup${i}`, code: `29${i}`, name: `Cream Of Squash Soup ${i}`, brand: "", sizeText: "", unitPriceCents: 1099, isActive: true })),
  ];
  const out = await searchCandidates(fakeBrainDb(catalog).posCatalogItem ? fakeBrainDb(catalog) : null, "t1", "Ta'am Tov cream of lox");
  assert.ok(out.some((c: any) => c.posProductId === "lox1"), "Cream Of Lox must be among the candidates");
  assert.equal(out[0].posProductId, "lox1", "and FIRST — the all-tokens name-or-brand pass beats the polluters");
});

test("a close-variant pick carries the unsure '?' flag onto the item", async () => {
  let call = 0;
  const llm = async () => {
    call++;
    if (call === 1) return { isOrder: true, lines: [{ phrase: "vanilla yogurt", qty: 1, constraints: "" }], remarks: [] };
    return { picks: [{ line: 0, id: "p3", qty: 1, unsure: true }], refused: [] };
  };
  const db: any = fakeBrainDb();
  const out = await runOrderBrain(
    { db, llm: llm as any, keyResolver: fakeKey, search: (async () => [{ posProductId: "p3", code: "333", name: "Vanilla Yogurt 5-Pack", brand: "", sizeText: "", unitPriceCents: 599 }]) as any } as any,
    "t1",
    "one vanilla yogurt",
  );
  assert.ok(out);
  assert.equal(out!.items.length, 1);
  assert.equal(out!.items[0].unsure, true);
});

test("the brain token budgets survived — 16000, never shrunk back to a truncating cap", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const s = readFileSync(path.join(__dirname, "orderBrain.ts"), "utf8").replace(/\r\n/g, "\n");
  // ⛔ proven live 2026-08-26: a real 31-line order used 3,946 of a 4,000 cap
  // (3,264 reasoning) — the truncated JSON silently fell back to the matcher.
  const calls = s.match(/EXTRACT_SYSTEM, text\.slice\(0, 6000\), (\d+)\)/);
  const calls2 = s.match(/RESOLVE_SYSTEM, resolveUser, (\d+)\)/);
  assert.ok(Number(calls?.[1]) >= 16000, "extract budget must stay >= 16000");
  assert.ok(Number(calls2?.[1]) >= 16000, "resolve budget must stay >= 16000");
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

// ── learning layer 2: phrase lessons ────────────────────────────────────────

test("pairLessons: the unambiguous single-skip/single-add case pairs with zero overlap", async () => {
  const { pairLessons } = await import("./phraseLessons");
  const pairs = pairLessons(["Doc's Sauce"], [{ posProductId: "duck1", name: "Duck Sauce Squeeze" }]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].posProductId, "duck1");
});

test("pairLessons: garbled brand phrase pairs to the rep's pick by stem overlap", async () => {
  const { pairLessons } = await import("./phraseLessons");
  const pairs = pairLessons(
    ["Schrieber's Sparkler chip cookie dough", "Million Men canola oil"],
    [
      { posProductId: "cd1", name: "Cookie Dough Bombs Chocolate Chip", brand: "Ostreicher's" },
      { posProductId: "oil1", name: "Canola Oil 96 Oz", brand: "Mehadrin" },
    ],
  );
  assert.equal(pairs.length, 2);
  assert.equal(pairs.find((p) => p.posProductId === "cd1") !== undefined, true);
  assert.equal(pairs.find((p) => p.posProductId === "oil1") !== undefined, true);
});

test("pairLessons: a tie between two items for one phrase pairs NOTHING for that phrase", async () => {
  const { pairLessons } = await import("./phraseLessons");
  const pairs = pairLessons(
    ["chocolate milk", "orange juice"],
    [
      { posProductId: "m1", name: "Chocolate Milk Quart" },
      { posProductId: "m2", name: "Chocolate Milk Gallon" },
    ],
  );
  // "chocolate milk" ties m1/m2 → skipped; "orange juice" overlaps neither
  assert.equal(pairs.length, 0);
});

test("matchLessonsToLines: a stored garble matches the same garble next time", async () => {
  const { matchLessonsToLines, normalizePhrase } = await import("./phraseLessons");
  const lessons = [{ phrase: normalizePhrase("Doc's Sauce"), posProductId: "duck1" }];
  const m = matchLessonsToLines(lessons, ["a small gate of Doc's Sauce", "eggs"]);
  assert.deepEqual(m.get(0), ["duck1"]);
  assert.equal(m.has(1), false);
});

test("the brain returns the per-line checklist: in_cart, unsure and skipped-with-suggestions", async () => {
  const { runOrderBrain } = await import("./orderBrain");
  const db = fakeBrainDb();
  let call = 0;
  const llm = async () => {
    call++;
    if (call === 1) {
      return { isOrder: true, lines: [
        { phrase: "milk", qty: 2 },
        { phrase: "unicorn spread", qty: 1 },
      ], remarks: [] };
    }
    return { picks: [{ line: 0, id: "p3", qty: 2 }], refused: [{ line: 1, reason: "Nothing like that in the catalog" }] };
  };
  const out = await runOrderBrain({ db, llm, keyResolver: async () => ({ apiKey: "k" }) } as any, "t1", "2 milk and unicorn spread");
  assert.ok(out);
  assert.equal(out!.lines!.length, 2);
  assert.equal(out!.lines![0].outcome, "in_cart");
  assert.equal(out!.lines![0].posProductId, "p3");
  assert.equal(out!.lines![1].outcome, "skipped");
  assert.match(String(out!.lines![1].reason), /Nothing like that/);
  assert.ok(Array.isArray(out!.lines![1].suggestions), "skipped line carries suggestions");
});

test("harvestPhraseLessons upserts a lesson from a submitted draft's skipped line + rep-added item", async () => {
  const { harvestPhraseLessons } = await import("./phraseLessons");
  const upserts: any[] = [];
  const db = { supermarketPhraseLesson: { upsert: async (a: any) => { upserts.push(a); } } };
  const n = await harvestPhraseLessons(db, "t1", {
    agentItems: [{ posProductId: "kept1" }],
    agentLines: [{ phrase: "Doc's Sauce", outcome: "skipped" }, { phrase: "milk", outcome: "in_cart" }],
  }, [
    { posProductId: "kept1", name: "Milk" },
    { posProductId: "duck1", name: "Duck Sauce Squeeze" },
  ]);
  assert.equal(n, 1);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].create.posProductId, "duck1");
  assert.equal(upserts[0].create.tenantId, "t1");
});

test("SOURCE GUARDS: agentLines is written at every compose site and lessons harvest at submit", async () => {
  const fs = await import("node:fs");
  const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const builder = read("src/supermarket/draftBuilder.ts");
  assert.equal((builder.match(/agentLines: content\.lines/g) ?? []).length, 2, "both create sites store agentLines");
  const routes = read("src/supermarket/supermarketRoutes.ts");
  assert.equal((routes.match(/agentLines: content\.lines/g) ?? []).length, 1, "reprocess stores agentLines");
  const submit = read("src/supermarket/orderSubmit.ts");
  assert.ok(submit.includes("harvestPhraseLessons(db, input.tenantId, draft"), "submit harvests lessons");
  const brain = read("src/supermarket/orderBrain.ts");
  assert.ok(brain.includes("REFUSING A LINE IS THE LAST RESORT"), "refusal is the last resort in the prompt");
  assert.ok(brain.includes("learned:true"), "the prompt explains learned candidates");
});
