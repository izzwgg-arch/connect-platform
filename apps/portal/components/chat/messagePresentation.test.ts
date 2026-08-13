import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  __resetStableAttachmentUrlCacheForTests,
  attachmentToneClass,
  messageBubbleClass,
  messageRowClass,
  splitMessageBody,
  stabilizeAttachmentUrl,
  stabilizeMessageAttachmentUrls,
} from "./chatPresentation";
import { crmSmsBadge, smsInboxBadge } from "./formatting";
import type { ChatMessage } from "./types";

test("message presentation classes distinguish incoming and outgoing bubbles", () => {
  assert.equal(messageRowClass({ mine: true }), "cc-msg-row mine");
  assert.equal(messageRowClass({ mine: false }), "cc-msg-row theirs");
  assert.equal(messageBubbleClass({ mine: true, deletedForEveryoneAt: null }), "cc-bubble mine");
  assert.equal(messageBubbleClass({ mine: false, deletedForEveryoneAt: "2026-05-31T12:00:00.000Z" }), "cc-bubble theirs deleted");
});

test("splitMessageBody renders URLs as compact wrapped link parts", () => {
  const parts = splitMessageBody("Open https://example.com/a/very/long/path?x=1, then reply");

  assert.deepEqual(parts, [
    { type: "text", value: "Open " },
    { type: "url", value: "https://example.com/a/very/long/path?x=1" },
    { type: "text", value: "," },
    { type: "text", value: " then reply" },
  ]);
});

test("attachmentToneClass identifies media and audio bubble styling", () => {
  assert.equal(attachmentToneClass({ mediaKind: "audio", mimeType: "audio/mp4", fileName: "note.m4a" }), "cc-attach-tone-audio");
  assert.equal(attachmentToneClass({ mediaKind: "image", mimeType: "image/jpeg", fileName: "photo.jpg" }), "cc-attach-tone-image");
  assert.equal(attachmentToneClass({ mediaKind: "video", mimeType: "video/mp4", fileName: "clip.mp4" }), "cc-attach-tone-video");
  assert.equal(attachmentToneClass({ mediaKind: "file", mimeType: "application/pdf", fileName: "doc.pdf" }), "cc-attach-tone-file");
});

test("SMS badges remain explicit and viewer-safe helpers stay opt-in", () => {
  assert.equal(crmSmsBadge(true), "CRM SMS");
  assert.equal(crmSmsBadge(false), null);
  // Shortened to "Shared"/"Personal" in f4fae3f4 (chat polish); this file was
  // not in the portal test script back then, so the assertion went stale unseen.
  assert.equal(smsInboxBadge("shared"), "Shared");
  assert.equal(smsInboxBadge("personal"), "Personal");
  assert.equal(smsInboxBadge(null), null);
});

/**
 * The chat polls every 7s and the API re-signs every attachment URL on each
 * fetch. Handing that changing string to <audio> aborted playback, so a voice
 * note stopped a few seconds in. These lock the pinning behaviour.
 */
const NOW_MS = 1_786_630_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function signedUrl(expSec: number, sig: string): string {
  return `https://app.connectcomunications.com/api/chat/attachments/download/k.m4a?exp=${expSec}&sig=${sig}`;
}

test("a re-signed URL for the same attachment keeps returning the first pinned URL", () => {
  __resetStableAttachmentUrlCacheForTests();
  const first = signedUrl(NOW_SEC + 900, "aaa");
  const second = signedUrl(NOW_SEC + 900, "bbb");

  assert.equal(stabilizeAttachmentUrl("att1", first, NOW_MS), first);
  assert.equal(stabilizeAttachmentUrl("att1", second, NOW_MS), first, "poll must not swap the src");
});

test("a pinned URL is replaced once it nears expiry, so playback never uses a dead link", () => {
  __resetStableAttachmentUrlCacheForTests();
  const first = signedUrl(NOW_SEC + 60, "aaa");
  const fresh = signedUrl(NOW_SEC + 900, "bbb");

  assert.equal(stabilizeAttachmentUrl("att1", first, NOW_MS), first);
  assert.equal(stabilizeAttachmentUrl("att1", fresh, NOW_MS), fresh, "within 120s of expiry must re-pin");
});

test("external MMS URLs and missing URLs pass through untouched", () => {
  __resetStableAttachmentUrlCacheForTests();
  const carrier = "https://voip.ms/media/abc.mp4";
  assert.equal(stabilizeAttachmentUrl("att1", carrier, NOW_MS), carrier);
  assert.equal(stabilizeAttachmentUrl("att2", null, NOW_MS), null);
  assert.equal(stabilizeAttachmentUrl("att3", undefined, NOW_MS), null);
});

test("stabilizeMessageAttachmentUrls pins across a poll and preserves identity when nothing changed", () => {
  __resetStableAttachmentUrlCacheForTests();
  const build = (sig: string): ChatMessage[] => [
    {
      id: "m1",
      threadId: "t1",
      senderId: "u1",
      senderName: "izzywgg",
      body: "",
      sentAt: "2026-08-13T14:17:50.500Z",
      mine: true,
      type: "AUDIO",
      attachments: [
        {
          id: "att1",
          fileName: "voice-note-1786630652620.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 800874,
          downloadUrl: signedUrl(NOW_SEC + 900, sig),
          mediaKind: "audio",
          durationMs: 63900,
        },
      ],
    },
  ];

  const firstPoll = stabilizeMessageAttachmentUrls(build("aaa"), NOW_MS);
  const pinned = firstPoll[0].attachments![0].downloadUrl;

  const secondPoll = stabilizeMessageAttachmentUrls(build("bbb"), NOW_MS);
  assert.equal(secondPoll[0].attachments![0].downloadUrl, pinned, "voice note src must survive a poll");

  const unchanged = stabilizeMessageAttachmentUrls(firstPoll, NOW_MS);
  assert.equal(unchanged, firstPoll, "identical input must keep React identities stable");
});

/**
 * The defect was a CALLER, not the helper: both chat surfaces fetch messages
 * and either one skipping the pin silently reintroduces the cut-off. A unit
 * test of the helper alone passes straight through that, so assert the sources.
 */
test("every portal chat surface pins attachment URLs after fetching messages", () => {
  const surfaces = [
    new URL("./MiniChat.tsx", import.meta.url),
    new URL("../../app/(platform)/chat/page.tsx", import.meta.url),
  ];

  for (const surface of surfaces) {
    const source = readFileSync(surface, "utf8");
    assert.match(source, /\/messages`\)/, `${surface.pathname} should fetch thread messages`);
    assert.match(
      source,
      /stabilizeMessageAttachmentUrls\(res\.messages \?\? \[\]\)/,
      `${surface.pathname} must pin signed attachment URLs, or voice notes cut off after one poll`,
    );
  }
});
