/**
 * LOAD + FAILURE-MODE stress for the FORWARD half of the SMS bridge.
 *
 * The sibling file (smsEmailForward.stress.test.ts) proves the CONTENT is safe.
 * This one attacks the pipeline itself: throughput, head-of-line blocking,
 * outages, crashes mid-send, re-entrancy, and the shapes that make an email
 * enormous or a recipient list absurd.
 *
 * Where a limit is real it is MEASURED and printed rather than asserted away —
 * a ceiling nobody has written down is a ceiling nobody can plan around.
 *
 *   L1  the burst ceiling is exactly MAX_BATCH x passes-in-window, and beyond it
 *       texts age out of the fresh window and are lost SILENTLY
 *   L2  a tenant with nobody opted in can never starve the tenants that are
 *   L3  a persistent SMTP outage is AUDITED (it used to return silently)
 *   L4  a crash between the send and the stamp duplicates, never loses
 *   L5  overlapping passes never double-send
 *   L6  one poisoned row never kills the rest of its batch
 *   L7  recipients are deduped, blanks dropped, and a huge list still sends once
 *   L8  a pathological thread cannot build an unbounded email
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { SmsEmailForwardJob } from "./smsEmailForwardJob";

const SECRET = "load-stress-secret-0123456789";
const DOMAIN = "loopcom.net";
const MSGDOM = "sms.connectcomunications.com";

/** The agent polls the forward job on a 30s timer (server.ts). */
const POLL_SECONDS = 30;

interface Row {
  id: string;
  tenantId: string;
  threadId: string;
  body: string;
  createdAt: Date;
  type: string;
}

interface HarnessOpts {
  smtpOk?: () => boolean;
  threads?: Record<string, any>;
  usersByThread?: Record<string, any[]>;
  stampThrowsFor?: Set<string>;
  processThrowsFor?: Set<string>;
  contextMessages?: number;
}

const THREAD_A = {
  id: "cmthreadA",
  type: "SMS",
  tenantId: "t1",
  tenantSmsE164: "+18452441708",
  externalSmsE164: "+18455551111",
  smsInboxOwnerUserId: "u1",
};
const THREAD_QUIET = {
  id: "cmthreadQuiet",
  type: "SMS",
  tenantId: "t2",
  tenantSmsE164: "+18452449999",
  externalSmsE164: "+18455552222",
  smsInboxOwnerUserId: "u9",
};

const OPTED_IN = [{ id: "u1", email: "owner@customer.com", smsEmailForwardEnabled: true, status: "ACTIVE" }];
const NOBODY = [{ id: "u9", email: "nobody@customer.com", smsEmailForwardEnabled: false, status: "ACTIVE" }];

function makeHarness(opts: HarnessOpts = {}) {
  const audits: Array<{ event: string; payload: any }> = [];
  const sends: any[] = [];
  const stamps: Array<{ id: string; error: string | null }> = [];
  const queries: any[] = [];
  let rows: Row[] = [];
  const stampedAt = new Map<string, Date>();
  const threads = opts.threads ?? { [THREAD_A.id]: THREAD_A, [THREAD_QUIET.id]: THREAD_QUIET };
  const usersByThread = opts.usersByThread ?? { [THREAD_A.id]: OPTED_IN, [THREAD_QUIET.id]: NOBODY };
  const smtpOk = opts.smtpOk ?? (() => true);

  // which thread a participant lookup is for — the job asks by threadId
  const usersFor = (threadId: string) => usersByThread[threadId] ?? OPTED_IN;

  const prisma = {
    connectChatMessage: {
      findMany: async (args: any) => {
        queries.push(args);
        if (args?.where && "emailForwardedAt" in args.where) {
          const since: Date | undefined = args.where.createdAt?.gte;
          const eligible = rows
            .filter((r) => !stampedAt.has(r.id))
            .filter((r) => !since || r.createdAt.getTime() >= since.getTime())
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          return eligible.slice(0, args.take ?? eligible.length);
        }
        // recent-context query for the bubbles
        const take = args?.take ?? 8;
        return rows.slice(-take).map((r) => ({ direction: "INBOUND", body: r.body, createdAt: r.createdAt, type: r.type }));
      },
      findUnique: async ({ where }: any) => ({ emailForwardedAt: stampedAt.get(where.id) ?? null }),
      update: async ({ where, data }: any) => {
        if (opts.stampThrowsFor?.has(where.id)) throw new Error("db write failed");
        stamps.push({ id: where.id, error: data.emailForwardError ?? null });
        stampedAt.set(where.id, new Date());
        return {};
      },
    },
    connectChatThread: {
      findUnique: async ({ where }: any) => {
        if (opts.processThrowsFor?.has(where.id)) throw new Error("thread lookup exploded");
        return threads[where.id] ?? null;
      },
    },
    connectChatParticipant: {
      findMany: async ({ where }: any) => usersFor(where.threadId).map((u: any) => ({ userId: u.id })),
    },
    user: {
      findMany: async ({ where }: any) => {
        const all = Object.values(usersByThread).flat() as any[];
        return all.filter((u) => u.smsEmailForwardEnabled && u.status === "ACTIVE" && where.id.in.includes(u.id));
      },
    },
    contactPhone: { findFirst: async () => null },
  };

  const job = new SmsEmailForwardJob({
    prisma: prisma as any,
    audit: { record: async (r: any) => { audits.push(r); } } as any,
    notifier: {
      send: async (msg: any) => {
        if (!smtpOk()) return { sent: false };
        sends.push(msg);
        return { sent: true };
      },
    } as any,
    messageIdDomain: () => MSGDOM,
    replyDomain: () => DOMAIN,
    replySecret: () => SECRET,
    brandName: "Loopcom",
  });

  return {
    job, audits, sends, stamps, queries, stampedAt,
    setRows: (r: Row[]) => { rows = r; },
    remaining: () => rows.filter((r) => !stampedAt.has(r.id)).length,
  };
}

