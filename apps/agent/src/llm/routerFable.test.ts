/**
 * Fable in the model picker (Izzy, 2026-08-20: "do fabel as well").
 *
 * The wiring is deliberately tiny: `KNOWN_ANTHROPIC_CHAT_MODELS` is unioned
 * into the live Anthropic catalog before `filterChatModels` runs, so
 * claude-fable-5 is offerable whether or not the provider's models API lists
 * it for our key. These tests pin the three facts that make that true —
 * including a SOURCE guard on `listModels`, because a unit test of the filter
 * alone would pass straight through a caller that forgot the union (this
 * repo's most repeated defect shape).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { filterChatModels, KNOWN_ANTHROPIC_CHAT_MODELS } from "./router";

test("claude-fable-5 is a curated always-offered Anthropic chat model", () => {
  assert.ok(KNOWN_ANTHROPIC_CHAT_MODELS.includes("claude-fable-5"));
});

test("filterChatModels admits claude-fable-5 and dedupes the union", () => {
  const out = filterChatModels("anthropic", [
    "claude-sonnet-5",
    "claude-fable-5",
    ...KNOWN_ANTHROPIC_CHAT_MODELS, // duplicate on purpose — the union path
  ]);
  assert.ok(out.includes("claude-fable-5"));
  assert.equal(out.filter((id) => id === "claude-fable-5").length, 1);
});

test("listModels really unions the curated list (source guard on the caller)", () => {
  const src = readFileSync(path.join(__dirname, "router.ts"), "utf8").replace(/\r\n/g, "\n");
  const listModels = src.slice(src.indexOf("async listModels("));
  const anthropicBranch = listModels.slice(0, listModels.indexOf("async ping("));
  assert.ok(
    anthropicBranch.includes("KNOWN_ANTHROPIC_CHAT_MODELS"),
    "listModels no longer unions KNOWN_ANTHROPIC_CHAT_MODELS — Fable would vanish from the picker whenever the provider list omits it",
  );
});
