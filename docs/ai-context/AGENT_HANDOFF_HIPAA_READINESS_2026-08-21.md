# AGENT HANDOFF — HIPAA readiness for Loopcom and Loopcom Meetings (2026-08-21)

Izzy, 2026-08-21: *"What do we need to do to make Loopcom, and especially
Loopcom meetings, HIPAA compliant and to be able to use it for medical
appointments?"*

**Read-only assessment — no code change, no deploy, no migration, no PBX write,
no env change, no tenant row touched, no vendor contacted, nothing signed.**
Every number below was measured on the live servers on 2026-08-21, not estimated.

Customer-facing writeup:
<https://claude.ai/code/artifact/7f1bd0b2-be96-4092-b3d5-62a137aaf557>

---

## §1 The answer in one paragraph

**Loopcom is not HIPAA-ready and must not be sold for medical appointments
today**, and the work is overwhelmingly NOT in Meetings — Meetings is the
*cleanest* part of the platform (stores nothing, records nothing, chat dies with
the meeting, media relayed by our own LiveKit container with no vendor in the
path). The blockers are hosting, encryption at rest, backups, and a missing
PHI-access audit trail, all of which are platform-wide. Realistic path to a
defensible position: **~1 quarter** — 2–4 weeks of hosting/infra, 4–8 weeks of
paperwork in parallel, 6–10 weeks of engineering.

⛔ **The framing that matters: Loopcom would be a BUSINESS ASSOCIATE, and since
the 2013 Omnibus Rule a business associate is DIRECTLY liable to OCR for the
Security Rule** — not merely contractually liable to the customer. A breach
before the agreements exist lands on Loopcom, not on the practice.

⛔ **There is no such thing as HIPAA certification.** Nobody can certify us; any
vendor selling a badge is selling an opinion. Compliance is a documented program.

---

## §2 What was MEASURED on 2026-08-21 (re-verify before quoting — these age)

| Fact | How it was read | Value |
|---|---|---|
| Disk encryption, loopcom | `lsblk -o NAME,FSTYPE,MOUNTPOINT` | `sda1 ext4 /` — **no LUKS, no crypt device** |
| Disk encryption, PBX | same, on 209.145.60.79 | `sda3 ext4 /` — **no LUKS** |
| Call recordings | `find /var/spool/asterisk/monitor -name "*.wav" \| wc -l` | **101,080 files, 169 GB** |
| Oldest recording | `find … -printf "%T+\n" \| sort \| head -1` | **2025-07-26** — 13 months, no retention policy |
| Voicemail store | `du -sh /var/spool/asterisk/voicemail` | **8.9 GB** |
| Postgres TLS | `psql -tAc "show ssl"` | **off** |
| Backups | `ls /opt/connectcomms/backups/postgres` + grep of `backup.sh` | 14 days of plain `.dump` files, **no offsite step, no encryption step** (grepped `rclone\|s3\|aws\|gpg\|scp\|rsync\|remote` → 0 hits) |
| PHI-read audit | `rg` for any audit write on recording/voicemail playback routes | **0 — none exists** |
| PBX disk headroom | `df -h /` | 490 G total, 266 G used, 58% |
| Routes with recording on | `select sum(enablerecording="yes") from ombu_inbound_routes` | **1 of 79** — ⛔ so the 101k recordings are NOT coming from inbound routes; the source (class of service / outbound / global) was **not** traced and is an open question |

⛔ **`AuditLog` exists and is healthy for ADMIN/CONFIG actions. It records no
reads of content.** That distinction is the whole finding — do not read the
presence of an audit table as satisfying §164.312(b).

---

## §3 Where PHI actually flows (why "just fix Meetings" is impossible)

A single patient voicemail today touches, in order: the **PBX disk** (wav) →
**Connect's local voicemail-audio volume** (`app_voicemail-audio`) → an
**outside transcription vendor** (Yiddish Labs, OpenAI Whisper, or the ivrit.ai
model on RunPod, chosen by `chooseProvider` in
`apps/agent/src/transcription/transcriber.ts`) → **`Voicemail.transcript`** in
Postgres → an **email with the WAV attached through Google Workspace** → and is
readable by the **AI assistant**, which sends it to OpenAI/Anthropic.

A patient text touches: **VoIP.ms** (which stores SMS bodies and can forward
them by `sms_email`) → `ConnectChatMessage` → the **SMS↔email bridge**, which
emails it out of `sms@loopcom.net` and accepts replies back in.

So scope is a decision, not a discovery. See §6 Phase 0.

---

## §4 Subcontractor BAA inventory (§164.308(b)(1))

Read off the actual call sites, not a vendor list.

**Hard blockers — will not sign:**
- ⛔⛔ **Contabo** hosts BOTH servers. Contabo does not offer BAAs. **This alone
  ends the conversation** — everything at rest lives on their disks.
- ⛔ **Yiddish Labs** receives voicemail AUDIO and chat message TEXT. Tiny
  vendor; a BAA is very unlikely. **This is the painful one** — it is the
  feature this customer base values most.