const row = (i: number, threadId: string, ageMin = 0, over: Partial<Row> = {}): Row => ({
  id: "m" + i,
  tenantId: "t1",
  threadId,
  body: "message " + i,
  createdAt: new Date(Date.now() - ageMin * 60_000),
  type: "TEXT",
  ...over,
});

describe("forward pipeline - load", () => {
  it("L1 - the burst ceiling is MEASURED, and past it texts are lost silently", async () => {
    const h = makeHarness();
    const BURST = 1000;
    h.setRows(Array.from({ length: BURST }, (_, i) => row(i, THREAD_A.id)));

    // one pass tells us the real batch size
    await h.job.runOnce();
    const batchSize = h.sends.length;
    assert.ok(batchSize > 0, "the job emailed nothing at all");

    const passesInWindow = (30 * 60) / POLL_SECONDS; // FRESH_WINDOW_MIN default / poll interval
    const ceiling = batchSize * passesInWindow;

    // drive the rest of the window
    for (let p = 1; p < passesInWindow; p++) await h.job.runOnce();

    console.log(
      "      MEASURED: batch=" + batchSize + "/pass, poll=" + POLL_SECONDS + "s, window=30min" +
      " -> ceiling " + ceiling + " texts per window",
    );
    console.log("      burst of " + BURST + ": emailed " + h.sends.length + ", still queued " + h.remaining());

    assert.strictEqual(h.sends.length, Math.min(BURST, ceiling), "throughput is not batch x passes");
    if (BURST > ceiling) {
      assert.ok(h.remaining() > 0, "expected a residue past the ceiling");
      // ⛔ THE POINT: those remaining rows are now older than the fresh window,
      //    so the very next query EXCLUDES them. They are never emailed and
      //    never stamped - the only trace is emailForwardedAt staying null.
      const aged = makeHarness();
      aged.setRows(Array.from({ length: 5 }, (_, i) => row(i, THREAD_A.id, 31)));
      assert.strictEqual(await aged.job.runOnce(), 0, "a text past the window must not be emailed");
      assert.strictEqual(aged.stamps.length, 0, "and it is not stamped either - it is silently abandoned");
    }
  });

  it("L2 - a tenant with nobody opted in can never starve one that is", async () => {
    // 400 older messages for a tenant where nobody wants email, then 20 real ones.
    const h = makeHarness();
    const quiet = Array.from({ length: 400 }, (_, i) => row(i, THREAD_QUIET.id, 20));
    const real = Array.from({ length: 20 }, (_, i) => row(1000 + i, THREAD_A.id, 5));
    h.setRows([...quiet, ...real]);

    let passes = 0;
    while (h.sends.length < 20 && passes < 200) { await h.job.runOnce(); passes++; }

    console.log("      400 no-recipient texts ahead of 20 real ones: cleared in " + passes + " passes");
    assert.strictEqual(h.sends.length, 20, "L2 VIOLATED - the real texts were starved");
    // they are only unblocked because a no-recipient row IS stamped; if it were
    // left unstamped it would sit at the head of the ascending batch forever.
    assert.ok(
      h.stamps.filter((s) => s.error === "no_opted_in_recipients").length >= 400,
      "L2 VIOLATED - skipped rows must be stamped or they block the queue head",
    );
  });
});

