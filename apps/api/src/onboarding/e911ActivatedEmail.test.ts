import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  E911_ACTIVATED_EMAIL_TYPE,
  buildE911ActivatedEmail,
  formatRegisteredAddress,
  queueE911ActivatedEmail,
  resolveE911EmailRecipient,
} from "./e911ActivatedEmail";
import type { E911Address } from "./e911Address";

const ADDRESS: E911Address = {
  fullName: "Matamim",
  streetNumber: "15",
  streetName: "VAN BUREN DR",
  addressType: "",
  addressNumber: "",
  city: "KIRYAS JOEL V",
  state: "NY",
  zip: "10950",
  country: "US",
  email: "office@matamimweekly.com",
  otherInfo: "",
};

// ── The type ─────────────────────────────────────────────────────────────────

test("the email type is NOT ADMIN_ALERT — that channel is muted and reaches nobody", () => {
  // ⛔ The whole failure mode this guards: an ADMIN_ALERT builds clean, logs
  // clean, and is dropped at the send door with lastErrorCode ALERTS_MUTED.
  assert.notEqual(E911_ACTIVATED_EMAIL_TYPE, "ADMIN_ALERT");
  assert.equal(E911_ACTIVATED_EMAIL_TYPE, "E911_ACTIVATED");
});

// ── The wording Izzy picked ──────────────────────────────────────────────────

test("it says E911, in those words", () => {
  // Izzy, 2026-08-17: "the email should say E911 is set."
  const t = buildE911ActivatedEmail({ address: ADDRESS });
  assert.match(t.subject, /E911/);
  assert.match(t.html, /E911 is set on your phones/);
  assert.match(t.text, /E911 is set on your phones/);
});

test("it states the address a dispatcher would be given", () => {
  const t = buildE911ActivatedEmail({ address: ADDRESS });
  const line = "15 VAN BUREN DR, KIRYAS JOEL V, NY 10950";
  assert.equal(formatRegisteredAddress(ADDRESS), line);
  assert.ok(t.html.includes(line), "the HTML must show the address");
  assert.ok(t.text.includes(line), "the plain-text part must show it too");
});

test("a unit is included, and a missing one leaves no stray words", () => {
  assert.equal(
    formatRegisteredAddress({ ...ADDRESS, addressType: "Suite", addressNumber: "200" }),
    "15 VAN BUREN DR Suite 200, KIRYAS JOEL V, NY 10950",
  );
  assert.equal(formatRegisteredAddress(ADDRESS), "15 VAN BUREN DR, KIRYAS JOEL V, NY 10950");
});

test("option A stays short — no support card, no button", () => {
  const t = buildE911ActivatedEmail({ address: ADDRESS });
  assert.match(t.html, /reply to this email and we will fix it/i);
  // Option A carries no explanation paragraph — that is what B and C added.
  assert.ok(!/official town name/i.test(t.html), "option A does not explain the town correction");
  // The whole support path is a reply, so there must be no CTA button.
  assert.ok(!/<a [^>]*href="https?:\/\/[^"]*"[^>]*style="[^"]*background/i.test(t.html), "no CTA button in option A");
});

// ── The guard that matters ───────────────────────────────────────────────────

function fakeDb(row: any) {
  const created: any[] = [];
  const updates: any[] = [];
  return {
    created,
    updates,
    db: {
      onboardingSubmission: {
        findUnique: async () => row,
        update: async (a: any) => { updates.push(a); return row; },
      },
      emailJob: { create: async (a: any) => { created.push(a.data); return a.data; } },
      user: { findFirst: async () => null },
    },
  };
}

const REGISTERED_ROW = {
  id: "sub_1",
  mainEmail: "office@matamimweekly.com",
  createdTenantId: "tenant_1",
  answers: { provisioning: { e911: { did: "9293598299", status: "provisioned", address: ADDRESS } } },
};

test("it sends when 911 really is registered", async () => {
  const f = fakeDb(REGISTERED_ROW);
  const logs: string[] = [];
  const r = await queueE911ActivatedEmail({ db: f.db, submissionId: "sub_1", log: (m) => { logs.push(m); } });

  assert.equal(r.sent, true);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].type, "E911_ACTIVATED");
  assert.equal(f.created[0].toEmail, "office@matamimweekly.com");
  assert.equal(f.created[0].tenantId, "tenant_1", "billed to the customer's own tenant");
  assert.match(f.created[0].subject, /E911/);
});

test("⛔ it does NOT tell a customer E911 is set when it is not", async () => {
  // The one thing this email must never do. Every non-registered outcome.
  for (const status of ["address_invalid", "address_incomplete", "failed", "dry_run"]) {
    const f = fakeDb({ ...REGISTERED_ROW, answers: { provisioning: { e911: { status, address: ADDRESS } } } });
    const r = await queueE911ActivatedEmail({ db: f.db, submissionId: "sub_1", log: () => {} });
    assert.equal(r.sent, false, `${status} must not send`);
    assert.equal(f.created.length, 0, `${status} must queue no email`);
  }
});

