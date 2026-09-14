# ⛔⛔ AGENT HANDOFF — Ezra's trainer sheet, worked end to end (2026-08-16) — READ FIRST before believing a red row on that sheet, before saying a capability "needs a new integration", or for ANY `/internal/agent/*` door

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_EZRA_SHEET_2026-08-09.md`**
(the sheet is **"Loopcom Edits"**, 3 pages — memory [[ezra-trainer-bug-sheet]].
~15 commits; **api + portal + agent all DEPLOYED and container-verified**, desktop
**0.1.6** published to the update feed. One PBX GRANT under a one-time mandate.)

- ⛔⛔ **I SAID "THAT NEEDS A NEW INTEGRATION" TWICE AND WAS WRONG BOTH TIMES.**
  Izzy pushed back both times and the thing already existed. **DND rides the
  SAME helper as hold music** — `getPbxDiversion`/`setPbxDiversion` in
  `pbxInboundRouteHelperClient.ts` → helper `/get-diversion`, `/set-diversion`,
  recorded in `AGENT_HANDOFF_SHAMMES_PBX_MS.md` as "M11 DND | LIVE, proven".
  **Screenshot understanding** needed no new plumbing either — both SDKs already
  take image content. **Deleting a queue/ring group** needed no VitalPBX API —
  the panel robot that CREATES them deletes them too.
  ⛔ **The search that lied: grepping for a ROUTE with the feature name in the
  path.** There is no route with "dnd" in it — the door is
  `/internal/agent/extfeature/action`. **Grep the helper CLIENT and the
  capability list, never route strings**, before declaring anything unbuilt.
- ⛔⛔ **TWO BUGS STACKED KILLED THE PROVISIONING TOOLS FOR SIX DAYS**, and
  "I couldn't retrieve the account setup details" was the only symptom.
  **(1) `/internal/agent/account-setup-info` was missing from
  `jwtPublicRouteBypass.ts`**, so the global hook 401'd it before its own
  shared-secret check ran — the agent shipped the caller, the api shipped the
  route, nothing connected them. ⛔ **THE STATUS CODE TELLS THEM APART: these
  doors answer 403 on a bad secret, so a 401 means you never reached the route.**
  **Every new `/internal/agent/*` door must be added to the bypass list AND the
  all-doors guard loop in `publicReadyJwtBypass.test.ts` in the SAME commit.**
  **(2) the schema model is `TenantBillingSettings` → accessor
  `tenantBillingSettings`, and every call site had the words transposed** —
  proven against the live client (`billingTenantSettings: undefined`).
  ⛔ **It shipped green because every site was `(db as any)` or an injected
  `deps.db`, AND `capabilities.test.ts` MOCKED THE WRONG NAME TOO** — 16 tests
  passing against a fake db that agreed with the bug. The casts are gone from
  the real-client sites so the next transposition is a build error.
  ⛔ Do NOT "fix" `apps/api/src/billing/*` — those are imports of a MODULE named
  `billingTenantSettingsMetadata`, not accessors.
- ⛔ **CLOSED HOURS: the per-number dialplan path ignores the mode ENTIRELY.**
  `Set(DID_MENU=${DB(connect/didmap/<did>/profile_id)})` → `Goto(connect-menu,...)`
  is unconditional, so an assigned number played its business menu around the
  clock and the trainer re-pointed it BY HAND at every open/close. Fixed
  api-side: **`resolveDidmapProfileId()`** (`ivrModeSelection.ts`, 7 tests)
  resolves the pointer THROUGH the mode inside `didBuildPublishValues` — the one
  derivation behind both publish paths, the DID switch routes **and the drift
  reconciler** (which would otherwise revert it within ~10 min).
  ⛔ **The mode sweep was INNOCENT** — zero `[IVR_MODE]` flips in 24 h is correct
  for a schedule with hours on Monday only. **And the holiday MENU selector had
  never existed on any screen** while `holidayProfileId` was honoured all the way
  down, so holidays silently played the closed menu.
- ⛔ **THREE UNRELATED THINGS WERE ALL CALLED "DND"**: the portal toggle
  (localStorage only, never sent anywhere), the API's `presence` (the hardcoded
  literal `"AVAILABLE"` in `formatExtensionControlPanel`), and the assistant's
  real PBX write. That is why the button and the assistant disagreed in both
  directions. The toggle now says **"Mute this browser"**; a real
  **`GET`/`POST /voice/extensions/me/dnd`** wraps the proven M11 calls, answers
  **200 `supported:false`** (never 403/503) when the tenant has no PBX link, and
  **reads back** so it can never claim a state the phone system did not confirm.
  ⛔ The old `cc-extension-dnd` flag is **never** promoted into real DND.
- ⛔ **CHECK THE CLOCK BEFORE BELIEVING A RED ROW.** Two "still broken" items
  were tested MINUTES before the deploy carrying their fix landed; both worked
  when re-run through the real chat. Several other reds were **already fixed**
  (row 50 Prisma crash, row 52 delete button, row 17 SMS, the Android backspace —
  live since May, he was on an old APK), and one was **never a bug** ("only one
  extension assigned" was true — his 1102/1103 request had never been actioned).
- **Also shipped:** `voicemails` / `list_contacts` read tools;
  `mark_my_chats_read` + `cancel_my_requests` (⛔ the ONLY self-scoped writes in
  the tool surface — `selfServiceTools.ts`'s header is the fence for the next
  one; new enum `CANCELLED`, applied); `companyNumbers` from
  **`PbxTenantInboundDid`** (⛔ NOT the `phoneNumber` table — zero rows for
  onboarded tenants); the widget's `context:{page,path}` finally read by the
  engine (the schema had silently dropped it); IVR timeout + retries pickers;
  history window 20 → 40; desktop **right-click** (Electron shows NO context menu
  unless the shell builds one); and 8 portal UI fixes incl. the light-theme-only
  select geometry and the composer/assistant overlap.
- ⏳ **NOT PROVEN — the honest list.** ⛔ **No IVR item is proven until someone
  CALLS**: closed hours, holiday, queues, unanswered-extension routing and early
  keypresses all end in what a caller hears. Three chat smoke tests are also
  unrun ("summarize my voicemails", "mark my chats read", "cancel my requests"),
  and nobody has uploaded a screenshot or deleted a team in a browser.
  ⛔ **Ezra's schedule has opening hours on MONDAY ONLY** — the new "Closed right
  now — no opening hours are set for Tuesday" line on the HoursCard is what
  explains his "the store is OPEN and I hear after-hours" report. Fix the days
  before re-testing. **Still unbuilt:** live page-CONTENTS awareness (the call
  list), and Teams membership editing (only create/delete exist).
