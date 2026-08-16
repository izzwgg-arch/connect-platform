import { test } from "node:test";
import assert from "node:assert/strict";
import { isEscalationReply, buildEscalationSms, parseReportSections, resolveEscalationUserName } from "./escalations";

// ── detection — matched against OUR OWN phrasings, from real transcripts ─────

test("real escalation replies from production transcripts are detected", () => {
  const realReplies = [
    // Trust Bookkeeping 2026-07-24 (prefix) / 07-28 (delete chat) / 08-04 (recording)
    "I will pass this request to our human support team. Here is a summary of what I will send them:",
    "Your request to delete this team chat has been passed to the human team for review.",
    "Sorry you’re having trouble listening to the recording. I’ve passed this to the human team for review.",
    "I’ve passed this to the human team: **extension 105 — phone not working**.",
    // engine canned fallbacks
    "I've received your message and passed it to our team — someone will follow up with you shortly.",
    "The support assistant is currently paused. Your message has been recorded and passed to the team.",
    "Your message has been recorded for the team. Logging out and back in usually fixes this.",
    // orchestrator fixed strings
    "This isn't something I can do for your account — I'll pass it to the team.",
    // Trimpro 2026-08-07 / Gesheft 2026-08-10
    "I’ve passed this request to the human team for review and handling.",
    "I’ve sent the request to our human team to help you reopen the mini view of the Connect app.",
    // ⛔ REGRESSION: missed LIVE on the first post-deploy test (2026-08-12) —
    // the model promised an escalation without naming a team after the verb.
    "I’m sorry—fax-line troubleshooting and repairs require our human team. I’ve passed along: **your fax machine stopped receiving faxes on the fax line yesterday**.",
    "I'll pass this along and our team will follow up with you.",
    "This has been escalated to a human who can help.",
  ];
  for (const reply of realReplies) {
    assert.equal(isEscalationReply(reply), true, `should detect: ${reply.slice(0, 60)}`);
  }
});

test("ordinary replies do NOT escalate", () => {
  const normal = [
    "Done — enable Do Not Disturb on ext 101.",
    "You missed 0 calls today. There was 1 answered outgoing call in the past 24 hours.",
    "Which hold music would you like? Your available options are: Main.",
    "On the Messages page, you can typically view your voicemail and other messages.",
    "The message was likely split because it exceeded the standard SMS length limit.",
    // mentions a team but promises nothing
    "Our team is available Monday through Friday.",
  ];
  for (const reply of normal) {
    assert.equal(isEscalationReply(reply), false, `should NOT detect: ${reply.slice(0, 60)}`);
  }
});

// ── SMS body — the owner's requirements verbatim ─────────────────────────────

test("the SMS carries tenant name, user name, issue and the ready fix", () => {
  const sms = buildEscalationSms({
    tenantName: "Trust Bookkeepings",
    userName: "Miss Spilman",
    userEmail: "cspilman@trustbookkeepingny.com",
    issue: "Caller-ID prefix is not working — her own number still shows when dialing with a prefix.",
    proposedFix: "Set the outbound caller ID for ext 106 to the Rose Leasing number (845-252-1213) on the prefix route.",
    degraded: false,
  });
  assert.match(sms, /Trust Bookkeepings/);
  assert.match(sms, /Miss Spilman/);
  assert.match(sms, /prefix is not working/i);
  assert.match(sms, /Fix ready:/);
  // ⛔ Was `assert.match(sms, /Reply OK/)`. Replying OK approves nothing — the
  // one-time FIX code does — so promising it in the text was actively wrong.
  assert.match(sms, /Full report emailed./);
  // Keep the text well under 5 SMS segments (~765 chars of GSM-7).
  assert.ok(sms.length <= 700, `sms too long: ${sms.length}`);
});

test("degraded research says so instead of inventing a fix", () => {
  const sms = buildEscalationSms({
    tenantName: "Gesheft",
    userName: "Unknown user",
    userEmail: null,
    issue: "Customer needs the mini view of the desktop app reopened.",
    proposedFix: "",
    degraded: true,
  });
  assert.match(sms, /research was unavailable/i);
  assert.doesNotMatch(sms, /Fix ready:/);
});

// ── report parsing ───────────────────────────────────────────────────────────

test("report sections parse from the researcher's format", () => {
  const text = [
    "ISSUE: The caller-ID prefix on ext 106 does not change the displayed number.",
    "FINDINGS: The tenant has one outbound route. No per-prefix caller ID rules exist.",
    "PROPOSED FIX: Add a caller-ID override for prefix 67 on the outbound route, pointing at 845-252-1213.",
    "APPROVAL: Saying okay authorizes adding that one caller-ID rule.",
  ].join("\n");
  const s = parseReportSections(text);
  assert.match(s.issue, /caller-ID prefix/);
  assert.match(s.findings, /one outbound route/);
  assert.match(s.proposedFix, /Add a caller-ID override/);
  assert.match(s.approval, /authorizes/);
});

// ── Naming the person (2026-08-16) ──────────────────────────────────────────
// A real escalation text reached the owner saying "Unknown user". The tenant
// name and the person's name are required content: he has to know who to call
// back without opening anything.

test("⛔ the escalation NEVER says 'Unknown user'", () => {
  for (const u of [null, undefined, {}, { firstName: null, lastName: null, email: null }]) {
    const name = resolveEscalationUserName(u as any);
    assert.doesNotMatch(name, /unknown user/i, `must not say Unknown user for ${JSON.stringify(u)}`);
    assert.ok(name.trim().length > 0, "and must always say something");
  }
});

test("a real person is named from first and last name", () => {
  assert.equal(resolveEscalationUserName({ firstName: "Sara", lastName: "Klein", email: "s@x.com" }), "Sara Klein");
});

test("a partial record still yields a usable name", () => {
  assert.equal(resolveEscalationUserName({ firstName: "Sara", lastName: null }), "Sara");
  assert.equal(resolveEscalationUserName({ displayName: "Front Desk" }), "Front Desk");
  assert.equal(resolveEscalationUserName({ email: "yossi@gesheft.com" }), "yossi");
});

test("nobody signed in is reported as a state of the world, not a mystery", () => {
  const name = resolveEscalationUserName(null);
  assert.match(name, /not signed in/i);
});

test("⛔ the SMS no longer promises that replying OK approves anything", () => {
  const sms = buildEscalationSms({
    tenantName: "Acme Ltd",
    userName: "Sara Klein",
    userEmail: "sara@acme.test",
    issue: "Their voicemail emails stopped.",
    proposedFix: "Add an address to mailbox 101.",
    degraded: false,
  });
  assert.doesNotMatch(sms, /reply ok/i, "an OK approves nothing — the FIX code does");
  assert.match(sms, /Company: Acme Ltd/);
  assert.match(sms, /User: Sara Klein \(sara@acme.test\)/);
});

test("the company and the person are always both present in the text", () => {
  const sms = buildEscalationSms({
    tenantName: "Gesheft",
    userName: resolveEscalationUserName(null),
    userEmail: null,
    issue: "x",
    proposedFix: "y",
    degraded: false,
  });
  assert.match(sms, /Company: Gesheft/);
  assert.match(sms, /User: not signed in/i);
});
