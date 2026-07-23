import { test } from "node:test";
import assert from "node:assert/strict";
import { EverettClient } from "./everett";

test("client reports unconfigured without key+endpoint and throws on calls", async () => {
  assert.equal(new EverettClient(null, null).configured, false);
  assert.equal(new EverettClient("rpa_x", null).configured, false);
  assert.equal(new EverettClient(null, "ep1").configured, false);
  assert.equal(new EverettClient("rpa_x", "ep1").configured, true);
  await assert.rejects(() => new EverettClient(null, null).transcribe({ file: Buffer.from("x") }), /not_configured/);
});

test("rejects oversized blobs with a use-url hint", async () => {
  const c = new EverettClient("rpa_x", "ep1");
  const big = Buffer.alloc(8 * 1024 * 1024);
  await assert.rejects(() => c.transcribe({ file: big }), /too_large.*use_url/);
});

test("requires audio", async () => {
  const c = new EverettClient("rpa_x", "ep1");
  await assert.rejects(() => c.transcribe({}), /no_audio/);
});

test("normalizeLanguage: hint wins, else inferred from script", () => {
  assert.equal(EverettClient.normalizeLanguage("שלום", "yi"), "yi");
  assert.equal(EverettClient.normalizeLanguage("שלום"), "he");
  assert.equal(EverettClient.normalizeLanguage("hello there"), "en");
  assert.equal(EverettClient.normalizeLanguage("איך דארף an appointment"), "yi-en");
  assert.equal(EverettClient.normalizeLanguage(undefined), undefined);
});
