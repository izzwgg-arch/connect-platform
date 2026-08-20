/**
 * SmsEmailReplyJob — the decision layer of reply-to-text-back, driven end to
 * end against fakes. Every case here is a way a reply email must NOT become a
 * text (stranger, toggle off, auto-reply, empty body, double-processing), plus
 * the one way it must.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { createHmac } from "node:crypto";
import { SmsEmailReplyJob, type SmsReplyEmail } from "./smsEmailReplyJob";
import { mintSmsReplyAddress } from "./smsEmailReply";

const SECRET = "reply-secret-0123456789abcdef";
const JWT = "jwt-secret-0123456789abcdef00";
const DOMAIN = "loopcom.net";
const THREAD_ID = "cmthread123";
const USER = { id: "u1", email: "baila@customer.com", role: "USER", tenantId: "t1", smsEmailForwardEnabled: true, status: "ACTIVE" };

function makeEmail(overrides: Partial<SmsReplyEmail> = {}): SmsReplyEmail {
  return {
    id: "101",
    messageId: "<abc@mail.gmail.com>",
    from: USER.email,
    to: ["sms@loopcom.net", mintSmsReplyAddress(THREAD_ID, SECRET, DOMAIN)],
    subject: "Re: Text with Chaim",
    text: "On my way now.\n\nOn Tue, Aug 20, 2026 at 1:15 PM Loopcom Texts <sms@loopcom.net> wrote:\n> hi",
    html: null,
    headers: {},
    ...overrides,
  };
}

interface Harness {
  job: SmsEmailReplyJob;
  fetches: Array<{ url: string; init: any }>;
  notices: any[];
  audits: Array<{ event: string; payload: any }>;
  db: any;
  setEmails(emails: SmsReplyEmail[]): void;
  processedIds: string[];
  state: { fetchResponder: () => Promise<any> };
}

function makeHarness(opts: { user?: any; participant?: boolean; thread?: any; priorClaims?: string[] } = {}): Harness {
  const audits: Array<{ event: string; payload: any }> = [];
  const notices: any[] = [];
  const fetches: Array<{ url: string; init: any }> = [];
  const processedIds: string[] = [];
  let emails: SmsReplyEmail[] = [];
  const priorClaims = new Set(opts.priorClaims || []);
  const state = {
    fetchResponder: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, messageId: "m1" }) }),
  };

  const thread = "thread" in opts ? opts.thread : { id: THREAD_ID, type: "SMS", tenantId: "t1", externalSmsE164: "+18455551234", tenantSmsE164: "+18455557768" };
  const user = "user" in opts ? opts.user : USER;

  const db = {
    connectChatThread: {
      findUnique: async ({ where }: any) => (thread && where.id === thread.id ? thread : null),
    },
    user: {
      findFirst: async ({ where }: any) =>
        user && String(where.email.equals).toLowerCase() === user.email.toLowerCase() && user.status === "ACTIVE" ? user : null,
    },
    connectChatParticipant: {
      findFirst: async () => ((opts.participant ?? true) ? { id: "p1" } : null),
    },
    agentAuditLog: {
      findFirst: async ({ where }: any) => (priorClaims.has(where.payload.equals) ? { id: "claim1" } : null),
    },
    contactPhone: { findFirst: async () => ({ contact: { displayName: "Chaim Katz" } }) },
  };

  const job = new SmsEmailReplyJob({
    prisma: db,
    audit: {
      record: async (row: any) => {
        audits.push({ event: row.event, payload: row.payload });
        if (row.event === "sms.reply_claimed") priorClaims.add(row.payload.dedupeId);
        return true;
      },
    } as any,
    notifier: { send: async (mail: any) => (notices.push(mail), { sent: true }) } as any,
    source: {
      poll: async (handler) => {
        let n = 0;
        for (const e of emails) {
          if (await handler(e)) {
            processedIds.push(e.id);
            n++;
          }
        }
        return n;
      },
    },
    replyDomain: () => DOMAIN,
    replySecret: () => SECRET,
    jwtSecret: () => JWT,
    apiBaseUrl: () => "http://api:3001",
    messageIdDomain: () => DOMAIN,
    fetchImpl: (async (url: any, init: any) => {
      fetches.push({ url: String(url), init });
      return state.fetchResponder();
    }) as any,
    brandName: "Loopcom",
  });

  return {
    job, fetches, notices, audits, db, processedIds, state,
    setEmails: (e) => { emails = e; },
  };
}

function decodeJwtPayload(bearer: string): any {
  const token = bearer.replace(/^Bearer /, "");
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
}

describe("SmsEmailReplyJob", () => {
  it("happy path: a verified reply becomes a text through the real route, as the real person", async () => {
    const h = makeHarness();
    h.setEmails([makeEmail()]);
    const sent = await h.job.runOnce();
    assert.strictEqual(sent, 1);
    assert.strictEqual(h.fetches.length, 1);
    assert.strictEqual(h.fetches[0].url, `http://api:3001/chat/threads/${THREAD_ID}/messages`);
    // Quoted history was stripped; only the person's words go out.
    assert.deepStrictEqual(JSON.parse(h.fetches[0].init.body), { body: "On my way now." });
    // The JWT is minted for the REPLYING USER (attribution + permission checks).
    const claims = decodeJwtPayload(h.fetches[0].init.headers.authorization);
    assert.strictEqual(claims.sub, USER.id);
    assert.strictEqual(claims.tenantId, USER.tenantId);
    assert.strictEqual(claims.role, "USER");
    assert.ok(claims.exp - claims.iat <= 300, "token must be short-lived");
    // Signature is real HS256 with the api's secret.
    const [head, payload, sig] = h.fetches[0].init.headers.authorization.replace(/^Bearer /, "").split(".");
    const expect = createHmac("sha256", JWT).update(`${head}.${payload}`).digest("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    assert.strictEqual(sig, expect);
    assert.ok(h.audits.some((a) => a.event === "sms.reply_sent"));
    assert.deepStrictEqual(h.processedIds, ["101"]);
    assert.strictEqual(h.notices.length, 0);
  });

  it("a stranger's From gets nothing — no text, no notice, no oracle", async () => {
    const h = makeHarness({ user: null });
    h.setEmails([makeEmail({ from: "attacker@evil.com" })]);
    assert.strictEqual(await h.job.runOnce(), 0);
    assert.strictEqual(h.fetches.length, 0);
    assert.strictEqual(h.notices.length, 0);
    assert.ok(h.audits.some((a) => a.event === "sms.reply_refused" && a.payload.reason === "unknown_sender"));
    assert.deepStrictEqual(h.processedIds, ["101"], "still marked processed — never retried");
  });

  it("a user from ANOTHER tenant is a stranger here", async () => {
    const h = makeHarness({ user: { ...USER, tenantId: "t2" } });
    h.setEmails([makeEmail()]);
    assert.strictEqual(await h.job.runOnce(), 0);
    assert.strictEqual(h.fetches.length, 0);
    assert.strictEqual(h.notices.length, 0);
  });

  it("toggle off / not a participant → refused WITH a threaded notice", async () => {
    for (const [opts, reason] of [
      [{ user: { ...USER, smsEmailForwardEnabled: false } }, "sms_to_email_off"],
      [{ participant: false }, "not_a_participant"],
    ] as const) {
      const h = makeHarness(opts as any);
      h.setEmails([makeEmail()]);
      assert.strictEqual(await h.job.runOnce(), 0);
      assert.strictEqual(h.fetches.length, 0);
      assert.strictEqual(h.notices.length, 1, `${reason}: the person must be told`);
      assert.ok(h.audits.some((a) => a.event === "sms.reply_refused" && a.payload.reason === reason));
      // The notice threads into the same email conversation.
      assert.strictEqual(h.notices[0].headers.References, `<sms-thread-${THREAD_ID}@${DOMAIN}>`);
      assert.strictEqual(h.notices[0].subject, "Text with Chaim Katz");
      assert.strictEqual(h.notices[0].headers["Auto-Submitted"], "auto-replied");
    }
  });

  it("mail without a valid signed address is ignored quietly (spam to the mailbox)", async () => {
    const h = makeHarness();
    const forged = mintSmsReplyAddress(THREAD_ID, "wrong-secret", DOMAIN);
    h.setEmails([
      makeEmail({ id: "1", to: ["sms@loopcom.net"] }),
      makeEmail({ id: "2", to: [forged] }),
    ]);
    assert.strictEqual(await h.job.runOnce(), 0);
    assert.strictEqual(h.fetches.length, 0);
    assert.strictEqual(h.notices.length, 0);
    assert.ok(h.audits.some((a) => a.event === "sms.reply_ignored" && a.payload.reason === "no_reply_address"));
    assert.ok(h.audits.some((a) => a.event === "sms.reply_ignored" && a.payload.reason === "bad_signature"));
  });

  it("an out-of-office auto-reply is never texted to a customer", async () => {
    const h = makeHarness();
    h.setEmails([makeEmail({ headers: { "auto-submitted": "auto-replied" }, text: "I am out of the office until Monday." })]);
    assert.strictEqual(await h.job.runOnce(), 0);
    assert.strictEqual(h.fetches.length, 0);
    assert.ok(h.audits.some((a) => a.event === "sms.reply_ignored" && a.payload.reason === "auto_generated"));
  });

  it("an empty reply (nothing above the quote) is refused with a notice, not sent as ''", async () => {
    const h = makeHarness();
    h.setEmails([makeEmail({ text: "\n\nOn Tue, Aug 20, 2026 at 1:15 PM L <sms@loopcom.net> wrote:\n> hi" })]);
    assert.strictEqual(await h.job.runOnce(), 0);
    assert.strictEqual(h.fetches.length, 0);
    assert.strictEqual(h.notices.length, 1);
    assert.ok(h.audits.some((a) => a.event === "sms.reply_refused" && a.payload.reason === "empty_body"));
  });

  it("the same email is never texted twice — a prior claim wins over everything", async () => {
    const h = makeHarness({ priorClaims: ["<abc@mail.gmail.com>"] });
    h.setEmails([makeEmail()]);
    assert.strictEqual(await h.job.runOnce(), 0);
    assert.strictEqual(h.fetches.length, 0);
    assert.ok(h.audits.some((a) => a.event === "sms.reply_ignored" && a.payload.reason === "already_claimed"));
  });

  it("processing the same email twice in one pass sends once (claim is written before the POST)", async () => {
    const h = makeHarness();
    h.setEmails([makeEmail(), makeEmail()]);
    assert.strictEqual(await h.job.runOnce(), 1);
    assert.strictEqual(h.fetches.length, 1);
  });

  it("an api refusal becomes a notice carrying the api's own message", async () => {
    const h = makeHarness();
    h.state.fetchResponder = async () => ({ ok: false, status: 400, json: async () => ({ error: "SMS_SEND_DISABLED", message: "Texting is not enabled for your account." }) });
    h.setEmails([makeEmail()]);
    assert.strictEqual(await h.job.runOnce(), 0);
    assert.strictEqual(h.notices.length, 1);
    assert.ok(String(h.notices[0].text).includes("Texting is not enabled for your account."));
    assert.ok(h.audits.some((a) => a.event === "sms.reply_failed" && a.payload.reason === "api_refused"));
    assert.deepStrictEqual(h.processedIds, ["101"]);
  });

  it("an unreachable api tells the person immediately and NEVER auto-retries the send", async () => {
    const h = makeHarness();
    h.state.fetchResponder = async () => { throw new Error("fetch failed"); };
    h.setEmails([makeEmail()]);
    assert.strictEqual(await h.job.runOnce(), 0);
    assert.strictEqual(h.notices.length, 1);
    assert.ok(h.audits.some((a) => a.event === "sms.reply_failed" && a.payload.reason === "api_unreachable"));
    assert.deepStrictEqual(h.processedIds, ["101"], "marked processed — an ambiguous half-send must not replay");
  });

  it("a reply to a vanished or non-SMS thread is refused", async () => {
    const h = makeHarness({ thread: null });
    h.setEmails([makeEmail()]);
    assert.strictEqual(await h.job.runOnce(), 0);
    assert.ok(h.audits.some((a) => a.event === "sms.reply_refused" && a.payload.reason === "thread_gone"));
  });

  it("does nothing at all when the reply domain / secrets are unconfigured", async () => {
    const h = makeHarness();
    const job = new SmsEmailReplyJob({
      ...(h.job as any).deps,
      replyDomain: () => null,
      source: { poll: async () => { throw new Error("must not poll"); } },
    });
    assert.strictEqual(await job.runOnce(), 0);
  });
});
