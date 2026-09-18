"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RequireAuth, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError } from "@/lib/api";
import { Button, Field, Icon, useToast } from "@/components/ui";
import "@/components/events/events.css";

type Speaker = { name: string; title: string };
type Sponsor = { name: string; url: string };
type MyGroup = { id: string; name: string; myMembership: { role: string; state: string } | null };

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function NewEventForm() {
  const { me } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const params = useSearchParams();
  const initialGroupId = params.get("groupId") ?? "";

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<"IN_PERSON" | "ONLINE" | "HYBRID">("IN_PERSON");
  const in2h = new Date(Date.now() + 2 * 3_600_000);
  const in4h = new Date(Date.now() + 4 * 3_600_000);
  const [startsAt, setStartsAt] = useState(toLocalInputValue(in2h));
  const [endsAt, setEndsAt] = useState(toLocalInputValue(in4h));
  const [venue, setVenue] = useState("");
  const [address, setAddress] = useState("");
  const [onlineUrl, setOnlineUrl] = useState("");
  const [capacity, setCapacity] = useState("");
  const [isFree, setIsFree] = useState(true);
  const [price, setPrice] = useState("");
  const [attendeeListVisibility, setAttendeeListVisibility] = useState<"PUBLIC" | "ATTENDEES" | "HOST">("ATTENDEES");
  const [organizationId, setOrganizationId] = useState("");
  const [groupId, setGroupId] = useState(initialGroupId);
  const [groups, setGroups] = useState<MyGroup[]>([]);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ items: MyGroup[] }>("/me/groups").then((r) => setGroups(r.items.filter((g) => g.myMembership?.state === "ACTIVE" && (g.myMembership.role === "OWNER" || g.myMembership.role === "ADMIN"))));
  }, []);

  const orgOptions = (me?.memberships ?? []).filter((m) => m.affiliation !== "REJECTED");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (title.trim().length < 2) {
      setError("Give the event a title.");
      return;
    }
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      setError("The event has to end after it starts.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ event: { id: string; slug: string } }>("/events", {
        method: "POST",
        body: {
          title: title.trim(),
          description: description || undefined,
          mode,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          venue: mode !== "ONLINE" ? venue || undefined : undefined,
          address: mode !== "ONLINE" ? address || undefined : undefined,
          onlineUrl: mode !== "IN_PERSON" ? onlineUrl || undefined : undefined,
          capacity: capacity ? Number(capacity) : undefined,
          isFree,
          price: !isFree && price ? Number(price) : undefined,
          attendeeListVisibility,
          organizationId: organizationId || undefined,
          groupId: groupId || undefined,
          speakers: speakers.filter((s) => s.name.trim()).map((s) => ({ name: s.name.trim(), title: s.title.trim() || undefined })),
          sponsors: sponsors.filter((s) => s.name.trim()).map((s) => ({ name: s.name.trim(), url: s.url.trim() || undefined })),
        },
      });
      toast(`${title} is live.`);
      router.push(`/events/${res.event.slug}`);
    } catch (err) {
      setError((err as ApiError).message ?? "Couldn't create the event.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gridColumn: "1/-1", maxWidth: 720 }}>
      <form className="card" onSubmit={submit}>
        <div className="ct">Create an event</div>
        <Field label="Title" htmlFor="ev-title">
          <input id="ev-title" className="in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} required data-testid="events-new-title" />
        </Field>
        <Field label="Description" htmlFor="ev-desc">
          <textarea id="ev-desc" className="in" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={6000} data-testid="events-new-description" />
        </Field>
        <Field label="Format" htmlFor="ev-mode">
          <select id="ev-mode" className="in" value={mode} onChange={(e) => setMode(e.target.value as any)} data-testid="events-new-mode">
            <option value="IN_PERSON">In person</option>
            <option value="ONLINE">Online</option>
            <option value="HYBRID">Hybrid</option>
          </select>
        </Field>
        <div className="event-form-grid">
          <Field label="Starts" htmlFor="ev-start">
            <input id="ev-start" type="datetime-local" className="in" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required data-testid="events-new-starts" />
          </Field>
          <Field label="Ends" htmlFor="ev-end">
            <input id="ev-end" type="datetime-local" className="in" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required data-testid="events-new-ends" />
          </Field>
        </div>
        {mode !== "ONLINE" ? (
          <div className="event-form-grid">
            <Field label="Venue" htmlFor="ev-venue">
              <input id="ev-venue" className="in" value={venue} onChange={(e) => setVenue(e.target.value)} maxLength={200} data-testid="events-new-venue" />
            </Field>
            <Field label="Address" htmlFor="ev-address">
              <input id="ev-address" className="in" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} data-testid="events-new-address" />
            </Field>
          </div>
        ) : null}
        {mode !== "IN_PERSON" ? (
          <Field label="Online link" htmlFor="ev-url" help="Sent to attendees closer to the date">
            <input id="ev-url" className="in" value={onlineUrl} onChange={(e) => setOnlineUrl(e.target.value)} placeholder="https://" data-testid="events-new-onlineurl" />
          </Field>
        ) : null}
        <div className="event-form-grid">
          <Field label="Capacity" htmlFor="ev-cap" help="Leave blank for unlimited">
            <input id="ev-cap" type="number" min={1} className="in" value={capacity} onChange={(e) => setCapacity(e.target.value)} data-testid="events-new-capacity" />
          </Field>
          <Field label="Who can see the attendee list" htmlFor="ev-vis">
            <select id="ev-vis" className="in" value={attendeeListVisibility} onChange={(e) => setAttendeeListVisibility(e.target.value as any)} data-testid="events-new-visibility">
              <option value="PUBLIC">Anyone</option>
              <option value="ATTENDEES">Attendees only</option>
              <option value="HOST">Host only</option>
            </select>
          </Field>
        </div>
        <label className="li" style={{ alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={isFree} onChange={(e) => setIsFree(e.target.checked)} data-testid="events-new-free" />
          <div className="t">
            <b style={{ fontWeight: 500 }}>Free event</b>
          </div>
        </label>
        {!isFree ? (
          <Field label="Price (USD)" htmlFor="ev-price">
            <input id="ev-price" type="number" min={0} step="0.01" className="in" value={price} onChange={(e) => setPrice(e.target.value)} data-testid="events-new-price" />
          </Field>
        ) : null}
        {orgOptions.length ? (
          <Field label="Host as a company (optional)" htmlFor="ev-org">
            <select id="ev-org" className="in" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} data-testid="events-new-org">
              <option value="">Just me</option>
              {orgOptions.map((m) => (
                <option key={m.organization.id} value={m.organization.id}>
                  {m.organization.displayName}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {groups.length ? (
          <Field label="Attach to a group you admin (optional)" htmlFor="ev-group">
            <select id="ev-group" className="in" value={groupId} onChange={(e) => setGroupId(e.target.value)} data-testid="events-new-group">
              <option value="">No group</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <div className="lbl" style={{ marginTop: 10 }}>Speakers</div>
        {speakers.map((s, i) => (
          <div className="row" key={i}>
            <input className="in" placeholder="Name" value={s.name} onChange={(e) => setSpeakers((cur) => cur.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} data-testid={`events-new-speaker-name-${i}`} />
            <input className="in" placeholder="Title / company" value={s.title} onChange={(e) => setSpeakers((cur) => cur.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} data-testid={`events-new-speaker-title-${i}`} />
            <button type="button" className="ib" aria-label="Remove speaker" onClick={() => setSpeakers((cur) => cur.filter((_, j) => j !== i))} data-testid={`events-new-speaker-remove-${i}`}>
              <Icon name="x" />
            </button>
          </div>
        ))}
        <Button kind="g" small type="button" icon="plus" onClick={() => setSpeakers((cur) => [...cur, { name: "", title: "" }])} data-testid="events-new-speaker-add">
          Add a speaker
        </Button>

        <div className="lbl" style={{ marginTop: 10 }}>Sponsors</div>
        {sponsors.map((s, i) => (
          <div className="row" key={i}>
            <input className="in" placeholder="Name" value={s.name} onChange={(e) => setSponsors((cur) => cur.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} data-testid={`events-new-sponsor-name-${i}`} />
            <input className="in" placeholder="https://" value={s.url} onChange={(e) => setSponsors((cur) => cur.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} data-testid={`events-new-sponsor-url-${i}`} />
            <button type="button" className="ib" aria-label="Remove sponsor" onClick={() => setSponsors((cur) => cur.filter((_, j) => j !== i))} data-testid={`events-new-sponsor-remove-${i}`}>
              <Icon name="x" />
            </button>
          </div>
        ))}
        <Button kind="g" small type="button" icon="plus" onClick={() => setSponsors((cur) => [...cur, { name: "", url: "" }])} data-testid="events-new-sponsor-add">
          Add a sponsor
        </Button>

        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="row" style={{ marginTop: 14 }}>
          <Button kind="p" type="submit" loading={busy} data-testid="events-new-submit">
            Create event
          </Button>
          <Button kind="g" type="button" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

export default function NewEventPage() {
  return (
    <RequireAuth>
      <AppShell title="Create an event">
        <NewEventForm />
      </AppShell>
    </RequireAuth>
  );
}
