import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJourneyStory, WIZARD_STEPS, humanSeconds } from "./journeyStory";

/**
 * ⛔ The fixture below is the REAL event stream of the TYH Industries sign-up
 * (submission cmsyuwds40w8sqo132jep3wlb, 2026-08-18), copied out of production
 * verbatim and trimmed only by dropping repeated autosaves. Driving the builder
 * on invented input is how you end up with a reader that works on fixtures and
 * falls over on the first real sign-up — this stream contains the awkward
 * shapes a synthetic one never would: a step visited twice, a "Reached" line
 * that arrives AFTER the customer has already been blocked on a later step, and
 * thirteen searches that found nothing.
 */
const t = (hhmmss: string) => new Date(`2026-08-18T${hhmmss}Z`);

const TYH = [
  { type: "CREATED", message: "Admin-created link", createdAt: t("16:07:44") },
  { type: "STATUS_CHANGED", message: "Customer opened the sign-up link", createdAt: t("16:09:23") },
  { type: "AUTOSAVED", message: "Step 0", createdAt: t("16:09:51") },
  { type: "AUTOSAVED", message: "Step 0", createdAt: t("16:09:54") },
  { type: "AUTOSAVED", message: "Step 0", createdAt: t("16:10:06") },
  { type: "STATUS_CHANGED", message: 'Reached "Contact" after 26s on "Company"', createdAt: t("16:10:09") },
  { type: "AUTOSAVED", message: "Step 1", createdAt: t("16:10:10") },
  { type: "AUTOSAVED", message: "Step 1", createdAt: t("16:11:03") },
  { type: "STATUS_CHANGED", message: 'Reached "Your number" after 58s on "Contact"', createdAt: t("16:11:06") },
  { type: "STATUS_CHANGED", message: 'Searched numbers for "415 (starts)" — 0 results', createdAt: t("16:11:29") },
  { type: "STATUS_CHANGED", message: 'Searched numbers for "718 (starts)" — 0 results', createdAt: t("16:11:45") },
  { type: "STATUS_CHANGED", message: 'Stuck on "Your number" — the wizard said: Please pick a number from the list.', createdAt: t("16:11:48") },
  { type: "STATUS_CHANGED", message: 'Searched numbers for "718 (starts)" — 0 results', createdAt: t("16:12:00") },
  { type: "STATUS_CHANGED", message: 'Stuck on "Your number" — the wizard said: Please pick a number from the list.', createdAt: t("16:12:34") },
  { type: "STATUS_CHANGED", message: 'Searched numbers for "646 (starts)" — 0 results', createdAt: t("16:13:06") },
  { type: "STATUS_CHANGED", message: 'Reached "Contact" after 241s on "Company"', createdAt: t("16:13:23") },
  { type: "STATUS_CHANGED", message: 'Stuck on "Contact" — the wizard said: A valid main email is required.', createdAt: t("16:13:27") },
  { type: "STATUS_CHANGED", message: 'Reached "Your number" after 7s on "Contact"', createdAt: t("16:13:30") },
  { type: "STATUS_CHANGED", message: 'Searched numbers for "562 (starts)" — 12 results', createdAt: t("16:13:46") },
  { type: "STATUS_CHANGED", message: 'Searched numbers for "929 (starts)" — 12 results', createdAt: t("16:15:57") },
  { type: "STATUS_CHANGED", message: 'Reached "Extensions" after 155s on "Your number"', createdAt: t("16:16:15") },
  { type: "STATUS_CHANGED", message: 'Stuck on "Extensions" — the wizard said: Extension number "(empty)" won\'t work — use at least three digits, like 101.', createdAt: t("16:16:41") },
  { type: "STATUS_CHANGED", message: 'Reached "Add-ons" after 33s on "Extensions"', createdAt: t("16:16:48") },
  { type: "STATUS_CHANGED", message: 'Reached "Review" after 3s on "Add-ons"', createdAt: t("16:16:52") },
  { type: "SUBMITTED", message: "1 extensions", createdAt: t("16:17:15") },
  { type: "STATUS_CHANGED", message: 'Reached "Payment" after 24s on "Review"', createdAt: t("16:17:15") },
  { type: "STATUS_CHANGED", message: "Handed to the payment page — $45.00 due", createdAt: t("16:17:16") },
  { type: "STATUS_CHANGED", message: "Paid: $45.00 a month, including tax. — on the checkout page", createdAt: t("16:21:54") },
  { type: "STATUS_CHANGED", message: "Subaccount 344022_apluscep3wlb created (Asterisk/IP-PBX, own device CallerID).", createdAt: t("16:23:08") },
  { type: "STATUS_CHANGED", message: "Watchdog resumed a stalled setup (stuck in \"not started\" for 15 min) — attempt 1 of 5.", createdAt: t("16:38:11") },
  { type: "STATUS_CHANGED", message: "DID 9298524026 routed to 344022_apluscep3wlb.", createdAt: t("16:38:30") },
  { type: "STATUS_CHANGED", message: "911 registered on 9298524026 at 13 koznitz rd, monroe NY 10950.", createdAt: t("16:39:05") },
  { type: "STATUS_CHANGED", message: "Could not make 9298524026 the trunk's default 911 number (voipms setSubAccount failed: invalid_default_911) — the number itself IS registered.", createdAt: t("16:39:40") },
  { type: "STATUS_CHANGED", message: "PBX build: trunk ok (id 131)", createdAt: t("16:39:58") },
  { type: "STATUS_CHANGED", message: "PBX build: extension 101 Golda Moldavsky ok (id 405)", createdAt: t("16:40:44") },
  { type: "STATUS_CHANGED", message: "PBX tenant built (path 088d5f86f5009184). Syncing into Connect…", createdAt: t("16:40:49") },
  { type: "STATUS_CHANGED", message: "Sent 1 invitation email(s).", createdAt: t("16:40:54") },
  { type: "STATUS_CHANGED", message: 'Setup complete — tenant "a plus center" is live with 1 extension(s) on 9298524026.', createdAt: t("16:40:54") },
];

