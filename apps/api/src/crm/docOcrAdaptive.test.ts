/**
 * The adaptive OCR loop itself — the engine is faked (what is under test is pass
 * ordering, early stop, fallback-to-best, error skipping and worker hygiene, not
 * Tesseract's reading). The desk-phone routes suite fakes this whole function, so
 * this file is the only place the real loop is exercised.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

type Step = { text?: string; confidence?: number; throw?: boolean };
let script: Step[] = [];
let recognizeCalls: Array<Record<string, unknown>> = [];
let workersCreated = 0;
let terminations = 0;

mock.module("tesseract.js", {
  namedExports: {
    createWorker: async () => {
      workersCreated++;
      return {
        recognize: async (_buf: unknown, options: Record<string, unknown>) => {
          const step = script[recognizeCalls.length];
          recognizeCalls.push(options ?? {});
          if (!step || step.throw) throw new Error("pass failed");
          return { data: { text: step.text ?? "", confidence: step.confidence ?? 0 } };
        },
        terminate: async () => { terminations++; },
      };
    },
  },
});

// Loaded after the mock: apps/api compiles to CommonJS.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractTextAdaptive } = require("./docOcrProvider");

const CONFIG = { enabled: true, maxFileBytes: 10 * 1024 * 1024, provider: "tesseract_js", lang: "eng", langPath: undefined };
const INPUT = { buffer: Buffer.from("fake"), mimeType: "image/jpeg", fileName: "label.jpg" };
const TESS = { name: "tesseract_js" };
const acceptAbove = (bar: number) => (_t: string, c: number) => c >= bar;

function reset() { script = []; recognizeCalls = []; workersCreated = 0; terminations = 0; }

test("stops at the first pass the caller approves — later rotations never run", async () => {
  reset();
  script = [{ text: "garbage", confidence: 10 }, { text: "S/N OK", confidence: 90 }];
  const out = await extractTextAdaptive(TESS, INPUT, CONFIG, acceptAbove(55));
  assert.equal(out.text, "S/N OK");
  assert.equal(out.pass, "rot90");
  assert.equal(out.passesRun, 2);
  assert.equal(recognizeCalls.length, 2);
  assert.deepEqual(recognizeCalls[0], { rotateAuto: true }, "the first pass is Tesseract's own deskew");
  assert.equal(recognizeCalls[1].rotateRadians, Math.PI / 2);
  assert.equal(terminations, 1, "the worker is terminated even on early success");
});

test("when no pass is approved, the best-confidence pass is returned for the caller to refuse in its own words", async () => {
  reset();
  script = [
    { text: "a", confidence: 12 }, { text: "b", confidence: 34 },
    { text: "c", confidence: 21 }, { text: "d", confidence: 8 },
  ];
  const out = await extractTextAdaptive(TESS, INPUT, CONFIG, acceptAbove(55));
  assert.equal(out.text, "b");
  assert.equal(out.confidence, 34);
  assert.equal(out.passesRun, 4);
  assert.equal(recognizeCalls[3].rotateRadians, Math.PI, "all four orientations were tried");
  assert.equal(terminations, 1);
});

test("a pass that throws is skipped, not fatal — the next rotation still gets its chance", async () => {
  reset();
  script = [{ throw: true }, { text: "readable", confidence: 80 }];
  const out = await extractTextAdaptive(TESS, INPUT, CONFIG, acceptAbove(55));
  assert.equal(out.text, "readable");
  assert.equal(out.passesRun, 2);
});

test("every pass throwing propagates an error, and the worker is still terminated", async () => {
  reset();
  script = [{ throw: true }, { throw: true }, { throw: true }, { throw: true }];
  await assert.rejects(() => extractTextAdaptive(TESS, INPUT, CONFIG, acceptAbove(55)));
  assert.equal(terminations, 1);
});

test("a provider that is not Tesseract keeps its single pass — no rotations, no worker", async () => {
  reset();
  let calls = 0;
  const other = {
    name: "other_engine",
    extractText: async () => { calls++; return { text: "one shot", confidence: 70, pageCount: 1, metadata: {} }; },
  };
  const out = await extractTextAdaptive(other, INPUT, CONFIG, acceptAbove(55));
  assert.equal(out.text, "one shot");
  assert.equal(out.pass, "single");
  assert.equal(out.passesRun, 1);
  assert.equal(calls, 1);
  assert.equal(workersCreated, 0);
});
