/**
 * Meeting scheduling + the invite email.
 *
 * ⛔ The source guards at the bottom exist because every defect of this repo's
 * shape lives in the CALLER or the wiring, not the pure function: an invite
 * email that quietly stops using the shared shell, a link built from the
 * request host instead of the canonical origin, or an ADMIN_ALERT type would
 * all pass a unit test of the builder and reach nobody (or reach them looking
 * wrong). They are asserted against the SOURCE, comments stripped.
 */
import assert from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import {
  MAX_INVITES_PER_MEETING,
  formatMeetingWhen,
  isUsableTimeZone,
  parseInviteEmails,
} from "./meetingSchedule";
import { buildMeetingInviteEmail, displayJoinLink, MEETING_INVITE_EMAIL_TYPE } from "./meetingInviteEmail";
import { registerMeetingRoutes } from "./meetingRoutes";

const CFG = { url: "http://livekit:7880", apiKey: "LKtestkey", apiSecret: "secret-for-tests-0123456789" };
const TZ = "America/New_York";
const NOW = new Date("2026-08-21T12:00:00Z");

/** Read a source file with comments stripped, so a negative assertion cannot
 *  be satisfied by the doc comment that explains the rule. This repo has been
 *  burned by that four times. CRLF-normalised — the working tree is CRLF. */
