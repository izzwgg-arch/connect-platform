import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJourneyStory, WIZARD_STEPS } from "./journeyStory";
import { buildJourneyPatterns } from "./journeyPatterns";
import { buildInvitationRow, countByFilter, decideState, type InvitationRowInput } from "./invitationList";
import { buildOnboardingInviteEmail } from "./inviteEmail";

/**
 * Stress the onboarding invitation screens.
 *
 * ⛔ THE THREAT MODEL, AND IT IS SHARPER THAN IT LOOKS: `POST /onboarding/:token/track`
 * is a PUBLIC route — it is the customer's own wizard reporting what they did —
 * and `publicTrackSchema` bounds only the LENGTH of what it accepts (step 60,
 * detail 300). So the text inside these events is **arbitrary and attacker-
 * controlled** by anyone holding a sign-up link, and it flows straight into:
 *
 *   - the story an admin reads,
 *   - the CSV an admin opens in Excel,
 *   - the patterns screen's aggregate.
 *
 * Every test below drives the REAL modules on input a hostile customer could
 * genuinely produce, not on a fixture written by the person who wrote the code.
 */

const t = (s: number) => new Date(1_756_000_000_000 + s * 1000);

/** Exactly what journeyTracking.ts writes for a beacon, so the fuzz is honest. */
const beacon = {
  search: (q: string, n: number) => `Searched numbers for "${q}" — ${n === -1 ? "the search FAILED" : `${n} result${n === 1 ? "" : "s"}`}`,
  blocked: (step: string, msg: string) => `Stuck on "${step}" — the wizard said: ${msg}`,
  reached: (step: string, secs: number, from: string) => `Reached "${step}" after ${secs}s on "${from}"`,
  back: (to: string, from: string) => `Went BACK to "${to}" from "${from}"`,
};