test("registered but with no recorded address sends nothing — the address IS the email", async () => {
  const f = fakeDb({ ...REGISTERED_ROW, answers: { provisioning: { e911: { status: "provisioned", address: null } } } });
  const logs: string[] = [];
  const r = await queueE911ActivatedEmail({ db: f.db, submissionId: "sub_1", log: (m) => { logs.push(m); } });
  assert.equal(r.sent, false);
  assert.equal(f.created.length, 0);
  assert.match(logs.join(" "), /could not state it/i);
});

test("an already-registered number still gets the email", async () => {
  // A re-run carries no address of its own, which is why applyE911ForDid keeps
  // the earlier run's — without that this customer would never be told.
  const f = fakeDb({ ...REGISTERED_ROW, answers: { provisioning: { e911: { status: "already_registered", address: ADDRESS } } } });
  const r = await queueE911ActivatedEmail({ db: f.db, submissionId: "sub_1", log: () => {} });
  assert.equal(r.sent, true);
  assert.equal(f.created.length, 1);
});

test("it sends once — a re-run does not email the customer twice", async () => {
  const f = fakeDb({
    ...REGISTERED_ROW,
    answers: { provisioning: { e911: { status: "provisioned", address: ADDRESS, emailedAt: "2026-08-17T00:00:00Z" } } },
  });
  const r = await queueE911ActivatedEmail({ db: f.db, submissionId: "sub_1", log: () => {} });
  assert.equal(r.sent, false);
  assert.equal(r.reason, "already_emailed");
  assert.equal(f.created.length, 0);
});

test("sending stamps emailedAt so the next run is a no-op", async () => {
  const f = fakeDb(REGISTERED_ROW);
  await queueE911ActivatedEmail({ db: f.db, submissionId: "sub_1", log: () => {} });
  const stamped = f.updates[0]?.data?.answers?.provisioning?.e911?.emailedAt;
  assert.ok(stamped, "emailedAt must be written");
  assert.ok(f.updates[0].data.answers.provisioning.e911.address, "the rest of the record must survive the stamp");
});

test("a database failure never breaks a finished sign-up", async () => {
  const db: any = {
    onboardingSubmission: { findUnique: async () => REGISTERED_ROW, update: async () => { throw new Error("db down"); } },
    emailJob: { create: async () => { throw new Error("db down"); } },
    user: { findFirst: async () => null },
  };
  const logs: string[] = [];
  const r = await queueE911ActivatedEmail({ db, submissionId: "sub_1", log: (m) => { logs.push(m); } });
  assert.equal(r.sent, false);
  assert.equal(r.reason, "error");
  assert.match(logs.join(" "), /could not be queued/i);
});

// ── Who gets it ──────────────────────────────────────────────────────────────

test("recipient chain: main email, then billing, then the oldest admin", async () => {
  const db: any = { user: { findFirst: async () => ({ email: "owner@acme.test" }) } };
  assert.deepEqual(await resolveE911EmailRecipient(db, { mainEmail: "a@b.test", billingEmail: "c@d.test" }, "t1"), {
    email: "a@b.test", source: "mainEmail",
  });
  assert.deepEqual(await resolveE911EmailRecipient(db, { mainEmail: "", billingEmail: "c@d.test" }, "t1"), {
    email: "c@d.test", source: "billingEmail",
  });
  assert.deepEqual(await resolveE911EmailRecipient(db, { mainEmail: "", billingEmail: "" }, "t1"), {
    email: "owner@acme.test", source: "tenantAdmin",
  });
});

test("no reachable human returns null rather than throwing", async () => {
  const db: any = { user: { findFirst: async () => null } };
  assert.equal(await resolveE911EmailRecipient(db, { mainEmail: "", billingEmail: "" }, "t1"), null);
  assert.equal(await resolveE911EmailRecipient(db, { mainEmail: "", billingEmail: "" }, ""), null);
});

// ── The call site ────────────────────────────────────────────────────────────

test("the orchestrator actually sends it when a sign-up finishes", () => {
  // ⛔ Reads the CALLER's source. A builder with no caller is the exact shape of
  // half the bugs in this repo — and this one would look complete while no
  // customer ever heard that their E911 was set.
  const src = fs.readFileSync(path.join(__dirname, "setupOrchestrator.ts"), "utf8");
  assert.match(src, /import \{ queueE911ActivatedEmail \} from "\.\/e911ActivatedEmail"/);
  assert.match(src, /await queueE911ActivatedEmail\(\{/);
  // It must run after the system is actually live, not before.
  const doneAt = src.indexOf('setPbxStatus(submissionId, "done")');
  const emailAt = src.indexOf("await queueE911ActivatedEmail({");
  assert.ok(doneAt > 0 && emailAt > doneAt, "the email must be queued after setup is marked done");
});

test("applyE911ForDid records the address, or the email has nothing to state", () => {
  const src = fs.readFileSync(path.join(__dirname, "voipMsProvisioning.ts"), "utf8");
  assert.match(src, /address: result\.address \|\| prior\.address \|\| null/);
  assert.match(src, /emailedAt: prior\.emailedAt \|\| null/);
});
