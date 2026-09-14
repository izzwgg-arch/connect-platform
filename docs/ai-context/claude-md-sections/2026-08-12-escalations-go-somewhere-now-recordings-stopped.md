# ⛔⛔ AGENT HANDOFF — escalations go somewhere now; recordings stopped lying; voicemails play their own audio (2026-08-12) — READ FIRST for agent escalations/alert email, ANY recording or voicemail playback work, before adding a reply.send(stream) to apps/api, or before believing a stored audio locator

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ESCALATIONS_RECORDINGS_VOICEMAIL_2026-08-12.md`**
(commits `1682c0a0` → `6947e0e2` — api + portal DEPLOYED, agent container
REBUILT at `6947e0e2`, two DB migrations, all live-verified incl. a real chat
that produced a real SMS + email.)

- ⛔ **"Passed to the human team" now has code behind it.** For weeks it was
  prompt text with NOTHING attached — 40+ customer requests reached nobody.
  Now: the agent detects its own escalation replies, RESEARCHES with the
  tenant-bound read tools (drafting ISSUE/FINDINGS/PROPOSED FIX/APPROVAL so the
  owner only says "okay"), writes `AgentEscalation`; the api's 30s dispatcher
  texts **(562) 209-6644 + (845) 723-1213 FROM (845) 557-7768** (tenant name +
  user name in the SMS) and emails tod10950@gmail.com. SMS capped 40/rolling-24h.
  ⛔ **The model free-forms its phrasing — the first live test escaped the
  transcript-derived regex** ("I've passed along: …", no team named); every
  live miss becomes a regression case in `escalations.test.ts`. ⛔ Replying
  "OK" does NOT auto-execute. ⛔ Research failure never loses the escalation
  (`researchDegraded` + raw transcript).
- ⛔ **ADMIN_ALERT email is MUTED platform-wide** (owner's explicit trade):
  the api's `processEmailJobsBatch` — the ONLY send door; the worker just
  creates rows — marks every ADMIN_ALERT job `SKIPPED`. Nobody receives
  platform alert emails anymore; the rows remain as audit trail. The agent's
  own SMTP also drops the alert address. The 2026-08-06 "don't re-enable until
  the cap bypass is understood" is moot — ADMIN_ALERT never sends at all.
- **(845) 557-7768 was taken from Landau Home** (Izzy's word; they now have NO
  texting number) and is the ADMIN tenant's default — owner replies land in the
  admin shared SMS inbox (proven, ~2.5 min poll) and admin outbound rides the
  same number.
- ⛔ **`ConnectCdr.recordingPath` proves INTENT, never existence** — VitalPBX
  sets `__REC_FILENAME`/`MIXMONITOR_FILENAME` on calls it then does NOT record.
  44% of Trust Bookkeeping's play buttons were dead (418 offered / 234 real).
  `recordingMissingAt` is stamped ONLY on a PBX-confirmed 404 + failed
  CDR-recovery (`recordingAvailability.ts`, unit-tested: a 5xx/timeout must
  NEVER hide a recording — queue/IVR calls record on another leg and recovery
  rescues them). Sweep: `POST /voice/recordings/verify` (dry-run default) —
  ⛔ **applied to Trust ONLY so far**. Whether Trust's routes SHOULD record is
  Izzy's open call (`enablerecording=no` on all their inbound routes; recording
  is per ROUTE, never per extension).
- ⛔ **In an async Fastify handler, `reply.send(<stream>)` that is not RETURNED
  answers `200 content-length: 0` EMPTY — silently.** A Buffer survives that
  race, a stream loses it, no log anywhere; caught only by a body-counting
  probe. Return the send through the whole chain. And never put
  `AbortSignal.timeout()` on a fetch whose body pipes to the client — bound
  time-to-headers only, or long audio cuts off mid-listen. Recordings now
  STREAM (first byte 571 ms on a 14 MB file, was full-transfer-first);
  voicemail skips the ffmpeg transcode when the RIFF header says PCM (header,
  never extension — wav49=GSM also ships as ".wav").
- ⛔ **Every stored voicemail locator is POSITIONAL** (msgNum, spool paths,
  `/static/…/msgNNNN.wav` — Asterisk renumbers slots on every delete/move).
  35 voicemails on one mailbox were bound to msg0000 — THE "every voicemail
  plays the first one" bug, both apps. Playback now resolves the current slot
  by **origtime** (from `pbxMessageId`), answers honest 404
  `voicemail_audio_gone` when the identity left the mailbox, and ⛔ **msg_num
  matching was removed from both refresh matchers — never reintroduce it**.
  The web app ALSO had an unkeyed player that set `audio.src` once, forever —
  two bugs, one symptom, which is why the earlier "fix" never held.
- Mini-dialer voicemails PRELOAD into a blob cache on list load (instant play;
  `?preload=1` never read-stamps — `?raw=1` is unsuitable, it skips transcode).
  ⛔ An already-open mini-dialer keeps the old bundle until app restart.
- ⛔ `git merge-base --is-ancestor A B` asks "is A an ancestor of B" — inverting
  it produced a false branch-rollback scare mid-session. `ls-remote` +
  merge-base before concluding anything about a rollback. Agent rebuilds build
  the branch TIP (sessions push all night); apps/api tests need
  `node --experimental-test-module-mocks --import tsx --test`.
