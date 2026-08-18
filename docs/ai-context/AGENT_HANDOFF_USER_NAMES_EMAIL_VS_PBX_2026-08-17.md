# AGENT HANDOFF — most customers are addressed by their email address, not their name (2026-08-17)

**Read-only audit. No code change, no deploy, no migration, no PBX write, no data change.**
Question asked (Izzy, 2026-08-17): *"Double-check that everybody's dashboard and all
their emails they are coming to are addressed to them. Their name matches the PBX,
not the email address."*

**Answer: they are NOT. 55 of 65 live users see a name on the main dashboard that is
not their PBX name, and it is almost always the front half of their email address.
Emails are worse — some real invitations went out addressed to a single letter.**

---

## 1. The one-line rule

**Connect stores a person's name in FOUR places and only one of them is right.**
`User.displayName` / `User.firstName` / `User.lastName` are whatever a hurried admin
or a sign-up form put there. **`Extension.displayName` is the PBX name — the real
one** — and it is verified accurate (see §5). Every screen and every email that
resolves a name **without** consulting the extension gets the email address instead.

The portal already knows this and already has the helper. **The main dashboard and
the entire email layer just don't call it.**

---

## 2. What each surface shows today

| Surface | Helper it uses | Looks at the PBX name? | Verdict |
|---|---|---|---|
| Sidebar (`SidebarNav.tsx:136`) | `getPreferredUserDisplayName` | **yes** | OK correct |
| Profile menu (`ProfileMenu.tsx:135`) | `getPreferredUserDisplayName` | **yes** | OK correct |
| CRM dashboard (`crm/dashboard/page.tsx:529`) | `getPreferredUserDisplayName` | **yes** | OK correct |
| **Main dashboard headline** (`app/(platform)/dashboard/page.tsx:230`) | its own local `firstName()` at :65 | **NO** | BROKEN — 55/65 wrong |
| **Every email** (`apps/api/src/server.ts:2233 displayNameForUser`) | — | **NO** | BROKEN |
| Mobile app (`SettingsScreen.tsx:278`) | `voice.displayName` (the extension) | **yes** | OK correct |

⛔ **`getPreferredUserDisplayName` (`apps/portal/lib/userDisplayName.ts:44`) is the
correct helper and it already ships.** It prefers `extensionDisplayName`, and `/me`
(`server.ts:6023`) already returns it. The main dashboard imports nothing and rolls
its own `firstName(user.name, user.email)` — that is the whole defect on the portal
side. **It is a one-line swap, subject to the traps in §6.**

⛔ **The API side has no equivalent helper at all.** `displayNameForUser()` is
`displayName || firstName+lastName || email.split("@")[0]` and **never selects the
extension**, so no email can be right by accident. It feeds the invite email, all
three password emails, the JWT `name` claim, and `/me`.

---

## 3. The numbers (live, 2026-08-17, 29 live tenants / 65 users)

- **54 of 65** users have **no real name stored at all** — `displayName` is literally
  the email local part, so every name is derived from the address.
- **55 of 65** main-dashboard headlines differ from the PBX name.
- **Only 6** match the PBX exactly: Alex Morgan and Maya Feldman (Loopcom Demo,
  seeded), **Lester Tan** (created by hand yesterday), Accounts Receivable, and the
  two Landau Home rows.
- **62 of 65** have an active extension, so the PBX name **is available** for them.
  Only **3** genuinely have nothing to fall back to.

Representative rows (dashboard headline -> what the PBX calls them):

