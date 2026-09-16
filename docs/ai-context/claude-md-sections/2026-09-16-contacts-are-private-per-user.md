# ⛔ Contacts are PRIVATE to the person who saved them (2026-09-16) — ✅ DEPLOYED + live-proven

Full handoff: **`docs/ai-context/AGENT_HANDOFF_PRIVATE_CONTACTS_2026-09-16.md`**

- **Report:** Relax Tires ext 101 — the two new extensions (102 Alex, 103 Felix) got all of
  his personal contacts in their app. **True:** 4,250 contacts, all created by 101, and
  `GET /contacts` returned every contact in the company. Same leak ran through the
  incoming/missed-call caller NAME, the duplicate check, the import merge, global search,
  the assistant's `list_contacts`, SMS→email, CRM hooks and supermarket blasts.
- **Fix (`2acf52b8` + `5f279499`):** `Contact.ownerUserId` (no FK on purpose); migration
  backfills `ownerUserId = createdBy` for every non-CRM contact. One rule in
  `apps/api/src/contactVisibility.ts`: shared + mine; no viewer = shared only; **no admin
  bypass**. CRM paths = shared only. `matchTenantContactByPhone` now REQUIRES a viewer.
- **Live proof (deployed code, real users):** 101 sees 4,250; **102 and 103 see 0** (only
  the 3 extensions). Assistant door: 101 → 4250, 102 → 0. api `34ff3aae` (contains fix),
  worker `e0e1ef28`, agent rebuilt `e0e1ef28` — all grepped in-container, 0 restarts.
- **Guard:** `contactVisibility.test.ts` 7 tests, 5 FAIL on pre-fix HEAD.
- ⛔⛔ First api deploy died `MODULE_NOT_FOUND`: staging `server.ts` swept another
  session's uncommitted textingRegistration wiring. Blue/green kept prod up; `5f279499`
  took those lines back. Stage hunks, not whole files, in this tree.
- ⏳ Not proven by a human: 102 opening the app; a real call to 102 from a 101-phone-book
  number showing no name. Portal-added contacts are now private too ("share with
  company" not built).
