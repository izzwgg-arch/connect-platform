import type { Db } from "../db.js";
import { env } from "../env.js";
import { slugify, shortSuffix } from "../lib/ids.js";
import { buildSearchText } from "../lib/search.js";
import { personCard, personCards, type PersonCard } from "../profiles/cards.js";
import { orgCard, type OrgCard } from "../organizations/cards.js";
import { calendarNote } from "./calendar.js";

export async function uniqueEventSlug(db: Db, title: string): Promise<string> {
  const base = slugify(title);
  for (let i = 0; i < 8; i++) {
    const candidate = i === 0 ? base : `${base}-${shortSuffix()}`;
    const exists = await db.event.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }
  return `${base}-${shortSuffix()}`;
}

export function eventSearchText(e: { title: string; description?: string | null; venue?: string | null; address?: string | null }): string {
  return buildSearchText([e.title, e.description, e.venue, e.address]);
}

export type EventCard = {
  id: string;
  slug: string;
  title: string;
  mode: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  venue: string | null;
  address: string | null;
  onlineUrl: string | null;
  isFree: boolean;
  price: string | null;
  coverAssetId: string | null;
  rsvpCount: number;
  capacity: number | null;
  organizationId: string | null;
  groupId: string | null;
  hostId: string;
};

type EventRow = {
  id: string;
  slug: string;
  title: string;
  mode: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  venue: string | null;
  address: string | null;
  onlineUrl: string | null;
  isFree: boolean;
  price: unknown;
  coverAssetId: string | null;
  rsvpCount: number;
  capacity: number | null;
  organizationId: string | null;
  groupId: string | null;
  hostId: string;
};

export function eventCard(e: EventRow): EventCard {
  return {
    id: e.id,
    slug: e.slug,
    title: e.title,
    mode: e.mode,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    timezone: e.timezone,
    venue: e.venue,
    address: e.address,
    onlineUrl: e.onlineUrl,
    isFree: e.isFree,
    price: e.price == null ? null : String(e.price),
    coverAssetId: e.coverAssetId,
    rsvpCount: e.rsvpCount,
    capacity: e.capacity,
    organizationId: e.organizationId,
    groupId: e.groupId,
    hostId: e.hostId,
  };
}

export type EventDetail = EventCard & {
  description: string | null;
  attendeeListVisibility: string;
  speakers: unknown;
  sponsors: unknown;
  chatThreadId: string | null;
  host: PersonCard | null;
  organization: OrgCard | null;
  group: { id: string; slug: string; name: string } | null;
  calendarNote: string | null;
};

export async function hydrateEventDetail(db: Db, e: EventRow & { description: string | null; attendeeListVisibility: string; speakers: unknown; sponsors: unknown; chatThreadId: string | null; groupId: string | null }): Promise<EventDetail> {
  const [host, org, group] = await Promise.all([
    personCard(db, e.hostId),
    e.organizationId ? orgCard(db, e.organizationId) : Promise.resolve(null),
    e.groupId ? db.group.findUnique({ where: { id: e.groupId }, select: { id: true, slug: true, name: true } }) : Promise.resolve(null),
  ]);
  return {
    ...eventCard(e),
    description: e.description,
    attendeeListVisibility: e.attendeeListVisibility,
    speakers: e.speakers,
    sponsors: e.sponsors,
    chatThreadId: e.chatThreadId,
    host,
    organization: org,
    group,
    calendarNote: calendarNote(e.startsAt, e.endsAt),
  };
}

/** Builds a minimal, valid VEVENT .ics for "Add to calendar". */
export function buildIcs(e: { id: string; title: string; description: string | null; startsAt: Date; endsAt: Date; venue: string | null; address: string | null; onlineUrl: string | null; slug: string }): string {
  const dt = (d: Date) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const location = [e.venue, e.address].filter(Boolean).join(", ") || e.onlineUrl || "";
  const url = `${env().COMMUNITY_API_URL}/public/events/${e.slug}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Loopcom Community//Events//EN",
    "BEGIN:VEVENT",
    `UID:${e.id}@loopcom-community`,
    `DTSTAMP:${dt(new Date())}`,
    `DTSTART:${dt(e.startsAt)}`,
    `DTEND:${dt(e.endsAt)}`,
    `SUMMARY:${esc(e.title)}`,
    location ? `LOCATION:${esc(location)}` : null,
    e.description ? `DESCRIPTION:${esc(e.description)}` : null,
    `URL:${url}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter((l): l is string => l != null);
  return lines.join("\r\n");
}

export function googleCalendarUrl(e: { title: string; description: string | null; startsAt: Date; endsAt: Date; venue: string | null; address: string | null; onlineUrl: string | null }): string {
  const dt = (d: Date) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const location = [e.venue, e.address].filter(Boolean).join(", ") || e.onlineUrl || "";
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${dt(e.startsAt)}/${dt(e.endsAt)}`,
    details: e.description ?? "",
    location,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export async function attendeeCards(db: Db, eventId: string, limit = 100): Promise<Array<{ person: PersonCard; status: string }>> {
  const rows = await db.eventRsvp.findMany({ where: { eventId, visible: true, status: { in: ["GOING", "INTERESTED"] } }, take: limit, orderBy: { createdAt: "asc" } });
  const cards = await personCards(db, rows.map((r) => r.personId));
  return rows.map((r) => ({ person: cards.get(r.personId)!, status: r.status })).filter((r) => r.person);
}
