import { test } from "node:test";
import assert from "node:assert/strict";
import { YiddishLabsClient, type YLResult } from "./yiddishlabs";

test("client reports unconfigured without a key and throws on calls", async () => {
  const c = new YiddishLabsClient(null);
  assert.equal(c.configured, false);
  await assert.rejects(() => c.submitSync({ file: Buffer.from("x"), filename: "a.mp3" }), /not_configured/);
});

test("normalizeLanguage trusts reported language", () => {
  assert.equal(YiddishLabsClient.normalizeLanguage({ id: "1", status: "completed", language: "yi" } as YLResult), "yi");
  assert.equal(YiddishLabsClient.normalizeLanguage({ id: "1", status: "completed", language: "EN" } as YLResult), "en");
  assert.equal(YiddishLabsClient.normalizeLanguage({ id: "1", status: "completed", language: "lk" } as YLResult), "lk");
});

test("normalizeLanguage infers from text when language absent (incl. code-switch)", () => {
  assert.equal(YiddishLabsClient.normalizeLanguage({ id: "1", status: "completed", text: "hello there" } as YLResult), "en");
  assert.equal(YiddishLabsClient.normalizeLanguage({ id: "1", status: "completed", text: "איך וויל רעדן" } as YLResult), "yi");
  assert.equal(YiddishLabsClient.normalizeLanguage({ id: "1", status: "completed", text: "איך דארף an appointment" } as YLResult), "yi-en");
});