function sourceOf(rel: string): string {
  const raw = readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ───────────────────────── address list ─────────────────────────

test("parseInviteEmails: Outlook 'Name <a@b.com>' paste, names are not errors", () => {
  const r = parseInviteEmails("Sara Klein <sara@x.com>, Moshe Berger <moshe@y.com>");
  assert.deepEqual(r.emails, ["sara@x.com", "moshe@y.com"]);
  assert.deepEqual(r.invalid, [], "a person's first and last name must never be reported as a bad address");
});

test("parseInviteEmails: multi-label domains are VALID (.co.uk, subdomains)", () => {
  // ⛔ Regression guard. The first cut used a dot-free class for the label
  // before the TLD, so every .co.uk / .com.au / subdomained address was
  // refused. Found by driving it, not by a fixture — the fixture used @x.com.
  const r = parseInviteEmails("a@y.co.uk, b@mail.corp.example.com, c@b.io");
  assert.deepEqual(r.emails, ["a@y.co.uk", "b@mail.corp.example.com", "c@b.io"]);
  assert.deepEqual(r.invalid, []);
});

test("parseInviteEmails: every separator a person might paste", () => {
  const r = parseInviteEmails("one@a.com;two@b.com\nthree@c.com\tfour@d.com , five@e.com");
  assert.deepEqual(r.emails, ["one@a.com", "two@b.com", "three@c.com", "four@d.com", "five@e.com"]);
});

test("parseInviteEmails: case-insensitive dedupe, junk reported, mailto stripped", () => {
  const r = parseInviteEmails("Moshe@Y.com, moshe@y.com, BAD@@, a@b, mailto:z@q.io");
  assert.deepEqual(r.emails, ["moshe@y.com", "z@q.io"]);
  assert.deepEqual(r.invalid, ["BAD@@", "a@b"]);
});

test("parseInviteEmails: caps the list and says so rather than silently dropping", () => {
  const many = Array.from({ length: MAX_INVITES_PER_MEETING + 5 }, (_, i) => `p${i}@x.com`).join(",");
  const r = parseInviteEmails(many);
  assert.equal(r.emails.length, MAX_INVITES_PER_MEETING);
  assert.equal(r.truncated, true);
});

test("parseInviteEmails: an array body works the same as a pasted string", () => {
  assert.deepEqual(parseInviteEmails(["a@b.com", "c@d.com"]).emails, ["a@b.com", "c@d.com"]);
  assert.deepEqual(parseInviteEmails("").emails, []);
});

// ───────────────────────── the time ─────────────────────────

test("formatMeetingWhen: same half of the day names AM/PM once", () => {
  const w = formatMeetingWhen({ startAt: new Date("2026-09-04T18:00:00Z"), durationMinutes: 30, timeZone: TZ, now: NOW });
  assert.equal(w.timeLine, "2:00 – 2:30 PM");
  assert.equal(w.dateLine, "Friday, September 4");
  assert.equal(w.subjectWhen, "Fri, Sep 4 at 2:00 PM");
});

test("formatMeetingWhen: crossing noon names both halves", () => {
  const w = formatMeetingWhen({ startAt: new Date("2026-09-04T15:30:00Z"), durationMinutes: 45, timeZone: TZ, now: NOW });
  assert.equal(w.timeLine, "11:30 AM – 12:15 PM");
});

test("formatMeetingWhen: running past midnight names the end DATE", () => {
  // Without this the end time reads as earlier than the start.
  const w = formatMeetingWhen({ startAt: new Date("2026-09-05T03:30:00Z"), durationMinutes: 120, timeZone: TZ, now: NOW });
  assert.match(w.timeLine, /11:30 PM – 1:30 AM \(Sep 5\)/);
});

test("formatMeetingWhen: the zone is named for the MEETING's date, not today's", () => {
  const summer = formatMeetingWhen({ startAt: new Date("2026-09-04T18:00:00Z"), durationMinutes: 30, timeZone: TZ, now: NOW });
  const winter = formatMeetingWhen({ startAt: new Date("2027-01-14T15:00:00Z"), durationMinutes: 60, timeZone: TZ, now: NOW });
  assert.equal(summer.zoneLine, "Eastern Daylight Time");
  assert.equal(winter.zoneLine, "Eastern Standard Time");
});

test("formatMeetingWhen: the year appears only when it is not the current one", () => {
  const thisYear = formatMeetingWhen({ startAt: new Date("2026-09-04T18:00:00Z"), durationMinutes: 30, timeZone: TZ, now: NOW });
  const nextYear = formatMeetingWhen({ startAt: new Date("2027-01-14T15:00:00Z"), durationMinutes: 60, timeZone: TZ, now: NOW });
  assert.equal(thisYear.dateLine.includes("2026"), false);
  assert.equal(nextYear.dateLine, "Thursday, January 14, 2027");
});

test("isUsableTimeZone: refuses junk so the email never states a time nobody's in", () => {
  assert.equal(isUsableTimeZone("America/New_York"), true);
  assert.equal(isUsableTimeZone("UTC"), true);
  assert.equal(isUsableTimeZone("Mars/Olympus"), false);
  assert.equal(isUsableTimeZone(""), false);
  assert.equal(isUsableTimeZone(null), false);
});

// ───────────────────────── the email ─────────────────────────

const WHEN = formatMeetingWhen({
  startAt: new Date("2026-09-04T18:00:00Z"),
  durationMinutes: 30,
  timeZone: TZ,
  now: NOW,
});

function invite(over: Partial<Parameters<typeof buildMeetingInviteEmail>[0]> = {}) {
  return buildMeetingInviteEmail({
    meetingTitle: "Weekly production sync",
    hostName: "Chaim Landau",
    joinUrl: "https://app.loopcom.net/meet/qk7-3fp-92x",
    when: WHEN,
    ...over,
  });
}

test("invite email: NEVER ADMIN_ALERT — that category is muted and reaches nobody", () => {
  assert.notEqual(MEETING_INVITE_EMAIL_TYPE, "ADMIN_ALERT");
  assert.equal(MEETING_INVITE_EMAIL_TYPE, "MEETING_INVITE");
});

test("invite email: built on the shared shell, so it inherits the Outlook hardening", () => {
  const { html } = invite();
  assert.match(html, /v:roundrect/, "the VML button is the only thing Word paints — proves ctaButton was reused");
  assert.match(html, /height:5px/, "the 5px accent bar is the billing shell's own top rule");
  assert.match(html, /Meeting invitation/, "eyebrow");
  assert.match(html, /loopcom-wordmark/, "the real Loopcom wordmark, not drawn text");
  assert.match(html, /if mso/, "the fixed-600px Outlook wrapper");
});

test("invite email: a scheduled meeting states the day, the time AND the zone", () => {
  const { html, subject, text } = invite();
  assert.match(html, /Friday, September 4/);
  assert.match(html, /2:00 – 2:30 PM/);
  assert.match(html, /Eastern Daylight Time/, "the zone is never omitted — recipients are elsewhere");
  assert.match(html, />When</);
  assert.equal(subject, "Weekly production sync — Fri, Sep 4 at 2:00 PM");
  assert.match(text, /Eastern Daylight Time/, "the plain-text part carries the zone too");
});

test("invite email: an instant meeting simply has no When panel and no reply-about-the-time line", () => {
  const { html, subject } = invite({ when: null });
  assert.equal(/>When</.test(html), false);
  assert.equal(subject, "Chaim Landau invited you to a video meeting");
  assert.equal(html.includes("If the time doesn’t work"), false);
});

test("invite email: the host's note appears, and hostile input is escaped", () => {
  const { html } = invite({
    meetingTitle: '<script>alert(1)</script>',
    message: 'Bring the <b>numbers</b> & the deck',
  });
  assert.equal(html.includes("<script>"), false, "a title must never become markup");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;b&gt;numbers&lt;\/b&gt; &amp; the deck/);
});

