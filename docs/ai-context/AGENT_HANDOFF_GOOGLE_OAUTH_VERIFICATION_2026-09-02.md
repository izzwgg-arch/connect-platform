# AGENT HANDOFF — Google OAuth app for Loopcom: found, rebranded, published, submitted (2026-09-02)

**Console-only work driven in Izzy's real Chrome (extension). No code change, no
deploy, no migration, no PBX write, no env change.** One DNS write (a TXT record on
connectcomunications.com in Cloudflare), one IAM grant, and the Google Auth Platform
changes below. Izzy signed in himself where a login was needed (support@ Cloud
Console, Cloudflare); every value written was confirmed with him first.

Izzy, 2026-09-02: *"I got my Duns number. I want to start the process of getting
Google Auth for my Loopcom System."* → *"drive it in the browser"* → *"it should be
for domain loopcom.net. Both if possible."*

⛔ **The D-U-N-S is irrelevant to Google OAuth.** It was needed for Play Console and
Apple (both done). OAuth verification is gated on Search Console domain ownership,
a privacy policy, a home page and the scope classification — nothing about the
business registration. Do not go looking for a D-U-N-S field in the Auth Platform.

## 1. Where the app lives (the fact that was unknown for two weeks)

| | |
|---|---|
| Google Cloud project | **`connect`** — id `connect-497316`, **number `1004420523742`** |
| Parent | Workspace org **connectcomunications.com** (`344042039077`) |
| Owner accounts (IAM) | `support@connectcomunications.com` (original) + **`izzy@loopcom.net` (added 2026-09-02)** |
| OAuth client | `connect production` — `1004420523742-to03vd0qr795748o10rogqfljm9romim`, created 2026-05-24 |
| Console URL | `https://console.cloud.google.com/auth/overview?project=connect-497316` |

⛔ **The August research said the owner was unknown and blocked on it.** Found by
walking the four Google accounts signed into Izzy's Chrome: `jw4226997@gmail.com`
(no projects, and a first-time Cloud ToS dialog — never accepted), `izzy@loopcom.net`
(sees the org, owned no projects), `izzwgg@gmail.com` (4 projects: the Firebase
`connect-app-23d4f`, `robust-seat-405703`, a Gemini project, `trimpro-83596` — none
holds the client), and `support@connectcomunications.com` (holds `connect-497316`).
⛔ `console.cloud.google.com/...?project=<PROJECT NUMBER>` works as a URL and answers
"You need additional access" for a non-owner — that is how each account was ruled out
without touching anything.

## 2. What was wrong before (measured, not assumed)

- **Publishing status was TESTING** with 4 test users (`deals@ribitcapital.com`,
  `eli@nexusrealtyad.com`, `izzwgg@gmail.com`, `support@`). Everyone else who tried
  to connect Gmail was refused by Google, and Testing mode expires refresh tokens
  after **7 days** — which is why all 5 `CrmEmailConnection` rows had gone stale
  (0 updated in 30 days).
- **Branding incomplete**: app name literally `onnect communications` (missing C),
  no home page, no privacy/terms links, one authorized domain
  (`connectcomunications.com`). Publish was disabled because of it.
- **Data Access declared ZERO scopes** even though the code requests
  `openid email profile gmail.send` (+ `gmail.readonly`, `drive.readonly`).
- **Client had ONE origin and ONE redirect URI**, both `app.connectcomunications.com`
  — the live `redirect_uri_mismatch` on `app.loopcom.net` recorded in CLAUDE.md.
- **The consent screen read "Sign in to connectcomunications.com"** (Google shows the
  domain instead of the app name when the brand is unverified).

## 3. What was changed (all saved, all re-read after a fresh load)

