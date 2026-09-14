# ⛔⛔ AGENT HANDOFF — HIPAA readiness: Loopcom is NOT compliant, and MEETINGS is the cleanest part of the platform (2026-08-21) — READ FIRST before answering ANY "can we take a medical customer", before promising a BAA, before adding meeting recording, and before assuming `AuditLog` satisfies audit controls

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full assessment: **`docs/ai-context/AGENT_HANDOFF_HIPAA_READINESS_2026-08-21.md`**
(**Read-only — no code, no deploy, no migration, no PBX write, no env change, no
vendor contacted, nothing signed.** Every number was measured on both live
servers 2026-08-21.) Writeup for Izzy:
<https://claude.ai/code/artifact/7f1bd0b2-be96-4092-b3d5-62a137aaf557>.
Memory: [[loopcom-is-not-hipaa-ready]].
Izzy, 2026-08-21: *"What do we need to do to make Loopcom, and especially
Loopcom meetings, HIPAA compliant and to be able to use it for medical
appointments?"*

- ⛔⛔ **THE ANSWER: not today, and the work is NOT mainly in Meetings.** Meetings
  is the *cleanest* surface on the platform — chat is never stored, there is no
  recording, and media is relayed by our OWN LiveKit container, so **LiveKit and
  VitalPBX need no BAA at all**. Self-hosting instead of buying Zoom is a real
  compliance advantage; **keep it that way.** The blockers are platform-wide:
  hosting, encryption at rest, backups, and a missing PHI-access audit trail.
- ⛔⛔ **Loopcom would be a BUSINESS ASSOCIATE, and since the 2013 Omnibus Rule a
  BA is DIRECTLY liable to OCR** — not merely contractually liable to the
  customer. **A breach before the agreements exist lands on Loopcom.** And
  ⛔ **there is no such thing as HIPAA certification** — anyone selling a badge
  is selling an opinion.
- ⛔⛔ **THREE HARD BLOCKERS, each independent, none of them code:** (1) both
  servers are on **Contabo, which does not sign BAAs**; (2) **nothing on either
  disk is encrypted** — `lsblk` shows plain ext4 roots, no LUKS, on loopcom AND
  the PBX; (3) **backups are local-only, unencrypted, 14 days**, sitting on the
  machine they protect (`backup.sh` greps 0 hits for `rclone|s3|gpg|scp|rsync`).
  ⛔ Encryption at rest is formally *addressable*, not required — but it is the
  **breach safe harbour**, so without it one stolen disk is a reportable breach
  for every practice at once.
- ⛔⛔ **`AuditLog` DOES NOT SATISFY §164.312(b), AND THAT IS THE BIGGEST BUILD.**
  It records admin/config actions well and records **ZERO reads of content** —
  nothing logs who played a recording, listened to a voicemail, opened a text
  thread or read a transcript. That is the first thing a practice asks about,
  because it is how they investigate their own staff. **Never read the presence
  of an audit table as covering audit controls.**
- ⛔ **Measured 2026-08-21, re-verify before quoting:** **101,080 call recordings,
  169 GB, oldest 2025-07-26, no retention policy** + **8.9 GB voicemail** on the
  PBX; Postgres `show ssl` → **off**; **0 tenants on 2FA, 0 users enrolled**;
  sessions still never expire.
  ⛔⛔ **AND AN OPEN QUESTION THAT BLOCKS ANY RETENTION WORK: only 1 of 79 inbound
  routes has `enablerecording=yes`, so those 101k recordings come from somewhere
  else** (class of service, outbound routes, or a global). **Find the switch
  before writing a deletion policy — you cannot bound what you cannot locate.**
- ⛔ **"Just make Meetings compliant" is impossible, because ONE voicemail
  touches:** the PBX disk → Connect's `app_voicemail-audio` volume → an outside
  transcriber (**Yiddish Labs / OpenAI Whisper / ivrit.ai on RunPod**) →
  `Voicemail.transcript` → **an email with the WAV attached through Gmail** →
  the **AI assistant**, which ships it to OpenAI/Anthropic. A patient text
  touches VoIP.ms (which STORES bodies) → `ConnectChatMessage` → the SMS↔email
  bridge. **13 vendors are in scope and 0 BAAs are signed.**