- ⛔ **Expo push relay** carries notification titles/bodies (caller name,
  message preview). Medical tenants must be on the direct-FCM/APNs path only.
- ⛔ **Apple (APNs)** does not sign. Standard industry answer: content-free
  payloads ("You have a new message"), never a name or a preview.

**Will sign, needs requesting:**
- ✅ **Google Workspace** — Gmail/Drive are HIPAA-includable; the BAA is
  accepted in the Admin console, and **only covered services may be used**.
  Firebase Cloud Messaging is on the covered list.
- ✅ **OpenAI** — BAA on request for the API, with zero data retention enabled.
- ✅ **Anthropic** — BAA on request for the API.
- ✅ **AWS** — BAA in Artifact; covers Polly (which only ever sees greeting
  text, not PHI).

**Unverified — get it in writing:**
- ⚠️ **VoIP.ms** — a carrier merely transmitting a call has a decent claim to
  the **conduit exception** (§160.103), which HHS reads narrowly. But VoIP.ms
  **stores** SMS bodies and offers email forwarding, which is past a conduit.
  Ask them directly.
- ⚠️ **RunPod** (hosts the ivrit.ai Yiddish model) — some tiers advertise
  HIPAA; unconfirmed.
- ⚠️ **ElevenLabs** — BAA is Enterprise-tier. Low risk if kept to outbound
  greetings; the **voice changer** (customer-uploaded audio) must be fenced.

**No BAA needed, and this is a real advantage:**
- ✅ **LiveKit** and **VitalPBX** are self-hosted software on our own boxes —
  no media leaves to a vendor. **Keep it that way**; buying Zoom or a cloud
  video API would have added a BAA dependency Meetings currently does not have.
- ✅ **Cardknox/Sola** — payment processing sits outside the rule.
- ✅ **Cloudflare** — Turnstile touches the login page only.

**Count for the headline stat: 13 vendors in scope, 0 BAAs signed.**

---

## §5 The gaps, by severity

### Blockers
1. **No encryption at rest anywhere** (§164.312(a)(2)(iv)). ⛔ It is formally
   *addressable*, not required — but it is the **breach safe harbour**: encrypted
   stolen data is not a reportable breach. Without it, one stolen disk is a
   notification event for every practice at once.
2. **Backups local-only, unencrypted, 14 days** (§164.308(a)(7) — one of the few
   flatly *required* items). A backup on the machine it protects is not a backup.
3. **No retention or disposal policy** (§164.310(d)(2)(i)). 101,080 recordings,
   oldest 13 months, growing. A practice cannot answer "how long do you keep
   it?" when the answer is "forever".

### Gaps
4. **No PHI-access audit trail** (§164.312(b), §164.308(a)(1)(ii)(D)). ⛔ **The
   biggest single engineering item**, and the first thing practices ask about —
   it is how they investigate their own staff.
