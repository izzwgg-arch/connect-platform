# ⛔⛔ AGENT HANDOFF — a blank mini dialer, because we flooded a customer off our own server (2026-08-17) — READ FIRST for ANY "the app is blank / won't load" report, before debugging a customer-side UI fault, before adding a prefetch/warm-up loop, or before trusting a query parameter you send

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_MINI_DIALER_BLANK_VOICEMAIL_PRELOAD_2026-08-17.md`**
(**portal + api DEPLOYED and container-verified**; customer unblocked live at
nginx. No PBX interaction, no migration, no data change, no flag flipped.)
Memory: [[blank-app-means-check-the-ban-first]], [[prefetch-must-fit-its-cache]].

- ⛔⛔ **"BLANK WINDOW" WAS NOT AN APP BUG — THE CUSTOMER'S WHOLE OFFICE WAS
  BANNED AT NGINX.** `denylist.conf` is included at the TOP of the server block,
  so a ban refuses **everything**: the API, the page's own HTML and JavaScript,
  `/ringtones/*`, `/version`. A reopened window cannot download the code that
  would draw anything, so it paints a blank box and shows no error — **which is
  exactly why closing and reopening it can never help.**
  ⛔⛔ **THE ONE-GREP TELL: `/version` IS UNAUTHENTICATED.** If it is 403ing
  next to the API calls, the fault is in front of the app — stop reading
  application code. A permission or login problem cannot reach an endpoint that
  checks neither. ⛔ **The api log is the WRONG place to look** — banned requests
  never reach the api, so its log goes *quieter* during the outage.
  **Check `/etc/nginx/connectcomms/denylist.json` FIRST for any "it's blank / it
  stopped working" report.** Unblock is `/opt/connectcomms/scripts/unblock_ip.sh <ip>`,
  and ⛔ **allowlist BEFORE unblocking** — `monitor.sh` runs every 60 s and
  re-bans inside a minute (`if ip in allow or ip in already: continue`).
- ⛔⛔ **WE SET THE BAN OFF OURSELVES, AND IT WAS TWO BUGS STACKED.**
  **(1) `GET /voice/voicemail` never declared `pageSize`, and zod strips what it
  does not declare** — so two portal screens that had been asking for **20** rows
  for months were silently handed **100** (`const take = 100`), proven on the
  wire (a `pageSize=20` request answered **33.4 KB** ≈ 100 records).
  **(2) The mini dialer then warmed audio for all 100 into a 30-entry cache**, so
  70 were evicted on arrival, found missing by the 30 s refresh, and downloaded
  again — forever. Measured, one office, seven minutes: **1,521 downloads of only
  102 distinct voicemails, 15–24× each, 963 MB**, ~250 req/min → over the
  `req5m > 1200` threshold → banned.
- ⛔ **A WARM-UP MUST NEVER FETCH MORE THAN ITS CACHE CAN HOLD, AND "EQUAL" IS
  NOT ENOUGH.** The eviction loop is `while (size >= MAX)`, so inserting entry 30
  evicts entry 1 and that one message thrashes forever. New `VM_PRELOAD_MAX = 20`
  is **strictly** under `VM_CACHE_MAX_ENTRIES = 30`. ⛔ **The cap lives INSIDE
  `preloadVoicemailAudio`, never at the call site** — the defect was a caller
  handing over a longer list than it promised, and a bound that only exists where
  today's single caller sits is one new caller away from being gone.
- ⛔ **The bug was NOT specific to the banned office — every machine on that
  extension was doing it**: 963 + 345 + 227 + 123 MB per seven minutes ≈ **1.65 GB
  per 7 min for ONE extension, ~14 GB/hour.** The office with two PCs behind one
  IP merely crossed the threshold first. **Lifting the ban alone would have left
  all of it running** — which is why the code fix shipped with it.
- ⛔⛔ **A SECOND CUSTOMER WENT BLANK WITH NO BAN AT ALL — so the ban was never
  the disease.** Trust Bookkeepings reported the same symptom ~40 min later,
  never banned (403s a flat ~180/h of background `/crm/notifications`, 192 of
  their last 200 requests were 200s), and was running the identical loop:
  **2,350 downloads of only 40 distinct voicemails, 59× each, 721 MB in two
  hours.** Their audio downloads ran a metronome 1,200/hour and **fell to ZERO at
  16:00 CEST**, exactly when their mini-dialer traffic dropped 2,424→612/hour
  while total traffic continued — **the app stopped, the network did not.**
  ⛔ **THEREFORE THE REAL THRESHOLD IS 30, NOT 100:** any inbox holding more than
  `VM_CACHE_MAX_ENTRIES` thrashes, because a working set bigger than the cache
  evicts everything each pass. The oversized 100-row page only made Gesheft
  violent enough to trip a rate limit. ⛔ **Triage by the REFETCH RATIO (total
  voicemail-stream requests vs distinct ids for that IP), never by whether a ban
  exists.**
- ⛔ **It predicts exactly who complains — whoever has the most voicemail.** Trust
  inboxes: **105 Mrs. Halpert 163 (the reporter)**, 104 Mrs. Schwartz 150,
  101 Mr. Sofer 82 — all thrashing; while 389/106/107 hold 9/4/2 and **fit inside
  the 30-slot cache, so those colleagues were never affected.** Gesheft ext 101
  holds 15,559.
- ⚠️ **INFERRED, NOT PROVEN, and must be repeated as such:** the step from
  "downloaded ~367 MB/hour into blob object URLs for hours" to "the Electron
  renderer gave out and painted white" fits every timestamp but rests on **no
  client-side crash telemetry** — nobody has read a renderer log. Proven: the
  flood, its volume, that it stopped the minute the window went blank, and that
  no server refusal was involved at Trust.
- ⛔ **`pageSize` defaults to 100 and MUST stay that way.** Three callers page
  through this endpoint without sending it (`apps/mobile/src/api/client.ts:268`,
  the portal voicemail page, `desktopNotificationPoll.ts`) and are byte-for-byte
  unchanged. Only a caller that ASKS for less now gets less.
- **Identifying "which one is it" when several people share a login:** the
  voicemail stream URL carries the JWT in the query string, so
  `grep <base64-payload> access.log | <ip + user-agent>` enumerates every machine
  on an account. Ext 101 had **five**; the two affected were the only ones at the
  banned IP, and were provably two PCs (two desktop versions, two `iat`s).
  ⛔ **Their old shells (0.1.3 / 0.1.5 vs published 0.1.6) were a coincidence,
  not the cause** — the desktop app wraps the hosted portal, so all five ran the
  same bundle.
- ⏳ **NOT PROVEN: nobody at that office has opened the mini dialer since.**
  Proven as restored HTTP service (403s stopped at 18:39 CEST, 200s resumed) and
  as a deployed bundle — **not** by a human seeing the dialer draw. ⛔ **They must
  close and reopen the desktop app**; an open window keeps the old bundle.
  ⏳ The temporary `allow 38.105.207.69;` line **can now be removed** — it was
  insurance while the fix was undeployed.
