/**
 * Model pixel-vision transport (Phase 2) — a Coworker screen tool hands back a
 * screenshot and the model actually SEES it, on both providers, while the picture
 * never gets stringified into the text stream or truncated into garbage.
 *
 *  - extractToolResultImage: pulls the image out, strips it from the rest, refuses
 *    a non-image / bad-media-type / array / null;
 *  - anthropicToolResultBlock: image → array content [text, image block] in the
 *    exact shape the Anthropic API wants; no image → a plain JSON string; is_error;
 *  - the OpenAI /v1/responses shape (function_call_output text + a following
 *    input_image user item) is exercised through the same extractor;
 *  - boundContent (desktopLink): the screenshot survives with its own larger ceiling
 *    while the rest is still capped, and an over-size image is dropped (not truncated).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractToolResultImage, anthropicToolResultBlock } from "./router";
import { boundContent, MAX_IMAGE_CHARS } from "../coworker/desktopLink";

const PNG1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA',".slice(0, 40); // any non-empty base64-ish string
const IMG = { ok: true, image: { mediaType: "image/jpeg", dataBase64: PNG1, width: 1280, height: 800 }, note: "a picture" };

test("extractToolResultImage: pulls the image and strips it from the rest; refuses non-images", () => {
  const got = extractToolResultImage(IMG);
  assert.ok(got);
  assert.equal(got!.image.mediaType, "image/jpeg");
  assert.equal(got!.image.dataBase64, PNG1);
  assert.equal((got!.rest as any).image, undefined, "image is stripped from the rest");
  assert.equal((got!.rest as any).note, "a picture", "the rest keeps the other fields");
  // refusals
  assert.equal(extractToolResultImage({ ok: true, message: "hi" }), null, "no image field");
  assert.equal(extractToolResultImage({ image: { mediaType: "text/plain", dataBase64: "x" } }), null, "bad media type");
  assert.equal(extractToolResultImage({ image: { mediaType: "image/png" } }), null, "no data");
  assert.equal(extractToolResultImage(null), null);
  assert.equal(extractToolResultImage("a string"), null);
  assert.equal(extractToolResultImage([1, 2, 3]), null, "arrays are not image results");
  // media type is lowercased and png/webp accepted
  assert.equal(extractToolResultImage({ image: { mediaType: "IMAGE/PNG", dataBase64: "x" } })!.image.mediaType, "image/png");
  assert.ok(extractToolResultImage({ image: { mediaType: "image/webp", dataBase64: "x" } }));
});

test("anthropicToolResultBlock: an image becomes an array [text, image block] in the API's exact shape; text-only stays a string", () => {
  const block = anthropicToolResultBlock("tu_1", { ok: true, content: IMG }) as any;
  assert.equal(block.type, "tool_result");
  assert.equal(block.tool_use_id, "tu_1");
  assert.ok(Array.isArray(block.content));
  assert.equal(block.content[0].type, "text");
  assert.doesNotMatch(block.content[0].text, /dataBase64|image/, "the base64 is NOT in the text block");
  assert.match(block.content[0].text, /"note":"a picture"/);
  assert.equal(block.content[1].type, "image");
  assert.deepEqual(block.content[1].source, { type: "base64", media_type: "image/jpeg", data: PNG1 });
  // text-only
  const plain = anthropicToolResultBlock("tu_2", { ok: false, content: { error: "nope" } }) as any;
  assert.equal(typeof plain.content, "string");
  assert.match(plain.content, /"error":"nope"/);
  assert.equal(plain.is_error, true, "a failed tool marks is_error");
  // an ok text result has no is_error
  assert.equal((anthropicToolResultBlock("tu_3", { ok: true, content: { done: true } }) as any).is_error, undefined);
});

test("openai transport shape: the same extractor drives function_call_output text + a following input_image data URL", () => {
  // The loop pushes: function_call_output(output = JSON of rest), then a user input_image.
  const img = extractToolResultImage(IMG)!;
  const output = JSON.stringify(img.rest ?? null);
  assert.doesNotMatch(output, /dataBase64/, "the picture is not in the function_call_output text");
  const dataUrl = `data:${img.image.mediaType};base64,${img.image.dataBase64}`;
  assert.equal(dataUrl, `data:image/jpeg;base64,${PNG1}`);
});

test("boundContent: the screenshot survives (its own ceiling); the rest is still capped; an over-size image is dropped, never truncated", () => {
  const okImg = boundContent({ ok: true, note: "shot", image: { mediaType: "image/jpeg", dataBase64: "A".repeat(1000), width: 1280, height: 800 } }) as any;
  assert.equal(okImg.image.dataBase64.length, 1000, "the image passes through intact");
  assert.equal(okImg.image.width, 1280);
  assert.equal(okImg.note, "shot");
  // a huge NON-image result is still truncated as before
  const bigText = boundContent({ ok: true, blob: "x".repeat(200_000) }) as any;
  assert.equal(bigText.truncated, true);
  // an over-size image is DROPPED (act from the control list), not sliced into garbage
  const huge = boundContent({ ok: true, image: { mediaType: "image/jpeg", dataBase64: "A".repeat(MAX_IMAGE_CHARS + 1) } }) as any;
  assert.equal(huge.imageDropped, true);
  assert.equal(huge.image, undefined);
  // a small text-only result is returned unchanged
  assert.deepEqual(boundContent({ ok: true, x: 1 }), { ok: true, x: 1 });
  assert.equal(boundContent(undefined), null);
});
