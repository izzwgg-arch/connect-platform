/**
 * Locks the screenshot-understanding plumbing: image parts must map to each
 * provider's exact wire shape, and must NEVER escape a user message — system
 * prompts are string-joined in several places, so an image anywhere else would
 * be silently stringified into garbage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatMessageText,
  toAnthropicContent,
  toOpenAiResponsesContent,
  toOpenAiChatContent,
  type ChatMessage,
} from "./router";

const IMG = { type: "image" as const, mediaType: "image/png", dataBase64: "aGVsbG8=" };
const userMsg: ChatMessage = { role: "user", content: [{ type: "text", text: "what does this error mean?" }, IMG] };

test("plain string content passes through every mapper untouched", () => {
  const m: ChatMessage = { role: "user", content: "hi" };
  assert.equal(toAnthropicContent(m), "hi");
  assert.equal(toOpenAiResponsesContent(m), "hi");
  assert.equal(toOpenAiChatContent(m), "hi");
});

test("anthropic: image part becomes a base64 source block", () => {
  assert.deepEqual(toAnthropicContent(userMsg), [
    { type: "text", text: "what does this error mean?" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
  ]);
});

test("openai /v1/responses: image part becomes input_image with a data URL", () => {
  assert.deepEqual(toOpenAiResponsesContent(userMsg), [
    { type: "input_text", text: "what does this error mean?" },
    { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
  ]);
});

test("openai chat.completions: image part becomes image_url with a data URL", () => {
  assert.deepEqual(toOpenAiChatContent(userMsg), [
    { type: "text", text: "what does this error mean?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
  ]);
});

test("⛔ parts on a non-user message flatten to their text in every mapper", () => {
  const sys: ChatMessage = { role: "system", content: [{ type: "text", text: "rules" }, IMG] };
  assert.equal(toAnthropicContent(sys), "rules");
  assert.equal(toOpenAiResponsesContent(sys), "rules");
  assert.equal(toOpenAiChatContent(sys), "rules");
});

test("chatMessageText joins only the text parts", () => {
  assert.equal(chatMessageText(userMsg.content), "what does this error mean?");
  assert.equal(chatMessageText("plain"), "plain");
});

test("classifyAttachment: provider-supported images are 'image', the rest stay documents", async () => {
  const { classifyAttachment } = await import("../attachments/uploadStore");
  assert.equal(classifyAttachment("shot.png", "image/png"), "image");
  assert.equal(classifyAttachment("pic.JPG", "image/jpeg"), "image");
  assert.equal(classifyAttachment("anim.webp", "image/webp"), "image");
  assert.equal(classifyAttachment("scan.tiff", "image/tiff"), "document"); // providers reject tiff
  assert.equal(classifyAttachment("note.mp3", "audio/mpeg"), "audio");     // audio wins over everything
  assert.equal(classifyAttachment("bill.pdf", "application/pdf"), "document");
});