5. **Sessions never expire; MFA/2FA built and off** (§164.312(a)(2)(iii),
   §164.312(d)). 0 tenants on 2FA, 0 users enrolled. ⛔ Blocked on the mobile
   401-handling work already scoped in the security handoff §8 — see that
   section before touching `expiresIn`, the trap there is real (a dead token is
   a 401 stream that auto-bans a customer's whole office).
6. **The AI assistant** reads transcripts/chat/CDR and sends them to outside
   models; `investigate` runs SQL that is deliberately **not** tenant-scoped;
   escalations text two **personal** mobile numbers and email a **personal
   Gmail** (§164.502(b) minimum necessary). None of those are covered channels.
7. **Postgres TLS off** (§164.312(e)(1)). Low practical risk (single host,
   docker network) but it is on every questionnaire and is an afternoon.

### Already in decent shape — do not re-derive this
TLS 1.2+ enforced and 1.0/1.1 refused; SSH keys-only; the tenant-isolation audit
findings §6a–§6l closed; `/internal/*` fails closed; per-user permissions
enforced server-side; remote support asks the screen's owner and asks
**separately** before control. That is most of a technical-safeguards story and
is why the remaining list is short.

---

## §6 Meetings specifically

**Must fix:**
- ⛔ **The meeting code IS the credential.** No waiting room, no host admit, no
  passcode, guest names self-asserted. For a patient consult that is an unlocked
  exam room. Fix = waiting room + host admit, and one-time per-patient links.
- ⛔ **The title travels.** `VideoMeeting.title` is stored indefinitely and goes
  out in invite emails (`VideoMeetingInvite`) through Google Workspace.
  "Follow-up — Mrs. Weiss" is PHI in an inbox. Medical tenants get neutral
  titles by default.

**Solved by work already approved:**
- The media server is in **France on Contabo**. ⛔ HIPAA has **no data-residency
  requirement**, so this is not a violation in itself — but Contabo won't sign
  and EU processing drags GDPR in. The **US VPS move already approved** in the
  video-meetings handoff §6 fixes both, and doubles as the TURN relay.

**Compliance wins — protect them:**
- Chat rides the LiveKit data channel and is **never stored**; meeting chat dies
  with the meeting; **there is no recording**; media is DTLS-SRTP and relayed by
  our own container.
- ⛔⛔ **The day recording is added it becomes PHI on a disk** — consent capture,
  retention, deletion and access logging all attach to it at once. Add it
  deliberately or not at all.
- ✅ **E2EE is available and unused.** `livekit-client` ships `E2eeManager` and
  `KeyProvider` (verified present in `node_modules`). Not required by HIPAA, but
  it is the strongest possible answer to a nervous practice — with it even our
  own SFU cannot hear the call.

---

## §7 The administrative half (§164.316) — where enforcement actually lands

⛔ **The most commonly cited failure in OCR settlements is not a hacked server —
it is not having done a documented risk analysis.**

Needed: written **risk analysis** (§164.308(a)(1)(ii)(A)); named **security and
privacy officials** (§164.308(a)(2)) — can be one person, must be written down;
**policies and procedures** kept 6 years; **training + sanction policy**
(§164.308(a)(5)); **access management with a termination procedure**
(§164.308(a)(3)(ii)(C)); **incident response + breach notification** — a BA must
notify the covered entity within 60 days (§164.410); a **tested contingency
plan** (§164.308(a)(7)); a **BAA template** for practices plus signed BAAs with
every subcontractor in §4.

⚠️ Most Loopcom customers are in NY, so the **SHIELD Act** already requires
reasonable safeguards for their residents' data, covered entity or not.

---

## §8 Recommended path

**Phase 0 — Izzy's decision, gates everything.** Whole-platform posture, or a
fenced **medical tier**? ✅ **Recommendation: the tier** — a per-tenant flag that
turns OFF Yiddish transcription, the Expo relay, the SMS↔email bridge, the AI
assistant and PBX call recording, and turns ON forced 2FA, session expiry,
meeting waiting room, neutral titles and the access log. Smaller, ships
incrementally, and does not force the Yiddish-speaking base off features built
for them.
⛔ **The trap: a per-tenant flag that SOME code paths ignore is worse than no
flag.** Every one must be enforced server-side and pinned by a source-guard
test — the exact discipline the `computeCurrentMode` five-call-site sweep and
the permission-key work already use. A missed call site here leaks PHI, silently.

**Phase 1 — infra, 2–4 weeks, mostly money.** Move BOTH boxes off Contabo to a
host that signs (major cloud, or a HIPAA specialist). Full-disk encryption or
provider-managed encrypted volumes. Encrypted offsite backups with a **tested**
restore. Postgres TLS on. Raise HSTS from its current 1-day value.

**Phase 2 — paperwork, 4–8 weeks, ~$5–20k/yr, runs in parallel.** Engage an
advisor or a compliance platform — ⛔ do not write the policy set from scratch,
it is a purchasable solved problem. Risk analysis, officials, policies,
training. Collect the BAAs in §4; get VoIP.ms and RunPod **in writing**.

**Phase 3 — engineering, 6–10 weeks.** The **PHI access log** (one append-only
table, one choke point every content read passes through — biggest item);
session expiry + enforced 2FA (mobile 401 work first); retention/disposal that
actually deletes the WAVs and records it; Meetings hardening (waiting room,
one-time links, neutral titles, an on-screen "not being recorded" line); fence
the assistant off uncovered models and personal escalation channels;
break-glass staff access that is time-boxed, logged and visible to the customer.

**Phase 4 — prove it.** Pen test, then **SOC 2 Type II** if selling past solo
practices. ⛔ SOC 2 is **not** required by HIPAA, but it answers forty security
questionnaires with one document and larger buyers ask for it first.

---

## §9 What to tell a practice today

That Loopcom is **building toward it and is not there yet**, and that we will
not sign a BAA we cannot stand behind. The narrow nearly-defensible offer is a
**video meeting with no recording, a neutral title, and no voicemail, texting or
AI in the loop** — but even that waits on the hosting move, because the servers
themselves are the exposure.

⛔ **The one thing not to do: take a medical customer on today's platform and
sort the compliance out afterwards.**

---

## §10 Open questions this pass did NOT answer

- ⛔ **Where the 101,080 recordings actually come from.** Only **1 of 79**
  inbound routes has `enablerecording=yes`, so recording is being switched on
  somewhere else (class of service, outbound routes, or a global setting).
  **Trace this before writing any retention policy** — you cannot delete or
  bound what you cannot find the switch for.
- Whether VoIP.ms and RunPod will sign. Nobody has asked.
- Whether the Google Workspace BAA has ever been accepted in the Admin console
  (it is a click, and it may already be done — unverified).
- Whether any current customer is already handling PHI. **Nobody has checked**,
  and a medical or therapy practice already on the platform would change the
  urgency of all of the above.
- The `VideoMeetingInvite` model exists in the schema but no `apps/api` code
  references it yet — the scheduled-meeting/invite feature appears to be
  schema-only or in another session's in-flight work. Confirm before assuming
  invite emails are live.
