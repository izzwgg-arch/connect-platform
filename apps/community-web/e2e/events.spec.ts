import { test, expect } from "@playwright/test";
import { signUp, uid, API, snap } from "./helpers";

function futureDateTimeLocal(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 16);
}

test.describe("events", () => {
  test("create an event; a second user RSVPs; the ics download link works", async ({ page, browser }) => {
    await signUp(page, { first: "Gitel" });
    const title = `E2E Craft Fair ${uid()}`;

    await page.goto("/events/new");
    await page.getByTestId("events-new-title").fill(title);
    await page.getByTestId("events-new-description").fill("A community craft fair for E2E vendors.");
    await page.getByTestId("events-new-mode").selectOption("IN_PERSON");
    await page.getByTestId("events-new-starts").fill(futureDateTimeLocal(7));
    await page.getByTestId("events-new-ends").fill(futureDateTimeLocal(7.1));
    await page.getByTestId("events-new-venue").fill("Community Hall");
    await page.getByTestId("events-new-address").fill("123 Main St, Monroe, NY");
    await page.getByTestId("events-new-free").check();
    await page.getByTestId("events-new-submit").click();
    // exclude "new": a bare /\/events\// also matches /events/new before the
    // post-create redirect actually happens, passing this assertion too early.
    await expect(page).toHaveURL(/\/events\/(?!new)/);
    const url = page.url();
    const slug = url.match(/\/events\/([^/?]+)/)![1];
    // the URL uses the slug, but /events/:id/ics needs the real id
    const publicEvent = await page.request.get(`${API}/public/events/${slug}`);
    const publicEventBody = await publicEvent.json();
    const eventId = (publicEventBody.event?.id ?? publicEventBody.id) as string;
    expect(eventId).toBeTruthy();

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { first: "Hadassa" });
    await pageB.goto(url);
    await pageB.getByTestId("event-rsvp-going").click();
    await expect(pageB.getByTestId("event-cancel-rsvp")).toBeVisible();

    // ics download link works — fetch it with the signed-in session's token and
    // check it's a real calendar file (the button itself triggers this same
    // fetch client-side via JS, not a plain <a href>, so we verify the endpoint directly).
    const token = await pageB.evaluate(() => window.localStorage.getItem("lc.access"));
    const ics = await pageB.request.get(`${API}/events/${eventId}/ics`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    expect(ics.ok()).toBeTruthy();
    const body = await ics.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    await snap(pageB, "events");

    await ctxB.close();
  });
});
