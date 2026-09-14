# ⛔⛔ AGENT HANDOFF — saved contact names now actually show on incoming calls and missed-call alerts (2026-08-23) — READ FIRST for ANY "contacts don't show on calls" report, before touching caller-name resolution on either side, or before trusting `numberNormalized` digit matching

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(`57ab7c71` on `feat/ivr-migration-takeover` — api + mobile. Deploy/build state at the
end of this section. The complaint was **Relax Tires ext 101** — 4,168 contacts, the
platform's largest list — and it was a STACK of defects, not one.)

- ⛔⛔ **THE DETERMINISTIC KILLER: the invite-path missed-call push read
  `invite.callerName` — A COLUMN THAT DOES NOT EXIST on CallInvite** — and the
  callback takes `invite: any`, so the typo compiled and every missed-call alert
  showed the raw number forever while the resolved contact name sat unread in
  `fromDisplay`. One-word fix; a source guard in `inboundCallerMatch.test.ts` now
  fails if `invite.callerName ||` ever returns. **The `any`-typed-callback +
  nonexistent-column shape is this repo's `(db as any)` transposition trap again.**
- ⛔⛔ **`ContactPhone.numberNormalized` IS STORED WITH THE LEADING `+`**
  (`+18457992855` — verified live on every sampled row) **while
  `buildPhoneMatchCandidates` produced digit-only keys** — so the exact indexed
  branch of `matchTenantContactByPhone` could never hit and every lookup fell
  through to the un-indexed `endsWith` suffix scan. The candidates now carry the
  +-forms. **Never assume the normalized column is digit-only; read a real row.**
- ⛔ **The ring path (`/internal/mobile-ring-notify`) had its own inline
  `endsWith` lookup** — an un-indexed `LIKE '%suffix'` scan of ContactPhone
  PLATFORM-WIDE on the ring hot path, slowest for exactly the biggest contact
  lists — replaced with `matchTenantContactByPhone`. ⛔ Its dedup branch used to
  return BEFORE writing the resolved name when the PBX-event/wake path had
  created the invite first with raw CNAM — the row is updated now.
- ⛔ **The mobile ring screen had NO contact fallback at all** — it trusted the
  push's `fromDisplay` alone while ActiveCall and Recents resolved locally.
  `IncomingCallScreen` now runs `useContactNameResolver` and a saved contact's
  name beats carrier CNAM (same rule as the server).
- ⛔ **Client matching keyed on `numberRaw` only** — imported phone-book
  formatting ("+1 (845) 555-1234 ext 12" → 13 digits) defeats `phoneMatchKey`,
  so imported contacts never resolved. Both map builders (RecentTab +
  useContactNameResolver) key on `numberNormalized` AND `numberRaw` now.
- ⛔ **The 4,000-contact cache pathology:** the directory is a 5-page,
  several-MB walk for this tenant; a single flaky page silently dropped the
  whole tail and CACHED IT AS COMPLETE (one retry per page now); nothing warmed
  the cache at startup (a `useContactsPreload` sits beside the chat preload in
  TabNavigator now); and `gcTime: 20min` evicted the whole directory between
  uses (24h now). **In-memory only — there is still NO persistence; a cold
  start still needs the walk before Recents shows names.**
- ⛔ **`/voice/me/calls` (mobile Recents) returns NO server-resolved contact
  name** — resolution is 100% client-side there. Deliberately unchanged.
- ✅ **Proven:** 10/10 `inboundCallerMatch.test.ts` incl. 3 source guards that
  ALL fail replayed against pre-fix HEAD; the live repro pair from prod
  (inbound `8457992855` ↔ contact `+18457992855`, same person); api typecheck
  at its 76 baseline with none at an edited line; mobile typecheck 0.
- ⏳ **NOT PROVEN: no real inbound call has exercised the fix** — acceptance is
  one call to Relax Tires ext 101 from a saved contact showing the name on the
  ring screen AND the missed-call alert. Deploy/build state: see the commit —
  api DEPLOYED and container-verified (`.build-commit` = `57ab7c71`, old typo
  grep 0, matcher grep 1, health 200 both hostnames, 0 restarts); the mobile
  half is in the fleet APK **published 2026-08-23** (`1.0.0+20260823-113754`).