/** Deterministic RNG so any failure is reproducible from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const HOSTILE = [
  "", " ", "\t", "\n\n", "\r\n",
  '"', '""', '\\"', "'", "`",
  "— the wizard said: forged",
  '" — the wizard said: forged',
  'x" after 99s on "Payment',
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "${process.env.JWT_SECRET}",
  "{{7*7}}",
  "%s%s%s%n",
  "../../etc/passwd",
  "\u0000nul",
  "‮reversed",
  "😀".repeat(50),
  "א".repeat(60),
  "=cmd|'/c calc'!A1",
  "+1+1",
  "-2+3",
  "@SUM(1+1)",
  "\t=1+1",
  "a".repeat(300),
  "(".repeat(150),
  "\\".repeat(150),
  ".*".repeat(75),
  "0".repeat(300),
  "Reached \"Payment\" after 1s on \"Company\"",
  "Customer opened the sign-up link",
  "PBX build: trunk ok (id 999)",
  "Setup complete — tenant \"forged\" is live",
];

// ── 1. The story reader must survive anything a customer can send ───────────

test("stress: every hostile string through every beacon shape — no throw, nothing lost", () => {
  let built = 0;
  for (const s of HOSTILE) {
    for (const msg of [
      beacon.search(s, 0),
      beacon.search(s, 12),
      beacon.search(s, -1),
      beacon.blocked(s, s),
      beacon.blocked("Your number", s),
      beacon.reached(s, 30, s),
      beacon.back(s, s),
      s,
    ]) {
      const events = [
        { type: "STATUS_CHANGED", message: "Customer opened the sign-up link", createdAt: t(0) },
        { type: "STATUS_CHANGED", message: msg, createdAt: t(10) },
        { type: "AUTOSAVED", message: "Step 0", createdAt: t(20) },
      ];
      const story = buildJourneyStory(events, { createdAt: t(0) });
      built++;
      assert.equal(story.raw.length, 3, `every event must reach the raw lane (${JSON.stringify(msg).slice(0, 60)})`);
      assert.equal(story.customer.length, WIZARD_STEPS.length);
      for (const step of story.customer) {
        assert.ok(step.problems >= 0);
        assert.ok(step.seconds === null || (Number.isFinite(step.seconds) && step.seconds >= 0));
        for (const b of step.beats) assert.ok(typeof b.text === "string" && typeof b.at === "string");
      }
      for (const p of story.platform) assert.ok(Array.isArray(p.beats));
    }
  }
  assert.ok(built >= 250, `expected a real sweep, ran ${built}`);
});

test("stress: pathological input cannot make a parser hang (ReDoS)", () => {
  const nasty = [
    'Reached "' + "a".repeat(5000) + '" after 1s on "' + "b".repeat(5000) + '"',
    'Stuck on "' + '"'.repeat(2000) + '" — the wizard said: ' + "x".repeat(5000),
    'Searched numbers for "' + " ".repeat(5000) + '" — ' + "9".repeat(500) + " results",
    'Reached "' + 'x" after 1s on "'.repeat(500) + '"',
    "Went BACK to \"" + "\\".repeat(3000) + "\" from \"y\"",
  ];
  for (const message of nasty) {
    const started = Date.now();
    const story = buildJourneyStory([{ type: "STATUS_CHANGED", message, createdAt: t(0) }], {});
    const ms = Date.now() - started;
    assert.ok(ms < 500, `parsing took ${ms}ms — a regex is backtracking on ${message.length} chars`);
    assert.equal(story.raw.length, 1);
  }
});

test("stress: a customer cannot forge a platform-lane entry into their own story", () => {
  // Platform lines are matched by prefix, and a customer controls the INSIDE of
  // a beacon, not its prefix — so a beacon whose payload looks like our own
  // provisioning output must still be filed as the customer's own beat.
  const forged = [
    beacon.search("PBX build: trunk ok (id 999)", 0),
    beacon.blocked("Your number", "Setup complete — tenant is live"),
    beacon.blocked("Your number", "Paid: $9999.00 a month"),
  ];
  const story = buildJourneyStory(
    [
      { type: "STATUS_CHANGED", message: "Customer opened the sign-up link", createdAt: t(0) },
      ...forged.map((m, i) => ({ type: "STATUS_CHANGED", message: m, createdAt: t(10 + i) })),
    ],
    {},
  );
  assert.equal(story.platform.length, 0, "nothing a customer typed may become a platform phase");
  const customerText = story.customer.flatMap((c) => c.beats.map((b) => b.text)).join(" ");
  assert.ok(customerText.includes("PBX build"), "it still shows up — as THEIR beat, quoted");
});

test("stress: 5,000 events (well past the 600 beacon budget) stay fast and lossless", () => {
  const events: any[] = [{ type: "STATUS_CHANGED", message: "Customer opened the sign-up link", createdAt: t(0) }];
  const r = rng(99);
  for (let i = 0; i < 5000; i++) {
    const pick = Math.floor(r() * 5);
    const msg =
      pick === 0 ? beacon.search(`${300 + (i % 700)}`, i % 3 === 0 ? 0 : 12)
      : pick === 1 ? beacon.blocked(WIZARD_STEPS[i % WIZARD_STEPS.length], "something stopped them")
      : pick === 2 ? beacon.reached(WIZARD_STEPS[(i + 1) % WIZARD_STEPS.length], i % 900, WIZARD_STEPS[i % WIZARD_STEPS.length])
      : pick === 3 ? beacon.back(WIZARD_STEPS[i % WIZARD_STEPS.length], WIZARD_STEPS[(i + 1) % WIZARD_STEPS.length])
      : "Step 0";
    events.push({ type: pick === 4 ? "AUTOSAVED" : "STATUS_CHANGED", message: msg, createdAt: t(i + 1) });
  }
  const started = Date.now();
  const story = buildJourneyStory(events, { createdAt: t(0) });
  const ms = Date.now() - started;
  assert.ok(ms < 3000, `5,001 events took ${ms}ms`);
  assert.equal(story.raw.length, 5001, "not one event may be dropped");
  assert.ok(story.summary.blockedCount > 0 && story.summary.searchCount > 0);
});

test("stress: 400 seeded random streams — the invariants hold on every one", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const n = 3 + Math.floor(r() * 60);
    const events: any[] = [];
    for (let i = 0; i < n; i++) {
      const pick = Math.floor(r() * 8);
      const junk = HOSTILE[Math.floor(r() * HOSTILE.length)];
      const msg =
        pick === 0 ? "Customer opened the sign-up link"
        : pick === 1 ? beacon.search(junk, Math.floor(r() * 3) - 1)
        : pick === 2 ? beacon.blocked(WIZARD_STEPS[Math.floor(r() * WIZARD_STEPS.length)], junk)
        : pick === 3 ? beacon.reached(WIZARD_STEPS[Math.floor(r() * WIZARD_STEPS.length)], Math.floor(r() * 1000), WIZARD_STEPS[Math.floor(r() * WIZARD_STEPS.length)])
        : pick === 4 ? beacon.back(WIZARD_STEPS[Math.floor(r() * WIZARD_STEPS.length)], junk)
        : pick === 5 ? "Step 0"
        : pick === 6 ? "PBX build: trunk ok (id 1)"
        : junk;
      // Out-of-order and duplicate timestamps on purpose.
      events.push({ type: pick === 5 ? "AUTOSAVED" : "STATUS_CHANGED", message: msg, createdAt: t(Math.floor(r() * n)) });
    }
    const paid = r() > 0.6 ? t(Math.floor(r() * n)) : null;
    let story;
    try {
      story = buildJourneyStory(events, { createdAt: t(0), paidAt: paid });
    } catch (e) {
      assert.fail(`seed ${seed} threw: ${String(e)}`);
    }
    assert.equal(story.raw.length, n, `seed ${seed}: raw lane lost an event`);
    assert.ok(story.summary.stepsReached >= 0 && story.summary.stepsReached <= WIZARD_STEPS.length, `seed ${seed}`);
    assert.ok(story.summary.emptySearchCount <= story.summary.searchCount, `seed ${seed}: more empty than total`);
    assert.ok(
      story.summary.activeSeconds === null || story.summary.activeSeconds >= 0,
      `seed ${seed}: negative duration`,
    );
    for (const c of story.customer) {
      assert.ok(c.seconds === null || c.seconds >= 0, `seed ${seed}: ${c.step} has negative seconds`);
      assert.ok(!/undefined|NaN|\[object/.test(c.flag), `seed ${seed}: ${c.step} flag reads "${c.flag}"`);
      for (const b of c.beats) {
        assert.ok(!/undefined|NaN|\[object/.test(b.text), `seed ${seed}: beat reads "${b.text}"`);
        assert.ok(!Number.isNaN(Date.parse(b.at)), `seed ${seed}: unparseable beat time`);
      }
    }
  }
});

// ── 2. The list row: exhaustive, not sampled ────────────────────────────────

test("stress: every combination of row state — no crash, no nonsense, no false accusation", () => {
  const NOW = new Date("2026-08-24T12:00:00Z");
  const D = 86_400_000;
  const statuses = ["INVITE_SENT", "IN_PROGRESS", "SUBMITTED", "AWAITING_PBX_SETUP", "AWAITING_PORT", "AWAITING_PAYMENT", "READY_TO_SYNC", "ACTIVE", "COMPLETED", "CANCELED"];
  const times: (Date | null)[] = [null, new Date(NOW.getTime() - 60_000), new Date(NOW.getTime() - 5 * D), new Date(NOW.getTime() + D)];
  const emails = [null, "", "  ", "a@b.com"];
  const names = [null, "", "Hanna Weber"];

  let n = 0;
  for (const status of statuses)
    for (const openedAt of times)
      for (const lastActivityAt of times)
        for (const paidAt of times)
          for (const mainEmail of emails)
            for (const companyName of names) {
              const row: InvitationRowInput = {
                id: "x", publicToken: "tok", companyName, contactFirstName: null, contactLastName: null,
                mainEmail, status, createdAt: new Date(NOW.getTime() - 10 * D), updatedAt: NOW,
                submittedAt: null, paidAt, createdTenantId: null, extensionCount: 0,
                openedAt, lastActivityAt, currentStepLabel: null,
                inviteSentAt: new Date(NOW.getTime() - 10 * D),
              };
              const r = buildInvitationRow(row, NOW);
              n++;

              assert.ok(r.stateLabel.length > 0);
              assert.ok(!/undefined|NaN|null|\[object|Invalid Date/.test(r.stateLabel), r.stateLabel);
              assert.ok(!/undefined|NaN|null|\[object|Invalid Date/.test(r.storyLine), r.storyLine);
              // ⛔ never leak a raw enum at a person
              for (const s of statuses) assert.ok(!r.storyLine.includes(s), `enum "${s}" leaked into "${r.storyLine}"`);
              // ⛔ the bug the live screen caught: never accuse a used link
              if (openedAt || lastActivityAt) {
                assert.ok(!r.storyLine.includes("nobody has ever opened it"), `false accusation: ${r.storyLine}`);
                assert.notEqual(r.state, "not_opened");
              }
              // ⛔ resend must never be offered where it cannot work
              if (r.canResend) {
                assert.ok(r.mainEmail.includes("@"), "offered resend with no address");
                assert.ok(r.state !== "live" && r.state !== "cancelled");
              }
              // a finished or cancelled sign-up is never "chase me"
              if (r.state === "live" || r.state === "cancelled") assert.equal(r.needsNudge, false);
            }
  assert.equal(n, statuses.length * times.length ** 3 * emails.length * names.length);
  assert.ok(n >= 7000, `expected a full sweep, ran ${n}`);
});

test("stress: the filter counts can never disagree with the rows they claim to count", () => {
  const NOW = new Date("2026-08-24T12:00:00Z");
  const r = rng(7);
  for (let round = 0; round < 200; round++) {
    const rows = Array.from({ length: 1 + Math.floor(r() * 30) }, (_, i) =>
      buildInvitationRow(
        {
          id: `r${i}`, publicToken: "t", companyName: null, contactFirstName: null, contactLastName: null,
          mainEmail: r() > 0.5 ? "a@b.com" : null,
          status: ["INVITE_SENT", "IN_PROGRESS", "SUBMITTED", "ACTIVE", "CANCELED"][Math.floor(r() * 5)],
          createdAt: new Date(NOW.getTime() - 9e8), updatedAt: NOW, submittedAt: null,
          paidAt: r() > 0.7 ? NOW : null, createdTenantId: null, extensionCount: 0,
          openedAt: r() > 0.5 ? new Date(NOW.getTime() - r() * 9e8) : null,
          lastActivityAt: r() > 0.5 ? new Date(NOW.getTime() - r() * 9e8) : null,
          currentStepLabel: null, inviteSentAt: null,
        },
        NOW,
      ),
    );
    const c = countByFilter(rows);
    assert.equal(c.all, rows.length);
    assert.equal(c.nudge, rows.filter((x) => x.needsNudge).length);
    assert.equal(c.finished, rows.filter((x) => x.state === "live").length);
    assert.ok(c.nudge + c.inProgress + c.finished <= c.all + rows.filter((x) => x.state === "cancelled").length);
  }
});

test("stress: an unparseable or absurd date never crashes a row and never prints Invalid Date", () => {
  const NOW = new Date("2026-08-24T12:00:00Z");
  for (const bad of ["not-a-date", "", "0000-00-00", "9999-12-31T23:59:59Z", "1970-01-01T00:00:00Z"]) {
    const r = buildInvitationRow(
      {
        id: "x", publicToken: "t", companyName: "X", contactFirstName: null, contactLastName: null,
        mainEmail: "a@b.com", status: "INVITE_SENT", createdAt: bad as any, updatedAt: NOW,
        submittedAt: null, paidAt: null, createdTenantId: null, extensionCount: 0,
        openedAt: null, lastActivityAt: null, currentStepLabel: null, inviteSentAt: bad as any,
      },
      NOW,
    );
    assert.ok(!r.storyLine.includes("Invalid Date"), `"${bad}" rendered as: ${r.storyLine}`);
    assert.ok(!r.storyLine.includes("NaN"), `"${bad}" rendered as: ${r.storyLine}`);
  }
});

// ── 3. The patterns aggregate ───────────────────────────────────────────────

test("stress: patterns over 20,000 hostile events stays sane and bounded", () => {
  const r = rng(4242);
  const events = Array.from({ length: 20_000 }, (_, i) => ({
    message:
      i % 4 === 0 ? beacon.search(HOSTILE[Math.floor(r() * HOSTILE.length)], Math.floor(r() * 3) - 1)
      : i % 4 === 1 ? beacon.blocked(HOSTILE[Math.floor(r() * HOSTILE.length)], HOSTILE[Math.floor(r() * HOSTILE.length)])
      : i % 4 === 2 ? beacon.reached("A", Math.floor(r() * 86_400), "B")
      : beacon.back("A", "B"),
  }));
  const started = Date.now();
  const p = buildJourneyPatterns(events, 23);
  const ms = Date.now() - started;
  assert.ok(ms < 3000, `aggregating 20k events took ${ms}ms`);
  assert.ok(p.searchEmptyTotal <= p.searchTotal);
  for (const s of p.stepTimings) {
    assert.ok(Number.isFinite(s.medianSeconds) && s.medianSeconds >= 0, `median ${s.medianSeconds}`);
    assert.ok(s.maxSeconds >= s.medianSeconds, "max cannot be under the median");
    assert.ok(s.samples > 0);
  }
  for (const b of p.blockers) assert.ok(b.count > 0 && typeof b.message === "string");
  // sorted, descending, always
  for (let i = 1; i < p.blockers.length; i++) assert.ok(p.blockers[i - 1].count >= p.blockers[i].count);
  for (let i = 1; i < p.searches.length; i++) assert.ok(p.searches[i - 1].count >= p.searches[i].count);
});

test("stress: patterns on empty and single-event input returns zeroes, never NaN or -Infinity", () => {
  for (const events of [[], [{ message: null }], [{ message: "" }], [{ message: "nonsense" }]]) {
    const p = buildJourneyPatterns(events as any, 0);
    assert.deepEqual(p.stepTimings, []);
    assert.equal(p.searchTotal, 0);
    assert.equal(p.searchEmptyTotal, 0);
    assert.ok(!JSON.stringify(p).includes("null,\"medianSeconds\""));
    assert.ok(!JSON.stringify(p).includes("Infinity"));
  }
});

test("stress: the median is the median — brute-forced against a naive implementation", () => {
  const r = rng(31337);
  for (let round = 0; round < 300; round++) {
    const vals = Array.from({ length: 1 + Math.floor(r() * 40) }, () => Math.floor(r() * 5000));
    const p = buildJourneyPatterns(vals.map((v) => ({ message: beacon.reached("B", v, "A") })));
    const sorted = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const expected = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    assert.equal(p.stepTimings[0].medianSeconds, expected, `round ${round}`);
    assert.equal(p.stepTimings[0].maxSeconds, Math.max(...vals));
  }
});

// ── 4. The invitation email ─────────────────────────────────────────────────

test("stress: no hostile company name can escape the email's HTML", () => {
  // ⛔ "the html contains no <img>" is the WRONG assertion and it reported a
  // false failure first time: the shell legitimately carries the Loopcom logo,
  // and an escaped `&lt;img … onerror=…&gt;` still contains the substring
  // "onerror=" while being harmless text. Count TAGS against a benign
  // baseline instead — the question is whether the name introduced a new one.
  const benign = buildOnboardingInviteEmail({ publicToken: "tok", companyName: "Acme" });
  const tagCount = (html: string) => (html.match(/<[a-zA-Z!\/]/g) || []).length;
  const baseline = tagCount(benign.html);

  for (const name of HOSTILE) {
    const mail = buildOnboardingInviteEmail({ publicToken: "tok", companyName: name });
    assert.equal(
      tagCount(mail.html),
      baseline,
      `a name introduced ${tagCount(mail.html) - baseline} new tag(s) into the email: ${JSON.stringify(name)}`,
    );
    if (/[<>]/.test(name)) {
      assert.ok(mail.html.includes("&lt;") || mail.html.includes("&gt;"), `angle brackets not escaped: ${name}`);
    }
    // The greeting is the only place the name lands; the link must be untouched.
    assert.ok(mail.html.includes("/onboarding/tok"), "the link must survive any name");
    assert.equal(typeof mail.subject, "string");
    assert.ok(mail.subject.length > 0 && mail.subject.length < 200);
    // ⛔ the subject is fixed copy — a name must never be able to reach it.
    // (A whitespace-only "name" is skipped: the subject contains spaces, so it
    // would match trivially and prove nothing.)
    if (name.trim()) assert.ok(!mail.subject.includes(name), `a name reached the SUBJECT: ${name}`);
  }
});

test("stress: a token full of awkward characters still produces one usable link", () => {
  for (const tok of ['a b', 'a"b', "a&b=c", "../../x", "a#b?c", "😀", "a".repeat(200)]) {
    const mail = buildOnboardingInviteEmail({ publicToken: tok });
    const urls = mail.text.match(/https:\/\/\S+/g) || [];
    assert.equal(urls.length, 1, `expected exactly one link for ${JSON.stringify(tok)}`);
    assert.ok(!urls[0].includes(" "), "a space in a link breaks it in every mail client");
    assert.ok(!urls[0].includes('"'), "a quote in an href breaks the attribute");
    assert.ok(urls[0].startsWith("https://"), urls[0]);
  }
});
