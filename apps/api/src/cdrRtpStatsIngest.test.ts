/**
 * Source guards for the PBX-side RTP stats landing on ConnectCdr (2026-08-23,
 * Izzy's "data, data, data" directive). The defect shape this protects
 * against: telephony sends the samples and the ingest silently strips them
 * (zod drops undeclared keys — the exact mechanism that ate `pageSize` on the
 * voicemail route for months).
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = () => readFileSync(join(__dirname, "server.ts"), "utf8").replace(/\r\n/g, "\n");

test("the cdr-ingest schema DECLARES rtpStats (zod strips undeclared keys silently)", () => {
  const s = src();
  assert.ok(/rtpStats: z\.array\(z\.object\(\{/.test(s), "rtpStats must be a declared, typed schema field");
  assert.ok(s.includes(".max(12).optional(),"), "bounded and optional (old telephony builds omit it)");
});

test("both the create and update branches write rtpStats — and never blank an earlier sample set", () => {
  const s = src();
  const writes = s.split("rtpStats: d.rtpStats && d.rtpStats.length > 0 ? (d.rtpStats as any) : undefined,").length - 1;
  assert.strictEqual(writes, 2, "create AND update must write; the empty/absent case must resolve to undefined (no overwrite), not null");
});

test("the schema keeps rx and tx directions — rx is the uplink truth no client can measure", () => {
  const s = src();
  assert.ok(s.includes("rxCount: z.number(), rxLost: z.number(), rxLossPct: z.number()"), "receive direction");
  assert.ok(s.includes("txCount: z.number(), txLost: z.number(), txLossPct: z.number()"), "transmit direction");
});
