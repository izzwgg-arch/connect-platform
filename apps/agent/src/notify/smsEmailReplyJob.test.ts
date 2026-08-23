/**
 * SmsEmailReplyJob — the decision layer of reply-to-text-back, driven end to end
 * against fakes.
 *
 * ⛔ THE RULE THIS FILE EXISTS TO PIN (changed 2026-08-21): the text goes out as
 * the THREAD'S OWN SMS ROUTING says, never as whoever the email came from. The
 * signature pins WHICH conversation; the conversation knows its phone number;
 * that number's routing knows the inbox. So a reply works from a forward, a
 * phone, or a personal account — and the From header decides nothing.
 *
 * The old behaviour (From must exactly equal a User.email) silently ate a real
 * customer's reply on 2026-08-20: cgreenfeld@trustbookkeepingny.com replied to a
 * text email that had been sent to cspilman@ and was dropped `unknown_sender`,
 * with no notice, while the thread itself recorded that the number routes to
 * cspilman. That case is test 2 below.
 *
 * Everything else here is a way a reply must NOT become a text — a forged
 * signature, an owner in another tenant, a disabled owner, a shared inbox, an
 * ambiguous address, an auto-reply, an empty body, a double-send, a flood.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { SmsEmailReplyJob, type SmsReplyEmail } from "./smsEmailReplyJob";
import { mintSmsReplyAddress } from "./smsEmailReply";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The REAL column names of AgentAuditLog, parsed from schema.prisma.
 *
 * ⛔ This exists because a fake that ignores its `where` clause cannot catch a
 * wrong field name. The flood cap was first written against `createdAt`, which
 * AgentAuditLog does not have; Prisma threw, a .catch swallowed it, the cap
 * silently never fired, and every test still passed. The fake now refuses any
 * field the real model does not have.
 */
const AGENT_AUDIT_LOG_FIELDS = (() => {
  const schema = readFileSync(join(__dirname, "../../../../packages/db/prisma/schema.prisma"), "utf8").replace(/\r\n/g, "\n");
  const block = /model AgentAuditLog \{([\s\S]*?)\n\}/.exec(schema);
  if (!block) throw new Error("could not find model AgentAuditLog in schema.prisma");
  return new Set(
    block[1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@") && !l.startsWith("///"))
      .map((l) => l.split(/\s+/)[0])
      .filter(Boolean),
  );
})();

function assertRealAuditFields(where: Record<string, unknown>) {
  for (const key of Object.keys(where || {})) {
    if (!AGENT_AUDIT_LOG_FIELDS.has(key)) {
      throw new Error(
        `Unknown argument \`${key}\`. Available options are marked with ?. (AgentAuditLog has no such field)`,
      );
    }
  }
}

const SECRET = "reply-secret-0123456789abcdef";
const JWT = "jwt-secret-0123456789abcdef00";
const DOMAIN = "loopcom.net";
const THREAD_ID = "cmthread123";

/** The inbox the thread's phone number routes to. */
const OWNER = { id: "u1", email: "cspilman@customer.com", role: "USER", tenantId: "t1", status: "ACTIVE" };
const THREAD = {
  id: THREAD_ID,
  type: "SMS",
  tenantId: "t1",
  externalSmsE164: "+18455551234",
  tenantSmsE164: "+18452441708",
  smsInboxOwnerUserId: OWNER.id,
};

function makeEmail(overrides: Partial<SmsReplyEmail> = {}): SmsReplyEmail {
  return {
    id: "101",
    messageId: "<abc@mail.gmail.com>",
    from: OWNER.email,
    to: ["sms@loopcom.net", mintSmsReplyAddress(THREAD_ID, SECRET, DOMAIN)],
    subject: "Re: Text with Chaim",
    text: "On my way now.\n\nOn Tue, Aug 20, 2026 at 1:15 PM Loopcom Texts <sms@loopcom.net> wrote:\n> hi",
    html: null,
    headers: {},
    ...overrides,
  };
}

function makeHarness(opts: { owner?: any; thread?: any; priorClaims?: string[]; sentLastHour?: number } = {}) {
  const audits: Array<{ event: string; payload: any }> = [];
  const notices: any[] = [];
  const fetches: Array<{ url: string; init: any }> = [];
  const processedIds: string[] = [];
  let emails: SmsReplyEmail[] = [];
  const priorClaims = new Set(opts.priorClaims || []);
  const state: { fetchResponder: () => Promise<any> } = {
    fetchResponder: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, messageId: "m1" }) }),
  };

  const thread = "thread" in opts ? opts.thread : THREAD;
  const owner = "owner" in opts ? opts.owner : OWNER;

  const db = {
    connectChatThread: {
      findUnique: async ({ where }: any) => (thread && where.id === thread.id ? thread : null),
    },
    user: {
      // ⛔ Looked up BY ID from the thread's routing — never by the email's From.
      findUnique: async ({ where }: any) => (owner && where.id === owner.id ? owner : null),
      // Only the PRE-2026-08-21 code called this (match the From against a
      // User row). Kept so the HEAD replay exercises the real old behaviour
      // instead of dying on a missing fake.
      findFirst: async ({ where }: any) =>
        owner && String(where?.email?.equals ?? "").toLowerCase() === owner.email.toLowerCase() && owner.status === "ACTIVE"
          ? { ...owner, smsEmailForwardEnabled: true }
          : null,
    },
    connectChatParticipant: { findFirst: async () => ({ id: "p1" }) },
    agentAuditLog: {
      findFirst: async ({ where }: any) => (priorClaims.has(where.payload.equals) ? { id: "claim1" } : null),
      count: async ({ where }: any) => {
        // Behaves like Prisma: an unknown field is a THROW, not a silent 0.
        assertRealAuditFields(where);
        return opts.sentLastHour ?? 0;
      },
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
    internalSecret: () => "internal-secret-for-tests",
    messageIdDomain: () => DOMAIN,
    fetchImpl: (async (url: any, init: any) => {
      fetches.push({ url: String(url), init });
      return state.fetchResponder();
    }) as any,
    brandName: "Loopcom",
  });

  return {
    job,
    fetches,
    notices,
    audits,
    processedIds,
    state,
    setEmails(next: SmsReplyEmail[]) {
      emails = next;
    },
    reason(event: string) {
      return audits.find((a) => a.event === event)?.payload?.reason;
    },
    has(event: string) {
      return audits.some((a) => a.event === event);
    },
  };
}

