/**
 * Turn a submission's raw event rows into the story of that sign-up.
 *
 * WHY THIS EXISTS (Izzy, 2026-08-24): "on each invitation, I should be able to
 * see exactly what the user did, step by step, in crazy detail, so we can
 * analyze it later."
 *
 * ⛔ THE THING TO KNOW BEFORE CHANGING ANYTHING HERE: the detail was ALREADY
 * being recorded, and had been since the journey beacons shipped. TYH
 * Industries carries 98 events, to the second — every step, the seconds spent
 * on the previous one, every validation message that stopped them, every
 * number search and what came back. What was missing was any way to READ it:
 * the admin page printed all 98 as one unbroken <ul> of raw ISO timestamps.
 *
 * So this module adds no recording. It is a pure reader: raw rows in, story
 * out. That is deliberate — it means the story works retroactively on every
 * sign-up that has ever happened, including the ones that already went wrong.
 *
 * Two lanes, deliberately separated (they were jumbled into one list before):
 *   - the CUSTOMER lane: what the person did in the wizard, per step
 *   - the PLATFORM lane: what we did after they paid (carrier, PBX, invites)
 * They are two different stories for two different questions ("why did this
 * customer struggle?" vs "why did this build fail?"), and reading either one
 * used to mean skipping past the other.
 */

/** The wizard's own steps, in order. Mirrors STEPS in the customer wizard. */
export const WIZARD_STEPS = [
  "Company",
  "Contact",
  "Your number",
  "Extensions",
  "Add-ons",
  "Review",
  "Payment",
] as const;

export type RawEvent = {
  id?: string;
  type: string;
  message: string | null;
  createdAt: Date | string;
};

export type BeatTone = "plain" | "good" | "warn" | "quiet";

export type Beat = {
  at: string;          // ISO
  text: string;        // plain English, already written for a person
  tone: BeatTone;
};

export type StoryStep = {
  step: string;
  /** Seconds the customer spent here, as the wizard itself measured it. */
  seconds: number | null;
  beats: Beat[];
  problems: number;
  reached: boolean;
  /** "clean" | "<n> problem(s)" | a completion note for the last steps. */
  flag: string;
  tone: "ok" | "warn" | "hot";
};

export type StorySummary = {
  invitedAt: string | null;
  openedAt: string | null;
  submittedAt: string | null;
  paidAt: string | null;
  /** Opening the link → paying (or → last activity if they never paid). */
  activeSeconds: number | null;
  stepsReached: number;
  stepsTotal: number;
  blockedCount: number;
  emptySearchCount: number;
  searchCount: number;
  wentBackCount: number;
  lastActivityAt: string | null;
};

export type JourneyStory = {
  summary: StorySummary;
  customer: StoryStep[];
  platform: { title: string; from: string | null; to: string | null; beats: Beat[]; tone: "ok" | "warn" | "hot"; flag: string }[];
  raw: Beat[];
};

// ── Message parsers ──────────────────────────────────────────────────────────
// These read the plain-English lines journeyTracking.ts writes. They are
// matched loosely on purpose: a line that no parser recognises still reaches
// the story as an ordinary beat, so nothing is ever silently dropped.

const RE_REACHED = /^Reached "(.+?)"(?: after (\d+)s on "(.+?)")?$/;
const RE_BACK = /^Went BACK to "(.+?)"(?: from "(.+?)")?$/;
const RE_BLOCKED = /^Stuck on "(.+?)" — the wizard said: (.+)$/;
const RE_SEARCH = /^Searched numbers for "(.+?)" — (.+)$/;
const RE_OPENED = /^Customer opened the sign-up link$/;
const RE_RETURNED = /^Customer came back to the sign-up link$/;
const RE_PORTABILITY = /^Number transfer check: (.+)$/;

function iso(d: Date | string): string {
  return typeof d === "string" ? new Date(d).toISOString() : d.toISOString();
}

function ms(d: Date | string): number {
  return typeof d === "string" ? new Date(d).getTime() : d.getTime();
}

/** A search result string like "0 results" / "12 results" / "the search FAILED". */
function searchFoundNothing(result: string): boolean {
  return /^0 results?\b/.test(result) || /the search FAILED/i.test(result);
}

/**
 * Everything the wizard writes while the customer types. There are 181 of
 * these across the whole platform and every one says only "Step 0" — they are
 * the single biggest source of noise in the raw list, and folding runs of them
 * into one line is what makes the real events visible.
 */
function isTypingNoise(e: RawEvent): boolean {
  return e.type === "AUTOSAVED";
}

/**
 * The platform lane starts once the customer has paid and we begin buying and
 * building things. These are the phrases the orchestrator writes.
 */
