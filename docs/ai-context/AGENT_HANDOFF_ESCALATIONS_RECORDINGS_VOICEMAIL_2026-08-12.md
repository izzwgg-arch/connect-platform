# AGENT HANDOFF — escalations go somewhere now; recordings stopped lying; voicemails play their own audio (2026-08-11 → 08-12)

One overnight session, three engagements, all **DEPLOYED and live-verified**:
api at ≥ `92c0fe79`, portal at ≥ `a16acf7a`, agent container rebuilt at
`6947e0e2` (manual compose build, done in-session under Izzy's "Do it. Finish
it."). Commits: `1682c0a0` (dead play buttons) → `35842af5` (instant play +
streaming) → `92c0fe79` (return-the-send fix) → `a16acf7a` (voicemail identity)
→ `b1304a54` (escalation pipeline) → `6947e0e2` (detector regression). Two DB
migrations: `20260811180000_cdr_recording_missing`, `20260812060000_agent_escalation`.

Origin story: Izzy asked whether the agent's chat history survives ("a lot of
people said it told them it would be escalated — we never got it"). It does:
92 conversations / 1,850 messages, queryable, Yiddish rows carry `contentEn`.
The escalations, though, went NOWHERE — "passed to the human team" was prompt
text with no code behind it. Working Trust Bookkeeping's backlog then surfaced
the recording and voicemail defects below.

---

## 1. ⛔ "I've passed this to the human team" now has code behind it (`b1304a54` + `6947e0e2`)

**The pipeline** (owner directive, 2026-08-12): every escalation →
- the agent RESEARCHES first, with the same tenant-bound read tools chat uses,
  and drafts `ISSUE / FINDINGS / PROPOSED FIX / APPROVAL` — the owner should
  only have to say "okay";
- SMS to **(562) 209-6644 + (845) 723-1213**, FROM **(845) 557-7768**, carrying
  the **tenant name and user name** (both are required content, not decoration);
- the full report emailed to tod10950@gmail.com;
- **every other alert to that inbox stops** (§2).

**Split on purpose:** the AGENT (manual rebuild) only detects + researches +
writes an `AgentEscalation` row. The API (redeployable in minutes) owns
delivery: `agentEscalationDispatch.ts`, a 30 s sweep — SMS both numbers,
partial delivery counts as sent (a one-number hiccup must not re-text the other
number on every retry), then the `AGENT_ESCALATION` EmailJob, then
SENT/FAILED. **SMS capped at 40 per rolling 24 h** (`AGENT_ESCALATION_SMS_DAILY_CAP`)
— a runaway agent bug must not text the owner all night; over the cap the email
still goes.

- ⛔ **The model free-forms its escalation phrasing — transcript-derived
  detection WILL miss.** The very first live post-deploy test escalated with
  "I've passed along: **…**" (no team named after the verb) and the regex built
  from six weeks of real transcripts missed it. The idioms themselves must
  match ("pass(ed) along", "escalated to a human", "our team will follow up"),
  and every live miss becomes a regression case in
  `apps/agent/src/escalation/escalations.test.ts`. Expect to add more.
- ⛔ **Detection triggers on the assistant's ENGLISH text** (`contentEn ?? content`
  — bridged Yiddish replies store the English mirror). It runs fire-and-forget
  AFTER the reply, hooked in `conversation/routes.ts` — chat never waits on it
  and never breaks over it. Owner-role turns are skipped; one escalation per
  conversation per 30 min.
- ⛔ **Research failure NEVER loses the escalation** — the row ships flagged
  `researchDegraded` with the raw transcript. The research is real when it
  runs: the live test looked up the account's actual number, saw its one
  extension was UNREGISTERED, pulled 72 h of call records, and correctly said
  the customer's fax line isn't hosted by Connect at all.
- **(845) 557-7768 was TAKEN FROM LANDAU HOME** (Izzy's word — it was their
  ONLY number; they now have none) and is the ADMIN tenant's default texting
  number. Replies land in the admin shared SMS inbox (proven: sent a text to
  it, worker poll ingested it into `connect-admin-tenant-v1`'s thread in
  ~2.5 min) and admin outbound rides the same number — the whole loop stays on
  one thread. DID has `sms_enabled=1` at VoIP.ms.
