/**
 * STRESS + INVARIANTS for SMS reply-address resolution.
 *
 * A green unit suite proves the cases somebody thought of. This drives the
 * resolver EXHAUSTIVELY over every combination of a hostile candidate universe,
 * and drives the REAL job over seeded random mail, re-checking the safety
 * invariants after every single case.
 *
 * The invariants are the security contract, stated once:
 *   I1  a routed conversation was always PROVEN by a verifying signature
 *   I2  two or more proven conversations never route (unless References names
 *       exactly one of them)
 *   I3  unverified junk can never change WHERE a resolvable reply goes, and can
 *       never turn a resolvable reply into a refusal (the CC-veto attack)
 *   I4  case-variants of one address are one conversation, never two
 *   I5  a References hint can never route on its own, and can never select a
 *       conversation outside the proven set
 *   I6  nothing throws, whatever arrives in a header
 *   I7  resolution is deterministic
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { mintSmsReplyAddress, mintSmsReplySignature, resolveSmsReplyTarget, verifySmsReplySignature } from "./smsEmailReply";
import { SmsEmailReplyJob, type SmsReplyEmail } from "./smsEmailReplyJob";

const SECRET = "stress-secret-0123456789abcdef";
const DOMAIN = "loopcom.net";
const A = "cmthreadaaa111";
const B = "cmthreadbbb222";
const C = "cmthreadccc333"; // never presented as a capability

const resolve = (candidates: string[], hint?: string | null) =>
  resolveSmsReplyTarget({ candidates, replyDomain: DOMAIN, secret: SECRET, threadingHint: hint ?? null });

const validA = mintSmsReplyAddress(A, SECRET, DOMAIN);
const validB = mintSmsReplyAddress(B, SECRET, DOMAIN);

/** Candidate universe: the real shapes plus everything hostile we can think of. */
const UNIVERSE: Array<{ label: string; value: string; proves: string | null }> = [
  { label: "validA", value: validA, proves: A },
  { label: "validA.lowercased(MTA)", value: validA.toLowerCase(), proves: A },
  { label: "validA.uppercaseDomain", value: validA.replace("@" + DOMAIN, "@" + DOMAIN.toUpperCase()), proves: A },
  { label: "validB", value: validB, proves: B },
  { label: "validB.lowercased(MTA)", value: validB.toLowerCase(), proves: B },
  { label: "junkSigOnOurDomain", value: "sms+" + A + "." + "z".repeat(24) + "@" + DOMAIN, proves: null },
  { label: "junkThreadOnOurDomain", value: "sms+cmnope000." + "q".repeat(24) + "@" + DOMAIN, proves: null },
  { label: "validAforeignDomain", value: mintSmsReplyAddress(A, SECRET, "evil.example.com"), proves: null },
  { label: "bareMailbox", value: "sms@" + DOMAIN, proves: null },
  { label: "ordinaryPerson", value: "someone@example.com", proves: null },
];