const PLATFORM_PHASES: { title: string; match: RegExp }[] = [
  // ⛔ Order matters — first match wins — and a failure is deliberately filed
  // with the phase it belongs to rather than swept into a separate "problems"
  // bucket. "Could not make X the default 911 number" IS the interesting part
  // of getting their number; reading it three phases away from its context is
  // how a real failure stops looking like one.
  { title: "Getting their phone number", match: /^(Subaccount |Reusing subaccount |DID |SMS enabled|911 |Number stage |Number search|Using spare number|Reusing temporary number|Temporary number |Ported number|Port-in |Porting|Port |VoIP\.ms port order|VoIP\.ms provisioning error|Texting moved|Routing re-published|Could not make)/i },
  { title: "Building the phone system", match: /^(PBX build:|PBX tenant built|Connect tenant linked|Directory entry seeded)/i },
  { title: "Handing it over", match: /^(All \d+ extension|Owner:|Sent \d+ invitation|Setup complete|Told )/i },
  { title: "Problems along the way", match: /^(Watchdog |Setup failed|Retry|Could not )/i },
];

/** Anything the platform wrote that no named phase claims still has a home. */
export const PLATFORM_OTHER_PHASE = "Other things we did";

/**
 * The customer's OWN beats, recognised positively. `journeyTracking.ts` is the
 * only thing that writes these shapes, plus the wizard's autosaves, its file
 * uploads and its submit. Everything else on a submission was written by us.
 *
 * ⛔ Keep this in step with `beaconMessage()` in journeyTracking.ts. If a new
 * beacon is added there and not here, it is filed under "what we did" — wrong,
 * but visible and harmless. The reverse default (unknown ⇒ the customer) is the
 * one that quietly blames a customer for our own porting failure.
 */
const CUSTOMER_SHAPES: RegExp[] = [
  /^Reached "/,
  /^Went BACK to "/,
  /^Stuck on "/,
  /^Searched numbers for "/,
  /^Number transfer check: /,
  /^Customer opened the sign-up link$/,
  /^Customer came back to the sign-up link$/,
  /^Handed to the payment page/,
  /^Paid:/,
  /^Card declined|^The card was declined/,
];

function isCustomerLine(e: RawEvent): boolean {
  if (e.type === "AUTOSAVED" || e.type === "SUBMITTED" || e.type === "FILE_UPLOADED") return true;
  const msg = String(e.message ?? "");
  return CUSTOMER_SHAPES.some((re) => re.test(msg));
}

/** The platform lane is the complement: everything that is not the customer's. */
function isPlatformLine(e: RawEvent): boolean {
  return e.type !== "CREATED" && !isCustomerLine(e) && Boolean(String(e.message ?? "").trim());
}

function platformPhaseFor(msg: string): string {
  for (const p of PLATFORM_PHASES) if (p.match.test(msg)) return p.title;
  return PLATFORM_OTHER_PHASE;
}

function toneForPlatform(msg: string): BeatTone {
  if (/^(Could not|Setup failed|Watchdog |Card declined|The card was declined|.*TURNED OFF)/i.test(msg)) return "warn";
  if (/(cannot reach emergency|was TURNED OFF)/i.test(msg)) return "warn";
  if (/^(Setup complete|Paid:|Sent \d+ invitation|All \d+ extension)/i.test(msg)) return "good";
  return "plain";
}

function humanSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

export { humanSeconds };

/**
 * Fold a run of consecutive typing saves into one honest line, e.g.
 * "typing — 6 saves over 26 seconds". A single save says "typing" with no
 * duration, because one save spans no time.
 */
function foldTyping(run: RawEvent[]): Beat {
  const first = run[0];
  const last = run[run.length - 1];
  const secs = Math.max(0, Math.round((ms(last.createdAt) - ms(first.createdAt)) / 1000));
  const text =
    run.length === 1
      ? "typing"
      : secs > 0
        ? `typing — ${run.length} saves over ${humanSeconds(secs)}`
        : `typing — ${run.length} saves`;
  return { at: iso(first.createdAt), text, tone: "quiet" };
}

/**
 * Build the whole story.
 *
 * `submission` supplies the few facts that live on the row rather than in the
 * event stream (when it was created, submitted, paid).
 */