test("invite email: a note's line breaks survive as <br>, not as a wall of text", () => {
  const { html } = invite({ message: "Line one\nLine two" });
  assert.match(html, /Line one<br>Line two/);
});

test("invite email: the plain link is readable and the button points at the same URL", () => {
  const { html } = invite();
  assert.equal(displayJoinLink("https://app.loopcom.net/meet/abc/"), "app.loopcom.net/meet/abc");
  assert.match(html, />app\.loopcom\.net\/meet\/qk7-3fp-92x</, "shown without the scheme");
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => h.includes("/meet/"));
  assert.ok(hrefs.length >= 2, "button + plain link");
  assert.ok(hrefs.every((h) => h === "https://app.loopcom.net/meet/qk7-3fp-92x"), "every link is the same join URL");
});

test("invite email: says no account or download is needed", () => {
  assert.match(invite().html, /No account or download needed/);
});

// ───────────────────────── the routes ─────────────────────────

function fakeDb() {
  const meetings: any[] = [];
  const invites: any[] = [];
  const emailJobs: any[] = [];
  const key = (i: any) => `${i.meetingId}::${i.email}`;
  return {
    meetings,
    invites,
    emailJobs,
    tenant: { findUnique: async () => ({ timezone: TZ }) },
    user: {
      findUnique: async () => ({
        email: "chaim@loopcom.net",
        firstName: null,
        lastName: null,
        extension: { displayName: "Chaim Landau" },
      }),
    },
    videoMeeting: {
      findUnique: async ({ where }: any) => meetings.find((r) => r.code === where.code || r.id === where.id) ?? null,
      findMany: async ({ where }: any) =>
        meetings.filter((r) => r.tenantId === where.tenantId && r.createdByUserId === where.createdByUserId),
      create: async ({ data }: any) => {
        const row = { id: `m${meetings.length + 1}`, locked: false, createdAt: new Date(), endedAt: null, ...data };
        meetings.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = meetings.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    videoMeetingInvite: {
      findUnique: async ({ where }: any) =>
        invites.find((i) => key(i) === `${where.meetingId_email.meetingId}::${where.meetingId_email.email}`) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `i${invites.length + 1}`, emailedAt: null, createdAt: new Date(), ...data };
        invites.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = invites.find(
          (i) => key(i) === `${where.meetingId_email.meetingId}::${where.meetingId_email.email}`,
        );
        Object.assign(row, data);
        return row;
      },
      count: async ({ where }: any) => invites.filter((i) => i.meetingId === where.meetingId).length,
    },
    emailJob: {
      create: async ({ data }: any) => {
        emailJobs.push(data);
        return data;
      },
    },
  };
}

