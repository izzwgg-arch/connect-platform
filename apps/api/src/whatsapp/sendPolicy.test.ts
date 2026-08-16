import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateSend,
  isServiceWindowOpen,
  SERVICE_WINDOW_MS,
  type SendContext,
  type TemplateRef,
} from "./sendPolicy";

const NOW = new Date("2026-08-16T12:00:00.000Z");

function tpl(over: Partial<TemplateRef> = {}): TemplateRef {
  return { name: "reminder", category: "UTILITY", status: "APPROVED", ...over };
}

function ctx(over: Partial<SendContext> = {}): SendContext {
  return {
    now: NOW,
    numberIsLive: true,
    quality: "GREEN",
    lastInboundAt: new Date(NOW.getTime() - 60 * 60 * 1000), // 1h ago
    recipientOptedOutAt: null,
    recipientOptedInAt: new Date("2026-01-01T00:00:00.000Z"),
    templates: { reminder: tpl(), promo: tpl({ name: "promo", category: "MARKETING" }) },
    uniqueRecipientsInWindow: 0,
    tierLimit: 1000,
    ...over,
  };
}

function refusalCode(v: ReturnType<typeof evaluateSend>): string {
  return v.allowed ? "ALLOWED" : v.code;
}

// ---------------------------------------------------------------- window math

test("window is open inside 24h and closed outside it", () => {
  assert.equal(isServiceWindowOpen(NOW, new Date(NOW.getTime() - 1000)), true);
  assert.equal(isServiceWindowOpen(NOW, new Date(NOW.getTime() - SERVICE_WINDOW_MS + 1000)), true);
  assert.equal(isServiceWindowOpen(NOW, new Date(NOW.getTime() - SERVICE_WINDOW_MS)), false);
  assert.equal(isServiceWindowOpen(NOW, new Date(NOW.getTime() - SERVICE_WINDOW_MS - 1)), false);
});

test("never having messaged us closes the window", () => {
  assert.equal(isServiceWindowOpen(NOW, null), false);
});

test("small clock skew does not refuse a legitimate reply", () => {
  // Meta's inbound stamp can land slightly ahead of our clock.
  assert.equal(isServiceWindowOpen(NOW, new Date(NOW.getTime() + 2000)), true);
});

// ---------------------------------------------------------------- number gate

test("a number that is not live refuses everything", () => {
  const c = ctx({ numberIsLive: false });
  assert.equal(refusalCode(evaluateSend({ kind: "free_form", body: "hi" }, c)), "number_not_live");
  assert.equal(refusalCode(evaluateSend({ kind: "template", templateName: "reminder" }, c)), "number_not_live");
});

// ---------------------------------------------------------------- opt-out

test("opt-out refuses free-form even with the window wide open", () => {
  const c = ctx({ recipientOptedOutAt: new Date("2026-07-12T00:00:00.000Z") });
  assert.equal(refusalCode(evaluateSend({ kind: "free_form", body: "hi" }, c)), "recipient_opted_out");
});

test("opt-out refuses an approved utility template", () => {
  const c = ctx({ recipientOptedOutAt: new Date("2026-07-12T00:00:00.000Z") });
  assert.equal(refusalCode(evaluateSend({ kind: "template", templateName: "reminder" }, c)), "recipient_opted_out");
});

test("opt-out beats a live opt-in — the later refusal is not reachable by re-opting in server-side", () => {
  const c = ctx({
    recipientOptedOutAt: new Date("2026-07-12T00:00:00.000Z"),
    recipientOptedInAt: new Date("2026-08-01T00:00:00.000Z"),
  });
  assert.equal(refusalCode(evaluateSend({ kind: "template", templateName: "promo" }, c)), "recipient_opted_out");
});

// ---------------------------------------------------------------- free-form

test("free-form is allowed inside the window", () => {
  const v = evaluateSend({ kind: "free_form", body: "ready now" }, ctx());
  assert.equal(v.allowed, true);
  if (v.allowed) assert.equal(v.windowOpen, true);
});

test("free-form is refused once the window closes", () => {
  const c = ctx({ lastInboundAt: new Date(NOW.getTime() - SERVICE_WINDOW_MS - 1) });
  const v = evaluateSend({ kind: "free_form", body: "still there?" }, c);
  assert.equal(refusalCode(v), "window_closed_free_form");
});

test("free-form is refused when they have never written", () => {
  const c = ctx({ lastInboundAt: null });
  assert.equal(refusalCode(evaluateSend({ kind: "free_form", body: "hello" }, c)), "window_closed_free_form");
});

test("free-form inside the window ignores tier and quality", () => {
  // Replies are not template sends; they must not be blocked by a marketing problem.
  const c = ctx({ quality: "RED", tierLimit: 10, uniqueRecipientsInWindow: 10 });
  assert.equal(evaluateSend({ kind: "free_form", body: "yes" }, c).allowed, true);
});

// ---------------------------------------------------------------- templates

test("an unknown template name is refused", () => {
  assert.equal(
    refusalCode(evaluateSend({ kind: "template", templateName: "nope" }, ctx())),
    "template_unknown",
  );
});

test("a pending template is refused and says so", () => {
  const c = ctx({ templates: { reminder: tpl({ status: "PENDING" }) } });
  const v = evaluateSend({ kind: "template", templateName: "reminder" }, c);
  assert.equal(refusalCode(v), "template_not_approved");
  if (!v.allowed) assert.match(v.customerMessage, /still reviewing/i);
});

test("rejected, paused and disabled templates are all refused", () => {
  for (const status of ["REJECTED", "PAUSED", "DISABLED"] as const) {
    const c = ctx({ templates: { reminder: tpl({ status }) } });
    assert.equal(
      refusalCode(evaluateSend({ kind: "template", templateName: "reminder" }, c)),
      "template_not_approved",
      `status ${status} must refuse`,
    );
  }
});

