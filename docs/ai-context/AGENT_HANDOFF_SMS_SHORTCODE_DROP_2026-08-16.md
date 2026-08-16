# AGENT HANDOFF — every shortcode SMS was silently discarded (2026-08-16)

Fix commit `6dd6cdca` on `feat/ivr-migration-takeover`. Worker + api deployed
through the queue (jobs `db94056e`, `d51c21f0`). No migration, no PBX write, no
flag flipped.

Found while chasing "the WhatsApp verification code never arrived." It had
arrived. Connect threw it away.

---

## 1. The one-line answer

**Connect discarded every inbound SMS whose sender was a numeric short code —
platform-wide, for the life of the platform, with no log line anywhere.** That
is every WhatsApp verification code, every bank code, every 2FA message, every
shortcode delivery notification, on every customer number.

---

## 2. How it was proven (not inferred)

Two facts, taken from opposite ends of the pipe on 2026-08-16:

**The carrier has the message.** VoIP.ms `getSMS`, platform account, DID
8455577768:

```
2026-08-16 11:37:22  from 29283  |  "Your WhatsApp code: 588-217"
```

**Connect does not.** Same number, same window:

```
ConnectChatMessage INBOUND on +18455577768, last 12h : 0
newest thread activity on that number               : 2026-08-12
```

And the scale of it, across all history:

```sql
select count(*) from "ConnectChatThread"
where "type"='SMS'
  and ("externalSmsE164" is null or left("externalSmsE164",1) <> '+'
       or length("externalSmsE164") < 11);
-- 0     (out of 571 SMS threads)
```

**Zero non-E.164 senders in 571 threads.** Not one shortcode message has ever
been ingested. That is not a delivery gap; it is a total, silent filter.

⛔ Note the second number in the same investigation: **+18457231213 returned
`status=no_sms`** at the carrier over two days while Meta's UI insisted it had
sent a code there. Two different failures were being read as one. Always ask the
carrier per DID before concluding anything about inbound delivery.

---

## 3. The mechanism

`normalizeUsCanadaToE164` (`packages/shared/src/phoneE164.ts`) accepts exactly
three shapes: 10 digits, 11 digits starting `1`, or `+` followed by 10–15
digits. A short code is **3–8 digits** (WhatsApp uses `29283`), so it returns
`{ ok: false, error: "unsupported_format" }`.

The VoIP.ms poller then ran the **sender** through that strict normalizer:

```ts
const from = canonicalSmsPhone(fromRaw);
const to   = canonicalSmsPhone(toRaw || tenantDidE164);
if (!from.ok || !to.ok) return null;     // ⛔ no warn, no routing-log row
```

`apps/worker/src/voipMsInboundSyncJob.ts`. The row was fetched from VoIP.ms,
found unusable, and dropped on the floor. **No log line, no `SmsRoutingLog`
row, nothing to grep for later** — which is exactly why an earlier investigation
concluded, correctly from the evidence it had, that "no verification code ever
arrived."

⛔ **The webhook path did NOT have this bug.** `handleVoipMsInbound`
(`apps/api/src/connectChatRoutes.ts`) already coped: `const extE164 = nf.ok ?
nf.e164 : rawFrom;` — it falls back to the raw sender. So the two inbound paths
disagreed about what a valid sender is, and the one that carries essentially all
real traffic (the poll) was the broken one. Same family as the two IVR publish
paths.

---

## 4. The fix

New `canonicalSmsSender()` in `packages/shared/src/phoneE164.ts`:

| Input | Result | kind |
|---|---|---|
| `8455551234`, `+18455551234`, `(845) 555-1234` | `+18455551234` | `e164` |
| `29283`, `611`, `262966` (3–8 digits) | the digits | `short_code` |
| `WhatsApp` → `WHATSAPP` (≤16 chars, alnum) | upper-cased | `alphanumeric` |
| `""`, `"!!!"`, 64 chars of `A` | refused **and logged** | — |

⛔ **THE ASYMMETRY IS THE DESIGN — do not collapse it.** The **sender** may be a
short code or a sender ID. The **destination** stays on strict
`canonicalSmsPhone`, because a `to` must be one of our own DIDs; loosening it
would let a message be filed against a destination we do not own. A test asserts
`canonicalSmsPhone("29283")` still fails.

