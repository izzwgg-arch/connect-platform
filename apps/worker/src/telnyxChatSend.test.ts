/**
 * Worker-side Telnyx dispatch guards + provider behaviour (unified messaging
 * Phase 1, 2026-09-16).
 *
 * Provider behaviour is driven against a stubbed global fetch — no network,
 * no credentials, nothing billed. Source guards pin the rules the SignalWire
 * path already earned:
 *  - the Telnyx send path never routes voice notes through the MP4
 *    conversion — sending the REAL audio file is the feature;
 *  - TELNYX_NOT_CONFIGURED throws a __configError (so the job can try the
 *    backup route, or stamp failed without 12 pointless BullMQ retries);
 *  - every error leaving the adapter carries the __anySent fallback contract.
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  TELNYX_MMS_MEDIA_PER_MESSAGE,
  TelnyxSmsProvider,
  telnyxBodyChunks,
} from "@connect/integrations";

function readSrc(rel: string): string {
  return readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
}
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");
}

test("the Telnyx send path never converts voice notes to MP4", () => {
  const src = stripComments(readSrc("./telnyxChatSend.ts"));
  assert.ok(!src.includes("convertAudioAttachmentsForMms"), "no MP4 conversion import/call");
  assert.ok(!src.includes("mmsAudioConvert"), "no mmsAudioConvert module reference");
});

test("TELNYX_NOT_CONFIGURED throws a config error instead of silently stamping failed", () => {
  const src = stripComments(readSrc("./telnyxChatSend.ts"));
  assert.ok(src.includes("__configError = true"), "not-configured is a __configError the job can act on");
  assert.ok(src.includes("__anySent"), "the fallback contract flag is attached");
});

test("test mode returns a fake id without touching the network", async () => {
  const provider = new TelnyxSmsProvider({ apiKey: "KEYtest" }, true);
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = () => {
    throw new Error("network touched in test mode");
  };
  try {
    const r = await provider.sendMessage({ from: "2053513327", to: "3479780090", body: "hi" });
    assert.strictEqual(r.status, "SENT");
    assert.ok(String(r.providerMessageId).startsWith("telnyx-test-"));
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test("live mode posts JSON with Bearer auth, E.164 numbers and media_urls", async () => {
  const provider = new TelnyxSmsProvider({ apiKey: "KEYabc" }, false);
  const realFetch = globalThis.fetch;
  let seenUrl = "";
  let seenBody: any = {};
  let seenAuth = "";
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = url;
    seenBody = JSON.parse(String(init.body));
    seenAuth = String(init.headers.Authorization);
    return { ok: true, status: 200, json: async () => ({ data: { id: "40318a00-aaaa-bbbb-cccc-0000000000f2", to: [{ status: "queued" }] } }) };
  };
  try {
    const r = await provider.sendMessage({
      from: "2053513327",
      to: "13479780090",
      body: "hello",
      mediaUrls: ["https://a/1.oga", "https://a/2.jpg"],
    });
    assert.strictEqual(seenUrl, "https://api.telnyx.com/v2/messages");
    assert.strictEqual(seenAuth, "Bearer KEYabc");
    assert.strictEqual(seenBody.from, "+12053513327");
    assert.strictEqual(seenBody.to, "+13479780090");
    assert.deepStrictEqual(seenBody.media_urls, ["https://a/1.oga", "https://a/2.jpg"]);
    assert.strictEqual(r.providerMessageId, "telnyx:40318a00-aaaa-bbbb-cccc-0000000000f2");
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test("a carrier refusal throws with the Telnyx error surfaced — never a silent SENT", async () => {
  const provider = new TelnyxSmsProvider({ apiKey: "KEYabc" }, false);
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ errors: [{ code: "40300", title: "Blocked", detail: "unsubscribed recipient" }] }),
  });
  try {
    await assert.rejects(
      () => provider.sendMessage({ from: "2053513327", to: "3479780090", body: "hi" }),
      (e: any) => e.code === "TELNYX_40300" && /unsubscribed/.test(e.message),
    );
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test("the chaos hook simulates an outage without touching the network", async () => {
  const provider = new TelnyxSmsProvider({ apiKey: "KEYabc" }, false);
  process.env.SIMULATE_PROVIDER_FAILURE_TELNYX = "true";
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = () => {
    throw new Error("network touched during simulated outage");
  };
  try {
    await assert.rejects(
      () => provider.sendMessage({ from: "2053513327", to: "3479780090", body: "hi" }),
      (e: any) => e.code === "SIM_TELNYX_DOWN",
    );
  } finally {
    delete process.env.SIMULATE_PROVIDER_FAILURE_TELNYX;
    (globalThis as any).fetch = realFetch;
  }
});

test("body chunking splits only past Telnyx's 1600-char cap; media cap is 10", () => {
  assert.deepStrictEqual(telnyxBodyChunks("short"), ["short"]);
  const long = "x".repeat(1601);
  const chunks = telnyxBodyChunks(long);
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0]!.length, 1600);
  assert.strictEqual(TELNYX_MMS_MEDIA_PER_MESSAGE, 10);
});