- ⛔ **Who will NOT sign:** Contabo, **Yiddish Labs** (tiny vendor, receives
  voicemail AUDIO and chat TEXT — the painful one, it is the feature this
  customer base values), the **Expo push relay** (carries caller names and
  message previews), and **Apple APNs** (industry answer: content-free payloads,
  never a name). **Who will:** Google Workspace (accept it in the Admin console;
  covers Gmail + FCM), OpenAI (+ zero data retention), Anthropic, AWS.
  **Unverified, ask in writing:** VoIP.ms (a carrier has a narrow **conduit
  exception**, but VoIP.ms *stores* SMS and can email it — past that line) and
  RunPod.
- ⛔ **MEETINGS' OWN TWO GAPS: the meeting code IS the whole lock** (no waiting
  room, no host admit, no passcode, self-asserted guest names — an unlocked exam
  room for a patient consult), and **the title travels** (`VideoMeeting.title`
  is stored forever and emailed out; "Follow-up — Mrs. Weiss" is PHI in an
  inbox). ⛔ **The France/Contabo hosting is NOT a residency violation — HIPAA
  has no residency rule** — but Contabo won't sign and EU processing drags GDPR
  in; the **already-approved US VPS move fixes both**.
  ⛔⛔ **THE DAY MEETING RECORDING IS ADDED IT BECOMES PHI ON A DISK**, with
  consent capture, retention, deletion and access logging all attaching at once.
  ✅ **E2EE is already available and unused** — `livekit-client` ships
  `E2eeManager`/`KeyProvider` (verified in `node_modules`); not required, but the
  strongest possible answer to a nervous practice.
- ✅ **RECOMMENDED SHAPE (Izzy's call, gates everything): a fenced MEDICAL TIER,
  not a whole-platform posture** — a per-tenant flag that turns OFF Yiddish
  transcription, the Expo relay, the SMS↔email bridge, the AI assistant and PBX
  recording, and turns ON forced 2FA, session expiry, meeting waiting room,
  neutral titles and the access log.
  ⛔⛔ **THE TRAP: a per-tenant flag that SOME code paths ignore is worse than no
  flag** — every one must be enforced server-side and pinned by a source guard,
  the exact discipline the `computeCurrentMode` five-call-site sweep already
  uses. **A missed call site here leaks PHI, silently.**
- ⛔ **The assistant is the sharpest edge:** it reads transcripts/chat/CDR into
  outside models, `investigate` runs SQL that is deliberately NOT tenant-scoped,
  and escalations text **two personal mobile numbers** and email a **personal
  Gmail** — none of which are covered channels.
- ✅ **Already in decent shape, do not re-derive:** TLS 1.2+ with 1.0/1.1
  refused, SSH keys-only, the tenant-isolation findings §6a–§6l closed,
  `/internal/*` fails closed, per-user permissions enforced server-side, remote
  support asks the screen's owner and asks **separately** before control.
- ⛔ **Most of HIPAA is paperwork, and that is where enforcement lands — the most
  commonly cited failure in OCR settlements is a missing documented RISK
  ANALYSIS**, not a hacked server. Phases + timings in §8 of the handoff:
  infra 2–4 wks, paperwork 4–8 wks (~$5–20k/yr, ⛔ buy the policy set, do not
  write it), engineering 6–10 wks. ⛔ SOC 2 is **not** required by HIPAA but
  answers forty questionnaires with one document.
- ⏳ **NOT DONE, and each is cheap:** nobody has asked VoIP.ms or RunPod;
  nobody has checked whether the Google Workspace BAA is already accepted in the
  Admin console (it is one click); and ⛔ **nobody has checked whether a current
  customer is ALREADY handling PHI** — a therapy or medical practice already on
  the platform would change the urgency of everything above.