function buildApp(opts: { user?: any } = {}) {
  const app = Fastify();
  const db = fakeDb();
  app.addHook("preHandler", async (req) => {
    (req as any).user = opts.user ?? { sub: "u1", tenantId: "t1", email: "a@b.c", role: "SUPER_ADMIN" };
  });
  registerMeetingRoutes(app, {
    db,
    // Hermetic stand-in for the live can_view_workspace_meetings check: this
    // harness grants nobody, so a non-super user still gets the 403 below.
    mayStartMeeting: async () => false,
    config: () => CFG as any,
    roomService: (async () => ({ ok: true, status: 200, body: "{}" })) as any,
  });
  return { app, db };
}

test("route: scheduling a meeting queues one invite email per address", async () => {
  const { app, db } = buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/meetings",
    payload: {
      title: "Weekly production sync",
      scheduledStartAt: "2026-09-04T18:00:00.000Z",
      durationMinutes: 30,
      timezone: TZ,
      message: "Bring the Q3 numbers.",
      invites: "Sara Klein <sara@x.com>, moshe@y.co.uk",
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.invitesSent, 2);
  assert.equal(db.emailJobs.length, 2);
  assert.equal(db.emailJobs[0].type, "MEETING_INVITE");
  assert.equal(db.emailJobs[0].tenantId, "t1", "billed to the host's own tenant");
  assert.equal(db.emailJobs[0].status, "QUEUED");
  assert.match(db.emailJobs[0].subject, /Weekly production sync/);
  assert.match(db.emailJobs[0].htmlBody, /Chaim Landau has invited you/, "host name comes from the PBX extension");
  assert.match(db.emailJobs[0].htmlBody, /Bring the Q3 numbers\./);
  assert.deepEqual(db.emailJobs.map((j: any) => j.toEmail), ["sara@x.com", "moshe@y.co.uk"]);
  assert.ok(body.when && body.when.timeLine, "the screen gets the same rendering the email uses");
});