**Branding** — app name **Loopcom**; support email `support@connectcomunications.com`
(kept — the dropdown offers only accounts the signed-in user owns); home
`https://www.loopcom.net/`; privacy `https://www.loopcom.net/legal/privacy/`; terms
`https://www.loopcom.net/legal/terms/` (all three answer 200); authorized domains
**connectcomunications.com AND loopcom.net**; developer contacts `izzywgg@gmail.com`
+ `izzy@loopcom.net`. No logo (a logo adds a review requirement; add later).

**Client `connect production`** — JavaScript origins `https://app.loopcom.net` +
`https://app.connectcomunications.com`; redirect URIs
`https://app.loopcom.net/api/crm/email/oauth/callback` +
`https://app.connectcomunications.com/api/crm/email/oauth/callback`.
⛔ Only ONE callback path exists in code: `GOOGLE_OAUTH_REDIRECT_URI` is the email
callback and **`driveRoutes.ts` reuses the same env value**, so there is no separate
Drive callback to register. `oauthRedirectUriForRequest` swaps only the origin.
✅ **Proven live**: an authorization URL with the loopcom callback renders the account
chooser reading *"to continue to loopcom.net"* — no `redirect_uri_mismatch`.

**Data Access (scopes)** — declared, and Google's own classification read off the
page (**this was the unrun "two-minute check" from the 2026-08-21 handoff**):

| Scope | Google's class | Consequence |
|---|---|---|
| `openid`, `userinfo.email`, `userinfo.profile` | non-sensitive | no review |
| `gmail.send` | **sensitive** | ordinary review, free |
| `gmail.readonly` (reply-tracking) | **restricted** | annual CASA assessment |
| `drive.readonly` (CRM Drive import) | **restricted** | annual CASA assessment |

**Izzy chose "drop the two restricted scopes"** (2026-09-02). The declared set is now
openid/email/profile + `gmail.send` only. ⛔ **THE CODE STILL REQUESTS THE RESTRICTED
ONES** — see §6; until that is changed, a Gmail connect with reply-tracking on, or any
Drive import, asks for a scope the app has not declared and shows Google's
"unverified app" interstitial.

**Audience** — **Published to production** (was Testing). Confirmed dialog text:
*"If your app's configuration … requests sensitive or restricted scopes, you will
need to submit for verification."* Consequences: the 7-day refresh-token expiry is
gone; the 100-user lifetime cap (5 used) applies only to **unapproved** sensitive
scopes, so it lifts once `gmail.send` is verified.

**IAM** — `izzy@loopcom.net` granted **Owner** on `connect-497316` (support@ keeps
Owner). Reason below.

**Search Console** — `connectcomunications.com` added as a **Domain property under
izzy@loopcom.net** and **VERIFIED** via TXT
`google-site-verification=bvDui_4CBX9VxHubQ5twjJ2UI9-L-Km_JiQM0OV4GAA` on the apex in
Cloudflare (record added 2026-09-02; resolved at 1.1.1.1 and 8.8.8.8 within a minute).
`loopcom.net` was already a verified domain property under the same account.

## 4. ⛔⛔ THE TRAP THAT COST AN HOUR: the "Verify branding" button is PER SIGNED-IN USER

Google requires every authorized domain to be verified in Search Console by a project
Owner/Editor — **and the Console evaluates that against the ACCOUNT YOU ARE SIGNED
IN AS, not against the project's owner list.** Signed in as `support@` (which owns no
Search Console property at all) the Branding page had **no** verification card and the
Verification Center's "Prepare for verification" stayed disabled with *"You need to
verify and publish your branding"* — no way forward, and the Google dev forum thread
"Stuck in Branding Verification Loop" describes exactly that dead end. Signed in as
`izzy@loopcom.net` (project Owner + Search Console owner of both domains) the same
page shows **"Verification status — Your branding needs to be verified before it can
be shown to users. [Verify branding]"**.

