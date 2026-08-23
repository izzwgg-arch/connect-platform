/**
 * Guards for the PBX-side RTP sampler (Izzy's 2026-08-23 "data, data, data"
 * directive). The parser fixtures are REAL `pjsip show channelstats` lines
 * captured live on 2026-08-21 — including the 39%-loss Hanna row that
 * motivated the whole feature.
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.JWT_SECRET = "x".repeat(32);
process.env.AMI_USERNAME = "test";
process.env.AMI_PASSWORD = "test";
process.env.ARI_BASE_URL = "http://test.invalid";
process.env.ARI_USERNAME = "test";
process.env.ARI_PASSWORD = "test";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseChannelStats, matchFragmentToChannel, RtpStatsSampler, setRtpStatsSampler, getRtpStatsForChannels } =
  require("./RtpStatsSampler") as typeof import("./RtpStatsSampler");

const REAL_OUTPUT = [
  "                                             ...........Receive......... .........Transmit..........",
  " BridgeId ChannelId ........ UpTime.. Codec.   Count    Lost Pct  Jitter   Count    Lost Pct  Jitter RTT....",
  " ===========================================================================================================",
  "",
  "          0001-00001267      00:00:15 ulaw      702       0    0   0.000      1       1  100   0.001   0.031",
  " PJSIP/T8_106-00001266 not valid",
  " 2c2edc5b 344022_gesheft-000 00:01:28 ulaw     4396       0    0   0.002   4244       0    0   0.001   0.033",
  " 4ff028de T141_101_1-0000125 00:02:39 opus     5537    1951   35   0.014   7829      68    1   0.007   0.539",
  "",
  "Objects found: 10",
].join("\n");

test("parses the real live output — bridged, bridgeless and 'not valid' rows", () => {
  const rows = parseChannelStats(REAL_OUTPUT);
  assert.strictEqual(rows.length, 3);
  const hanna = rows.find((r) => r.channelFragment === "T141_101_1-0000125");
  assert.ok(hanna, "the Hanna row must parse");
  // THE row: 39% uplink loss the app could never see.
  assert.strictEqual(hanna!.codec, "opus");
  assert.strictEqual(hanna!.rxCount, 5537);
  assert.strictEqual(hanna!.rxLost, 1951);
  assert.strictEqual(hanna!.rxLossPct, 35);
  assert.strictEqual(hanna!.rttSec, 0.539);
  const bridgeless = rows.find((r) => r.channelFragment === "0001-00001267");
  assert.ok(bridgeless, "a row with an empty BridgeId column must still parse");
  assert.strictEqual(bridgeless!.txLossPct, 100);
});

test("header, separator and count lines never parse as channels", () => {
  const rows = parseChannelStats(REAL_OUTPUT);
  for (const r of rows) assert.ok(!/BridgeId|=====|Objects/.test(r.channelFragment));
});

test("fragment matching: truncated name → full channel, ambiguity → NONE", () => {
  const live = ["PJSIP/T141_101_1-0000125e", "PJSIP/344022_gesheft-0001263a"];
  assert.strictEqual(matchFragmentToChannel("T141_101_1-0000125", live), "PJSIP/T141_101_1-0000125e");
  // ⛔ Two live channels sharing a fragment: guessing would attach one call's
  // loss numbers to another call's record — worse than no data.
  const ambiguous = ["PJSIP/T141_101_1-0000125e", "PJSIP/T141_101_1-0000125f"];
  assert.strictEqual(matchFragmentToChannel("T141_101_1-0000125", ambiguous), null);
  assert.strictEqual(matchFragmentToChannel("T9_999-00000001", live), null);
});

test("sampler end-to-end: samples while active, attaches at call end, zero AMI traffic when idle", async () => {
  let commandCalls = 0;
  const ami = {
    command: async () => { commandCalls += 1; return { ok: true as const, output: REAL_OUTPUT }; },
  };
  const calls = { getActive: () => [{ channels: ["PJSIP/T141_101_1-0000125e", "PJSIP/0001-0000125f"] }] };
  const sampler = new RtpStatsSampler(ami as any, calls as any, 1_000_000);
  await (sampler as any).tick();
  assert.strictEqual(commandCalls, 1);
  setRtpStatsSampler(sampler);
  const attached = getRtpStatsForChannels(["PJSIP/T141_101_1-0000125e"]);
  assert.strictEqual(attached.length, 1);
  assert.strictEqual(attached[0]!.rxLossPct, 35);
  assert.strictEqual(attached[0]!.channel, "PJSIP/T141_101_1-0000125e");
  // Idle: no calls → no AMI command at all.
  const idle = new RtpStatsSampler(ami as any, { getActive: () => [] } as any, 1_000_000);
  const before = commandCalls;
  await (idle as any).tick();
  assert.strictEqual(commandCalls, before, "an idle PBX must get zero AMI traffic");
});

test("getRtpStatsForChannels never throws and returns [] for unknown channels", () => {
  assert.deepStrictEqual(getRtpStatsForChannels(null), []);
  assert.deepStrictEqual(getRtpStatsForChannels(["PJSIP/nope-0000"]).length, 0);
});

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

test("SOURCE GUARD: CdrNotifier attaches rtpStats to the main payload", () => {
  const src = read("./CdrNotifier.ts");
  assert.ok(src.includes("rtpStats: getRtpStatsForChannels("), "the CDR payload must carry the samples");
});

test("SOURCE GUARD: the sampler is booted and registered in telephony/index.ts", () => {
  const src = read("../index.ts");
  assert.ok(src.includes("setRtpStatsSampler(rtpStatsSampler)"), "module handle must be set");
  assert.ok(src.includes("rtpStatsSampler.start()"), "sampler must be started at boot");
});
