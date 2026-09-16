/**
 * WHO MAY SEE A SAVED CONTACT (2026-09-16, Izzy's standing rule).
 *
 * Relax Tires ext 101 imported his phone book (4,250 contacts). When extensions
 * 102 and 103 signed in, every one of those contacts was in THEIR app too,
 * because GET /contacts returned every contact in the company. Izzy: "This
 * should never, ever happen … even if it's in the same company, different
 * extensions shouldn't get other people's contacts."
 *
 * The rule, in one place:
 *   - `Contact.ownerUserId` set  → PRIVATE: only that one user ever sees it.
 *   - `Contact.ownerUserId` null → SHARED company contact (CRM leads, website
 *     submissions, seed data). CRM has its own per-user access rules on top.
 *
 * ⛔ There is NO admin bypass. A tenant admin (or platform staff working inside a
 * tenant) does not see a colleague's private phone book either.
 * ⛔ Every read of Contact / ContactPhone / ContactEmail that can put a name or a
 * number in front of a person MUST go through one of these fragments — a
 * duplicate check or a phone-number match that ignores them leaks a name.
 * `contactVisibility.test.ts` reads the callers' source to hold that line.
 */

/** Contacts this user may see: shared ones plus their own private ones. */
export function contactVisibleToUserWhere(userId: string | null | undefined): Record<string, unknown> {
  const id = typeof userId === "string" ? userId.trim() : "";
  // No known viewer → shared contacts only. Never "everything".
  if (!id) return { ownerUserId: null };
  return { OR: [{ ownerUserId: null }, { ownerUserId: id }] };
}

/** Shared company contacts only — for machine paths with no single viewer (blasts, CRM hooks). */
export const SHARED_CONTACTS_ONLY_WHERE: Readonly<Record<string, unknown>> = Object.freeze({ ownerUserId: null });

/** Pure predicate mirror of {@link contactVisibleToUserWhere}, for rows already loaded. */
export function isContactVisibleToUser(
  contact: { ownerUserId?: string | null } | null | undefined,
  userId: string | null | undefined,
): boolean {
  if (!contact) return false;
  const owner = contact.ownerUserId ?? null;
  if (owner === null) return true;
  const id = typeof userId === "string" ? userId.trim() : "";
  return id !== "" && owner === id;
}
