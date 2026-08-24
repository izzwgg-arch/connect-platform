import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildOnboardingInviteEmail,
  queueOnboardingInviteEmail,
  ONBOARDING_INVITE_EMAIL_TYPE,
  ONBOARDING_INVITE_TENANT_ID,
} from "./inviteEmail";
import { buildJourneyPatterns } from "./journeyPatterns";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CLEAN = { ONBOARDING_LINK_ORIGIN: undefined, PUBLIC_PORTAL_URL: undefined, PORTAL_PUBLIC_URL: undefined, CONNECT_APP_URL: undefined, APP_PUBLIC_URL: undefined };

// ⛔ THE GUARD THAT MATTERS MOST. Every ADMIN_ALERT job is marked SKIPPED at the
// send door by the platform-wide alert mute, so an invitation on that type
// would build clean, log clean, and reach nobody at all.
test("the invitation is NEVER sent on the muted ADMIN_ALERT type", () => {
  assert.notEqual(ONBOARDING_INVITE_EMAIL_TYPE, "ADMIN_ALERT");
  assert.equal(ONBOARDING_INVITE_EMAIL_TYPE, "ONBOARDING_INVITE");
});

test("the link in the email is absolute — a relative path is useless in an inbox", () => {
  withEnv(CLEAN, () => {
    const mail = buildOnboardingInviteEmail({ publicToken: "Ic6nRr9vKQm2xTd4" });
    assert.match(mail.link, /^https:\/\//);
    assert.ok(mail.html.includes(mail.link), "the body carries the same absolute link");
    assert.ok(mail.text.includes(mail.link));
    assert.ok(!/href="\/onboarding/.test(mail.html), "no bare-path hrefs");
  });
});

test("the sign-up link says Loopcom while the platform default still says the old domain", () => {
  withEnv(CLEAN, () => {
    const mail = buildOnboardingInviteEmail({ publicToken: "abc" });
    assert.match(mail.link, /^https:\/\/app\.loopcom\.net\/onboarding\/abc$/);
  });
});

test("once the platform picks a canonical host, the invitation follows it rather than pinning loopcom for ever", () => {
  withEnv({ ...CLEAN, PUBLIC_PORTAL_URL: "https://app.example.com/" }, () => {
    const mail = buildOnboardingInviteEmail({ publicToken: "abc" });
    assert.equal(mail.link, "https://app.example.com/onboarding/abc");
  });
  withEnv({ ...CLEAN, ONBOARDING_LINK_ORIGIN: "https://signup.example.com" }, () => {
    assert.equal(buildOnboardingInviteEmail({ publicToken: "abc" }).link, "https://signup.example.com/onboarding/abc");
  });
});

test("the token is URL-encoded, so a token with an awkward character cannot break the link", () => {
  withEnv(CLEAN, () => {
    const mail = buildOnboardingInviteEmail({ publicToken: "a b&c" });
    assert.ok(mail.link.includes("a%20b%26c"));
  });
});

// ⛔ The billing shell is what carries the Outlook hardening. A hand-rolled
// invitation looks perfect in Gmail and arrives in Outlook as bare blue text.
test("it rides the hardened billing shell, so Outlook gets a real button", () => {
  withEnv(CLEAN, () => {
    const { html } = buildOnboardingInviteEmail({ publicToken: "abc", companyName: "Hanna Weber" });
    assert.ok(html.includes("v:roundrect"), "the VML button is the only thing Word's renderer paints");
    assert.ok(html.includes("[if mso]"), "the fixed-600px Outlook wrapper");
    assert.ok(html.toLowerCase().includes("<!doctype html>"));
  });
});

test("the wording matches the approved mock-up", () => {
  withEnv(CLEAN, () => {
    const mail = buildOnboardingInviteEmail({ publicToken: "abc", companyName: "Hanna Weber" });
    assert.equal(mail.subject, "Set up your Loopcom phone system");
    assert.ok(mail.html.includes("Your phone system is ready to set up"));
    assert.ok(mail.html.includes("Getting started"), "the eyebrow");
    assert.ok(mail.html.includes("Hi Hanna Weber,"));
    assert.ok(mail.html.includes("Start setting up"));
    assert.ok(mail.html.includes("This link is just for you"));
    assert.ok(mail.html.includes("Reply to this email"));
  });
});

test("with no name at all it still greets the customer like a person", () => {
  withEnv(CLEAN, () => {
    const mail = buildOnboardingInviteEmail({ publicToken: "abc" });
    assert.ok(mail.html.includes("Hi there,"));
    assert.ok(mail.text.includes("Hi there,"));
  });
});

test("a company name with markup in it cannot inject into the email", () => {
  withEnv(CLEAN, () => {
    const mail = buildOnboardingInviteEmail({ publicToken: "abc", companyName: '<script>alert(1)</script>' });
    assert.ok(!mail.html.includes("<script>"), "the name is escaped");
    assert.ok(mail.html.includes("&lt;script&gt;"));
  });
});

test("queueing writes one job, on the right type and tenant", async () => {
  const created: any[] = [];
  const db = { emailJob: { create: async (args: any) => created.push(args.data) } };
  const res = await withEnv(CLEAN, () => queueOnboardingInviteEmail(db as any, { publicToken: "abc", toEmail: "a@b.com" }));
  assert.equal(res.sent, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].type, ONBOARDING_INVITE_EMAIL_TYPE);
  assert.equal(created[0].tenantId, ONBOARDING_INVITE_TENANT_ID);
  assert.equal(created[0].toEmail, "a@b.com");
  assert.ok(created[0].textBody.includes("https://"), "the plain-text half carries the link too");
});

// ⛔ Losing the link the admin just created, because the mail server hiccuped,
// is worse than the failed send: the screen shows the link either way.
test("a failed send never throws, and still returns the link", async () => {
  const db = { emailJob: { create: async () => { throw new Error("smtp down"); } } };
  const res = await withEnv(CLEAN, () => queueOnboardingInviteEmail(db as any, { publicToken: "abc", toEmail: "a@b.com" }));
  assert.equal(res.sent, false);
  assert.match(res.error || "", /smtp down/);
  assert.match(res.link, /^https:\/\/.+\/onboarding\/abc$/);
});

test("no email address means no job — never a send to nowhere", async () => {
  let calls = 0;
  const db = { emailJob: { create: async () => { calls++; } } };
  const res = await withEnv(CLEAN, () => queueOnboardingInviteEmail(db as any, { publicToken: "abc", toEmail: "  " }));
  assert.equal(res.sent, false);
  assert.equal(res.error, "no_email");
  assert.equal(calls, 0);
});

// ── Source guards ───────────────────────────────────────────────────────────
// These read the routes' own source, because both defects they guard against
// are in the CALLER: a route that forgets the admin gate, and a resend that
// mints a fresh token. A unit test of the handler passes straight through both.
function routeSource(): string {
  return readFileSync(join(__dirname, "invitationRoutes.ts"), "utf8").replace(/\r\n/g, "\n");
}
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
    .join("\n");
}