export function buildJourneyStory(
  events: RawEvent[],
  submission: { createdAt?: Date | string | null; submittedAt?: Date | string | null; paidAt?: Date | string | null } = {},
): JourneyStory {
  const sorted = [...events].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));

  // ── Summary counters ──────────────────────────────────────────────────────
  let openedAt: string | null = null;
  let blockedCount = 0;
  let searchCount = 0;
  let emptySearchCount = 0;
  let wentBackCount = 0;
  const reached = new Set<string>();

  for (const e of sorted) {
    const msg = String(e.message ?? "");
    if (RE_OPENED.test(msg) && !openedAt) openedAt = iso(e.createdAt);
    if (RE_BLOCKED.test(msg)) blockedCount++;
    if (RE_BACK.test(msg)) wentBackCount++;
    const s = msg.match(RE_SEARCH);
    if (s) {
      searchCount++;
      if (searchFoundNothing(s[2])) emptySearchCount++;
    }
    const r = msg.match(RE_REACHED);
    if (r) reached.add(r[1]);
  }
  // The first step is never "reached" — they land on it.
  if (sorted.length) reached.add(WIZARD_STEPS[0]);

  const lastActivityAt = sorted.length ? iso(sorted[sorted.length - 1].createdAt) : null;
  const paidAt = submission.paidAt ? iso(submission.paidAt) : null;
  const endForClock = paidAt ?? lastActivityAt;
  const activeSeconds =
    openedAt && endForClock ? Math.max(0, Math.round((new Date(endForClock).getTime() - new Date(openedAt).getTime()) / 1000)) : null;

  const summary: StorySummary = {
    invitedAt: submission.createdAt ? iso(submission.createdAt) : null,
    openedAt,
    submittedAt: submission.submittedAt ? iso(submission.submittedAt) : null,
    paidAt,
    activeSeconds,
    stepsReached: reached.size,
    stepsTotal: WIZARD_STEPS.length,
    blockedCount,
    emptySearchCount,
    searchCount,
    wentBackCount,
    lastActivityAt,
  };

  // ── Customer lane ─────────────────────────────────────────────────────────
  // Walk the stream keeping track of which step the customer is on. A beat is
  // filed against the step named in the message when there is one (a stuck
  // message names its own step), otherwise against wherever they currently are.
  const byStep = new Map<string, StoryStep>();
  for (const step of WIZARD_STEPS) {
    byStep.set(step, { step, seconds: null, beats: [], problems: 0, reached: false, flag: "not reached", tone: "ok" });
  }
  byStep.get(WIZARD_STEPS[0])!.reached = sorted.length > 0;

  let current = WIZARD_STEPS[0] as string;
  let typingRun: RawEvent[] = [];
  let reachedPaymentAt: number | null = null;

  const flushTyping = () => {
    if (!typingRun.length) return;
    byStep.get(current)?.beats.push(foldTyping(typingRun));
    typingRun = [];
  };

  const raw: Beat[] = [];

  for (const e of sorted) {
    const msg = String(e.message ?? "");
    raw.push({ at: iso(e.createdAt), text: msg || e.type, tone: RE_BLOCKED.test(msg) ? "warn" : "plain" });

    if (isTypingNoise(e)) {
      typingRun.push(e);
      continue;
    }
    flushTyping();

    // Ours, not theirs — collected into the platform lane further down.
    if (isPlatformLine(e)) continue;

    let m: RegExpMatchArray | null;

    if ((m = msg.match(RE_REACHED))) {
      const [, step, secs, fromStep] = m;
      if (fromStep && secs != null && byStep.has(fromStep)) {
        const prev = byStep.get(fromStep)!;
        // A customer can pass through a step twice (they went back). Keep the
        // LONGEST visit — that is the one that hurt.
        const n = Number(secs);
        prev.seconds = prev.seconds == null ? n : Math.max(prev.seconds, n);
        prev.beats.push({ at: iso(e.createdAt), text: `moved on to ${step}`, tone: "plain" });
      }
      if (byStep.has(step)) {
        byStep.get(step)!.reached = true;
        if (step === "Payment" && reachedPaymentAt == null) reachedPaymentAt = ms(e.createdAt);
        current = step;
      }
      continue;
    }

    if ((m = msg.match(RE_BACK))) {
      const [, toStep, fromStep] = m;
      const target = byStep.get(fromStep && byStep.has(fromStep) ? fromStep : current);
      target?.beats.push({ at: iso(e.createdAt), text: `went back to ${toStep}`, tone: "warn" });
      if (byStep.has(toStep)) current = toStep;
      continue;
    }

    if ((m = msg.match(RE_BLOCKED))) {
      const [, step, said] = m;
      const target = byStep.get(byStep.has(step) ? step : current)!;
      target.beats.push({ at: iso(e.createdAt), text: `blocked: “${said}”`, tone: "warn" });
      target.problems++;
      continue;
    }

    if ((m = msg.match(RE_SEARCH))) {
      const [, query, result] = m;
      const empty = searchFoundNothing(result);
      const target = byStep.get("Your number")!;
      target.beats.push({
        at: iso(e.createdAt),
        text: empty ? `searched ${query} — nothing came back` : `searched ${query} — ${result}`,
        tone: empty ? "warn" : "good",
      });
      if (empty) target.problems++;
      continue;
    }

    if ((m = msg.match(RE_PORTABILITY))) {
      byStep.get("Your number")!.beats.push({ at: iso(e.createdAt), text: `number transfer check: ${m[1]}`, tone: "plain" });
      continue;
    }

    if (RE_OPENED.test(msg) || RE_RETURNED.test(msg)) {
      byStep.get(WIZARD_STEPS[0])!.beats.push({
        at: iso(e.createdAt),
        text: RE_OPENED.test(msg) ? "opened the sign-up link" : "came back to the link",
        tone: "plain",
      });
      continue;
    }

    if (e.type === "SUBMITTED") {
      const target = byStep.get("Review")!;
      target.reached = true;
      target.beats.push({ at: iso(e.createdAt), text: `submitted — ${msg || "sent to us"}`, tone: "good" });
      continue;
    }

    if (e.type === "CREATED") continue; // belongs to the invitation, not the wizard

    if (e.type === "FILE_UPLOADED") {
      byStep.get(current)?.beats.push({ at: iso(e.createdAt), text: `uploaded ${msg || "a file"}`, tone: "plain" });
      continue;
    }

    // Paying is the customer's own last step. A decline belongs to their story
    // just as much as the success does — it is the single most common place a
    // sign-up dies, so it must never read as an ordinary line.
    if (/^(Paid:|Card declined|The card was declined)/i.test(msg)) {
      const declined = /declin/i.test(msg);
      const target = byStep.get("Payment")!;
      target.reached = true;
      target.beats.push({ at: iso(e.createdAt), text: msg, tone: declined ? "warn" : "good" });
      if (declined) target.problems++;
      continue;
    }

    // A customer-shaped line with no dedicated parser above still belongs to
    // them — e.g. "Handed to the payment page". ⛔ Deleting this fallback (as a
    // first cut of the lane inversion did) silently drops such lines from the
    // customer lane altogether; they survive in `raw`, so nothing looks broken.
    if (msg) byStep.get(current)?.beats.push({ at: iso(e.createdAt), text: msg, tone: "plain" });

    // ⛔ EVERYTHING NOT CUSTOMER-SHAPED IS OURS, AND THE DIRECTION OF THAT
    // DEFAULT IS THE POINT. This used to be the other way round — a prefix
    // allowlist decided what was "platform" and anything unmatched was
    // attributed to the CUSTOMER. Replaying all 23 real sign-ups showed 23
    // distinct lines WE wrote landing in the customer's own steps: the whole
    // porting family, every VoIP.ms error, tenant linking, the uploaded bill.
    // The allowlist had been built from one sign-up's events and could only
    // ever describe that one.
    //
    // Recognising the customer's beats POSITIVELY fails safe: a message nobody
    // has seen before appears under "what we did", which is true by
    // construction, instead of blaming a customer for our own porting failure.
  }
  flushTyping();

  // Payment is the last step, so nothing downstream ever reports how long it
  // took. When they paid, the two ends of it are both known.
  const payment = byStep.get("Payment")!;
  if (payment.seconds == null && paidAt && reachedPaymentAt) {
    const spent = Math.round((new Date(paidAt).getTime() - reachedPaymentAt) / 1000);
    if (spent >= 0) payment.seconds = spent;
  }

  const customer: StoryStep[] = WIZARD_STEPS.map((name) => {
    const s = byStep.get(name)!;
    s.tone = s.problems === 0 ? "ok" : s.problems >= 5 ? "hot" : "warn";
    s.flag = !s.reached
      ? "not reached"
      : s.problems === 0
        ? "clean"
        : `${s.problems} problem${s.problems === 1 ? "" : "s"}`;
    return s;
  });

  // ── Platform lane ─────────────────────────────────────────────────────────
  const phaseOrder: string[] = [];
  const phases = new Map<string, Beat[]>();
  for (const e of sorted) {
    const msg = String(e.message ?? "");
    if (!isPlatformLine(e)) continue;
    const phase = platformPhaseFor(msg);
    if (!phases.has(phase)) {
      phases.set(phase, []);
      phaseOrder.push(phase);
    }
    phases.get(phase)!.push({ at: iso(e.createdAt), text: msg, tone: toneForPlatform(msg) });
  }

  const platform = phaseOrder.map((title) => {
    const beats = phases.get(title)!;
    const warns = beats.filter((b) => b.tone === "warn").length;
    return {
      title,
      from: beats.length ? beats[0].at : null,
      to: beats.length ? beats[beats.length - 1].at : null,
      beats,
      tone: (warns === 0 ? "ok" : warns >= 2 ? "hot" : "warn") as "ok" | "warn" | "hot",
      flag: warns === 0 ? "clean" : `${warns} problem${warns === 1 ? "" : "s"}`,
    };
  });

  return { summary, customer, platform, raw };
}
