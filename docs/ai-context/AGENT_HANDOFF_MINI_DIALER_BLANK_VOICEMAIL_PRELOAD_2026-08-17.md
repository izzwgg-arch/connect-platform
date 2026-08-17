# The mini dialer came up blank, and it was us flooding ourselves off our own server (2026-08-17)

**Reported as:** "Gesheft 101 — one of the people using that extension says the
mini dialer is not loading. They've closed it and opened it back up. It just
stays blank."

**Status:** customer unblocked live (nginx allowlist + ban lifted, verified);
code fix committed and deployed (portal + api, container-verified). The
allowlist entry is a temporary belt-and-braces and is **safe to remove now that
the fix is out** — see §8.

---

## 1. Which one it was

The complaint came from the **"Orders" login on Gesheft ext 101**
(`yisraelweinstock@gmail.com`, user `cmnmjhr3500anp96hc00p068a`, tenant
`cmnlgnumu0001p9g6xyl1pbdd`), at the office on **38.105.207.69**.

⛔ **It was not one person — it was both PCs at that office**, because the thing
that broke is attached to the internet connection, not to a login or an app.
Evidence they are two machines and not one: two different desktop shell versions
in the same minute (`@connect/desktop/0.1.3` and `0.1.5`) and two different
session tokens (different `iat`: 1784296970 and 1786548086).

**Five machines in total are signed in to that one ext-101 account**, and only
the two at that office were affected:

| IP | desktop | requests today | affected |
|---|---|---|---|
| 38.105.207.69 | **0.1.5** | 141,006 | **yes** |
| 38.105.207.69 | **0.1.3** | 4,767 | **yes** |
| 94.26.67.21 | 0.1.6 | 58,774 | no |
| 94.26.67.4 | 0.1.6 | 48,677 | no |
| 199.16.53.3 | 0.1.6 | 46,597 | no |

⛔ **The old desktop versions are a coincidence, not the cause.** The desktop app
is a shell around the hosted portal, so all five run the same portal bundle. The
two stale shells matter only because they happen to sit at the same office.

⛔ **That IP carries exactly one Connect account** (verified by decoding every
token seen from it — all ext 101 "Orders"), which is what made an allowlist entry
safe: nobody else's traffic rides on it.

---

## 2. Why the window was blank — read this before hunting in the app

Their whole office was **banned at nginx**. `/etc/nginx/connectcomms/denylist.json`:

```json
{ "ip": "38.105.207.69",
  "reason": "req/min>1200 immediate, req/min>600",
  "detectedAt": "2026-08-17T16:10:15Z", "expiresAt": "2026-08-17T17:10:15Z",
  "counters": { "req5m": 1226, "s404": 0, "s401": 0, "distinctPaths": 317 } }
```

⛔ **The deny is at the top of the server block** (`sites-available/connectcomms:3`
includes `denylist.conf`), so it refuses **everything** — not just `/api/*` but
the mini dialer's own HTML, its JavaScript, even `/ringtones/*` and `/version`.
Proven during the ban: `403 /version`, `403 /ringtones/connect-default-ringtone.ogg`.

**That is the whole "closing and reopening doesn't help".** A reopened window
cannot download the code it needs to draw anything, so it paints a blank box.
No error reaches the user because there is no app running to show one.

⛔⛔ **THE TELL THAT SAVES THE NEXT INVESTIGATION: `/version` IS
UNAUTHENTICATED.** If it is 403ing alongside the API calls, the problem is in
front of the app and you can stop reading application code immediately. A
permission or login fault cannot reach an endpoint that never checks either.

⛔ **Do not diagnose this from the api logs.** The api's own 403s are dominated
by unrelated tenants; the banned requests never reach the api at all, so its log
is *quieter* during the outage, not noisier. The evidence is entirely in
`/var/log/nginx/access.log`.

### Distinguishing the ban from ordinary noise

That IP produces ~20 harmless 403s per 10 minutes **all day**, almost all
`/api/crm/notifications` (that user has no CRM permission — normal, ignore it).
The ban shows up as a jump to **400–530 per 10 minutes across every endpoint at
once**, including static files. Two ban windows on 2026-08-17 (CEST):
16:10→17:20 and 18:10→18:39 (the second ended when it was lifted by hand).

---

## 3. What set the ban off — our own bug, in two halves

**Half one — the server ignores the page size it is asked for.**
`GET /voice/voicemail` (`apps/api/src/server.ts`) declared only
`folder / extension / tenantId / page` in its zod schema, and **zod strips what
it does not declare**. Two portal screens have been sending `pageSize=20` for
months:

- `apps/portal/components/DesktopMiniDialer.tsx:731`
- `apps/portal/components/NotificationPanel.tsx:124`

Both were silently given **100 rows** every time, because the handler read
`const take = 100;`. Same family as the billingEmail zod-transform bug: the
parameter is not rejected, it simply ceases to exist.

