/**
 * STRESS + INVARIANTS for the FORWARD half of the SMS bridge (text -> email).
 *
 * This half carries ALL of the live traffic and had NO tests at all until
 * 2026-08-23. It is the path that reaches a customer's inbox, so the things
 * that matter are: nothing a stranger can type may escape into a mail header
 * or into the HTML, no inbound text is ever silently lost, and the
 * one-email-thread-per-number promise holds.
 *
 * Invariants:
 *   F1  the Subject never contains CR or LF          (mail-header injection)
 *   F2  nothing from a message body or a contact name reaches the HTML as markup
 *   F3  building an email never throws, for any input
 *   F4  the subject is stable per contact             (half of the threading)
 *   J1  every inbound row ends up STAMPED, or left for retry
 *   J2  a text is never emailed twice
 *   J3  only opted-in ACTIVE participants are ever recipients
 *   J4  the Reply-To verifies, and for THAT thread only
 *   J5  the threading root id is identical for every message of one thread
 *   J6  an SMTP failure leaves the row unstamped and records no "emailed"
 *   J7  the backlog guard lives in the QUERY (fresh window + unstamped only)
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { buildSmsEmail, messageIsRtl, formatSmsPhone, headerSafeName, type SmsEmailMessage } from "./smsEmail";
import { SmsEmailForwardJob } from "./smsEmailForwardJob";
import { mintSmsReplyAddress, parseSmsReplyAddress, verifySmsReplySignature } from "./smsEmailReply";

const SECRET = "forward-stress-secret-0123456789";
const DOMAIN = "loopcom.net";
const MSGDOM = "sms.connectcomunications.com";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * ⛔ The shared shell contributes exactly ONE legitimate `<img>` (the brand
 * logo), so "the html contains no img tag" is the WRONG assertion — it fires on
 * a perfectly good email. Count against a benign baseline instead: an injected
 * tag raises the count, the logo does not.
 */
const countImgs = (html: string) => (html.match(/<\s*img\b/gi) || []).length;
const ACTIVE_TAG_RE = /<\s*(script|iframe|object|embed|svg)\b/i;

const BASELINE_IMGS = countImgs(
  buildSmsEmail({
    contactName: "Benign",
    contactNumber: "+18455551234",
    yourNumber: "+18452441708",
    messages: [{ direction: "IN", body: "hello", at: new Date(1756000000000) }],
  }).html,
);

/** Everything a stranger could put in a text, plus everything a contact could be named. */
const BODIES: Array<{ label: string; value: string }> = [
  { label: "plain", value: "On my way now." },
  { label: "empty", value: "" },
  { label: "whitespace", value: "   \n\t  " },
  { label: "script tag", value: '<script>alert("xss")</script>' },
  { label: "img onerror", value: '<img src=x onerror="steal()">' },
  { label: "svg onload", value: "<svg onload=alert(1)>" },
  { label: "quotes+amp", value: 'He said "5 & 6" <b>now</b>' },
  { label: "crlf", value: "line1\r\nBcc: evil@example.com\r\n\r\nline2" },
  { label: "control chars", value: "a" + String.fromCharCode(0, 1, 7, 27) + "bcd" },
  { label: "yiddish (RTL)", value: "מיר זענען דא" },
  { label: "arabic (RTL)", value: "مرحبا بك" },
  { label: "mixed ltr+rtl", value: "call מיר back" },
  { label: "emoji", value: "📷 🚀 ok" },
  { label: "10k chars", value: "x".repeat(10000) },
  { label: "html entity", value: "&lt;already escaped&gt;" },
  { label: "url", value: "see https://example.com/a?b=1&c=2" },
];

const NAMES: Array<{ label: string; value: string | null }> = [
  { label: "null", value: null },
  { label: "plain", value: "Chaim Weiss" },
  { label: "crlf injection", value: "Bob\r\nBcc: evil@example.com" },
  { label: "lf injection", value: "Bob\nSubject: hijacked" },
  { label: "html", value: "<script>x</script>" },
  { label: "img injection", value: "<img src=x onerror=1>" },
  { label: "quotes", value: 'The "Big" Shop & Co' },
  { label: "rtl", value: "חיים" },
  { label: "very long", value: "N".repeat(3000) },
];

