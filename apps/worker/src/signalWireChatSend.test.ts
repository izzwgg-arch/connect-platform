/**
 * Worker-side SignalWire dispatch guards + provider behaviour.
 *
 * Source guards (comment-stripped, CRLF-normalised) pin the CALLER-side rules:
 *  - the provider branch in connectChatSmsJob runs BEFORE any VoIP.ms
 *    credential concern (a SignalWire number must never fail
 *    VOIPMS_NOT_CONFIGURED);
 *  - the VoIP.ms inbound POLL only polls VoIP.ms numbers;
 *  - the SignalWire send path never routes voice notes through the MP4
 *    conversion — sending the REAL audio file is the feature.
 *
 * Provider behaviour is driven against a stubbed global fetch — no network,
 * no credentials, nothing billed.
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SIGNALWIRE_MMS_MEDIA_PER_MESSAGE,
  SignalWireSmsProvider,
  signalWireBodyChunks,
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

test("connectChatSmsJob dispatches SIGNALWIRE numbers before any VoIP.ms concern", () => {
  const src = stripComments(readSrc("./connectChatSmsJob.ts"));
  const jobAt = src.indexOf("export async function processConnectChatSmsJob");
  const body = src.slice(jobAt);
  const dispatchAt = body.indexOf("sendConnectChatMessageViaSignalWire");
  const credsAt = body.indexOf("const creds = await loadVoipMsCredsWorker()");
  const cfgAt = body.indexOf("globalVoipMsConfig.findUnique");
  assert.ok(dispatchAt > -1, "the SignalWire dispatch exists");
  assert.ok(credsAt > dispatchAt, "VoIP.ms credentials are only loaded AFTER the provider branch");
  assert.ok(cfgAt > dispatchAt, "VoIP.ms config is only read AFTER the provider branch");
  assert.ok(body.includes('"SIGNALWIRE"'), "branch keys on the number row's provider");
});

test("the VoIP.ms inbound poll only polls VoIP.ms numbers", () => {
  const src = stripComments(readSrc("./voipMsInboundSyncJob.ts"));
  assert.ok(src.includes('provider: "VOIPMS"'), "poll where-clause filters by provider");
});

test("the SignalWire send path never converts voice notes to MP4", () => {
  const src = stripComments(readSrc("./signalWireChatSend.ts"));
  assert.ok(!src.includes("convertAudioAttachmentsForMms"), "no MP4 conversion import/call");
  assert.ok(!src.includes("mmsAudioConvert"), "no mmsAudioConvert module reference");
});

test("test mode returns a fake id without touching the network", async () => {
  const provider = new SignalWireSmsProvider({ spaceUrl: "x.signalwire.com", projectId: "p", apiToken: "t" }, true);
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = () => {
    throw new Error("network touched in test mode");
  };
  try {
    const r = await provider.sendMessage({ from: "2053513327", to: "3479780090", body: "hi" });
    assert.strictEqual(r.status, "SENT");
    assert.ok(String(r.providerMessageId).startsWith("signalwire-test-"));
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test("live mode posts the Twilio-shaped form with repeated MediaUrl and E.164 numbers", async () => {
  const provider = new SignalWireSmsProvider({ spaceUrl: "loop.signalwire.com", projectId: "pid", apiToken: "tok" }, false);
  const realFetch = globalThis.fetch;
  let seenUrl = "";
  let seenBody = "";
  let seenAuth = "";
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = url;
    seenBody = String(init.body);
    seenAuth = String(init.headers.Authorization);
    return { ok: true, status: 201, json: async () => ({ sid: "SMabc", status: "queued", num_segments: "1" }) };
  };
  try {
    const r = await provider.sendMessage({
      from: "2053513327",
      to: "13479780090",
      body: "hello",
      mediaUrls: ["https://a/1.oga", "https://a/2.jpg"],
    });
    assert.ok(seenUrl.includes("loop.signalwire.com/api/laml/2010-04-01/Accounts/pid/Messages.json"));
    assert.strictEqual(seenAuth, `Basic ${Buffer.from("pid:tok").toString("base64")}`);
    const params = new URLSearchParams(seenBody);
    assert.strictEqual(params.get("From"), "+12053513327");
    assert.strictEqual(params.get("To"), "+13479780090");
    assert.deepStrictEqual(params.getAll("MediaUrl"), ["https://a/1.oga", "https://a/2.jpg"]);
    assert.strictEqual(r.providerMessageId, "signalwire:SMabc");
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test("a carrier refusal throws with the SignalWire error surfaced — never a silent SENT", async () => {
  const provider = new SignalWireSmsProvider({ spaceUrl: "loop.signalwire.com", projectId: "pid", apiToken: "tok" }, false);
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ code: 21610, message: "unsubscribed recipient" }),
  });
  try {
    await assert.rejects(
      () => provider.sendMessage({ from: "2053513327", to: "3479780090", body: "hi" }),
      (e: any) => e.code === "SIGNALWIRE_21610" && /unsubscribed/.test(e.message),
    );
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test("body chunking splits only past SignalWire's 1600-char cap", () => {
  assert.deepStrictEqual(signalWireBodyChunks("short"), ["short"]);
  const long = "x".repeat(1601);
  const chunks = signalWireBodyChunks(long);
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0]!.length, 1600);
  assert.ok(SIGNALWIRE_MMS_MEDIA_PER_MESSAGE === 10);
});