**So: do all Google Auth Platform work for this project signed in as
`izzy@loopcom.net`** (`authuser=4` in Izzy's Chrome today — the index is per session).

⛔ **And that card is lazy-loaded and fragile.** It rendered once, then on every
reload the page sat with a `Loading` progress bar beside Save, the card absent, and
the console's own banner *"failed to load JavaScript sources from www.gstatic.com …
excessive automated requests"*. That is the automation tripping Google's throttle
(dozens of console loads in an hour), on top of Izzy's filtered line. **If the card is
missing: stop reloading, wait ten minutes, load the page ONCE.**

## 5. State at handoff (2026-09-02)

| Item | State |
|---|---|
| Client redirect URIs for both hostnames | ✅ saved, proven live |
| Branding fields (name, links, both domains) | ✅ saved, re-read after reload |
| Scopes declared = sign-in + `gmail.send` | ✅ saved, re-read after reload |
| Publishing status | ✅ **In production** |
| izzy@loopcom.net project Owner | ✅ (IAM list shows both owners) |
| Both domains verified in Search Console by an Owner | ✅ |
| **Brand verification submitted** | ⏳ see the status line at the end of this file |
| **Data-access (gmail.send) verification submitted** | ⏳ blocked until branding is verified AND published (Verification Center → "Prepare for verification" → Confirm) |
| Code still requesting `gmail.readonly` / `drive.readonly` | ⛔ open, §6 |
| Sign in with Google (login) | ❌ not built — a separate portal/api feature; the OAuth app is now ready for it (non-sensitive scopes need no review) |

## 6. What the code must do next (not done — needs a real api change + deploy)

1. **Stop requesting `gmail.readonly`.** `crm/emailRoutes.ts:453` adds it when reply
   tracking is on; `crmEmailHelpers.ts` has the `GMAIL_READONLY_SCOPE` health check.
   Remove the scope from the auth URL and make reply-tracking read "unavailable"
   rather than "no_scope". Otherwise the consent screen carries an undeclared
   restricted scope and every such connect shows the unverified interstitial.
2. **Move Drive import to `drive.file`** (non-sensitive, per-file picker) or remove
   the Drive scope. `driveService.ts:25` pins `drive.readonly` for folder traversal —
   the folder-walk design has to change to a Google Picker flow.
3. Then re-check Data Access in the console — the declared set must equal what the
   code sends, or verification is granted for the wrong list.
4. **Sign in with Google** is a build task with no Google-side blocker now.

## 7. Verify / acceptance

- Consent screen: open the auth URL for the loopcom callback signed out — the chooser
  must say *"to continue to loopcom.net"* (today) and, once branding is verified and
  published, *"to continue to Loopcom"*.
- A real Gmail connect from `app.loopcom.net` by a NON-test-user must reach the
  callback (proves Published) — expect the "unverified app" warning only while
  `gmail.send` is unapproved.
- `select count(*) filter (where "updatedAt" > now() - interval '7 days') from
  "CrmEmailConnection"` should start moving again once people reconnect.
- Verification Center → Branding status should read verified/published; Data access
  status should show a submitted review for `gmail.send`.

## 8. Reusable recipes

- **Find which Google account owns a project number**: hit
  `console.cloud.google.com/cloud-resource-manager?authuser=N` for each N; "No results"
  = no projects; then `apis/credentials?project=<id>&authuser=N` lists client ids.
- **The Console's `Add URI` textbox IS the existing URI field** for `form_input` — it
  overwrote URI 1 rather than adding; always re-read every URI value before Save.
- **Scope panel**: type the full scope strings into "Manually paste scopes", REAL-click
  "Add to table", REAL-click "Update", then Save. JS `.click()` on those buttons and on
  the row trash icons did nothing; two panels stacked in the DOM after a JS-opened one.
  Uncheck rows inside the panel to remove scopes — the trash icons never worked.
- **Search Console**: "Verify your ownership" from the property URL runs "Checking
  verification…" and then silently returns to the access page — check the property
  overview URL afterwards; it had passed.
- Cloudflare's "Add record" Type control is a button-combobox: click it, type `TXT`,
  Enter. `form_input` refuses it.