/** The `sub`/`tenantId` the job actually minted a token for. */
function tokenClaims(init: any): any {
  const bearer = String(init.headers.authorization).replace(/^Bearer /, "");
  const payload = bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

describe("SmsEmailReplyJob — routing decides the sender, not the From header", () => {
  it("a verified reply becomes a text, sent as the inbox the number routes to", async () => {
    const h = makeHarness();
    h.setEmails([makeEmail()]);
    assert.equal(await h.job.runOnce(), 1);
    assert.equal(h.fetches.length, 1);
    assert.match(h.fetches[0].url, new RegExp(`/chat/threads/${THREAD_ID}/messages$`));
    assert.equal(JSON.parse(h.fetches[0].init.body).body, "On my way now.");
    // Sent AS the routing owner.
    assert.equal(tokenClaims(h.fetches[0].init).sub, OWNER.id);
    assert.equal(tokenClaims(h.fetches[0].init).tenantId, THREAD.tenantId);
    assert.equal(h.has("sms.reply_sent"), true);
  });

  it("THE REGRESSION: a reply from a DIFFERENT address still sends, as the inbox owner", async () => {
    // The real 2026-08-20 drop: emailed to cspilman@, replied from cgreenfeld@.
    const h = makeHarness();
    h.setEmails([makeEmail({ from: "cgreenfeld@customer.com" })]);
    assert.equal(await h.job.runOnce(), 1, "the reply must be texted, not dropped");
    assert.equal(tokenClaims(h.fetches[0].init).sub, OWNER.id, "attributed to the inbox the number routes to");
    const sent = h.audits.find((a) => a.event === "sms.reply_sent")!;
    // The address that actually replied is recorded, for the trail.
    assert.equal(sent.payload.receivedFrom, "cgreenfeld@customer.com");
    assert.equal(sent.payload.sentAs, OWNER.email);
  });

  it("a reply from an unrelated personal account still sends — the address is the credential", async () => {
    const h = makeHarness();
    h.setEmails([makeEmail({ from: "someone.personal@gmail.com" })]);
    assert.equal(await h.job.runOnce(), 1);
    assert.equal(tokenClaims(h.fetches[0].init).sub, OWNER.id);
  });

  it("a FORGED signature sends nothing and says nothing", async () => {
    const h = makeHarness();
    h.setEmails([makeEmail({ to: ["sms@loopcom.net", `sms+${THREAD_ID}.AAAAAAAAAAAAAAAAAAAAAAAA@${DOMAIN}`] })]);
    assert.equal(await h.job.runOnce(), 0);
    assert.equal(h.fetches.length, 0);
    assert.equal(h.notices.length, 0, "no backscatter to a forger");
    assert.equal(h.reason("sms.reply_ignored"), "bad_signature");
  });

  it("mail with no reply address at all is ignored quietly", async () => {
    const h = makeHarness();
    h.setEmails([makeEmail({ to: ["sms@loopcom.net"] })]);
    assert.equal(await h.job.runOnce(), 0);
    assert.equal(h.fetches.length, 0);
    assert.equal(h.notices.length, 0);
    assert.equal(h.reason("sms.reply_ignored"), "no_reply_address");
  });

  it("TENANT LEAK LOCK: an inbox owner in ANOTHER tenant is refused, silently", async () => {
    const h = makeHarness({ owner: { ...OWNER, tenantId: "SOME-OTHER-TENANT" } });
    h.setEmails([makeEmail()]);
    assert.equal(await h.job.runOnce(), 0);
    assert.equal(h.fetches.length, 0, "must never send into another tenant");
    assert.equal(h.notices.length, 0);
    assert.equal(h.reason("sms.reply_refused"), "inbox_owner_tenant_mismatch");
  });

  it("an inbox owner who is not ACTIVE is refused", async () => {
    const h = makeHarness({ owner: { ...OWNER, status: "DISABLED" } });
    h.setEmails([makeEmail()]);
    assert.equal(await h.job.runOnce(), 0);
    assert.equal(h.fetches.length, 0);
    assert.equal(h.reason("sms.reply_refused"), "inbox_owner_inactive");
  });

  it("an inbox owner whose row is gone is refused", async () => {
    const h = makeHarness({ owner: null });
    h.setEmails([makeEmail()]);
    assert.equal(await h.job.runOnce(), 0);
    assert.equal(h.fetches.length, 0);
    assert.equal(h.reason("sms.reply_refused"), "inbox_owner_gone");
  });

  it("a SHARED inbox from an unknown address is TEXTED with no name, via the system door", async () => {
    const h = makeHarness({ thread: { ...THREAD, smsInboxOwnerUserId: "" } });
    h.setEmails([makeEmail({ from: "nobody@elsewhere.example" })]);
    assert.equal(await h.job.runOnce(), 1);
    assert.equal(h.fetches.length, 1);
    // The system door, not the per-user route.
    assert.match(h.fetches[0].url, /\/internal\/chat\/sms-system-reply$/);
    assert.equal(h.fetches[0].init.headers["x-cdr-secret"], "internal-secret-for-tests");
    // It carries a thread id and a message and NOTHING else — no tenant to forge.
    const body = JSON.parse(h.fetches[0].init.body);
    assert.deepEqual(Object.keys(body).sort(), ["body", "threadId"]);
    assert.equal(body.threadId, THREAD_ID);
    // Never a bearer token on this path.
    assert.equal(h.fetches[0].init.headers.authorization, undefined);
    const sent = h.audits.find((a) => a.event === "sms.reply_sent")!;
    assert.equal(sent.payload.userId, null);
    assert.equal(sent.payload.systemSend, true);
    assert.equal(sent.payload.receivedFrom, "nobody@elsewhere.example");
  });

  it("a system send that FAILS notifies nobody — there is no verified address", async () => {
    const h = makeHarness({ thread: { ...THREAD, smsInboxOwnerUserId: "" } });
    h.state.fetchResponder = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "FORBIDDEN", message: "nope" }),
    });
    h.setEmails([makeEmail({ from: "nobody@elsewhere.example" })]);
    assert.equal(await h.job.runOnce(), 0);
    assert.equal(h.notices.length, 0, "replying to the From would be an oracle");
    assert.equal(h.reason("sms.reply_failed"), "api_refused");
  });

  it("an OWNED inbox never uses the system door — it is sent as the person", async () => {
    const h = makeHarness();
    h.setEmails([makeEmail({ from: "anyone@elsewhere.example" })]);
    assert.equal(await h.job.runOnce(), 1);
    assert.doesNotMatch(h.fetches[0].url, /sms-system-reply/);
    assert.ok(String(h.fetches[0].init.headers.authorization).startsWith("Bearer "));
  });

  it("NO REGRESSION: a shared inbox still sends when the From IS one of our users", async () => {
    // 315 of 616 live threads are shared. They could already do this before
    // 2026-08-21 and must not lose it.
    const h = makeHarness({ thread: { ...THREAD, smsInboxOwnerUserId: "" } });
    h.setEmails([makeEmail({ from: OWNER.email })]);
    assert.equal(await h.job.runOnce(), 1);
    assert.equal(tokenClaims(h.fetches[0].init).sub, OWNER.id);
  });

  it("a shared inbox never ATTRIBUTES to a From from another tenant", async () => {
    // It still sends (the signed address is the credential) but it must not be
    // attributed to a user outside the thread's tenant — it goes out unnamed.
    const h = makeHarness({
      thread: { ...THREAD, smsInboxOwnerUserId: "" },
      owner: { ...OWNER, tenantId: "SOME-OTHER-TENANT" },
    });
    h.setEmails([makeEmail({ from: OWNER.email })]);
    assert.equal(await h.job.runOnce(), 1);
    assert.match(h.fetches[0].url, /sms-system-reply$/, "must not borrow another tenant's user");
    const sent = h.audits.find((a) => a.event === "sms.reply_sent")!;
    assert.equal(sent.payload.userId, null);
  });

  it("TWO different valid reply addresses is ambiguous and is refused, never resolved", async () => {
    const h = makeHarness();
    h.setEmails([
      makeEmail({
        to: [
          mintSmsReplyAddress(THREAD_ID, SECRET, DOMAIN),
          mintSmsReplyAddress("cmotherthread999", SECRET, DOMAIN),
        ],
      }),
    ]);
    assert.equal(await h.job.runOnce(), 0);
    assert.equal(h.fetches.length, 0);
    assert.equal(h.reason("sms.reply_ignored"), "ambiguous_reply_address");
  });

  it("⛔⛔ THE REGRESSION: Gmail's To: + lower-cased Delivered-To: copy still sends", async () => {
    // The exact shape measured on the live bridge mailbox 2026-08-23 for BOTH
    // real customer replies: one conversation, carried twice, second copy with
    // the whole local part flattened by the receiving MTA. The 08-21 build
    // counted those as two conversations and refused every real reply.
    const addr = mintSmsReplyAddress(THREAD_ID, SECRET, DOMAIN);
    assert.ok(/[A-Z]/.test(addr.split("@")[0]), "fixture must have upper-case in the local part or this test proves nothing");
    const h = makeHarness();
    h.setEmails([makeEmail({ to: ["sms@loopcom.net", addr, addr.toLowerCase()] })]);
    assert.equal(await h.job.runOnce(), 1, "a real Gmail reply must be sent");
    assert.equal(h.fetches.length, 1);
    assert.match(h.fetches[0].url, new RegExp(`/chat/threads/${THREAD_ID}/messages$`));
  });

  it("a reply whose ONLY surviving copy is the MTA-flattened one still sends", async () => {
    const addr = mintSmsReplyAddress(THREAD_ID, SECRET, DOMAIN);
    const h = makeHarness();
    h.setEmails([makeEmail({ to: ["sms@loopcom.net", addr.toLowerCase()] })]);
    assert.equal(await h.job.runOnce(), 1);
  });

  it("a made-up address CC'd alongside a real one cannot veto the reply", async () => {
    // Otherwise anyone who knows the pattern can permanently kill a customer's
    // replies just by CC'ing `sms+anything.<junk>@loopcom.net`.
    const h = makeHarness();
    h.setEmails([makeEmail({ to: [mintSmsReplyAddress(THREAD_ID, SECRET, DOMAIN), `sms+cmfake999.${"z".repeat(24)}@${DOMAIN}`] })]);
    assert.equal(await h.job.runOnce(), 1);
    assert.match(h.fetches[0].url, new RegExp(`/chat/threads/${THREAD_ID}/messages$`));
  });

  it("References picks between two PROVEN conversations instead of refusing", async () => {
    const h = makeHarness();
    h.setEmails([
      makeEmail({
        to: [mintSmsReplyAddress(THREAD_ID, SECRET, DOMAIN), mintSmsReplyAddress("cmotherthread999", SECRET, DOMAIN)],
        headers: { references: `<sms-thread-${THREAD_ID}@sms.connectcomunications.com>` },
      }),
    ]);
    assert.equal(await h.job.runOnce(), 1);
    assert.match(h.fetches[0].url, new RegExp(`/chat/threads/${THREAD_ID}/messages$`));
  });

  it("an address on our domain that proves nothing is 'bad_signature', not 'no_reply_address'", async () => {
    const h = makeHarness();
    h.setEmails([makeEmail({ to: [`sms+cmfake999.${"z".repeat(24)}@${DOMAIN}`] })]);
    assert.equal(await h.job.runOnce(), 0);
    assert.equal(h.fetches.length, 0);
    assert.equal(h.reason("sms.reply_ignored"), "bad_signature");
  });

  it("the SAME address repeated is not ambiguous", async () => {
    const addr = mintSmsReplyAddress(THREAD_ID, SECRET, DOMAIN);
    const h = makeHarness();
    h.setEmails([makeEmail({ to: [addr, addr, "sms@loopcom.net"] })]);
    assert.equal(await h.job.runOnce(), 1);
  });

  it("an out-of-office responder is never texted to a customer", async () => {
    const h = makeHarness();
    h.setEmails([makeEmail({ headers: { "auto-submitted": "auto-replied" } })]);
    assert.equal(await h.job.runOnce(), 0);
    assert.equal(h.fetches.length, 0);
    assert.equal(h.reason("sms.reply_ignored"), "auto_generated");
  });

  it("an empty reply is refused with a notice, never sent as ''", async () => {
    const h = makeHarness();
    h.setEmails([makeEmail({ text: "On Tue, Aug 20, 2026 at 1:15 PM Loopcom Texts <sms@loopcom.net> wrote:\n> hi" })]);
    assert.equal(await h.job.runOnce(), 0);
    assert.equal(h.fetches.length, 0);
    assert.equal(h.reason("sms.reply_refused"), "empty_body");
    assert.equal(h.notices.length, 1);
  });

  it("ANTI-ORACLE: the failure notice goes to the OWNER we hold, never to the address that replied", async () => {
    const h = makeHarness();
    h.setEmails([
      makeEmail({
        from: "stranger@elsewhere.example",
        text: "On Tue, Aug 20, 2026 at 1:15 PM Loopcom Texts <sms@loopcom.net> wrote:\n> hi",
      }),
    ]);
    await h.job.runOnce();
    assert.equal(h.notices.length, 1);
    assert.deepEqual(h.notices[0].to, [OWNER.email]);
    assert.ok(
      !JSON.stringify(h.notices[0]).includes("stranger@elsewhere.example"),
      "nothing goes back to the address that replied",
    );
  });

  it("a flood into one thread is capped", async () => {
    const h = makeHarness({ sentLastHour: 20 });
    h.setEmails([makeEmail()]);
    assert.equal(await h.job.runOnce(), 0);
    assert.equal(h.fetches.length, 0);
    assert.equal(h.reason("sms.reply_refused"), "rate_limited");
    assert.equal(h.notices.length, 1, "the owner is told, so it is not a silent drop");
  });

  it("the cap queries a REAL AgentAuditLog column — a wrong field must not be swallowed", async () => {
    // Regression for the bug this suite missed once: the cap was written
    // against `createdAt`, which AgentAuditLog does not have. Prisma threw, a
    // .catch swallowed it, and the cap silently never fired. The fake now
    // throws on an unknown field, so the send still happens (fail-open) BUT
    // the failure is audited rather than silent.
    const h = makeHarness({ sentLastHour: 999 });
    h.setEmails([makeEmail()]);
    await h.job.runOnce();
    assert.equal(
      h.has("sms.reply_rate_check_failed"),
      false,
      "the cap query must use real columns — an audited failure here means it does not",
    );
  });

  it("the same email is never texted twice — a prior claim wins over everything", async () => {
    const h = makeHarness({ priorClaims: ["<abc@mail.gmail.com>"] });
    h.setEmails([makeEmail()]);
    assert.equal(await h.job.runOnce(), 0);
    assert.equal(h.fetches.length, 0);
    assert.equal(h.reason("sms.reply_ignored"), "already_claimed");
  });

  it("processing the same email twice in one pass sends once (claim is written before the POST)", async () => {
    const h = makeHarness();
    h.setEmails([makeEmail(), makeEmail()]);
    assert.equal(await h.job.runOnce(), 1);
    assert.equal(h.fetches.length, 1);
  });

  it("an api refusal becomes a notice carrying the api's own message", async () => {
    const h = makeHarness();
    h.state.fetchResponder = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "FORBIDDEN", message: "You do not have permission to send texts." }),
    });
    h.setEmails([makeEmail()]);
    assert.equal(await h.job.runOnce(), 0);
    assert.equal(h.notices.length, 1);
    assert.match(String(h.notices[0].text), /permission to send texts/);
    assert.equal(h.reason("sms.reply_failed"), "api_refused");
  });

  it("an unreachable api tells the owner immediately and NEVER auto-retries the send", async () => {
    const h = makeHarness();
    h.state.fetchResponder = async () => {
      throw new Error("ECONNREFUSED");
    };
    h.setEmails([makeEmail()]);
    assert.equal(await h.job.runOnce(), 0);
    assert.equal(h.notices.length, 1);
    assert.equal(h.reason("sms.reply_failed"), "api_unreachable");
    // Claimed, and the mail is marked processed — an ambiguous half-send must
    // become a notice, never a duplicate text on the next pass.
    assert.equal(h.has("sms.reply_claimed"), true);
    assert.deepEqual(h.processedIds, ["101"]);
  });
});