describe("buildSmsEmail - hostile input sweep", () => {
  it("F1/F2/F3/F4 hold across every body x every contact name", () => {
    let built = 0;
    for (const name of NAMES) {
      for (const body of BODIES) {
        const messages: SmsEmailMessage[] = [
          { direction: "OUT", body: "earlier outbound " + body.value.slice(0, 20), at: new Date(1756000000000) },
          { direction: "IN", body: body.value, at: new Date(1756000060000) },
        ];
        const ctx = "name=" + name.label + " body=" + body.label;

        // F3 - never throws
        const email = buildSmsEmail({
          contactName: name.value,
          contactNumber: "+18455551234",
          yourNumber: "+18452441708",
          messages,
          replyEnabled: true,
          brandName: "Loopcom",
        });
        built++;

        // F1 - the subject can never carry a header break
        assert.ok(!/[\r\n]/.test(email.subject), "F1 VIOLATED - header injection via subject: " + ctx);
        assert.ok(email.subject.length > 0, "empty subject: " + ctx);

        // F2 - nothing from untrusted text becomes markup
        assert.ok(!ACTIVE_TAG_RE.test(email.html), "F2 VIOLATED - an active tag was built from untrusted text: " + ctx);
        assert.strictEqual(countImgs(email.html), BASELINE_IMGS, "F2 VIOLATED - an img was injected: " + ctx);
        if (body.value.includes("<")) {
          assert.ok(!email.html.includes(body.value), "F2 VIOLATED - raw body reached the html: " + ctx);
          assert.ok(email.html.includes("&lt;"), "F2 - body angle bracket not escaped: " + ctx);
        }
        if (name.value && name.value.includes("<")) {
          assert.ok(!email.html.includes(name.value), "F2 VIOLATED - raw contact name in html: " + ctx);
        }

        assert.ok(typeof email.text === "string" && email.text.length > 0, "empty text part: " + ctx);
      }

      // F4 - the subject depends only on the contact, not on the messages
      const a = buildSmsEmail({ contactName: name.value, contactNumber: "+18455551234", yourNumber: "+1", messages: [{ direction: "IN", body: "one", at: new Date(1) }] });
      const b = buildSmsEmail({ contactName: name.value, contactNumber: "+18455551234", yourNumber: "+1", messages: [{ direction: "IN", body: "two", at: new Date(2) }] });
      assert.strictEqual(a.subject, b.subject, "F4 VIOLATED - subject varies per message, threading breaks: " + name.label);
    }
    console.log("      built " + built + " emails from hostile input, 0 violations");
  });

  it("F3 - random fuzz never throws, never breaks the subject, never injects markup", () => {
    const rand = rng(20260823);
    for (let i = 0; i < 1500; i++) {
      let s = "";
      const len = Math.floor(rand() * 120);
      for (let j = 0; j < len; j++) s += String.fromCharCode(Math.floor(rand() * 0x2000));
      const email = buildSmsEmail({
        contactName: rand() < 0.5 ? s : null,
        contactNumber: s.slice(0, 20),
        yourNumber: "+18452441708",
        messages: [{ direction: "IN", body: s, at: new Date(1756000000000) }],
        replyEnabled: rand() < 0.5,
      });
      assert.ok(!/[\r\n]/.test(email.subject), "F1 VIOLATED by fuzz iteration " + i);
      assert.ok(!ACTIVE_TAG_RE.test(email.html), "F2 VIOLATED by fuzz iteration " + i);
      assert.strictEqual(countImgs(email.html), BASELINE_IMGS, "F2 VIOLATED - img injected, fuzz iteration " + i);
    }
  });

  it("headerSafeName strips control characters and caps length", () => {
    assert.strictEqual(headerSafeName("Bob\r\nBcc: evil@example.com"), "Bob Bcc: evil@example.com");
    assert.strictEqual(headerSafeName("  spaced   out  "), "spaced out");
    assert.strictEqual(headerSafeName("plain"), "plain");
    assert.strictEqual(headerSafeName(null as any), "");
    assert.ok(headerSafeName("N".repeat(3000)).length <= 120);
    assert.strictEqual(headerSafeName("חיים"), "חיים", "a real name must pass through untouched");
  });

  it("RTL is decided PER MESSAGE, never once for the thread", () => {
    const email = buildSmsEmail({
      contactName: "Mixed",
      contactNumber: "+18455551234",
      yourNumber: "+18452441708",
      messages: [
        { direction: "IN", body: "plain english", at: new Date(1756000000000) },
        { direction: "OUT", body: "מיר זענען", at: new Date(1756000060000) },
      ],
    });
    assert.strictEqual((email.html.match(/dir="rtl"/g) || []).length, 1, "exactly the Yiddish bubble must be RTL");
    assert.strictEqual(messageIsRtl("hello"), false);
    assert.strictEqual(messageIsRtl("שלום"), true);
  });

  it("formatSmsPhone never throws and never returns empty", () => {
    for (const n of [null, "", "+18455551234", "8455551234", "18455551234", "+972501234567", "abc", "+".repeat(50)]) {
      const out = formatSmsPhone(n as any);
      assert.ok(typeof out === "string" && out.length > 0, "bad format for " + JSON.stringify(n));
    }
  });
});

