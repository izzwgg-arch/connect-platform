# ⛔⛔ AGENT HANDOFF — every shortcode SMS was silently discarded, platform-wide (2026-08-16) — READ FIRST for ANY "the verification code never arrived", before trusting Connect's SMS inbox as proof of what was received, or before adding a `return null` to an ingest path

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SMS_SHORTCODE_DROP_2026-08-16.md`**
(`6dd6cdca` on `feat/ivr-migration-takeover`. **worker + api DEPLOYED and
container-verified.** No migration, no PBX write, no flag flipped.)

- ⛔⛔ **CONNECT THREW AWAY EVERY INBOUND MESSAGE SENT FROM A SHORT CODE — for
  the life of the platform, with no log line anywhere.** That is every WhatsApp
  verification code, every bank code, every 2FA message, on every customer
  number. Found only because a WhatsApp registration "never received its code".
- ⛔ **THE PROOF IS TWO READINGS FROM OPPOSITE ENDS OF THE PIPE.** VoIP.ms
  `getSMS` for DID 8455577768 held `2026-08-16 11:37:22 from 29283 | "Your
  WhatsApp code: 588-217"` while Connect showed **0 inbound on that number in
  12 h**; and **0 of 571 SMS threads** platform-wide had a non-E.164 sender.
  Zero, ever — that is a total filter, not a delivery gap.
- **The mechanism:** `normalizeUsCanadaToE164` takes only 10-digit, 11-digit-
  starting-1, or `+`-prefixed 10–15 digits. A short code is **3–8 digits**
  (WhatsApp uses `29283`), so it returned `unsupported_format`, and the poller
  did `if (!from.ok || !to.ok) return null` — **no warn, no `SmsRoutingLog`
  row, nothing to grep**. The row was fetched from the carrier and dropped.
- ⛔ **THE TWO INBOUND PATHS DISAGREED, AND THE BROKEN ONE CARRIES ALL THE
  TRAFFIC.** The webhook (`handleVoipMsInbound`) already coped — `nf.ok ?
  nf.e164 : rawFrom`. Only the **poll** dropped, and inbound arrives by poll.
  Same family as the two IVR publish paths. Both now call one shared helper.
- **The fix:** `canonicalSmsSender()` in `packages/shared/src/phoneE164.ts` —
  identical E.164 for anything that is a real number, 3–8 digits → short code,
  alphanumeric sender IDs upper-cased for a stable thread key, junk refused
  **and logged**. ⛔ **THE SENDER/DESTINATION ASYMMETRY IS THE DESIGN — never
  collapse the two functions.** A `to` must be one of our own DIDs and stays on
  strict `canonicalSmsPhone`; a test asserts `canonicalSmsPhone("29283")` still
  fails. Safe to change the canonical form only because 0 of 571 threads used
  it, so no `dedupeKey` can collide.
- ⛔ **ASK THE CARRIER, NOT THE DATABASE, WHETHER A MESSAGE ARRIVED.** Connect's
  inbox can only ever show what survived ingest. Per-DID `getSMS` is ground
  truth and it settled a question two sessions had argued over — it also showed
  **+18457231213 returning `status=no_sms`** for codes Meta insisted it sent, so
  two different failures were being read as one.
- ⛔ **An unassigned spare number is NEVER POLLED AT ALL** —
  `voipMsInboundSyncJob.ts:655` filters `tenantId: { not: null }`. A code sent
  to a spare cannot appear in Connect even with this fix. Assign it first.
- ✅ **PROVEN END TO END WITH REAL DATA, not plumbing-only.** Both containers
  verified (`canonicalSmsSender` present, the old dropping line **gone**), and
  the poller's 2-day window **back-filled the message itself**:
  `ConnectChatMessage 2026-08-16T15:37:22Z | 29283 -> +18455577768 | "Your
  WhatsApp code: 588-217"` — the first non-E.164 sender ever recorded here
  (count went 0 → 1), matching the carrier to the second. Zero
  `dropped inbound message` warnings in the 20 min after deploy. Tests: 8 new
  cases + worker 99 pass / 0 fail, api phone + shared-inbox 17 pass / 0 fail.
- ⛔ **NOT recovered: anything older than the 2-day poll window.** Every
  shortcode message before ~2026-08-14 was discarded at ingest and is gone from
  Connect. VoIP.ms keeps history longer, so a one-off back-fill is possible —
  **not done, Izzy's call**, since it would drop months of stale verification
  codes into customers' inboxes.
- ⛔ **Replying to a shortcode thread will fail at the provider** — untouched by
  this change; those threads are effectively read-only.
- **Related, same investigation:** the WhatsApp integration itself still cannot
  send anything (see the WhatsApp audit section) — this fix is about Connect's
  own SMS inbox, not about WhatsApp working.