describe("forward pipeline - failure modes", () => {
  it("L3 - a persistent SMTP outage is AUDITED, once per pass", async () => {
    const h = makeHarness({ smtpOk: () => false });
    h.setRows(Array.from({ length: 8 }, (_, i) => row(i, THREAD_A.id)));

    await h.job.runOnce();
    const failures = h.audits.filter((a) => a.event === "sms.email_send_failed");
    assert.strictEqual(failures.length, 1, "L3 VIOLATED - an SMTP outage must leave exactly one audit row per pass");
    assert.strictEqual(failures[0].payload.failed, 8, "the audit must say how many were refused");
    assert.strictEqual(h.stamps.length, 0, "nothing may be stamped - the texts must stay retryable");
    assert.strictEqual(h.sends.length, 0);

    // three more passes => three more rows, never one per message
    await h.job.runOnce();
    await h.job.runOnce();
    assert.strictEqual(h.audits.filter((a) => a.event === "sms.email_send_failed").length, 3);
  });

  it("L3b - a healthy pass writes NO send-failure row", async () => {
    const h = makeHarness();
    h.setRows([row(1, THREAD_A.id)]);
    await h.job.runOnce();
    assert.strictEqual(h.audits.filter((a) => a.event === "sms.email_send_failed").length, 0);
    // and a deliberate skip is not a send failure either
    const q = makeHarness();
    q.setRows([row(1, THREAD_QUIET.id)]);
    await q.job.runOnce();
    assert.strictEqual(q.audits.filter((a) => a.event === "sms.email_send_failed").length, 0,
      "a no-recipient skip must not look like an outage");
  });

  it("L4 - a failed stamp costs ONE duplicate at most, not a whole window of them", async () => {
    // The stamp is written AFTER the email goes out - deliberately, so a crash
    // duplicates rather than loses. But an unstamped row is re-selected on every
    // pass, so before the in-process guard a single failed write meant the SAME
    // text emailed once per pass until it aged out: 60 copies at a 30s poll.
    const h = makeHarness({ stampThrowsFor: new Set(["m1"]) });
    h.setRows([row(1, THREAD_A.id)]);
    const passesInWindow = (30 * 60) / POLL_SECONDS;
    for (let p = 0; p < passesInWindow; p++) await h.job.runOnce();

    console.log("      stamp fails for a whole 30-min window (" + passesInWindow + " passes) -> " + h.sends.length + " email(s)");
    assert.strictEqual(h.sends.length, 1, "L4 VIOLATED - the customer got " + h.sends.length + " copies of one text");
    assert.ok(
      h.audits.some((a) => a.event === "sms.email_stamp_failed"),
      "a stamp failure must be audited - it used to be swallowed entirely",
    );
  });

  it("L4b - once the database recovers, the stamp lands and nothing is re-sent", async () => {
    const failing = new Set(["m1"]);
    const h = makeHarness({ stampThrowsFor: failing });
    h.setRows([row(1, THREAD_A.id)]);
    await h.job.runOnce();
    assert.strictEqual(h.sends.length, 1);
    assert.strictEqual(h.stamps.length, 0, "the stamp was supposed to fail");
    failing.delete("m1"); // database comes back
    await h.job.runOnce();
    assert.strictEqual(h.sends.length, 1, "L4b VIOLATED - re-sent instead of re-stamping");
    assert.strictEqual(h.stamps.length, 1, "L4b VIOLATED - the stamp was never retried");
    assert.strictEqual(h.stamps[0].id, "m1");
  });

  it("L4c - the guard is bounded: it cannot grow past one window of throughput", async () => {
    const h = makeHarness();
    h.setRows(Array.from({ length: 200 }, (_, i) => row(i, THREAD_A.id)));
    for (let p = 0; p < 25; p++) await h.job.runOnce();
    const anyJob = h.job as any;
    const size = anyJob.emailedThisProcess?.size ?? -1;
    assert.ok(size >= 0, "the guard map is gone - a stamp failure can flood again");
    assert.ok(size <= 8 * ((30 * 60) / POLL_SECONDS), "L4c VIOLATED - guard grew past a window of throughput: " + size);
    console.log("      after 200 emails the dedupe guard holds " + size + " ids (cap " + 8 * ((30 * 60) / POLL_SECONDS) + ")");
  });

  it("L5 - overlapping passes never double-send", async () => {
    const h = makeHarness();
    h.setRows(Array.from({ length: 8 }, (_, i) => row(i, THREAD_A.id)));
    // fire five passes concurrently, as a slow pass overlapping its own timer would
    const results = await Promise.all([h.job.runOnce(), h.job.runOnce(), h.job.runOnce(), h.job.runOnce(), h.job.runOnce()]);
    const totalReported = results.reduce((a, b) => a + b, 0);
    assert.strictEqual(h.sends.length, 8, "L5 VIOLATED - a text was emailed more than once under overlap");
    assert.strictEqual(totalReported, 8, "the re-entrancy guard must make the extra calls no-ops");
    assert.strictEqual(new Set(h.stamps.map((s) => s.id)).size, h.stamps.length, "stamped twice");
  });

  it("L6 - one poisoned row never kills the rest of its batch", async () => {
    const POISON = "cmthreadPoison";
    const h = makeHarness({
      threads: { [THREAD_A.id]: THREAD_A, [POISON]: { ...THREAD_A, id: POISON } },
      usersByThread: { [THREAD_A.id]: OPTED_IN, [POISON]: OPTED_IN },
      processThrowsFor: new Set([POISON]),
    });
    const rows = Array.from({ length: 8 }, (_, i) => row(i, i === 3 ? POISON : THREAD_A.id));
    h.setRows(rows);
    await h.job.runOnce();
    assert.strictEqual(h.sends.length, 7, "L6 VIOLATED - a single bad row took out its whole batch");
    assert.ok(h.audits.some((a) => a.event === "sms.email_failed"), "the bad row must be audited");
  });

  it("L7 - recipients are deduped, blanks dropped, and a huge list still sends once", async () => {
    const many = [
      ...Array.from({ length: 200 }, (_, i) => ({ id: "u" + i, email: "person" + i + "@customer.com", smsEmailForwardEnabled: true, status: "ACTIVE" })),
      { id: "dupA", email: "SAME@customer.com", smsEmailForwardEnabled: true, status: "ACTIVE" },
      { id: "dupB", email: "same@customer.com", smsEmailForwardEnabled: true, status: "ACTIVE" },
      { id: "blank", email: "", smsEmailForwardEnabled: true, status: "ACTIVE" },
      { id: "nulled", email: null, smsEmailForwardEnabled: true, status: "ACTIVE" },
      { id: "nonsense", email: "not-an-address", smsEmailForwardEnabled: true, status: "ACTIVE" },
    ];
    const h = makeHarness({
      threads: { [THREAD_A.id]: THREAD_A },
      usersByThread: { [THREAD_A.id]: many as any },
    });
    h.setRows([row(1, THREAD_A.id)]);
    await h.job.runOnce();
    assert.strictEqual(h.sends.length, 1, "one text must be one email, however many recipients");
    const to: string[] = h.sends[0].to;
    assert.strictEqual(new Set(to).size, to.length, "L7 VIOLATED - duplicate recipients");
    assert.strictEqual(to.filter((e) => e === "same@customer.com").length, 1, "case-variant duplicate not collapsed");
    assert.ok(!to.some((e) => !e || !e.includes("@")), "L7 VIOLATED - a blank or malformed address reached the To list");
    console.log("      200 participants + duplicates + blanks -> " + to.length + " unique recipients, 1 email");
  });

  it("L8 - a pathological thread cannot build an unbounded email", async () => {
    const huge = "x".repeat(10_000);
    const h = makeHarness();
    h.setRows(Array.from({ length: 40 }, (_, i) => row(i, THREAD_A.id, 0, { body: huge })));
    await h.job.runOnce();
    const sizes = h.sends.map((s) => Buffer.byteLength(String(s.html), "utf8"));
    const biggest = Math.max(...sizes);
    console.log("      40 x 10k-char texts -> biggest email html " + Math.round(biggest / 1024) + " KB");
    // the context window caps how many bubbles are embedded, so this must not
    // scale with the size of the conversation
    assert.ok(biggest < 1024 * 1024, "L8 VIOLATED - an email grew past 1 MB: " + biggest);
  });

  it("L9 - oldest first, always", async () => {
    const h = makeHarness();
    const shuffled = [row(3, THREAD_A.id, 1), row(1, THREAD_A.id, 9), row(2, THREAD_A.id, 5)];
    h.setRows(shuffled);
    await h.job.runOnce();
    assert.deepStrictEqual(h.stamps.map((s) => s.id), ["m1", "m2", "m3"], "L9 VIOLATED - not processed oldest-first");
  });
});