Proof from the wire, not from reading: the response to a `pageSize=20` request
measured **33,364–34,698 bytes**, ≈100 records at ~330 bytes each.

**Half two — the warm-up downloads more than the cache can hold.**
The mini dialer warms voicemail audio into a module-scope blob cache so Play is
instant. `VM_CACHE_MAX_ENTRIES = 30`. It handed the warm-up **every id the list
returned — all 100**. Entries 31→100 evicted entries 1→70 as they arrived, the
30-second refresh then found them missing, and downloaded them again. Forever.

**Measured on the wire, one office, seven minutes (18:03–18:09 CEST):**

| | |
|---|---|
| voicemail audio downloads | **1,521** |
| distinct voicemails involved | **102** |
| times each was re-downloaded | **15–24** |
| audio transferred | **963 MB** |
| request rate | ~250/min → trips `req5m > 1200` |

⛔ **Gesheft ext 101 is the worst mailbox on the platform for this** — 15,559
voicemails in the inbox, 15,298 unread, averaging ~600 KB each. The inbox is
never shorter than a full page, so the loop never runs out of work.

⛔ **This was NOT specific to the banned office — every machine on that
extension was doing it**, and still would be:

| IP | downloads / 7 min | MB / 7 min |
|---|---|---|
| 38.105.207.69 (2 PCs) | 1,521 | 963 |
| 94.26.67.21 | 492 | 345 |
| 94.26.67.4 | 313 | 227 |
| 199.16.53.3 | 177 | 123 |

≈**1.65 GB per seven minutes** for one extension — on the order of **14 GB an
hour**. The office with two PCs behind one IP was simply the first to cross the
ban threshold. **Fixing only the ban would have left all of that running.**

---

## 3b. ⛔⛔ A SECOND CUSTOMER, BLANK WITH NO BAN — the ban was never the disease

Trust Bookkeepings reported the identical symptom ~40 minutes later, and **they
were never banned**: no denylist entry today, 403s a flat ~180/hour all day
(background `/crm/notifications`, not a ban's several-hundred-per-ten-minutes
spike across every endpoint), and 192 of their last 200 requests were 200s.
**Their network was fine and their mini dialer was blank anyway.**

They were running the same loop, proven the same way — Trust office IP,
14:00–15:59 CEST: **2,350 downloads of only 40 distinct voicemails, 59× each,
721 MB.** A clean metronome of **1,200 downloads / 367 MB per hour**.

⛔⛔ **SO THE 100-ROW PAGE WAS NEVER THE REAL THRESHOLD — 30 IS.** Any inbox
holding **more than `VM_CACHE_MAX_ENTRIES` (30)** thrashes, because a working
set larger than the cache evicts everything on each pass. Trust never received
100 rows; 40 was enough. The oversized page made Gesheft's case violent enough
to trip a rate limit, but the defect bites at 31 messages.

**And it predicts exactly who complains.** Trust inbox counts:

| ext | who | inbox | thrashes? |
|---|---|---|---|
| **105** | **Mrs. Halpert — the reporter** | **163** | yes, worst |
| 104 | Mrs. Schwartz | 150 | yes |
| 101 | Mr. Sofer | 82 | yes |
| 389 / 106 / 107 | Rollup / Spilman / Pollak | 9 / 4 / 2 | **no — fits in 30** |

The two people with big mailboxes are the two whose windows died; their
colleagues with 2–4 voicemails were never affected. Same at Gesheft: ext 101
holds 15,559.

**What the timeline shows at Trust** (their voicemail audio downloads per hour,
CEST): `12:00 → 1200`, `13:00 → 1200`, `14:00 → 1200`, `15:00 → 1150`,
**`16:00 → 0`, `17:00 → 0`**, `18:00 → 241`. The preloader — which only the mini
dialer runs — **stopped dead at 16:00**, and their mini-dialer request rate fell
from 2,424/hour to 612/hour at the same moment while their *total* traffic
carried on (they moved to the main portal window). The app stopped, the network
did not.

⚠️ **INFERRED, NOT PROVEN — say so out loud.** The step from "downloaded 367 MB
an hour into blob object URLs for hours" to "the Electron renderer gave out and
painted white" is the obvious reading and it fits every timestamp, but there is
**no client-side crash telemetry** and nobody has captured a renderer log. What
IS proven: the flood, its volume, that it stopped exactly when the window went
blank, and that no server refusal was involved. ⛔ **Do not write this up as a
confirmed OOM** until someone reads a renderer log.

⛔ **Consequence for triage: an unbanned customer can have this too.** The ban is
one way it surfaces (Gesheft) and the client dying is the other (Trust). Judge
by the **refetch ratio** — total voicemail-stream requests versus distinct ids
for that IP — not by whether a ban exists.

---

## 4. The fix

