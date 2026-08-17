import assert from "node:assert/strict";
import test from "node:test";

import {
  PORT_COMPLETE_EMAIL_TYPE,
  buildPortCompleteEmail,
  formatTenDigitsForHumans,
  resolvePortCompleteRecipient,
} from "./portCompleteEmail";

const MATAMIM = { portedDid: "9293598299", tempDid: "7244198226" };

test("the type is never ADMIN_ALERT — that channel is muted and would never send", () => {
  // The one failure this whole feature exists to avoid: a customer email that
  // looks built, logs no error, and is dropped at the send door.
  assert.notEqual(PORT_COMPLETE_EMAIL_TYPE, "ADMIN_ALERT");
  assert.ok(PORT_COMPLETE_EMAIL_TYPE.length > 0);
});

test("formats a ten-digit number the way a person reads it", () => {
  assert.equal(formatTenDigitsForHumans("9293598299"), "(929) 359-8299");
  assert.equal(formatTenDigitsForHumans("19293598299"), "(929) 359-8299");
  assert.equal(formatTenDigitsForHumans("+1 929-359-8299"), "(929) 359-8299");
});

test("leaves a number it cannot parse alone rather than mangling it", () => {
  assert.equal(formatTenDigitsForHumans("12345"), "12345");
  assert.equal(formatTenDigitsForHumans(""), "");
  assert.equal(formatTenDigitsForHumans(null), "");
});

test("the subject and body name the real number", () => {
  const mail = buildPortCompleteEmail(MATAMIM);
  assert.equal(mail.subject, "Your number is live — (929) 359-8299");
  assert.ok(mail.html.includes("(929) 359-8299"));
  assert.ok(mail.text.includes("(929) 359-8299"));
});

test("tells them the temporary number is switched off, and names it", () => {
  const mail = buildPortCompleteEmail(MATAMIM);
  assert.ok(mail.html.includes("(724) 419-8226"));
  assert.ok(mail.html.includes("switched off"));
  assert.ok(mail.text.includes("(724) 419-8226"));
});

test("says nothing about a temporary number when there wasn't one", () => {
  // A hand-filed port can go straight to the real number. Telling that customer
  // to stop using a number they never had is worse than saying nothing.
  const mail = buildPortCompleteEmail({ portedDid: "9293598299" });
  assert.ok(!mail.html.includes("temporary number"));
  assert.ok(!mail.text.includes("temporary number"));
  assert.ok(!mail.html.includes("One thing:"));
  // The rest of the email still stands on its own.
  assert.ok(mail.html.includes("(929) 359-8299"));
  assert.ok(mail.text.includes("Just reply to this email."));
});

test("carries no Connect branding — the customer sees Loopcom", () => {
  const mail = buildPortCompleteEmail(MATAMIM);
  const all = `${mail.subject}\n${mail.html}\n${mail.text}`;
  assert.ok(!/Connect Communications/i.test(all));
  // ⛔ The rebrand test only ever checked the two-word form, which is how
  // "Your Connect payment is due in 3 days" survived in the autopay subject.
  // Check the bare word too, ignoring the logo URL's legacy host.
  const prose = all.replace(/https?:\/\/\S+/g, "");
  assert.ok(!/\bConnect\b/.test(prose), "found a bare 'Connect' in customer-facing copy");
  assert.ok(mail.html.includes("Loopcom"));
});

test("renders no billing chrome — no eyebrow, no billing footer, no support card", () => {
  const mail = buildPortCompleteEmail(MATAMIM);
  assert.ok(!mail.html.includes(">Billing</p>"));
  assert.ok(!mail.html.includes("Sent by Loopcom billing."));
  assert.ok(!mail.html.includes("Need help with billing?"));
  assert.ok(mail.html.includes("Sent by Loopcom."));
});

