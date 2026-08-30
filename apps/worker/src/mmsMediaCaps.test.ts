import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { MAX_INBOUND_MMS_MEDIA, parseMediaUrls } from "./voipMsInboundSyncJob";
import { MMS_MEDIA_PER_MESSAGE } from "./connectChatSmsJob";

// Source-reading guards must normalise CRLF (Windows checkout) — see
// [[source-reading-tests-must-normalise-crlf]].
function readSource(rel: string): string {
  return readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
}

describe("parseMediaUrls — inbound MMS media is UNCAPPED", () => {
  it("keeps all five urls of a real five-image carrier row (the FixUp loss shape)", () => {
    // Replay of the REAL VoIP.ms getMMS row voipms:10166591 (2026-08-28):
    // five images as col_media1..col_media5 AND a `media` array. The old
    // parser read col_media1..3 and sliced the array branch to 3, so two of
    // the customer's five photos silently never reached FixUp.
    const u = (n: number) => `https://voip.ms/media/hash${n}/media.jpeg`;
    const row = {
      id: "10166591",
      did: "8458067040",
      contact: "8453240113",
      message: "",
      col_media1: u(2),
      col_media2: u(3),
      col_media3: u(4),
      col_media4: u(5),
      col_media5: u(6),
      media: [u(2), u(3), u(4), u(5), u(6)],
    };
    assert.deepEqual(parseMediaUrls(row), [u(2), u(3), u(4), u(5), u(6)]);
  });

  it("dedupes the media array against the numbered keys, preserving order", () => {
    const row = { media: ["https://x/a", "https://x/b"], col_media1: "https://x/a", col_media2: "https://x/b" };
    assert.deepEqual(parseMediaUrls(row), ["https://x/a", "https://x/b"]);
  });

  it("legacy shapes still parse: media1..3, comma string, bare array", () => {
    assert.deepEqual(parseMediaUrls({ media1: "https://x/1", media2: "https://x/2", media3: "https://x/3" }), [
      "https://x/1",
      "https://x/2",
      "https://x/3",
    ]);
    assert.deepEqual(parseMediaUrls({ media: "https://x/1, https://x/2" }), ["https://x/1", "https://x/2"]);
    assert.deepEqual(parseMediaUrls({ media: ["https://x/1"] }), ["https://x/1"]);
  });

  it("numbered keys sort NUMERICALLY (media10 after media2, never lexicographic)", () => {
    const row = { col_media10: "https://x/10", col_media2: "https://x/2", col_media1: "https://x/1" };
    assert.deepEqual(parseMediaUrls(row), ["https://x/1", "https://x/2", "https://x/10"]);
  });

  it("the only bound left is the pathological one, far past any real MMS", () => {
    assert.ok(MAX_INBOUND_MMS_MEDIA >= 50, "this is a runaway-input bound, not a product cap");
    const row: Record<string, string> = {};
    for (let i = 1; i <= 60; i++) row[`col_media${i}`] = `https://x/${i}`;
    assert.equal(parseMediaUrls(row).length, MAX_INBOUND_MMS_MEDIA);
  });

  it("a non-string/non-array media field is ignored, never stringified into junk urls", () => {
    assert.deepEqual(parseMediaUrls({ media: { nested: true } as any }), []);
  });
});

describe("inbound mirror + backfill (source guards)", () => {
  const src = readSource("voipMsInboundSyncJob.ts");

  it("the mirror carries every url — no slice(0, 3) anywhere in the file", () => {
    assert.ok(!src.includes(".slice(0, 3)"), "a 3-url cap on inbound media is the FixUp photo loss");
    assert.ok(!src.includes(".slice(0, 6)"), "the old 6-url merge cap is gone too");
  });

  it("mirror idempotency is by COUNT, so a partially-mirrored message resumes", () => {
    assert.ok(src.includes("existing >= urls.length"), "count-based resume");
    assert.ok(src.includes("urls.slice(existing)"), "mirror only the tail that has no attachment yet");
  });

  it("metadata backfill GROWS an existing url list instead of freezing at the first write", () => {
    assert.ok(src.includes("input.row.mediaUrls.length > cur.length"), "a message first seen with fewer urls must pick up the rest on the next poll");
  });
});

describe("outbound MMS chunking (source guards)", () => {
  const src = readSource("connectChatSmsJob.ts");

  it("more than 3 attachments ship as extra MMS messages, never dropped", () => {
    assert.equal(MMS_MEDIA_PER_MESSAGE, 3, "3 per message is VoIP.ms sendMMS's media1..3 parameter surface");
    assert.ok(src.includes("i += MMS_MEDIA_PER_MESSAGE"), "chunk loop must exist");
  });

  it("the body rides the FIRST chunk only — no duplicate text per chunk", () => {
    assert.ok(src.includes('i === 0 ? providerBody : ""'));
  });

  it("a failed chunk falls back to links for the UNDELIVERED attachments only", () => {
    assert.ok(src.includes("deliveredSourceIds"), "attachments already sent by a successful chunk must not be re-sent as links");
    assert.ok(src.includes("sentMediaCount === 0 ? smsSegmentsForBody(msg.body) : []"), "body segments only when the body-carrying first chunk never left");
    assert.ok(!/const links = sourceAttachments\.map\(/.test(src), "the old fallback linked EVERY attachment even after some were delivered");
  });

  it("converted voice notes map back to their ORIGINAL attachment for the fallback", () => {
    assert.ok(src.includes("sourceId: a.convertedFromAttachmentId"));
  });
});