test("every invitation route is behind the SUPER_ADMIN gate", () => {
  const src = stripComments(routeSource());
  const handlers = src.match(/app\.(get|post|delete)\(/g) || [];
  const gates = src.match(/await requireOwner\(req, reply\)/g) || [];
  assert.ok(handlers.length >= 7, `expected the seven routes, found ${handlers.length}`);
  assert.equal(gates.length, handlers.length, "one gate per route, no exceptions");
});

// ⛔ A fresh link per chase is exactly how this account ended up with eleven
// orphaned links nobody could match to a customer — and it would not even
// invalidate the old one, so the customer ends up holding two.
test("resend reuses the stored token and never mints a new one", () => {
  const src = stripComments(routeSource());
  const resend = src.slice(src.indexOf('/resend"'), src.indexOf('/story"'));
  assert.ok(resend.includes("row.publicToken"), "it sends the link that already exists");
  assert.ok(!resend.includes("secureToken()"), "a resend must never generate a token");
  assert.ok(!resend.includes("onboardingSubmission.create"), "a resend must never create a second sign-up");
});

test("the patterns aggregate uses medians, not averages", () => {
  const src = readFileSync(join(__dirname, "journeyPatterns.ts"), "utf8");
  assert.ok(src.includes("function median("), "medians survive one abandoned overnight tab; averages do not");
  // and prove it behaves that way on a stream with exactly that outlier in it
  const patterns = buildJourneyPatterns([
    { message: 'Reached "Contact" after 10s on "Company"' },
    { message: 'Reached "Contact" after 12s on "Company"' },
    { message: 'Reached "Contact" after 40000s on "Company"' },
  ]);
  assert.equal(patterns.stepTimings[0].medianSeconds, 12, "the overnight tab must not invent a problem");
  assert.equal(patterns.stepTimings[0].maxSeconds, 40000, "but it is still visible as the max");
});