- ⛔ **Replying "OK" does NOT auto-execute the fix.** The reply lands in the
  admin inbox like any text; approval means telling the assistant/staff to
  proceed. Auto-execution-on-reply was deliberately NOT built (a text changing
  customers' phone systems needs its own design pass).
- ⛔ Izzy dictated "todd10950@gmail.com" (two d's); every existing config says
  `tod10950@gmail.com` — the existing address was used. `AGENT_ESCALATION_EMAIL`
  overrides if that was wrong.
- ⛔ The live test ran with `clientUserId: null` → SMS said "Unknown user". Real
  portal chats carry the user id; verify the first REAL customer escalation
  names its user properly.
- SMS sender: `resolvePlatformSmsSender(fromNumber)` extracted from
  `billingSmsSender.ts`. The escalation from-number can NEVER be the billing
  number — (845) 723-1213 is one of the escalation RECIPIENTS.

## 2. ⛔ ADMIN_ALERT email is MUTED platform-wide — deliberately

`processEmailJobsBatch` (the api is the only sender of EmailJob rows — the
worker just creates them) marks every `ADMIN_ALERT` job **SKIPPED**
(new `EmailJobStatus` value) with an explanatory message, whatever created it —
several files create these rows without going through `sendAdminAlert`, so
gating creation sites would always leak. The agent's own SMTP notifier also
drops the alert address from every mail (`AGENT_MUTED_ALERT_RECIPIENTS`).
Proven live in the most fitting way: the deploy's own "[Connect Alert] Connect
API (re)started" was intercepted and SKIPPED.

- ⛔ **This means NOBODY receives platform alert emails anymore** — that is the
  owner's explicit trade ("stop all other alerts that go to that email"), and
  it also ends the 500/day-quota burn (2026-08-06: alerts took 402 of 499 sends
  and silenced customer email for a day). The rows still exist as an audit
  trail: `EmailJob WHERE type='ADMIN_ALERT' AND status='SKIPPED'`.
- The 2026-08-06 handoff's "do not re-enable alerts until the cap bypass is
  understood" is now moot — ADMIN_ALERT never sends at all.

## 3. ⛔ A play button was offered for calls that were never recorded (`1682c0a0`)

Trust Bookkeeping's "I can't listen to the recording / download is also not
proper" (2026-08-04, via the agent chat that went nowhere) was real and was
ours: **`ConnectCdr.recordingPath` is captured from the AMI VarSet of
`__REC_FILENAME`/`MIXMONITOR_FILENAME`, and VitalPBX sets that variable on
calls it then does NOT record** — it is the name the file WOULD have carried.
A stored path proves INTENT, never existence. Measured: Aug 2026, Trust — 418
offered, 234 real, **183 dead (44%)**; the customer clicked the same dead
button four times in eight minutes while the UI said "please try again".

- Fix: `recordingMissingAt` stamped ONLY when the PBX 404s the stored path AND
  the VitalPBX-CDR recovery finds no alternative recfile (queue/IVR calls
  record on a different leg — 1 of Trust's 184 was rescued exactly this way and
  must keep playing). Both decisions live in
  `apps/api/src/recordingAvailability.ts`, fail toward SHOWING the recording,
  and are unit-tested: **a 5xx/timeout/unreachable PBX must never hide a
  customer's recording.**
- `POST /voice/recordings/verify` (SUPER_ADMIN, **dry-run by default**) sweeps a
  tenant through the same resolve→fetch→recover chain a click uses. ⛔ **Applied
  to Trust Bookkeeping only** (183 stamped, live-verified). Other tenants clean
  up lazily per click — or run the sweep, ~0.5 s per recording.
- Honest UI: "Not recorded" chip (server asked for one byte to distinguish
  permanent from transient), and downloads report WHY they failed
  (`downloadRecordingWithReason`). ⛔ Whether these calls SHOULD be recorded is
  Izzy's open decision — Trust's inbound routes all carry `enablerecording=no`;
  recording is per ROUTE on the PBX, never per extension.
- ⛔ **The diagnostic needs BOTH sides compared by recordingPath FILENAME** vs
  the PBX filesystem. Do NOT compare `linkedId` against file uniqueids — files
  are named after whichever leg MixMonitor ran on; that comparison invented
  ~125 false "missing" and had to be redone in-session.

## 4. ⛔ Streaming + instant play (`35842af5` + `92c0fe79`)

"It takes forever to start… it shows playing but nothing is playing."
- Recordings: the stream endpoint did `await pbxResp.arrayBuffer()` — the WHOLE
  WAV crossed PBX→Connect before the browser got byte one. Now piped
  (`Readable.fromWeb`); measured on a real 14.2 MB recording:
  **first byte 571 ms** (was: nothing until the full transfer), full file 3.1 s.
- ⛔ **THE TRAP THAT SHIPPED AND WAS CAUGHT BY MEASURING: in an async Fastify
  handler, `reply.send(stream)` that is not RETURNED answers
  `200 content-length: 0` with an EMPTY body.** The handler's own `undefined`
  resolution races the send; a Buffer survives the race, a stream loses it —
  so converting buffered→streaming breaks SILENTLY (no error in any log; the
  deploy log, api log and container-commit check all looked perfect). Return
  the send through the whole chain. Probe with a BODY-COUNTING fetch, never
  curl -I. Reproduced standalone on Fastify 5.7.4: 0 → 1,048,576 bytes by
  adding `return` alone.
- ⛔ **`AbortSignal.timeout()` on a fetch whose body is piped to the client cuts
  the audio off mid-listen** — the body now drains at the CLIENT's pace, so a
  long recording on a slow line legitimately takes minutes. Both PBX fetches
  bound TIME-TO-HEADERS only (AbortController + clearTimeout after await).
- Voicemail: the ffmpeg WAV→MP3 transcode is SKIPPED when the RIFF header says
  plain PCM (format code 1 — browsers play it natively; Asterisk voicemail
  normally is). Decided by the HEADER, never the extension: wav49 = GSM (code
  49) also ships as ".wav" and MUST still transcode.
- Mini-dialer (Windows app): voicemail audio is PRELOADED into a module-scope
  blob cache the moment the list arrives (30 entries / 64 MB, oldest-first
  eviction) — a Play press is served from memory, zero network. The warm-up
  uses **`?preload=1`, which NEVER read-stamps** (fetching ahead is not
  listening; `?raw=1` was unsuitable — it skips transcode and can hand the
  browser GSM). Cache misses show a spinner; player state follows the
  element's real events, not the play() promise.
- ⏳ Not human-verified: nobody has watched a real press in the Windows app yet;
  and an already-open mini-dialer keeps the old bundle until the app restarts.

## 5. ⛔ "The next voicemail replays the first one" — TWO bugs, one symptom (`a16acf7a`)

Reported in the mini-dialer AND the web app; "we claimed to fix it once" —
because either bug alone reproduces it:

- **SERVER (both apps): every stored voicemail locator is POSITIONAL** —
  `pbxMsgNum`, spool paths, and VitalPBX's `/static/<token>/…/msgNNNN.wav` all
  name a SLOT, and Asterisk renumbers slots on every delete/move (INBOX→Old on
  phone playback). Production: **35 voicemails on one mailbox all bound to
  msg0000**; Trust ext 105 had 9 sharing msg0001. The refresh matcher made it
  self-worsening: it matched PBX records BY msg_num and PERSISTED the wrong
  file back. Fix: playback resolves the CURRENT slot by **origtime**
  (`pbxMessageId` = `{pbxTenantId}|{ext}|{origtime}|{caller10}`; same-second
  ties broken by caller digits) via the helper's spool list, fetches exactly
  that message, and answers an honest 404 `voicemail_audio_gone` when the
  identity is no longer in the mailbox — never someone else's audio.
  ⛔ **msg_num matching was REMOVED from both refresh matchers — never
  reintroduce it.** Stored locators are refreshed after each resolve as
  ADVISORY state only; playback never trusts them, so the ~27k historical rows
  needed no repair pass.
- **WEB APP (client):** the detail panel rendered `SmartAudioPlayer` unkeyed
  and `if (!audio.src) audio.src = src` bound the element to the FIRST
  voicemail forever. Now keyed by vm.id + rebinds on src change
  (`_ccAssignedSrc`). The mini-dialer's own player code was fine — its symptom
  was purely the server bug.
- Verified live: two previously-aliased Trust rows now produce distinct results
  (one plays its own audio — sha-verified; two answer "audio gone", and the PBX
  spool confirms those messages sit in the mailbox's **Deleted** folder).
- ⏳ Nuances: the helper list scans INBOX/Old/Urgent, NOT Deleted — handset-
  deleted messages answer "audio gone" though the file still exists in
  `Deleted/` (playing those = helper folder widening, a product decision).
  Connect's list can show voicemails whose PBX message is deleted (sync
  freshness gap) — those rows are where the aliasing used to bite. The
  helper-down legacy chain is untested.

## 6. Environment notes that cost time tonight

- ⛔ **`git merge-base --is-ancestor A B` asks "is A an ancestor of B"** — read
  it twice. Inverting it produced a false "the branch was force-pushed
  backwards!" scare; the tip actually CONTAINED the whole night. `git
  ls-remote` + `merge-base` before concluding anything about a rollback.
- Multiple sessions pushed to the branch all night (softphone, billing, IVR
  hours, agent knowledge). **Agent rebuilds must build the branch TIP** — pull
  before every build; never pin your own older commit.
- The api's EmailJob processor — not the worker — is the single send door for
  queued mail. The worker only CREATES rows.
- apps/api test suite runs `node --experimental-test-module-mocks --import tsx
  --test` — a bare `tsx --test` fails on `mock.module` and looks like a real
  failure.
- SSH + `git push` to GitHub work directly from the Bash tool here (Git Bash on
  Windows). Deploys: api/portal via `deploy-direct.sh` on loopcom (check
  `ps aux | grep -E "[e]nqueue|[r]un-heavy"` AND the queue's runningCount
  first — a queued deploy of another session's commit ran mid-session); agent
  via manual compose build.

## 7. Open / not proven

1. First REAL customer escalation: verify the SMS names the actual user (the
   test ran with a null clientUserId) and that research quality holds on a
   messier account.
2. Recording sweep for the OTHER tenants (Trust only so far) — one dry-run call
   per tenant, then apply.
3. Whether Trust Bookkeeping's routes SHOULD record (their complaint implies
   they think so; all their inbound routes have recording off) — Izzy's call,
   then a PBX panel change under mandate.
4. Mini-dialer instant play watched by a human in the Windows app.
5. Landau Home has NO texting number now.
6. Reply-"OK"-auto-executes was NOT built — decide if wanted, design carefully.