⛔ Alphanumeric senders are **upper-cased for the thread key** so carrier casing
changes cannot open two threads for one sender; the original spelling survives
in `externalSmsRaw`.

Both inbound paths now call the shared helper, so they cannot drift again. An
unusable sender now logs `[voipms-inbound] dropped inbound message: unusable
sender …` instead of vanishing.

**Safe to change the canonical form precisely because 0 of 571 threads used it**
— there is no existing thread whose `dedupeKey` could collide or duplicate.

---

## 5. Tests

`apps/worker/src/smsShortCodeSender.test.ts` — 8 cases, built around the real
dropped message. Covers the short code, unchanged E.164 behaviour (asserted
equal to `canonicalSmsPhone` for anything that is a number), the 3–8 digit
range, 10 digits still being a phone number, casing stability, junk refusal, and
the destination-stays-strict guard.

```
worker suite : 99 pass / 0 fail
api phoneE164 + smsSharedInbox : 17 pass / 0 fail
```

Worker typecheck shows only the pre-existing `@connect/shared/<subpath>`
moduleResolution errors in `main.ts` and `packages/db`; none in the touched
files. api typecheck clean for both touched files (the repo's 72 pre-existing
errors are elsewhere).

---

## 6. ✅ PROVEN END TO END WITH REAL DATA

Not plumbing-only. Both containers were verified (`canonicalSmsSender` present
in `app-worker-1` and `app-api-1`, and the old `if (!from.ok || !to.ok) return
null` line **gone** from the worker), and then the message that started all this
**back-filled by itself** — the poller fetches a 2-day window
(`voipMsDateFromParam`), so it re-fetched and this time kept it:

```
ConnectChatThread   +18455577768  <-  29283
ConnectChatMessage  2026-08-16T15:37:22Z  |  "Your WhatsApp code: 588-217"
```

15:37 UTC = 11:37 ET, matching the carrier record to the second. That is the
first non-E.164 sender ever recorded on this platform — the count went 0 → 1.

The standing check, for any future regression:

```sql
select t."tenantSmsE164", t."externalSmsE164", m."createdAt", left(m.body, 60)
from "ConnectChatMessage" m join "ConnectChatThread" t on t.id = m."threadId"
where left(t."externalSmsE164", 1) <> '+' order by m."createdAt" desc;
```

`docker logs app-worker-1 | grep "dropped inbound message"` was **empty** over
the 20 minutes after deploy — no sender shape is still being refused. Anything
that appears there in future is a shape we do not handle yet, and it is now
visible instead of silent.

⛔ **What is NOT recovered: everything older than the 2-day poll window.** Every
shortcode message from before ~2026-08-14 was discarded at ingest and is not in
Connect. VoIP.ms retains history longer than we poll, so a one-off back-fill
over `getSMS` per DID is possible — **not done, and it is Izzy's call**, since it
would drop months of old verification codes into customers' inboxes.

---

## 7. Traps for the next session

- ⛔ **A silent `return null` in an ingest path is how a whole message class
  disappears for the life of a platform.** Nothing was broken loudly. The
  carrier said delivered, the poller said `fetched=N`, and the message was gone.
  Every drop in an ingest path needs a log line or a routing-log row.
- ⛔ **Ask the carrier, not the database, whether a message arrived.** The DB can
  only ever tell you what survived ingest. `getSMS` per DID is the ground truth
  and it settled a question two sessions had argued about.
- ⛔ **An unassigned spare number is never polled at all.** The poller filters
  `tenantId: { not: null }` (`voipMsInboundSyncJob.ts:655`), so a code sent to a
  spare cannot appear in Connect even with this fix. Assign the number first.
- ⛔ **Replying to a shortcode thread will fail at the provider**, and that is
  untouched by this change — these threads are effectively read-only. Not a
  regression; worth a UI affordance one day.
- ⛔ Do not "simplify" `canonicalSmsSender` and `canonicalSmsPhone` into one
  function. See §4.