test("an approved utility template sends outside the window — that is the point of templates", () => {
  const c = ctx({ lastInboundAt: null });
  assert.equal(evaluateSend({ kind: "template", templateName: "reminder" }, c).allowed, true);
});

// ---------------------------------------------------------------- marketing

test("marketing without a recorded opt-in is refused", () => {
  const c = ctx({ recipientOptedInAt: null });
  assert.equal(
    refusalCode(evaluateSend({ kind: "template", templateName: "promo" }, c)),
    "marketing_requires_opt_in",
  );
});

test("utility without an opt-in still sends", () => {
  // Reminders and order updates are not marketing; requiring marketing opt-in
  // for them would break the main use case.
  const c = ctx({ recipientOptedInAt: null });
  assert.equal(evaluateSend({ kind: "template", templateName: "reminder" }, c).allowed, true);
});

test("marketing is blocked below GREEN quality", () => {
  for (const quality of ["MEDIUM", "RED"] as const) {
    const c = ctx({ quality });
    assert.equal(
      refusalCode(evaluateSend({ kind: "template", templateName: "promo" }, c)),
      "marketing_blocked_low_quality",
      `quality ${quality} must block marketing`,
    );
  }
});

test("UNKNOWN quality blocks marketing — fail closed", () => {
  const c = ctx({ quality: "UNKNOWN" });
  assert.equal(
    refusalCode(evaluateSend({ kind: "template", templateName: "promo" }, c)),
    "marketing_blocked_low_quality",
  );
});

test("utility keeps flowing while quality is poor", () => {
  // A marketing problem must never silence appointment reminders.
  for (const quality of ["MEDIUM", "RED", "UNKNOWN"] as const) {
    const c = ctx({ quality });
    assert.equal(
      evaluateSend({ kind: "template", templateName: "reminder" }, c).allowed,
      true,
      `utility must still send at ${quality}`,
    );
  }
});

test("authentication templates are treated like utility, not marketing", () => {
  const c = ctx({
    quality: "RED",
    recipientOptedInAt: null,
    templates: { code: tpl({ name: "code", category: "AUTHENTICATION" }) },
  });
  assert.equal(evaluateSend({ kind: "template", templateName: "code" }, c).allowed, true);
});

// ---------------------------------------------------------------- tier

test("tier limit refuses at the ceiling, not before", () => {
  assert.equal(
    evaluateSend({ kind: "template", templateName: "reminder" }, ctx({ tierLimit: 100, uniqueRecipientsInWindow: 99 })).allowed,
    true,
  );
  assert.equal(
    refusalCode(evaluateSend({ kind: "template", templateName: "reminder" }, ctx({ tierLimit: 100, uniqueRecipientsInWindow: 100 }))),
    "tier_limit_reached",
  );
});

test("an unknown tier does not block a brand-new number", () => {
  const c = ctx({ tierLimit: null, uniqueRecipientsInWindow: 99999 });
  assert.equal(evaluateSend({ kind: "template", templateName: "reminder" }, c).allowed, true);
});

// ---------------------------------------------------------------- ordering

test("the refusal names the most fundamental cause, not an incidental one", () => {
  // Everything is wrong at once. The sender must be told they opted out —
  // not that the tier is full or the template is unapproved.
  const c = ctx({
    recipientOptedOutAt: new Date("2026-07-12T00:00:00.000Z"),
    quality: "RED",
    tierLimit: 1,
    uniqueRecipientsInWindow: 50,
    templates: { promo: tpl({ name: "promo", category: "MARKETING", status: "REJECTED" }) },
  });
  assert.equal(refusalCode(evaluateSend({ kind: "template", templateName: "promo" }, c)), "recipient_opted_out");
});

test("a dead number outranks even opt-out", () => {
  const c = ctx({ numberIsLive: false, recipientOptedOutAt: new Date("2026-07-12T00:00:00.000Z") });
  assert.equal(refusalCode(evaluateSend({ kind: "free_form", body: "x" }, c)), "number_not_live");
});

// ---------------------------------------------------------------- messaging

test("every refusal carries both a staff and a customer message, and they differ", () => {
  const cases: Array<[SendContext, Parameters<typeof evaluateSend>[0]]> = [
    [ctx({ numberIsLive: false }), { kind: "free_form", body: "x" }],
    [ctx({ recipientOptedOutAt: NOW }), { kind: "free_form", body: "x" }],
    [ctx({ lastInboundAt: null }), { kind: "free_form", body: "x" }],
    [ctx(), { kind: "template", templateName: "missing" }],
    [ctx({ templates: { reminder: tpl({ status: "REJECTED" }) } }), { kind: "template", templateName: "reminder" }],
    [ctx({ recipientOptedInAt: null }), { kind: "template", templateName: "promo" }],
    [ctx({ quality: "RED" }), { kind: "template", templateName: "promo" }],
    [ctx({ tierLimit: 1, uniqueRecipientsInWindow: 1 }), { kind: "template", templateName: "reminder" }],
  ];
  for (const [c, req] of cases) {
    const v = evaluateSend(req, c);
    assert.equal(v.allowed, false, `expected refusal for ${JSON.stringify(req)}`);
    if (!v.allowed) {
      assert.ok(v.staffMessage.length > 10, `staffMessage too short for ${v.code}`);
      assert.ok(v.customerMessage.length > 10, `customerMessage too short for ${v.code}`);
      assert.notEqual(v.staffMessage, v.customerMessage, `${v.code} must not show staff wording to the sender`);
    }
  }
});