const SUBMISSION = { createdAt: t("16:07:44"), submittedAt: t("16:17:15"), paidAt: t("16:21:54") };

test("the real TYH sign-up reads back as the story it actually was", () => {
  const story = buildJourneyStory(TYH, SUBMISSION);
  const s = story.summary;

  assert.equal(s.openedAt, t("16:09:23").toISOString());
  assert.equal(s.paidAt, t("16:21:54").toISOString());
  // Opened 16:09:23 → paid 16:21:54 is 12m 31s.
  assert.equal(s.activeSeconds, 751);
  assert.equal(s.stepsReached, WIZARD_STEPS.length, "they finished every step");
  assert.equal(s.blockedCount, 4, "four validation messages stopped them");
  assert.equal(s.searchCount, 6);
  assert.equal(s.emptySearchCount, 4, "four of the six searches in this trimmed stream found nothing");
});

test("the number step is the one flagged as trouble", () => {
  const story = buildJourneyStory(TYH, SUBMISSION);
  const number = story.customer.find((c) => c.step === "Your number")!;
  assert.equal(number.tone, "hot", "2 blocks + 4 empty searches is the worst step");
  assert.ok(number.problems >= 5, `expected the number step to carry the problems, got ${number.problems}`);
  assert.match(number.flag, /problems$/);

  const addons = story.customer.find((c) => c.step === "Add-ons")!;
  assert.equal(addons.tone, "ok");
  assert.equal(addons.flag, "clean");
});

test("a step visited twice keeps the LONGEST visit, because that is the one that hurt", () => {
  // Company appears twice: 26s the first time, 241s the second.
  const story = buildJourneyStory(TYH, SUBMISSION);
  const company = story.customer.find((c) => c.step === "Company")!;
  assert.equal(company.seconds, 241, "the 26s first pass must not overwrite the 241s one");
});

test("a search that found nothing is worded as such, and a search that found numbers is not", () => {
  const story = buildJourneyStory(TYH, SUBMISSION);
  const beats = story.customer.find((c) => c.step === "Your number")!.beats;
  const empty = beats.find((b) => b.text.includes("415"))!;
  assert.equal(empty.text, "searched 415 (starts) — nothing came back");
  assert.equal(empty.tone, "warn");
  const found = beats.find((b) => b.text.includes("929"))!;
  assert.match(found.text, /12 results/);
  assert.equal(found.tone, "good");
});

