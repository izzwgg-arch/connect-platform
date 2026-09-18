import type { Db } from "../db.js";
import { slugify, shortSuffix } from "../lib/ids.js";
import { buildSearchText } from "../lib/search.js";

/** Slug from the group name, de-duped with a short suffix on collision. */
export async function uniqueGroupSlug(db: Db, name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 8; i++) {
    const candidate = i === 0 ? base : `${base}-${shortSuffix()}`;
    const exists = await db.group.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }
  return `${base}-${shortSuffix()}`;
}

export function groupSearchText(g: { name: string; description?: string | null; category?: string | null; rules?: string | null }): string {
  return buildSearchText([g.name, g.description, g.category, g.rules]);
}

export type GroupCard = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  isPrivate: boolean;
  requiresApproval: boolean;
  coverAssetId: string | null;
  logoAssetId: string | null;
  memberCount: number;
  chatThreadId: string | null;
  createdAt: string;
};

export function groupCard(g: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  isPrivate: boolean;
  requiresApproval: boolean;
  coverAssetId: string | null;
  logoAssetId: string | null;
  memberCount: number;
  chatThreadId: string | null;
  createdAt: Date;
}): GroupCard {
  return {
    id: g.id,
    slug: g.slug,
    name: g.name,
    description: g.description,
    category: g.category,
    isPrivate: g.isPrivate,
    requiresApproval: g.requiresApproval,
    coverAssetId: g.coverAssetId,
    logoAssetId: g.logoAssetId,
    memberCount: g.memberCount,
    chatThreadId: g.chatThreadId,
    createdAt: g.createdAt.toISOString(),
  };
}

/** Adds a person to a group's chat thread as an active participant, if they aren't already one. */
export async function ensureInGroupChat(db: Db, threadId: string | null, personId: string, role: "ADMIN" | "MEMBER" = "MEMBER") {
  if (!threadId) return;
  const existing = await db.threadParticipant.findUnique({ where: { threadId_personId: { threadId, personId } } });
  if (!existing) {
    await db.threadParticipant.create({ data: { threadId, personId, role, state: "ACTIVE" } });
  } else if (existing.state !== "ACTIVE") {
    await db.threadParticipant.update({ where: { id: existing.id }, data: { state: "ACTIVE" } });
  }
}