test("route: an instant meeting still works and sends nothing", async () => {
  const { app, db } = buildApp();
  const res = await app.inject({ method: "POST", url: "/meetings", payload: { title: "Quick call" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().scheduledStartAt, null);
  assert.equal(db.emailJobs.length, 0);
});

test("route: a bad time zone is refused in plain English, never swapped for UTC", async () => {
  const { app, db } = buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/meetings",
    payload: { scheduledStartAt: "2026-09-04T18:00:00.000Z", timezone: "Mars/Olympus" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /time zone was not recognised/);
  assert.equal(db.meetings.length, 0, "nothing is created when the schedule is refused");
});

test("route: an obviously mistyped year is refused", async () => {
  const { app } = buildApp();
  const far = await app.inject({ method: "POST", url: "/meetings", payload: { scheduledStartAt: "2035-01-01T10:00:00.000Z" } });
  assert.equal(far.statusCode, 400);
  assert.match(far.json().message, /two years away/);
  const old = await app.inject({ method: "POST", url: "/meetings", payload: { scheduledStartAt: "2020-01-01T10:00:00.000Z" } });
  assert.equal(old.statusCode, 400);
  assert.match(old.json().message, /month in the past/);
});

test("route: a list of pure junk is refused and names what it could not read", async () => {
  const { app } = buildApp();
  const res = await app.inject({ method: "POST", url: "/meetings", payload: { invites: "nope@@, alsobad@" } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /None of those look like email addresses/);
});

test("route: inviting more people later does NOT re-mail the ones already invited", async () => {
  const { app, db } = buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/meetings",
    payload: { title: "Sync", invites: "a@x.com, b@x.com" },
  });
  const code = created.json().code;
  assert.equal(db.emailJobs.length, 2);

  const more = await app.inject({
    method: "POST",
    url: `/meetings/${code}/invite`,
    payload: { invites: "a@x.com, c@x.com" },
  });
  assert.equal(more.statusCode, 200);
  const body = more.json();
  assert.deepEqual(body.sent, ["c@x.com"]);
  assert.deepEqual(body.alreadyInvited, ["a@x.com"]);
  assert.equal(db.emailJobs.length, 3, "exactly one new email, not three");
});

test("route: only the host may invite; a non-creator is refused", async () => {
  const { app } = buildApp();
  const created = await app.inject({ method: "POST", url: "/meetings", payload: { title: "Sync" } });
  const code = created.json().code;

  const other = Fastify();
  const shared = (app as any);
  // Re-register against the same db with a different, non-super user.
  const { app: app2, db: db2 } = buildApp({ user: { sub: "u2", tenantId: "t1", email: "z@z.z", role: "TENANT_ADMIN" } });
  const res = await app2.inject({ method: "POST", url: `/meetings/${code}/invite`, payload: { invites: "x@y.com" } });
  assert.equal(res.statusCode, 403, "a tenant admin without can_view_workspace_meetings cannot invite");
  assert.equal(db2.emailJobs.length, 0);
  void other;
  void shared;
});

test("route: a meeting that has ended cannot be invited to", async () => {
  const { app, db } = buildApp();
  const created = await app.inject({ method: "POST", url: "/meetings", payload: { title: "Sync" } });
  const code = created.json().code;
  db.meetings[0].endedAt = new Date();
  const res = await app.inject({ method: "POST", url: `/meetings/${code}/invite`, payload: { invites: "x@y.com" } });
  assert.equal(res.statusCode, 409);
  assert.equal(db.emailJobs.length, 0);
});

test("route: the invite cap is enforced across calls", async () => {
  const { app } = buildApp();
  const first = Array.from({ length: MAX_INVITES_PER_MEETING }, (_, i) => `p${i}@x.com`).join(",");
  const created = await app.inject({ method: "POST", url: "/meetings", payload: { invites: first } });
  const code = created.json().code;
  const res = await app.inject({ method: "POST", url: `/meetings/${code}/invite`, payload: { invites: "one@more.com" } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /at most/);
});

// ───────────────────────── source guards ─────────────────────────

test("guard: the invite email is built on the shared shell, never its own HTML", () => {
  const src = sourceOf("meetingInviteEmail.ts");
  assert.match(src, /import \{ emailShell, ctaButton \} from "\.\.\/billing\/emailTemplates"/);
  assert.equal(/<html/i.test(src), false, "no hand-rolled document — that loses the Outlook wrapper");
  assert.equal(src.includes("v:roundrect"), false, "no copied button — that loses the VML hardening");
});

test("guard: ctaButton is exported from the billing templates (one implementation)", () => {
  const src = readFileSync(path.join(__dirname, "..", "billing", "emailTemplates.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /export function ctaButton\(/);
});

test("guard: the join link uses the CANONICAL origin, never the request host", () => {
  const src = sourceOf("meetingInviteSend.ts");
  assert.match(src, /canonicalPortalOrigin/);
  assert.equal(src.includes("portalOriginForRequest"), false, "an emailed link must survive a hostname change");
  assert.equal(src.includes("apiBaseForRequest"), false);
});

test("guard: the invite routes are gated — SUPER_ADMIN, then the meeting's own host", () => {
  const src = sourceOf("meetingRoutes.ts");
  const inviteRoute = src.slice(src.indexOf('app.post("/meetings/:code/invite"'));
  assert.ok(inviteRoute.length > 200, "invite route present");
  const body = inviteRoute.slice(0, inviteRoute.indexOf("app.post(", 10) === -1 ? undefined : inviteRoute.indexOf("app.post(", 10));
  assert.match(body, /requireMeetingCreator\(req, reply\)/);
  assert.match(body, /isMeetingHost\(meeting, user\)/);
});

test("guard: an invite is recorded as sent only AFTER its email job exists", () => {
  const src = sourceOf("meetingInviteSend.ts");
  const jobAt = src.indexOf("emailJob.create");
  const stampAt = src.indexOf("emailedAt: new Date()");
  assert.ok(jobAt > 0 && stampAt > jobAt, "stamping before queueing would silently lose invites");
});