test("runs of typing fold into one honest line instead of a wall of 'Step 0'", () => {
  const story = buildJourneyStory(TYH, SUBMISSION);
  const company = story.customer.find((c) => c.step === "Company")!;
  const typing = company.beats.filter((b) => b.tone === "quiet");
  assert.equal(typing.length, 1, "three consecutive autosaves become ONE beat");
  assert.equal(typing[0].text, "typing — 3 saves over 15s");
  // ...and the raw lane still has every single one of them.
  assert.equal(story.raw.filter((b) => b.text === "Step 0").length, 3);
});

test("the two lanes are separated — provisioning never appears in the customer's steps", () => {
  const story = buildJourneyStory(TYH, SUBMISSION);
  const allCustomerText = story.customer.flatMap((c) => c.beats.map((b) => b.text)).join(" | ");
  for (const leak of ["Subaccount", "PBX build", "DID 9298524026", "Watchdog"]) {
    assert.ok(!allCustomerText.includes(leak), `"${leak}" belongs in the platform lane, not the customer's`);
  }
  const titles = story.platform.map((p) => p.title);
  // ⛔ Paying is the customer's own last step, so it is NOT a platform phase —
  // the platform lane starts where we begin buying and building things.
  assert.deepEqual(titles, ["Getting their phone number", "Problems along the way", "Building the phone system", "Handing it over"]);
});

test("a platform phase that hit trouble is flagged, and a clean one is not", () => {
  const story = buildJourneyStory(TYH, SUBMISSION);
  const number = story.platform.find((p) => p.title === "Getting their phone number")!;
  assert.equal(number.tone, "warn", "the failed default-911 line is a problem worth flagging");
  assert.equal(number.flag, "1 problem");

  const handover = story.platform.find((p) => p.title === "Handing it over")!;
  assert.equal(handover.tone, "ok");
  assert.equal(handover.flag, "clean");
});

test("nothing is ever silently dropped — every event reaches the raw lane", () => {
  const story = buildJourneyStory(TYH, SUBMISSION);
  assert.equal(story.raw.length, TYH.length);
});

// ⛔ A message nobody has written a parser for is OURS by default, not the
// customer's — see the lane inversion in journeyStory.ts. It must still be
// visible, and it must land under "what we did".
test("an unrecognised message shows up under what WE did, never blamed on the customer", () => {
  const story = buildJourneyStory(
    [
      { type: "STATUS_CHANGED", message: "Customer opened the sign-up link", createdAt: t("10:00:00") },
      { type: "STATUS_CHANGED", message: "something nobody has written a parser for", createdAt: t("10:00:05") },
    ],
    {},
  );
  const customerTexts = story.customer.flatMap((c) => c.beats.map((b) => b.text));
  const platformTexts = story.platform.flatMap((p) => p.beats.map((b) => b.text));
  assert.ok(!customerTexts.includes("something nobody has written a parser for"), "must not be attributed to the customer");
  assert.ok(platformTexts.includes("something nobody has written a parser for"), "but must still be visible");
  assert.ok(story.raw.some((b) => b.text === "something nobody has written a parser for"), "and always in the raw lane");
});

// ⛔ THE BUG THIS WHOLE INVERSION EXISTS FOR, found by replaying all 23 real
// sign-ups: our own porting failures were landing in the customer's steps.
test("nothing WE write can ever be attributed to the customer", () => {
  const ours = [
    "Port-in needs manual follow-up: voipms addLNPPort failed: invalid",
    "VoIP.ms provisioning error: voipms createSubAccount failed: used_username",
    "Ported number 6469846023 arrived — routed to 344022_iniimi92gh2m.",
    "Temporary number 8452605692 retired — routed back to the master account (spare pool).",
    "Texting moved to the real number 9293598299 (now the number the company texts from).",
    "Connect tenant linked (cmt1qoxrq0004o8myjoq13m21).",
    "Directory entry seeded from the PBX database (REST tenant list is a stale cache — known trap).",
    "Using spare number 8452605692 as temporary number until the port completes.",
    "VoIP.ms port order number recorded: 217760 (for 6469846023 from Verizon).",
    "Routing re-published — the ported number's inbound route is live.",
    "Billing stamp deliberately SKIPPED — free account per Izzy",
    "Canceled — payment-audit test run (Claude, 2026-08-04)",
  ];
  const story = buildJourneyStory(
    [
      { type: "STATUS_CHANGED", message: "Customer opened the sign-up link", createdAt: t("10:00:00") },
      { type: "STATUS_CHANGED", message: 'Reached "Payment" after 10s on "Review"', createdAt: t("10:01:00") },
      ...ours.map((m, i) => ({ type: "STATUS_CHANGED", message: m, createdAt: t(`10:0${2 + (i % 7)}:00`) })),
    ],
    {},
  );
  const customerTexts = story.customer.flatMap((c) => c.beats.map((b) => b.text)).join(" ||| ");
  for (const m of ours) {
    assert.ok(!customerTexts.includes(m), `OUR line was filed as the customer's: ${m}`);
  }
  const platformTexts = story.platform.flatMap((p) => p.beats.map((b) => b.text));
  for (const m of ours) assert.ok(platformTexts.includes(m), `our line vanished entirely: ${m}`);
  assert.equal(story.raw.length, ours.length + 2);
});

