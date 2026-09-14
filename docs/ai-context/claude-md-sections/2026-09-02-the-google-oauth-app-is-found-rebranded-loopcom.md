# ⛔ AGENT HANDOFF — the Google OAuth app is FOUND, rebranded Loopcom, PUBLISHED, and the brand is under verification (2026-09-02) — READ FIRST before touching the Google OAuth client, the Gmail/Drive scopes, or answering "why does Gmail connect fail / show unverified"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_GOOGLE_OAUTH_VERIFICATION_2026-09-02.md`**
(**Console-only, driven in Izzy's real Chrome. No code, no deploy, no migration, no PBX
write, no env change.** Writes: Google Auth Platform settings, one IAM grant, one TXT
record in Cloudflare. Every value confirmed with Izzy first.) Memory:
[[google-oauth-app-found-and-published]].

- ⛔ **The D-U-N-S has NOTHING to do with Google OAuth** (it gated Play + Apple, both done).
  OAuth verification gates on Search Console domain ownership + privacy/home pages + scope
  class. Izzy's "I got my DUNS, start Google Auth" was answered by doing the OAuth work.
- ✅ **THE UNKNOWN OWNER IS KNOWN: project `connect-497316` (number 1004420523742), under
  the connectcomunications.com Workspace org, owned by `support@connectcomunications.com` —
  and now ALSO by `izzy@loopcom.net` (IAM Owner, 2026-09-02).** The client is `connect
  production`, created 2026-05-24. izzwgg@gmail.com's four projects (incl. Firebase
  `connect-app-23d4f`) hold NO OAuth client — don't look there.
- ⛔⛔ **IT HAD BEEN IN TESTING SINCE MAY: 4 test users, 7-day refresh-token expiry.** That
  is why all 5 `CrmEmailConnection` rows were stale and why any non-test customer's Gmail
  connect was refused by Google. **Published to production 2026-09-02.** Branding was also
  incomplete (app name literally `onnect communications`, no links, one domain) and the
  Data Access page declared ZERO scopes.
- ✅ **DONE AND RE-READ AFTER RELOAD:** app name **Loopcom**; home `https://www.loopcom.net/`;
  privacy `/legal/privacy/`, terms `/legal/terms/` on www.loopcom.net; authorized domains
  **connectcomunications.com AND loopcom.net**; client origins + redirect URIs for BOTH
  `app.loopcom.net` and `app.connectcomunications.com` (the redirect-URI bug flagged in the
  publicOrigins section is CLOSED — proven live: the consent chooser reads *"to continue to
  loopcom.net"* with the loopcom callback). ⛔ There is ONE callback path in code —
  `driveRoutes.ts` reuses `GOOGLE_OAUTH_REDIRECT_URI` — so no Drive callback exists to register.
- ⛔⛔ **THE SCOPE CLASSIFICATION IS NOW A FACT, read off Google's own page:** `openid` /
  `email` / `profile` non-sensitive; **`gmail.send` SENSITIVE** (ordinary free review);
  **`gmail.readonly` and `drive.readonly` RESTRICTED** (annual paid CASA assessment, ~$540–
  1,800/yr). **Izzy chose to DROP both restricted scopes** — the declared set is sign-in +
  `gmail.send`. ⛔ **THE CODE STILL REQUESTS THEM** (`crm/emailRoutes.ts:453` adds
  `gmail.readonly` when reply-tracking is on; `crm/driveService.ts:25` pins `drive.readonly`).
  Until those are removed / moved to `drive.file`, a reply-tracking connect or a Drive import
  asks for an UNDECLARED restricted scope and shows Google's unverified-app interstitial.
  That is an api change + deploy, not done.
- ⛔⛔ **THE TRAP THAT COST AN HOUR: the "Verify branding" button is evaluated against the
  SIGNED-IN USER's Search Console ownership, not the project's owner list.** Signed in as
  support@ (zero Search Console properties) the Branding page shows no verification card and
  the Verification Center dead-ends on *"You need to verify and publish your branding"* —
  the exact loop the Google dev forum thread describes. Signed in as **izzy@loopcom.net**
  (project Owner + Search Console owner of BOTH domains) the card appears. **Do all Auth
  Platform work for this project as izzy@loopcom.net.** ⛔ The card is lazy-loaded and
  repeated reloads trip Google's *"excessive automated requests"* throttle (the console
  then can't load gstatic JS and the card never renders) — load ONCE, wait; the `&jsmode`
  link the page offers loaded it when the normal mode would not.
- ✅ **connectcomunications.com is VERIFIED in Search Console under izzy@loopcom.net** (Domain
  property, TXT `google-site-verification=bvDui_4CBX9VxHubQ5twjJ2UI9-L-Km_JiQM0OV4GAA` on the
  apex in Cloudflare — ⛔ never delete it). `loopcom.net` was already verified there.
- ⏳ **Brand verification SUBMITTED 2026-09-02 ("Verification in progress… up to 5 minutes").**
  Next: **Publish branding** (7-day window after a pass — miss it and it says "Need to
  re-verify"), then Verification Center → **Prepare for verification → Confirm** for
  `gmail.send`. The final state is recorded at the end of the handoff doc.
- ⛔ **Console driving traps:** the client page's `Add URI` textbox IS the existing URI field
  (form_input overwrote URI 1 — re-read every URI before Save); the scope panel needs REAL
  clicks on Add-to-table / Update / the row checkboxes (JS clicks and the row trash icons
  did nothing, and a JS-opened panel left two stacked in the DOM); Search Console's "Verify
  your ownership" returns silently to the access page after passing — check the property
  overview URL.
- ⏳ **NOT BUILT: "Sign in with Google" for the portal login** — it needs only the
  non-sensitive scopes, so the OAuth app is ready for it today with no further Google review.
