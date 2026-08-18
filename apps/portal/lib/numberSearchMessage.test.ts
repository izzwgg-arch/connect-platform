import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NUMBER_SEARCH_FAILED_MESSAGE, numberSearchEmptyMessage } from "./numberSearchMessage";

// ⛔ CRLF: Izzy's global core.autocrlf checks .ts / .tsx out with \r\n, so every
// literal-\n match below would miss on this machine and pass while guarding
// nothing. See CLAUDE.md "a source-reading guard test that fails ONLY on Windows".
const src = (rel: string) =>
  readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const WIZARD = "app/onboarding/[token]/page.tsx";

test("an area code with no stock is named, not left blank", () => {
  const m = numberSearchEmptyMessage({ query: "718", mode: "starts", tab: "local" });
  assert.equal(m, "Area code 718 is not available right now. Try a different area code.");
});

test("the area code is read from what the customer typed, punctuation and all", () => {
  assert.match(numberSearchEmptyMessage({ query: "(646)", mode: "starts", tab: "local" }), /Area code 646 is not available/);
});

test("a default (unset) mode is treated as 'starts', which is the wizard's default", () => {
  assert.match(numberSearchEmptyMessage({ query: "347", tab: "local" }), /Area code 347 is not available/);
});

test("longer digit patterns say where the digits were meant to sit", () => {
  assert.match(numberSearchEmptyMessage({ query: "4155", mode: "starts", tab: "local" }), /starting with 4155/);
  assert.match(numberSearchEmptyMessage({ query: "4155", mode: "contains", tab: "local" }), /containing 4155/);
  assert.match(numberSearchEmptyMessage({ query: "4155", mode: "ends", tab: "local" }), /ending in 4155/);
});

test("three digits under contains/ends is NOT called an area code", () => {
  // Only "starts" means an area code; 305 typed under "ends" is a suffix.
  assert.match(numberSearchEmptyMessage({ query: "305", mode: "ends", tab: "local" }), /ending in 305/);
  assert.doesNotMatch(numberSearchEmptyMessage({ query: "305", mode: "ends", tab: "local" }), /Area code/);
});

test("a blank search suggests the next thing to try instead of dead-ending", () => {
  assert.match(numberSearchEmptyMessage({ query: "", tab: "local" }), /Try searching for an area code/);
});

test("toll-free never advertises a non-existent area code", () => {
  const m = numberSearchEmptyMessage({ query: "833", mode: "starts", tab: "tollfree" });
  assert.doesNotMatch(m, /Area code/);
  assert.match(m, /toll-free numbers/);
});

test("a vanity word is quoted back so the customer can see what was searched", () => {
  const m = numberSearchEmptyMessage({ query: "", tab: "tollfree", vanity: "pizza" });
  assert.match(m, /"PIZZA"/);
  assert.match(m, /Try another word/);
});

test("every message tells the customer what to do next", () => {
  const cases: Array<Parameters<typeof numberSearchEmptyMessage>[0]> = [
    { query: "718", mode: "starts", tab: "local" },
    { query: "4155", mode: "contains", tab: "local" },
    { query: "", tab: "local" },
    { query: "833", tab: "tollfree" },
    { query: "", tab: "tollfree" },
    { query: "", tab: "tollfree", vanity: "pizza" },
  ];
  for (const c of cases) {
    const m = numberSearchEmptyMessage(c);
    assert.match(m, /Try /, `no next step offered for ${JSON.stringify(c)}`);
    assert.ok(m.length > 30, `message too terse for ${JSON.stringify(c)}`);
  }
});

test("an empty result NEVER borrows the try-again copy", () => {
  // The whole point of the split: "nothing in stock" must not read as an outage.
  const cases: Array<Parameters<typeof numberSearchEmptyMessage>[0]> = [
    { query: "718", mode: "starts", tab: "local" },
    { query: "", tab: "local" },
    { query: "", tab: "tollfree", vanity: "pizza" },
  ];
  for (const c of cases) {
    assert.notEqual(numberSearchEmptyMessage(c), NUMBER_SEARCH_FAILED_MESSAGE);
    assert.doesNotMatch(numberSearchEmptyMessage(c), /briefly busy/);
  }
});

// ── Call-site guards ────────────────────────────────────────────────────────
// ⛔ The defect was a CALLER: the helper could be perfect and the wizard would
// still render a blank space, because the results grid is gated on
// `numbers.length > 0` and nothing covered the empty case. A unit test of the
// function passes straight through that, so these read the page's source.

test("the wizard actually renders the empty-result message", () => {
  const w = src(WIZARD);
  assert.match(w, /numberSearchEmptyMessage\(/, "wizard never calls the helper");
  assert.match(w, /\{numbersNone\}/, "wizard never renders the empty message");
});

test("the wizard keeps 'found nothing' and 'search broke' in separate state", () => {
  const w = src(WIZARD);
  assert.match(w, /setNumbersNone\(/);
  assert.match(w, /setNumbersError\(/);
  // Reading the API's error field is what stops an outage rendering as
  // "not available" — the endpoint answers 200 either way.
  assert.match(w, /r\.error \|\| r\.note/, "wizard ignores the API's failure flag");
});

test("the retry copy lives in one place, not duplicated back into the page", () => {
  const w = src(WIZARD);
  assert.match(w, /NUMBER_SEARCH_FAILED_MESSAGE/);
  assert.doesNotMatch(w, /the number service may be briefly busy/, "retry copy re-inlined in the page");
});

test("the API reports a failed search instead of an innocent empty list", () => {
  const api = readFileSync(
    join(__dirname, "..", "..", "api", "src", "onboarding", "publicRoutes.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.match(api, /searchFailed = true/, "provider failure is still swallowed into []");
  assert.match(
    api,
    /if \(!numbers\.length && searchFailed\) return \{ numbers: \[\], error: "number_search_failed" \}/,
    "a failed search is not reported to the wizard",
  );
});

test("VoIP.ms 'unavailable_info' counts as empty stock, not a provider error", () => {
  // Proven live 2026-08-18: searchDIDsUSA answers unavailable_info for 305/212/786
  // while 845/562/929 return thousands of rows. Throwing on it made every
  // area-code search look like an outage.
  const prov = readFileSync(
    join(__dirname, "..", "..", "..", "packages", "integrations", "src", "index.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.match(prov, /no_result\|unavailable_info/);
});