**Portal — `DesktopMiniDialer.tsx` (this is the one that actually stops it):**
new `VM_PRELOAD_MAX = 20`, applied **inside** `preloadVoicemailAudio` via
`ids.slice(0, VM_PRELOAD_MAX)`.

⛔ **The bound must be STRICTLY below `VM_CACHE_MAX_ENTRIES`, not equal to it.**
The eviction loop runs `while (size >= MAX)`, so inserting entry 30 evicts entry
1 — at parity, exactly one message thrashes on every cycle forever. 20 < 30.

⛔ **The cap lives inside the warm-up, not at the call site.** The defect arrived
as a caller passing a longer list than it promised; a bound that only exists
where today's single caller sits is one new caller away from being gone.

**API — `server.ts`:** `pageSize: z.coerce.number().int().min(1).max(100)
.optional().default(100)`, and `const take = q.pageSize;`.

⛔ **The default stays 100 on purpose.** Three callers page through this endpoint
and none of them send `pageSize` — `apps/mobile/src/api/client.ts:268`,
`apps/portal/app/(platform)/voicemail/page.tsx:818`, and
`apps/portal/lib/desktopNotificationPoll.ts:59`. They are byte-for-byte
unchanged. Only a caller that **asks** for fewer now gets fewer.

**Deliberately accepted:** the mini dialer's and NotificationPanel's
"mark all read" now covers the 20 rows they display instead of an accidental
100. On ext 101 that changes nothing anyone can see — the unread badge comes
from `/voice/voicemail/unread-count` and reads **15,298**, so marking a page was
never going to clear it either way.

---

## 5. Guard

`apps/portal/lib/voicemailPreloadBound.test.ts` — 6 tests, **registered in the
portal `test` script** (⛔ a portal test does nothing until it is named there).

It asserts the warm-up is bounded, that the bound is **strictly** under the cache
size, that the cap sits inside `preloadVoicemailAudio`, and — on the api side —
that `pageSize` is declared, defaults to 100, and that `take` is no longer
hardcoded.

⛔ **Proven real, not assumed:** reverting each half individually was run, and the
suite failed 2/6 with exactly the matching cases. It reads source on purpose —
the cache and warm-up are module-private to a `"use client"` component, and a
test that reimplemented them would assert its own copy rather than the shipped one.

---

## 6. Verification

- Portal `tsc --noEmit`: **clean**.
- api `tsc --noEmit`: **75 errors = the exact pre-existing baseline**, none in
  the edited range (18450–18600).
- Portal suite: **113 tests, 111 pass, 2 fail** — both failures pre-existing and
  unrelated (`campaignsIndexLayout`, `webrtcSdpDiagnostics`); neither reads any
  file touched here.

---

## 7. The live actions taken

1. `allowlist.conf` — added `allow 38.105.207.69;` with a dated comment.
   Backup: `/etc/nginx/connectcomms/allowlist.conf.bak.<epoch>`.
   ⛔ Allowlist **first**, then unblock — `monitor.sh` runs every 60 s and would
   otherwise re-ban inside a minute (`if ip in allow or ip in already: continue`).
2. `/opt/connectcomms/scripts/unblock_ip.sh 38.105.207.69` — the sanctioned
   unblock path; `nginx -t` clean afterwards.
3. Verified live: 403s stopped mid-minute at 18:39 CEST and 200s resumed
   (18:40 read 103×200, 2×206, and only the 2 ordinary `/crm/notifications` 403s).

⛔ No PBX interaction, no migration, no data change, no flag flipped.

---

## 8. Open / next

- ⏳ **NOT PROVEN: nobody at that office has looked at the mini dialer since.**
  It is proven as restored HTTP service and as a deployed bundle, **not** by a
  human seeing the dialer draw. ⛔ Their two windows were blank when the ban was
  on; **they must close and reopen the desktop app** to pick up both the
  restored service and the new bundle.
- The **allowlist entry can now be removed** (`unblock_ip.sh` is not needed —
  just delete the `allow 38.105.207.69;` line and reload). It was insurance
  while the fix was undeployed. Leaving it costs only the loss of auto-ban
  protection for that one office.
- ⛔ **The two PCs there are on desktop 0.1.3 and 0.1.5 while 0.1.6 is
  published.** Unrelated to this outage, but they are missing shell fixes and
  the auto-updater has evidently not moved them. Worth a look.
- **Gesheft ext 101's mailbox is the real underlying weight** — 15,559 in the
  inbox against `maxmsg=9999` on the PBX side (see
  `AGENT_HANDOFF_VOICEMAIL_EMAIL_PBX_2026-08-09.md` §9: at the wall, callers
  stop being recorded at all). This fix removes the flood, not the mailbox.
- ⏳ **NotificationPanel now genuinely receives 20** where it always asked for
  20. Nobody has opened it since the deploy.