test("a sign-up nobody ever opened produces an empty, honest story rather than throwing", () => {
  const story = buildJourneyStory([{ type: "CREATED", message: "Admin-created link", createdAt: t("09:00:00") }], {
    createdAt: t("09:00:00"),
  });
  assert.equal(story.summary.openedAt, null);
  assert.equal(story.summary.blockedCount, 0);
  assert.equal(story.platform.length, 0);
  assert.equal(story.customer.filter((c) => c.reached).length, 1, "only the step they land on counts as reached");
  assert.equal(story.customer.find((c) => c.step === "Contact")!.flag, "not reached");
});

test("events arriving out of order are sorted before anything is derived", () => {
  const shuffled = [...TYH].reverse();
  const a = buildJourneyStory(TYH, SUBMISSION);
  const b = buildJourneyStory(shuffled, SUBMISSION);
  assert.deepEqual(b.summary, a.summary);
  assert.deepEqual(b.raw.map((x) => x.at), a.raw.map((x) => x.at));
});

test("humanSeconds reads like a person wrote it", () => {
  assert.equal(humanSeconds(3), "3s");
  assert.equal(humanSeconds(59), "59s");
  assert.equal(humanSeconds(60), "1m");
  assert.equal(humanSeconds(398), "6m 38s");
});

test("paying is the customer's last step, and its length is measured from both ends", () => {
  const story = buildJourneyStory(TYH, SUBMISSION);
  const payment = story.customer.find((c) => c.step === "Payment")!;
  // Reached Payment 16:17:15, paid 16:21:54.
  assert.equal(payment.seconds, 279, "nothing downstream reports this step, so it is derived from paidAt");
  const texts = payment.beats.map((b) => b.text);
  assert.ok(texts.some((t) => t.includes("Handed to the payment page")), "the hand-off belongs to the customer's story");
  assert.ok(texts.some((t) => t.includes("Paid: $45.00")));
  assert.equal(payment.beats.find((b) => b.text.startsWith("Paid:"))!.tone, "good");
});

test("a sign-up that never paid leaves the Payment step undated rather than inventing a number", () => {
  const upToReview = TYH.filter((e) => !/^(Handed to the payment page|Paid:)/.test(String(e.message)));
  const story = buildJourneyStory(upToReview, { createdAt: SUBMISSION.createdAt, submittedAt: SUBMISSION.submittedAt });
  assert.equal(story.customer.find((c) => c.step === "Payment")!.seconds, null);
});

// ⛔ A declined card is where sign-ups die most often. It must never read as an
// ordinary line in the customer's story.
test("a declined card is flagged as the customer's problem, not filed as routine", () => {
  const story = buildJourneyStory(
    [
      { type: "STATUS_CHANGED", message: "Customer opened the sign-up link", createdAt: t("10:00:00") },
      { type: "STATUS_CHANGED", message: 'Reached "Payment" after 10s on "Review"', createdAt: t("10:01:00") },
      { type: "STATUS_CHANGED", message: "Card declined — the card was declined", createdAt: t("10:02:00") },
      { type: "STATUS_CHANGED", message: "Paid: $45.00 a month, including tax.", createdAt: t("10:05:00") },
    ],
    { paidAt: t("10:05:00") },
  );
  const payment = story.customer.find((c) => c.step === "Payment")!;
  assert.equal(payment.problems, 1, "the decline counts against the step");
  assert.equal(payment.tone, "warn");
  assert.equal(payment.beats.find((b) => /declin/i.test(b.text))!.tone, "warn");
  assert.equal(payment.beats.find((b) => b.text.startsWith("Paid:"))!.tone, "good");
  assert.equal(payment.seconds, 240, "reached 10:01, paid 10:05");
});