// -- the REAL forward job over a fake database --------------------------------

const THREAD = {
  id: "cmfwdthread001",
  type: "SMS",
  tenantSmsE164: "+18452441708",
  externalSmsE164: "+18455551234",
  smsInboxOwnerUserId: "u1",
};

function makeHarness(opts: { smtpOk?: boolean; thread?: any; users?: any[]; tenant?: any } = {}) {
  const audits: Array<{ event: string; payload: any }> = [];
  const sends: any[] = [];
  const stamps: Array<{ id: string; error: string | null }> = [];
  const queries: any[] = [];
  let rows: any[] = [];
  const stamped = new Set<string>();
  const thread = "thread" in opts ? opts.thread : THREAD;
  const users = opts.users ?? [{ id: "u1", email: "owner@customer.com", smsEmailForwardEnabled: true, status: "ACTIVE" }];

  const prisma = {
    connectChatMessage: {
      findMany: async (args: any) => {
        queries.push(args);
        // the batch query is the one filtering on the stamp; the other is context
        if (args?.where && "emailForwardedAt" in args.where) return rows.filter((r) => !stamped.has(r.id));
        return rows.map((r) => ({ direction: "INBOUND", body: r.body, createdAt: r.createdAt, type: r.type }));
      },
      update: async ({ where, data }: any) => {
        stamps.push({ id: where.id, error: data.emailForwardError ?? null });
        stamped.add(where.id);
        return {};
      },
    },
    connectChatThread: { findUnique: async ({ where }: any) => (thread && where.id === thread.id ? thread : null) },
    connectChatParticipant: { findMany: async () => users.map((u) => ({ userId: u.id })) },
    user: {
      findMany: async ({ where }: any) =>
        users.filter((u) => u.smsEmailForwardEnabled && u.status === "ACTIVE" && where.id.in.includes(u.id)),
    },
    contactPhone: { findFirst: async () => null },
    // The footer names the recipient's own company. `opts.tenant` lets a test
    // make this lookup fail or come back empty — the email must still go.
    tenant: {
      findUnique: async () => {
        if (opts.tenant === "throws") throw new Error("db down");
        if ("tenant" in opts) return opts.tenant;
        return { name: "Trust Bookkeepings" };
      },
    },
  };

  const job = new SmsEmailForwardJob({
    prisma: prisma as any,
    audit: { record: async (r: any) => { audits.push(r); } } as any,
    notifier: {
      send: async (msg: any) => {
        const ok = opts.smtpOk !== false;
        if (ok) sends.push(msg);
        return { sent: ok };
      },
    } as any,
    messageIdDomain: () => MSGDOM,
    replyDomain: () => DOMAIN,
    replySecret: () => SECRET,
    brandName: "Loopcom",
  });

  return { job, audits, sends, stamps, queries, setRows: (r: any[]) => { rows = r; } };
}

const msg = (i: number, over: any = {}) => ({
  id: "m" + i,
  tenantId: "t1",
  threadId: THREAD.id,
  body: "message " + i,
  createdAt: new Date(Date.now() - 60_000),
  type: "TEXT",
  ...over,
});

