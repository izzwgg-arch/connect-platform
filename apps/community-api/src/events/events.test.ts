import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createUser, tdb, testApp } from "../testing/harness.js";
import { sendDueEventReminders } from "./routes.js";

function inDays(n: number) {
  return new Date(Date.now() + n * 86_400_000).toISOString();
}
/** Same day as inDays(n), 2 hours later — a valid endsAt for it. */
function inDaysEnd(n: number) {
  return new Date(Date.now() + n * 86_400_000 + 2 * 3_600_000).toISOString();
}

test("creating an event auto-RSVPs the host as GOING and its .ics contains DTSTART", async () => {
  const app = await testApp();
  const host = await createUser(app);
  const res = await api(app, {
    method: "POST",
    url: "/events",
    token: host.accessToken,
    payload: { title: "Rockland Business Breakfast", mode: "IN_PERSON", startsAt: inDays(10), endsAt: inDaysEnd(10), venue: "Atrium Hall", isFree: true },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.event.rsvpCount, 1);

  const ics = await api(app, { method: "GET", url: `/events/${res.body.event.id}/ics`, token: host.accessToken });
  assert.equal(ics.status, 200);
  assert.match(String(ics.body), /DTSTART:/);
  assert.match(ics.headers["content-type"], /text\/calendar/);
});

test("rsvp respects capacity and spills to WAITLIST", async () => {
  const app = await testApp();
  const host = await createUser(app);
  const a = await createUser(app);
  const b = await createUser(app);
  const created = await api(app, { method: "POST", url: "/events", token: host.accessToken, payload: { title: "Small Meetup", startsAt: inDays(5), endsAt: inDaysEnd(5), capacity: 2, isFree: true } });
  const eventId = created.body.event.id; // host already occupies 1 of 2 seats

  const rsvpA = await api(app, { method: "POST", url: `/events/${eventId}/rsvp`, token: a.accessToken, payload: { status: "GOING" } });
  assert.equal(rsvpA.status, 200);
  assert.equal(rsvpA.body.status, "GOING");

  const rsvpB = await api(app, { method: "POST", url: `/events/${eventId}/rsvp`, token: b.accessToken, payload: { status: "GOING" } });
  assert.equal(rsvpB.status, 200);
  assert.equal(rsvpB.body.status, "WAITLIST");

  const pub = await api(app, { method: "GET", url: `/public/events/${created.body.event.slug}`, token: host.accessToken });
  assert.equal(pub.body.counts.going, 2);
  assert.equal(pub.body.counts.spotsLeft, 0);
});

test("attendee list visibility HOST hides the list from a guest but shows it to the host", async () => {
  const app = await testApp();
  const host = await createUser(app);
  const guest = await createUser(app);
  const created = await api(app, {
    method: "POST",
    url: "/events",
    token: host.accessToken,
    payload: { title: "Invite-only roundtable", startsAt: inDays(3), endsAt: inDaysEnd(3), isFree: true, attendeeListVisibility: "HOST" },
  });
  await api(app, { method: "POST", url: `/events/${created.body.event.id}/rsvp`, token: guest.accessToken, payload: { status: "GOING" } });

  const asGuest = await api(app, { method: "GET", url: `/events/${created.body.event.id}/attendees`, token: guest.accessToken });
  assert.equal(asGuest.status, 403);

  const asHost = await api(app, { method: "GET", url: `/events/${created.body.event.id}/attendees`, token: host.accessToken });
  assert.equal(asHost.status, 200);
  assert.ok(asHost.body.items.some((i: any) => i.person?.id === guest.personId));

  const pubAsGuest = await api(app, { method: "GET", url: `/public/events/${created.body.event.slug}`, token: guest.accessToken });
  assert.equal(pubAsGuest.body.attendeeListVisible, false);
  assert.equal(pubAsGuest.body.attendees.length, 0);
});

test("an ATTENDEES-visibility event's list is visible to anyone who RSVP'd", async () => {
  const app = await testApp();
  const host = await createUser(app);
  const guest = await createUser(app);
  const created = await api(app, { method: "POST", url: "/events", token: host.accessToken, payload: { title: "Open Roundtable", startsAt: inDays(3), endsAt: inDaysEnd(3), isFree: true, attendeeListVisibility: "ATTENDEES" } });
  await api(app, { method: "POST", url: `/events/${created.body.event.id}/rsvp`, token: guest.accessToken, payload: { status: "GOING" } });
  const asGuest = await api(app, { method: "GET", url: `/events/${created.body.event.id}/attendees`, token: guest.accessToken });
  assert.equal(asGuest.status, 200);
  assert.equal(asGuest.body.items.length, 2); // host + guest
});

test("the reminder job fires event.reminder for a due rsvp and clears reminderAt", async () => {
  const app = await testApp();
  const host = await createUser(app);
  const guest = await createUser(app);
  const created = await api(app, { method: "POST", url: "/events", token: host.accessToken, payload: { title: "Wholesale meetup", startsAt: inDays(1), endsAt: inDaysEnd(1), isFree: true } });
  await api(app, { method: "POST", url: `/events/${created.body.event.id}/rsvp`, token: guest.accessToken, payload: { status: "GOING" } });

  // Force the reminder due now instead of waiting 24h.
  await tdb().eventRsvp.update({ where: { eventId_personId: { eventId: created.body.event.id, personId: guest.personId } }, data: { reminderAt: new Date(Date.now() - 1000) } });

  await sendDueEventReminders(tdb());

  const notifs = await api(app, { method: "GET", url: "/notifications", token: guest.accessToken });
  assert.ok(notifs.body.items.some((n: any) => n.kind === "event.reminder"));

  const row = await tdb().eventRsvp.findUnique({ where: { eventId_personId: { eventId: created.body.event.id, personId: guest.personId } } });
  assert.equal(row?.reminderAt, null);
});

test("editing the venue notifies GOING/INTERESTED attendees with event.update", async () => {
  const app = await testApp();
  const host = await createUser(app);
  const guest = await createUser(app);
  const created = await api(app, { method: "POST", url: "/events", token: host.accessToken, payload: { title: "Networking Night", startsAt: inDays(7), endsAt: inDaysEnd(7), isFree: true, venue: "Old Hall" } });
  await api(app, { method: "POST", url: `/events/${created.body.event.id}/rsvp`, token: guest.accessToken, payload: { status: "GOING" } });

  const patch = await api(app, { method: "PATCH", url: `/events/${created.body.event.id}`, token: host.accessToken, payload: { venue: "New Hall" } });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.event.venue, "New Hall");

  const notifs = await api(app, { method: "GET", url: "/notifications", token: guest.accessToken });
  assert.ok(notifs.body.items.some((n: any) => n.kind === "event.update"));
});

test("only the host (or an org/group admin) can edit an event", async () => {
  const app = await testApp();
  const host = await createUser(app);
  const stranger = await createUser(app);
  const created = await api(app, { method: "POST", url: "/events", token: host.accessToken, payload: { title: "Members only", startsAt: inDays(4), endsAt: inDaysEnd(4), isFree: true } });
  const patch = await api(app, { method: "PATCH", url: `/events/${created.body.event.id}`, token: stranger.accessToken, payload: { title: "Hijacked" } });
  assert.equal(patch.status, 403);
});
