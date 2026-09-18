import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _resetYiddishCache, hasHebrewScript, hear, inboundForBrain, renderForCustomer, type Translator } from "./laybelLanguage";

const YI = "האַלט דעם קנעפּל";
const tr = (opts: { failEn?: boolean; failYi?: boolean } = {}) => {
  const calls = { en: 0, yi: 0 };
  const t: Translator = {
    toEnglish: async (s) => { calls.en++; if (opts.failEn) throw new Error("402"); return `EN(${s})`; },
    toYiddish: async (s) => { calls.yi++; if (opts.failYi) throw new Error("402"); return `YI(${s})`; },
  };
  return { t, calls };
};

describe("hasHebrewScript", () => {
  it("detects Hebrew-script text and nothing else", () => {
    assert.equal(hasHebrewScript(YI), true);
    assert.equal(hasHebrewScript("hold the button"), false);
    assert.equal(hasHebrewScript(""), false);
  });
});

describe("inboundForBrain — the brain always reads English", () => {
  it("Yiddish goes through YL; English passes straight (no credits spent)", async () => {
    const { t, calls } = tr();
    assert.deepEqual(await inboundForBrain(YI, t), { english: `EN(${YI})`, translated: true });
    assert.deepEqual(await inboundForBrain("nothing happens", t), { english: "nothing happens", translated: false });
    assert.equal(calls.en, 1);
  });
  it("a YL failure hands the original over untouched — never silence, never a retry", async () => {
    const { t, calls } = tr({ failEn: true });
    assert.deepEqual(await inboundForBrain(YI, t), { english: YI, translated: false });
    assert.equal(calls.en, 1);
    assert.deepEqual(await inboundForBrain(YI, null), { english: YI, translated: false });
  });
});

describe("renderForCustomer — Yiddish captions from the fenced English", () => {
  it("English selected → nothing translated, no credits", async () => {
    const { t, calls } = tr();
    assert.deepEqual(await renderForCustomer({ say: "Hold OK", chips: ["Done"] }, "en", t), { sayYiddish: null, chipsYiddish: null });
    assert.equal(calls.yi, 0);
  });
  it("Yiddish selected → say and every chip translated, cached on repeat", async () => {
    _resetYiddishCache();
    const { t, calls } = tr();
    const first = await renderForCustomer({ say: "Hold OK", chips: ["Done", "Nothing"] }, "yi", t);
    assert.deepEqual(first, { sayYiddish: "YI(Hold OK)", chipsYiddish: ["YI(Done)", "YI(Nothing)"] });
    assert.equal(calls.yi, 3);
    await renderForCustomer({ say: "Hold OK", chips: ["Done", "Nothing"] }, "yi", t);
    assert.equal(calls.yi, 3, "the same lines cost nothing the second time");
  });
  it("a YL failure → null, so the screen shows English rather than nothing", async () => {
    _resetYiddishCache();
    const { t } = tr({ failYi: true });
    assert.deepEqual(await renderForCustomer({ say: "Hold OK", chips: ["Done"] }, "yi", t), { sayYiddish: null, chipsYiddish: null });
  });
});

describe("hear — the mic", () => {
  it("a Yiddish recording is transcribed by YL and translated for the brain; English is used as-is", async () => {
    const { t } = tr();
    const yi = await hear(Buffer.from("x"), "mic.webm", async () => YI, t);
    assert.deepEqual(yi, { transcript: YI, english: `EN(${YI})`, yiddish: true });
    const en = await hear(Buffer.from("x"), "mic.webm", async () => "it wants a password", t);
    assert.deepEqual(en, { transcript: "it wants a password", english: "it wants a password", yiddish: false });
  });
  it("a transcription failure propagates — never a made-up transcript", async () => {
    await assert.rejects(hear(Buffer.from("x"), "mic.webm", async () => { throw new Error("yl_out_of_credits"); }, null), /yl_out_of_credits/);
  });
});