describe("SmsEmailForwardJob - the live path, driven", () => {
  it("J7 - the backlog guard is in the QUERY, not in a later branch", async () => {
    const h = makeHarness();
    h.setRows([msg(1)]);
    await h.job.runOnce();
    const batch = h.queries.find((q) => q?.where && "emailForwardedAt" in q.where);
    assert.ok(batch, "no batch query was issued");
    assert.strictEqual(batch.where.emailForwardedAt, null, "must only consider unstamped rows");
    assert.strictEqual(batch.where.direction, "INBOUND", "must only forward INBOUND texts");
    assert.ok(batch.where.createdAt?.gte instanceof Date, "J7 VIOLATED - no fresh window: the whole SMS backlog is in scope");
    const ageMin = (Date.now() - batch.where.createdAt.gte.getTime()) / 60000;
    assert.ok(ageMin > 0 && ageMin <= 24 * 60, "fresh window looks wrong: " + ageMin + " min");
    assert.ok(typeof batch.take === "number" && batch.take > 0 && batch.take <= 100, "batch must be bounded");
  });

  it("the footer names the recipient's own company", async () => {
    const h = makeHarness();
    h.setRows([msg(1)]);
    await h.job.runOnce();
    assert.match(String(h.sends[0].html), /This email was sent on behalf of Trust Bookkeepings\./);
  });

  it("the tenant lookup can NEVER cost anyone their email", async () => {
    // Losing a company name off a footer is cosmetic; losing the text is not.
    for (const tenant of ["throws", null, { name: "" }, { name: "   " }] as const) {
      const h = makeHarness({ tenant });
      h.setRows([msg(1)]);
      await h.job.runOnce();
      assert.strictEqual(h.sends.length, 1, "the email did not go out for tenant=" + JSON.stringify(tenant));
      assert.match(String(h.sends[0].html), /This email was sent on behalf of your organization\./);
    }
  });

  it("J4 - the Reply-To verifies, and only for THAT thread", async () => {
    const h = makeHarness();
    h.setRows([msg(1)]);
    await h.job.runOnce();
    assert.strictEqual(h.sends.length, 1);
    const replyTo = h.sends[0].replyTo;
    assert.ok(replyTo, "no Reply-To - replies are impossible");
    const parsed = parseSmsReplyAddress(replyTo);
    assert.ok(parsed, "Reply-To is not a routable address: " + replyTo);
    assert.strictEqual(parsed!.threadId, THREAD.id);
    assert.ok(verifySmsReplySignature(parsed!.threadId, parsed!.sig, SECRET), "J4 VIOLATED - minted a signature the reply half will reject");
    assert.strictEqual(replyTo, mintSmsReplyAddress(THREAD.id, SECRET, DOMAIN), "mint drifted from the shared helper");
    assert.strictEqual(verifySmsReplySignature("cmotherthread", parsed!.sig, SECRET), false);
  });

  it("J5/J8 - every message of one thread shares a root id AND a subject", async () => {
    const h = makeHarness();
    h.setRows([msg(1), msg(2), msg(3)]);
    await h.job.runOnce();
    assert.strictEqual(h.sends.length, 3);
    assert.strictEqual(new Set(h.sends.map((s) => s.headers.References)).size, 1, "J5 VIOLATED - one thread would split into several email conversations");
    assert.strictEqual(new Set(h.sends.map((s) => s.subject)).size, 1, "J8 VIOLATED - subject varies, mail clients will split the thread");
    assert.match(String(h.sends[0].headers.References), new RegExp("^<sms-thread-" + THREAD.id + "@"));
    assert.strictEqual(new Set(h.sends.map((s) => s.messageId)).size, 3, "each message needs its own Message-ID");
  });

  it("J1/J2 - every row is stamped exactly once and never emailed twice", async () => {
    const h = makeHarness();
    h.setRows([msg(1), msg(2)]);
    await h.job.runOnce();
    await h.job.runOnce(); // a second pass must find nothing left
    assert.strictEqual(h.sends.length, 2, "J2 VIOLATED - a text was emailed twice");
    assert.strictEqual(h.stamps.length, 2, "J1 VIOLATED - a row was left unstamped");
    assert.deepStrictEqual(h.stamps.map((s) => s.error), [null, null]);
  });

  it("J3 - opted-out and inactive people are never emailed", async () => {
    const h = makeHarness({
      users: [
        { id: "u1", email: "yes@customer.com", smsEmailForwardEnabled: true, status: "ACTIVE" },
        { id: "u2", email: "optedout@customer.com", smsEmailForwardEnabled: false, status: "ACTIVE" },
        { id: "u3", email: "gone@customer.com", smsEmailForwardEnabled: true, status: "DISABLED" },
      ],
    });
    h.setRows([msg(1)]);
    await h.job.runOnce();
    assert.deepStrictEqual(h.sends[0].to, ["yes@customer.com"], "J3 VIOLATED - emailed someone who did not opt in");
  });

  it("J3 - nobody opted in means NO email and an explained stamp", async () => {
    const h = makeHarness({ users: [{ id: "u1", email: "x@y.com", smsEmailForwardEnabled: false, status: "ACTIVE" }] });
    h.setRows([msg(1)]);
    assert.strictEqual(await h.job.runOnce(), 0);
    assert.strictEqual(h.sends.length, 0);
    assert.strictEqual(h.stamps[0].error, "no_opted_in_recipients", "the reason must be recorded, not left blank");
  });

  it("J6 - an SMTP failure leaves the row for retry and claims nothing", async () => {
    const h = makeHarness({ smtpOk: false });
    h.setRows([msg(1)]);
    assert.strictEqual(await h.job.runOnce(), 0);
    assert.strictEqual(h.stamps.length, 0, "J6 VIOLATED - stamped despite the email never going out; the text is lost forever");
    assert.strictEqual(h.audits.filter((a) => a.event === "sms.emailed").length, 0, "must not claim it emailed");
  });

  it("a non-SMS thread is stamped with a reason, never emailed", async () => {
    const h = makeHarness({ thread: { ...THREAD, type: "DM" } });
    h.setRows([msg(1)]);
    await h.job.runOnce();
    assert.strictEqual(h.sends.length, 0);
    assert.strictEqual(h.stamps[0].error, "not_sms_thread");
  });

  it("chaos: 200 random inbound texts are never lost and never duplicated", async () => {
    const seed = 20260824;
    const rand = rng(seed);
    let totalSends = 0;
    for (let i = 0; i < 200; i++) {
      const smtpOk = rand() > 0.25;
      const optedIn = rand() > 0.2;
      const isSms = rand() > 0.1;
      const h = makeHarness({
        smtpOk,
        thread: isSms ? THREAD : { ...THREAD, type: "GROUP" },
        users: [{ id: "u1", email: "owner@customer.com", smsEmailForwardEnabled: optedIn, status: "ACTIVE" }],
      });
      const body = BODIES[Math.floor(rand() * BODIES.length)].value;
      const n = 1 + Math.floor(rand() * 3);
      h.setRows(Array.from({ length: n }, (_, k) => msg(k, { body, type: rand() > 0.85 ? "IMAGE" : "TEXT" })));

      await h.job.runOnce();
      totalSends += h.sends.length;
      const ctx = "seed=" + seed + " i=" + i + " smtpOk=" + smtpOk + " optedIn=" + optedIn + " isSms=" + isSms;

      // J1 - sent and stamped-clean must agree exactly
      assert.strictEqual(h.sends.length, h.stamps.filter((s) => s.error === null).length, "J1 VIOLATED - send/stamp mismatch: " + ctx);
      if (!smtpOk && optedIn && isSms) assert.strictEqual(h.stamps.length, 0, "J6 VIOLATED - stamped a text that never went out: " + ctx);
      // J2 - no duplicates within a pass
      assert.strictEqual(new Set(h.stamps.map((s) => s.id)).size, h.stamps.length, "J2 VIOLATED - stamped twice: " + ctx);
      for (const s of h.sends) {
        assert.ok(!/[\r\n]/.test(s.subject), "F1 VIOLATED in the live path: " + ctx);
        assert.ok(!ACTIVE_TAG_RE.test(s.html), "F2 VIOLATED in the live path: " + ctx);
        assert.strictEqual(countImgs(s.html), BASELINE_IMGS, "F2 VIOLATED - img injected in the live path: " + ctx);
        assert.ok(String(s.replyTo || "").endsWith("@" + DOMAIN), "Reply-To lost or off-domain: " + ctx);
      }
    }
    assert.ok(totalSends > 0, "the chaos run must actually send sometimes");
    console.log("      200 chaos passes, " + totalSends + " emails, 0 invariant violations");
  });
});