```
Trust Bookkeepings   "Welcome, fhalpert"          PBX: 105 - Mrs. Halpert
Trust Bookkeepings   "Welcome, vigdor"            PBX: 101- Mr. Sofer
Trust Bookkeepings   "Welcome, lschwartz"         PBX: 104 - Mrs. Schwartz
Trust Bookkeepings   "Welcome, cspilman"          PBX: 106 - Miss Spilman
A plus center        "Welcome, leahw"             PBX: Leah Fulop
A plus center        "Welcome, saraw"             PBX: Libby Weinstock
A plus center        "Welcome, yehuditw"          PBX: Mrs Weinstock
A plus center        "Welcome, Sarahb"            PBX: Mrs Brach
Yossis Wood Works    "Welcome, nicholas"          PBX: Nick Stefanicha
Yossis Wood Works    "Welcome, dan/jesse/lea"     PBX: Dan Mitchell / Jesse Stone / Lea Klein
Displaydex           "Welcome, eli"               PBX: Eli Lovi
Luxure Management    "Welcome, simonwer08"        PBX: Simon Wertzberger
LUZER                "Welcome, 845luzerj"         PBX: Luzer Jungreis
RSBK                 "Welcome, 7816646"           PBX: Barish
RSBK                 "Welcome, rosnfeld.yoel"     PBX: Hazkoora
Smooth Leasing       "Welcome, smoothoffice1213"  PBX: Secretary
Relax Tires          "Welcome, Relaxtires"        PBX: S M Weiss
Trimpro              "Welcome, trimpronyinc"      PBX: Nachemya Ungar
Secro Selutions      "Welcome, hendy.secrosolutions" PBX: Hendy
Create A Box         "Welcome, Senderweiss"       PBX: Sender Weiss
```

⛔ **`845luzerj` and `7816646` are the ones to quote to Izzy** — a customer opening
Connect is greeted by their own gmail handle and by a bare phone number.

---

## 4. ⛔⛔ The worse half: real emails went out addressed to a SINGLE LETTER

Read from the `EmailJob` table — these are **sent** messages, not templates:

```
2026-08-13 USER_INVITE office@secrosolutions.com     -> "Hi s,"
2026-08-13 USER_INVITE office@secroselutions.com     -> "Hi s,"
2026-08-10 USER_INVITE yisraelweinstock@gmail.com    -> "Hi g,"
2026-08-07 USER_INVITE hello@iniimini.com            -> "Hi l,"
2026-08-05 USER_INVITE yossi@yossiswoodworx.com      -> "Hi y,"
2026-08-05 USER_INVITE fixupusa1@gmail.com           -> "Hi fix,"
2026-08-03 USER_INVITE ezra@connectcomunications.com -> "Hi e,"
2026-08-13 USER_INVITE hendy.secrosolutions@gmail.com -> "Hi hendy.secrosolutions,"
2026-08-13 USER_INVITE myworksecro@gmail.com         -> "Hi myworksecro,"
2026-08-03 USER_INVITE fhalpert@trustbookkeepingny.com -> "Hi fhalpert,"
2026-07-31 USER_INVITE eli@displaydex.com            -> "Hi eli,"
2026-07-29 USER_INVITE ezralife13@gmail.com          -> "Hi ezralife13,"
2026-07-20 USER_INVITE yitz@trimprony.com            -> "Hi yitz,"
```

**Cause: 13 live users carry INITIALS in the name columns**, and the invite template
(`userEmailTemplates.ts:327`) prefers `userFirstName` **over** the fuller `userName`:

```
inii mini              sales@iniimini.com              firstName="l"   lastName="d"
Connect Communications ezra@connectcomunications.com   firstName="e"   lastName="e"
RSBK                   7816646@gmail.com               firstName="b"   lastName="s"
RSBK                   rosnfeld.yoel@gmail.com         firstName="h"   lastName="h"
RSBK                   sh9673@gmail.com                firstName="h"   lastName="h"
Fixup Group            fixupusa1@gmail.com             firstName="fix" lastName="up"
Gesheft                yisraelweinstock@gmail.com      firstName="g"   lastName="g"
Displaydex             eli@displaydex.com              firstName="e"   lastName="l"   <- Eli Lovi
Yossis Wood Works      yossi@yossiswoodworx.com        firstName="y"   lastName="p"   <- Yossi Perlman
Trust Bookkeepings     vigdor@trustbookkeepingny.com   firstName="v"   lastName="s"
Trimpro                shia@trimprony.com              firstName="s"   lastName="w"   <- Shia Weinstock
Relax Tires            relaxtires@gmail.com            firstName="S"   lastName="M Weiss"
```

⛔ **These are initials of the real name** (`e`/`l` = Eli Lovi, `y`/`p` = Yossi
Perlman, `s`/`w` = Shia Weinstock). Somebody seeded the columns with initials on
**2026-04-06** and they have been the source of "Hi e," ever since. **Fixing the
lookup order without cleaning these columns still leaves them one code path away
from resurfacing.**

