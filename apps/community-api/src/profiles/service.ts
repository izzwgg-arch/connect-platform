import type { Db } from "../db.js";
import { buildSearchText } from "../lib/search.js";

/**
 * Rebuilds `Profile.searchText` from everything CONVENTIONS §9 says must feed
 * it: name, headline, about, industry, location, skills/serviceArea/languages,
 * service names, experience titles/companies. `searchTsv` is a Postgres
 * GENERATED column over `searchText` (migration 20260918124200), so writing
 * the text column is enough — no raw SQL needed here.
 */
export async function rebuildProfileSearchText(db: Db, personId: string): Promise<void> {
  const [profile, experiences, services] = await Promise.all([
    db.profile.findUnique({ where: { personId } }),
    db.experience.findMany({ where: { personId }, select: { title: true, companyName: true } }),
    db.profileService.findMany({ where: { personId }, select: { name: true } }),
  ]);
  if (!profile) return;
  const text = buildSearchText([
    profile.firstName,
    profile.lastName,
    profile.headline,
    profile.about,
    profile.industry,
    profile.location,
    profile.skills,
    profile.serviceArea,
    profile.languages,
    services.map((s) => s.name),
    experiences.flatMap((e) => [e.title, e.companyName]),
  ]);
  await db.profile.update({ where: { personId }, data: { searchText: text } });
}

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/;
const RESERVED_USERNAMES = new Set([
  "admin", "api", "me", "public", "auth", "settings", "messages", "search", "help", "support",
  "loopcom", "community", "null", "undefined", "dev", "flags", "media", "notifications",
]);

/** Returns a human sentence when the candidate username is unusable, else null. */
export function usernameProblem(raw: string): string | null {
  const u = raw.trim().toLowerCase();
  if (u.length < 3 || u.length > 30) return "Usernames are 3 to 30 characters.";
  if (!USERNAME_RE.test(u)) return "Use lowercase letters, numbers and single hyphens — no spaces or symbols, and it can't start or end with a hyphen.";
  if (RESERVED_USERNAMES.has(u)) return "That username is reserved. Try another.";
  return null;
}

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}
