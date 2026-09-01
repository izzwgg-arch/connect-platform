/**
 * Guards on the customer's half of the support loop — the badge and the two
 * answer buttons in the assistant widget.
 *
 * ⛔ These read the COMPONENT'S SOURCE on purpose. Every defect this file is
 * defending against is a property of what the component does — which endpoint it
 * calls, how often, and whether it gates on the auth token — and a unit test of
 * a helper passes straight through all of them.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = fs
  .readFileSync(path.join(process.cwd(), "components", "FloatingAssistant.tsx"), "utf8")
  // CRLF is the checkout default here; a multi-line LF pattern would match
  // nothing and read as "the code isn't there".
  .replace(/\r\n/g, "\n");

/** Executable lines only — several guards below would otherwise match a comment. */
const CODE = SRC.split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join("\n");

describe("the widget's support-update poll", () => {
  test("it polls the customer-facing route, not an admin one", () => {
    assert.match(CODE, /apiGet<[^>]*>\("\/support\/updates"\)/);
    assert.ok(!/\/admin\/support/.test(CODE), "the widget must never call an admin route");
  });

  test("⛔ it is gated on the auth token", () => {
    // A signed-out tab polling an authenticated route is how a customer's whole
    // office gets auto-banned at nginx (2026-08-17).
    assert.match(CODE, /if \(!hasBrowserAuthToken\(\)\) return;/);
  });

  test("⛔ the poll is minutes, not seconds", () => {
    // The voicemail flood: a widget poll runs on every page, for every customer,
    // forever. This is a note that arrives once a week at most.
    const m = CODE.match(/setInterval\(\(\) => void tick\(\), (\d+)\)/);
    assert.ok(m, "the update poll interval was not found");
    assert.ok(Number(m![1]) >= 60000, `poll is ${m![1]}ms — far too eager`);
  });

  test("the interval is cleared, so leaving the page stops it", () => {
    assert.match(CODE, /return \(\) => \{ stop = true; clearInterval\(t\); \};/);
  });
});

describe("what it shows and what it cannot", () => {
  test("⛔ the technical report is never referenced in the browser", () => {
    assert.ok(!/technicalReport/.test(SRC), "the widget referenced the internal report");
    assert.ok(!/heldReason|safetyIssues/.test(SRC), "the widget referenced operator-only fields");
  });

  test("it renders the plain-English message and the ticket it belongs to", () => {
    assert.match(CODE, /u\.message/);
    assert.match(CODE, /fa-upd-msg/);
  });

  test("it asks them to test it, in their words", () => {
    assert.match(SRC, /Yes, it&apos;s working/);
    assert.match(SRC, /No, still not right/);
  });

  test("both answers post a verdict to their own update", () => {
    assert.match(CODE, /\/support\/updates\/\$\{encodeURIComponent\(id\)\}\/verdict/);
    assert.match(CODE, /answerUpdate\(u\.id, "fixed"\)/);
    assert.match(CODE, /answerUpdate\(u\.id, "not_fixed"\)/);
  });

  test("⛔ a failed answer leaves the card up rather than pretending it landed", () => {
    // setAnswered runs only after the POST resolves. If it moved above the await,
    // a network failure would look to the customer like their answer was recorded.
    const fn = CODE.slice(CODE.indexOf("const answerUpdate"), CODE.indexOf("const answerUpdate") + 700);
    assert.ok(
      fn.indexOf("await apiPost") < fn.indexOf("setAnswered"),
      "the card is marked answered before the request succeeds",
    );
  });

  test("the badge counts what still needs the customer: unanswered updates + unread support messages", () => {
    // Widened 2026-09-01: direct messages from support joined the widget, and
    // an unread one must light the badge exactly like an unanswered update.
    assert.match(CODE, /unanswered\.length \+ unreadSupportMsgs\.length > 0 && \(/);
    assert.match(CODE, /updates\.filter\(\(u\) => !answered\[u\.id\]\)/);
    assert.match(CODE, /direction === "to_customer" && !m\.readAt && !readLocally\[m\.id\]/);
  });
});