⛔ **Billing emails dodge this only because they use `customerName`, and it is
usually unset** — 20 of the last 45 customer emails opened with a bare "Hello,"
rather than a wrong name. That is luck, not design.

---

## 5. The PBX names are correct and Connect's copy is current — verified, not assumed

Read directly off the PBX (`ombutel.ombu_extensions`, read-only) for five tenants and
compared to Connect's `Extension.displayName`: **byte-identical.** e.g.
`displaydex 101 Eli Lovi`, `yossis_wood_works 103 Nick Stefanicha`,
`a_plus_center 101 Leah Fulop`, `trust_bookkeepings 105 "105 - Mrs. Halpert"`.

**So no PBX work is needed and no name has to be re-typed. The right name is already
in Connect's own database on the extension row.** This is purely a lookup-order bug.

---

## 6. ⛔ Traps for whoever fixes this — the naive fix is wrong four ways

1. ⛔ **Five extensions carry the number as a prefix.** Trust Bookkeepings names its
   extensions `"105 - Mrs. Halpert"`, `"101- Mr. Sofer"` (note: no space before the
   dash on 101 — do not write a fragile pattern). The dashboard headline takes the
   **first word**, so a verbatim swap greets them **"Welcome, 105"** — worse than
   today. Strip a leading number-and-dash prefix before use.
2. ⛔ **`/me` returns only the OLDEST active extension** (`server.ts:5984`,
   `orderBy: createdAt asc, take: 1`). Four users own two: `contact@gesheftkosher.com`
   would be greeted **"Yossef Friedman"** off extension 112 while also owning 107
   "Customer Phone 2"; `scn@gesheftkosher.com` gets "Accounts Payable" over
   "Phone Orders 2". Picking the oldest is arbitrary, not correct.
3. ⛔ **Some of these logins are role mailboxes, and the PBX name is a department.**
   `sales@bvisible.us` -> "Front Desk", `connect@gesheftkosher.com` -> "Hiring",
   `office@matamimweekly.com` -> "Joel", `smoothoffice1213@gmail.com` -> "Secretary".
   Greeting a shared office login "Welcome, Secretary" is defensible; **"Hi Front
   Desk," at the top of an invoice email is a decision, not an improvement.**
4. ⛔ **3 users have no active extension** (`crm.pilot.agent...`, the `izzywgg@gmail.com`
   support login, and one more) — the email fallback must survive for them.

⛔ **And the fix has TWO halves that live in different codebases.** Changing the
portal helper does nothing for email; `displayNameForUser()` in `apps/api/src/server.ts`
is a separate implementation feeding invites, password mails and the JWT. Same shape
as the two IVR publish paths — **fix one and the customer still gets "Hi fhalpert,"
in their inbox.**

---

## 7. What was NOT done

- ⛔ **Nothing was changed.** No name written, no column cleaned, no code edited, no
  deploy. This is the audit only; the fix is Izzy's call because of §6.3.
- The `firstName`/`lastName` initials columns (§4) are untouched.
- Not checked: the AI assistant's own greeting, CRM contact-facing templates, and
  whether the SMS escalation path names people correctly (it was fixed separately on
  2026-08-16 and reads the conversation row, not these columns).

## 8. Acceptance test for the eventual fix

1. Sign in as `fhalpert@trustbookkeepingny.com` -> the dashboard must read
   **"Welcome, Mrs. Halpert"**, not "Welcome, fhalpert" and **not "Welcome, 105"**.
2. Resend that user's invite -> the email must open **"Hi Mrs. Halpert,"**.
3. Sign in as a user with **no** extension -> must still get a sensible greeting, not
   "Welcome, ".
4. ⛔ The negative that matters: `contact@gesheftkosher.com` owns two extensions —
   confirm the chosen one is deliberate.

## 9. Reproduce the audit

The three queries used (run inside `app-api-1`, all read-only) are: list every live
user with `displayName`/`firstName`/`lastName` plus `ownedExtensions.displayName` and
compare; read `EmailJob.textBody` for the last 45 customer emails and grep the opening
`Hi ...,` line; and read `ombutel.ombu_extensions` on the PBX to confirm Connect's copy.
⛔ The email body column is **`textBody`/`htmlBody`**, not `bodyText` — the obvious
guess throws a Prisma validation error.
