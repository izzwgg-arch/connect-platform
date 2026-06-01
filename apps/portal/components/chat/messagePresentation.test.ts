import test from "node:test";
import assert from "node:assert/strict";
import { attachmentToneClass, messageBubbleClass, messageRowClass, splitMessageBody } from "./chatPresentation";
import { crmSmsBadge, smsInboxBadge } from "./formatting";

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
  assert.equal(smsInboxBadge("shared"), "Shared SMS");
  assert.equal(smsInboxBadge("personal"), "Personal SMS");
  assert.equal(smsInboxBadge(null), null);
});