test("keeps the hardened shell — Outlook wrapper, 600px cap, light lock", () => {
  const mail = buildPortCompleteEmail(MATAMIM);
  assert.ok(mail.html.includes("<!--[if mso]>"));
  assert.ok(mail.html.includes("max-width:600px"));
  assert.ok(mail.html.includes('content="light"'));
  assert.ok(mail.html.includes("max-width: 620px") || mail.html.includes("max-width:620px"));
});

test("the plain-text version is actually plain", () => {
  const mail = buildPortCompleteEmail(MATAMIM);
  assert.ok(!/<[a-z/]/i.test(mail.text), "plain-text body still contains markup");
  assert.ok(!mail.text.includes("&amp;"));
});

test("a customer name with markup in it cannot inject into the email", () => {
  // Numbers are the only interpolated values, but they arrive from carrier data
  // and submission answers — neither is ours.
  const mail = buildPortCompleteEmail({
    portedDid: "9293598299",
    tempDid: "<script>alert(1)</script>",
  });
  assert.ok(!mail.html.includes("<script>"));
  assert.ok(mail.html.includes("&lt;script&gt;"));
});

// ── Who gets told ─────────────────────────────────────────────────────────────
//
// A sign-up with no contact email would otherwise mean the one person who most
// needs to know their number moved is the one person nobody tells.

function fakeDb(users: Array<{ tenantId: string; role: string; email: string; createdAt: Date }>) {
  return {
    user: {
      findFirst: async ({ where, orderBy }: any) => {
        const hits = users
          .filter((u) => u.tenantId === where.tenantId && u.role === where.role)
          .sort((a, b) => (orderBy?.createdAt === "asc" ? +a.createdAt - +b.createdAt : 0));
        return hits[0] || null;
      },
    },
  };
}

test("uses the sign-up's main contact when there is one", async () => {
  const r = await resolvePortCompleteRecipient(fakeDb([]), { mainEmail: "office@x.com", billingEmail: "pay@x.com" }, "t1");
  assert.deepEqual(r, { email: "office@x.com", source: "mainEmail" });
});

test("falls back to the billing email", async () => {
  const r = await resolvePortCompleteRecipient(fakeDb([]), { mainEmail: "  ", billingEmail: "pay@x.com" }, "t1");
  assert.deepEqual(r, { email: "pay@x.com", source: "billingEmail" });
});

test("falls back to the account admin when the sign-up carries no contact at all", async () => {
  const db = fakeDb([
    { tenantId: "t1", role: "TENANT_ADMIN", email: "owner@x.com", createdAt: new Date("2026-01-01") },
    { tenantId: "t1", role: "TENANT_ADMIN", email: "later@x.com", createdAt: new Date("2026-06-01") },
    { tenantId: "t1", role: "USER", email: "staff@x.com", createdAt: new Date("2025-01-01") },
  ]);
  const r = await resolvePortCompleteRecipient(db, { mainEmail: null, billingEmail: null }, "t1");
  // Oldest admin — onboarding promotes the first extension's owner, so on a
  // sign-up-built tenant that is the account owner, not a later addition.
  assert.deepEqual(r, { email: "owner@x.com", source: "tenantAdmin" });
});

test("never reaches for an ordinary user, and never another tenant's admin", async () => {
  const db = fakeDb([
    { tenantId: "t1", role: "USER", email: "staff@x.com", createdAt: new Date("2025-01-01") },
    { tenantId: "t2", role: "TENANT_ADMIN", email: "someone@else.com", createdAt: new Date("2025-01-01") },
  ]);
  const r = await resolvePortCompleteRecipient(db, { mainEmail: null, billingEmail: null }, "t1");
  assert.equal(r, null);
});

test("a database failure returns nobody rather than throwing into the port", async () => {
  const db = { user: { findFirst: async () => { throw new Error("db down"); } } };
  const r = await resolvePortCompleteRecipient(db, { mainEmail: null, billingEmail: null }, "t1");
  assert.equal(r, null);
});