/** Deterministic PRNG so any failure is reproducible from the printed seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

describe("resolveSmsReplyTarget - exhaustive over the candidate universe", () => {
  const HINTS: Array<string | null> = [
    null,
    "",
    "<sms-thread-" + A + "@sms.connectcomunications.com>",
    "<sms-thread-" + B + "@sms.connectcomunications.com>",
    "<sms-thread-" + C + "@sms.connectcomunications.com>",
    "<sms-thread-" + A + "@d> <sms-thread-" + B + "@d>",
    "<not-one-of-ours@example.com>",
    "sms-thread-@",
  ];

  it("holds every invariant across all 1024 subsets x 8 hints", () => {
    let checked = 0;
    let okCount = 0;
    let ambiguousCount = 0;
    for (let mask = 0; mask < 2 ** UNIVERSE.length; mask++) {
      const chosen = UNIVERSE.filter((_, i) => mask & (1 << i));
      const candidates = chosen.map((c) => c.value);
      const provenSet = new Set(chosen.map((c) => c.proves).filter(Boolean) as string[]);

      for (const hint of HINTS) {
        const r = resolve(candidates, hint);
        checked++;
        const ctx = () => "mask=" + mask + " hint=" + JSON.stringify(hint) + " [" + chosen.map((c) => c.label).join(",") + "]";

        // I6 - the shape is always well formed
        assert.ok(["ok", "none", "ambiguous"].includes(r.status), ctx());

        if (r.status === "ok") {
          okCount++;
          assert.ok(r.target, ctx());
          // I1 - routed only to a PROVEN conversation
          assert.ok(
            verifySmsReplySignature(r.target!.threadId, r.target!.sig, SECRET),
            "I1 violated - routed to an unproven conversation: " + ctx(),
          );
          assert.ok(provenSet.has(r.target!.threadId.toLowerCase()), "I1 set membership: " + ctx());
          // I5 - the hint never selects outside the proven set
          assert.notStrictEqual(r.target!.threadId.toLowerCase(), C, "I5 violated - hint routed to an unproven thread: " + ctx());
          // I2 - a single route means one proven conversation, or a hint chose
          if (provenSet.size > 1) assert.ok(r.usedThreadingHint, "I2 violated - multi-thread routed with no hint: " + ctx());
        } else if (r.status === "ambiguous") {
          ambiguousCount++;
          assert.ok(provenSet.size > 1, "ambiguous with " + provenSet.size + " proven: " + ctx());
          assert.strictEqual(r.target, null, ctx());
        } else {
          // "none" - must genuinely have had nothing proven
          assert.strictEqual(provenSet.size, 0, "I1 violated - refused a proven reply: " + ctx());
        }

        // I7 - deterministic
        const again = resolve(candidates, hint);
        assert.strictEqual(again.status, r.status, "I7: " + ctx());
        assert.strictEqual(again.target?.threadId ?? null, r.target?.threadId ?? null, "I7 target: " + ctx());
      }
    }
    assert.ok(okCount > 0 && ambiguousCount > 0, "the sweep must exercise both outcomes");
    console.log("      swept " + checked + " resolutions - ok:" + okCount + " ambiguous:" + ambiguousCount);
  });

  it("I4 - ANY mix of case-variants of ONE address is one conversation", () => {
    const variants = [validA, validA.toLowerCase(), validA.replace("@" + DOMAIN, "@" + DOMAIN.toUpperCase()), validA.toLowerCase()];
    for (let mask = 1; mask < 2 ** variants.length; mask++) {
      const chosen = variants.filter((_, i) => mask & (1 << i));
      const r = resolve(chosen);
      assert.strictEqual(r.status, "ok", "case-variants read as ambiguous: " + JSON.stringify(chosen));
      assert.strictEqual(r.threadIds.length, 1);
      assert.strictEqual(r.target!.threadId.toLowerCase(), A);
    }
  });

  it("I3 - junk can never move a target, nor turn a send into a refusal", () => {
    const junk = UNIVERSE.filter((u) => u.proves === null).map((u) => u.value);
    const base = resolve([validA]);
    assert.strictEqual(base.status, "ok");
    for (let mask = 0; mask < 2 ** junk.length; mask++) {
      const noise = junk.filter((_, i) => mask & (1 << i));
      const orders = [[validA].concat(noise), noise.concat([validA])];
      for (const order of orders) {
        const r = resolve(order);
        assert.strictEqual(r.status, "ok", "I3 violated - junk vetoed a real reply: " + JSON.stringify(order));
        assert.strictEqual(r.target!.threadId, base.target!.threadId, "I3 violated - junk moved the target");
      }
    }
  });

  it("I5 - a hint alone never routes", () => {
    const hints = ["<sms-thread-" + A + "@d>", "<sms-thread-" + B + "@d>", "sms-thread-" + A + "@"];
    for (const hint of hints) {
      assert.strictEqual(resolve([], hint).status, "none");
      assert.strictEqual(resolve(["someone@example.com"], hint).status, "none");
      assert.strictEqual(resolve(["sms+" + A + "." + "z".repeat(24) + "@" + DOMAIN], hint).status, "none");
    }
  });

  it("I6 - hostile and malformed input never throws", () => {
    const rand = rng(20260823);
    const goodSig = mintSmsReplySignature(A, SECRET);
    const nasty = [
      "", " ", "@", "sms+@x",
      "sms+" + A + ".@" + DOMAIN,
      "sms+." + "z".repeat(24) + "@" + DOMAIN,
      "sms+" + A + "." + "z".repeat(24),
      "sms+a.b@c@d",
      " ", "\n\r\t",
      "sms+" + "a".repeat(5000) + "." + "z".repeat(24) + "@" + DOMAIN,
      "sms+" + A + "." + "z".repeat(5000) + "@" + DOMAIN,
      "SMS+" + A + "." + goodSig + "@" + DOMAIN,
      "sms+" + A + "." + goodSig + "@" + DOMAIN + "‮",
      '"sms+' + A + "." + goodSig + '"@' + DOMAIN,
      "sms+" + A + "." + goodSig + "@" + DOMAIN + ".evil.com",
      "sms+" + A + "." + goodSig + "@sub." + DOMAIN,
    ];
    for (const n of nasty) {
      const r = resolve([n]);
      assert.ok(["ok", "none", "ambiguous"].includes(r.status), "bad status for " + JSON.stringify(n));
      if (r.status === "ok") {
        assert.ok(verifySmsReplySignature(r.target!.threadId, r.target!.sig, SECRET), "I1 violated by " + JSON.stringify(n));
        assert.strictEqual(r.target!.domain, DOMAIN, "routed on a look-alike domain: " + JSON.stringify(n));
      }
    }
    // 2000 random strings, then a flooded header, bounded time
    const started = Date.now();
    const big: string[] = [];
    for (let i = 0; i < 2000; i++) {
      let s = "";
      const len = Math.floor(rand() * 60);
      for (let j = 0; j < len; j++) s += String.fromCharCode(32 + Math.floor(rand() * 95));
      big.push(s);
      assert.ok(["ok", "none", "ambiguous"].includes(resolve([s]).status));
    }
    const r = resolve(big.concat([validA]));
    assert.strictEqual(r.status, "ok", "a real address buried in 2000 junk ones must still resolve");
    assert.ok(Date.now() - started < 15000, "resolution must stay fast under a flooded header");
  });
});

// -- the REAL job, driven over seeded random mail -----------------------------

const THREADS: Record<string, any> = {
  [A]: { id: A, type: "SMS", tenantId: "t1", externalSmsE164: "+18455551111", tenantSmsE164: "+18452441708", smsInboxOwnerUserId: "u1" },
  [B]: { id: B, type: "SMS", tenantId: "t1", externalSmsE164: "+18455552222", tenantSmsE164: "+18452441708", smsInboxOwnerUserId: "" },
};
const USER = { id: "u1", email: "owner@customer.com", role: "USER", tenantId: "t1", status: "ACTIVE" };

function makeJob() {
  const audits: Array<{ event: string; payload: any }> = [];
  const fetches: Array<{ url: string }> = [];
  let emails: SmsReplyEmail[] = [];
  const claims = new Set<string>();
  const db = {
    connectChatThread: { findUnique: async ({ where }: any) => THREADS[where.id] ?? null },
    user: { findUnique: async ({ where }: any) => (where.id === USER.id ? USER : null), findFirst: async () => null },
    contactPhone: { findFirst: async () => null },
    agentAuditLog: {
      count: async () => 0,
      findFirst: async ({ where }: any) => (claims.has(where?.payload?.equals) ? { id: "x" } : null),
    },
  };
  const job = new SmsEmailReplyJob({
    prisma: db as any,
    audit: {
      record: async (r: any) => {
        audits.push(r);
        if (r.event === "sms.reply_claimed") claims.add(r.payload.dedupeId);
      },
    } as any,
    notifier: { send: async () => ({ sent: true }) } as any,
    source: {
      poll: async (h: any) => {
        for (const e of emails) await h(e);
        return emails.length;
      },
    },
    replyDomain: () => DOMAIN,
    replySecret: () => SECRET,
    jwtSecret: () => "jwt-secret-0123456789abcdef00",
    apiBaseUrl: () => "http://api:3001",
    internalSecret: () => "internal",
    messageIdDomain: () => "sms.connectcomunications.com",
    fetchImpl: (async (url: string) => {
      fetches.push({ url: String(url) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }) as any,
    brandName: "Loopcom",
  });
  return { job, audits, fetches, setEmails: (e: SmsReplyEmail[]) => { emails = e; } };
}

describe("SmsEmailReplyJob - seeded chaos over real mail shapes", () => {
  it("300 random emails: never sends to an unproven conversation, never sends twice", async () => {
    const seed = 20260823;
    const rand = rng(seed);
    const pick = (xs: any[]) => xs[Math.floor(rand() * xs.length)];
    let sends = 0;

    for (let i = 0; i < 300; i++) {
      const h = makeJob();
      const n = 1 + Math.floor(rand() * 4);
      const chosen: Array<{ label: string; value: string; proves: string | null }> = [];
      for (let k = 0; k < n; k++) chosen.push(pick(UNIVERSE));
      const proven = new Set(chosen.map((c) => c.proves).filter(Boolean) as string[]);
      const hint = pick([undefined, "<sms-thread-" + A + "@d>", "<sms-thread-" + B + "@d>", "<sms-thread-" + C + "@d>", "garbage"]);

      const email: SmsReplyEmail = {
        id: String(i),
        messageId: "<chaos-" + i + "@mail.gmail.com>",
        from: pick(["owner@customer.com", "stranger@nowhere.com", "sales@iniimini.com", null]),
        to: chosen.map((c) => c.value),
        subject: pick(["Re: Text with Chaim", "", "Automatic reply: away"]),
        text: pick(["On my way now.\n\nOn Tue wrote:\n> hi", "ok", "   ", null]),
        html: null,
        headers: hint ? { references: hint } : {},
      };
      h.setEmails([email, email]); // the same mail twice in one pass - exactly-once must hold

      const sent = await h.job.runOnce();
      sends += sent;
      const ctx = "seed=" + seed + " i=" + i + " to=" + JSON.stringify(email.to) + " hint=" + hint;

      assert.ok(sent <= 1, "sent " + sent + " times for one email - " + ctx);
      assert.strictEqual(h.fetches.length, sent, "fetch count must equal send count - " + ctx);
      for (const f of h.fetches) {
        const m = /\/chat\/threads\/([^/]+)\/messages$/.exec(f.url);
        const isSystem = f.url.indexOf("sms-system-reply") !== -1;
        assert.ok(m || isSystem, "unexpected route " + f.url + " - " + ctx);
        if (m) {
          const threadId = decodeURIComponent(m[1]);
          assert.ok(proven.has(threadId), "SENT TO AN UNPROVEN CONVERSATION " + threadId + " - " + ctx);
        }
        if (proven.size > 1) assert.ok(hint && String(hint).indexOf("sms-thread-") !== -1, "multi-thread mail sent with no hint - " + ctx);
      }
      // C is never a capability in this universe - it must never be written to
      assert.ok(!h.fetches.some((f) => f.url.indexOf(C) !== -1), "routed to the never-proven thread - " + ctx);
      // every email leaves an audit trail
      assert.ok(h.audits.length > 0, "no audit written - " + ctx);
    }
    assert.ok(sends > 0, "the chaos run must actually send sometimes");
    console.log("      300 chaos emails, " + sends + " sends, 0 invariant violations");
  });
});
