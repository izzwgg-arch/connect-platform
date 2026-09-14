# ⛔⛔ AGENT HANDOFF — the PBX name is what we call people now, on screen and in every email (2026-08-17) — READ FIRST before rendering a person's name ANYWHERE, before adding a naming fallback, or before "fixing" a name that looks wrong

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_USER_NAMES_EMAIL_VS_PBX_2026-08-17.md`**
(`48052a59` + `b7244858`. **api + portal DEPLOYED and container-verified.** No
migration, no PBX write, **no data changed** — the right names were already on the
extension rows.) Memory: [[name-comes-from-email-not-pbx]].

- ⛔⛔ **ONE RULE, ONE FILE: `packages/shared/src/personDisplayName.ts`. The PBX
  extension name is ALWAYS the source of truth** (Izzy, 2026-08-17). It holds for
  existing customers AND new sign-ups, because at onboarding the name the customer
  types becomes that person's extension name (`ext_name: person.name`,
  `onboarding/pbxTenantBuild.ts`) — **so there is no "new tenants are different"
  branch, and do not add one.** ⛔ **If the PBX says "Front Desk", the person is
  called Front Desk** — asked and answered; do not add cleverness that detects
  "that's not a real name" and falls back to the email.
- ⛔ **It is SHARED between the portal and apps/api on purpose.** They each had
  their own copy, the api's never looked at the extension, and that drift WAS the
  bug: **55 of 65 customers were greeted by the front half of their email address**
  ("Welcome, 845luzerj" for Luzer Jungreis, "Welcome, 7816646" for Barish) while
  the sidebar beside it showed the real name, and real invitations went out
  reading **"Hi s," / "Hi g," / "Hi fix,"**. Never reimplement it locally.
- ✅ **PROVEN AGAINST LIVE DATA WITH THE DEPLOYED CODE, not inferred: 56 of 65
  names changed and ZERO users still show an email address.** Containers verified
  both ways — the api carries the new resolvers and the old email-only one is
  **gone**; the portal bundle carries the prefix-strip regex and **no longer
  contains the old `[._-]` splitter**. ⛔ Grep the shipped bundle by the **regex
  literal**, not the function name — minification renames the name and a 0-hit
  grep reads exactly like a failed deploy.
- ⛔ **Two traps the rule already handles — do not "simplify" either away.**
  (1) Some tenants prefix the extension name with its number (`"105 - Mrs. Halpert"`,
  and `"101- Mr. Sofer"` with no space, so a stricter pattern misses it); it is
  stripped, or the headline reads **"Welcome, 105"**. (2) **The name is NEVER cut
  to a first word** — that turns "Front Desk" into "Front" and "Mrs. Halpert" into
  "Mrs.". So emails now open "Hi Mrs. Halpert,". Going back to first names needs a
  person-vs-department distinction that cannot be derived from the name.
- ⛔ **A name typed in lower case is capitalised** (Izzy, 2026-08-17: *"even if the
  customer enters it in lower case, you should always use uppercase on the
  first"*) — inii mini's `baila` reads **Baila**, Landau's `home 2` reads
  **Home 2**. ⛔⛔ **`capitalizeNameWords` only ever RAISES a lower-case first
  letter and NEVER lowercases anything** — that is what protects `TEMP`,
  `S M Weiss`, `McNamara` and `LUZER`, all of which a `toLowerCase()`-first
  implementation would wreck. ⛔ Words split on whitespace and hyphens but **not
  apostrophes**: `mary-jane` → Mary-Jane, while splitting on `'` would give
  *"Shloime'S Phone"*. ⛔ It is applied inside `getExtensionDisplayName` too, not
  at the call sites — the sidebar, profile menu and dashboard all take that path.
  ✅ Proven live with the deployed code: **0 of 65 names still start lower case.**
- ⛔⛔ **A PROMISE `.catch()` DOES NOT CATCH A SYNCHRONOUS THROW — this shipped
  broken for one commit and the onboarding suite caught it.** The name lookup used
  `db.extension.findFirst(...).catch(() => null)`; when the model accessor is
  missing the call throws **before a promise exists**, so **the whole invitation
  failed** instead of merely losing the nicer name (12 red tests,
  `import_db.db.extension.findFirst is not a function`). It is a real `try`/`catch`
  + optional call now, in both apps/api and onboarding.
- ⛔ **The guard test reads the CALL SITES' source** (`userDisplayName.callsites.test.ts`,
  `apps/portal/lib/userDisplayName.test.ts`) — the defect was callers: queries that
  never fetched the extension, and templates handed the raw `firstName` column. A
  unit test of the resolver passes straight through all of it. **Proven real: every
  assertion fails against the pre-fix files.**
- ⛔ **Sloppy PBX names are now VISIBLE, and that is correct, not a bug.**
  `izzywkg@gmail.com` on A plus center is greeted **"TEMP"** (ext 110 is named
  TEMP), Fixup Group's owner gets **"Office"**, inii mini's is lowercase
  **"baila"**. **Fix those by renaming the extension on the PBX** — that is now the
  one place a name lives.
- ⏳ **NOT PROVEN: nobody has signed in and looked, and no email has been sent
  since the deploy.** ⛔ Open portal windows keep the old bundle until reloaded;
  the desktop app needs a full close and reopen. ⏳ The 13 initials rows in
  `User.firstName`/`lastName` were deliberately left alone — the rule makes them
  unreachable for anyone with an extension.
