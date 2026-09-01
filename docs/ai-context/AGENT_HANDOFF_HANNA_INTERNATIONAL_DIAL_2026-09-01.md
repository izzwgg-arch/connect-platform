# Hanna: "they didn't let her call Israel" — nothing blocked her, the number was never complete (2026-09-01)

**Read-only investigation — no code change, no deploy, no PBX write, no carrier write,
no test call placed.** Every fact below is read from the live PBX log, the rendered
dialplan, the Asterisk CDR table, and one read-only VoIP.ms `getSubAccounts`.

Izzy, 2026-09-01: *"Check Hanna. She is in the UK. She was trying to call to Israel,
dialing 011. They didn't let her make the call. Check why."*

Tenant **Hanna** (`cmt1qoxrq0004o8myjoq13m21`), PBX **T141** (`hanna_eneh5c`), ext **101**,
user `chaniweb16@gmail.com`, outbound route **162**, ARS **289**.

---

## 1. The answer

**Nothing on our side refused the call. She never dialed a complete international
number.** Two of her four attempts were rejected by our own PBX before reaching a
carrier because they matched no dial pattern; the other two *did* go out to both
carriers and were refused because the digits are not a real international number —
**the country code `972` is missing.**

### The four attempts, from `/var/log/asterisk/full` (PBX clock = EDT)

| # | Time | Digits that arrived | Outcome |
|---|---|---|---|
| 1 | 13:06:42 | `97229993371` | No `011` → matched nothing → *"cannot be completed as dialed"* |
| 2 | 13:07:09 | `029993371` | Israeli **domestic** format → matched nothing → same recording |
| 3 | 13:11:42 | `01129993371` | `011` present, **`972` missing** → routed out, both carriers refused |
| 4 | 13:12:02 | `01129993371` | identical retry, identical refusal |

Attempt 1 is the **correct digits with no `011`**. Attempts 3–4 are the **correct
`011` with the country code dropped**. She got each half right once and never both
together.

**The string that works is `011 972 2 999 3371` → `01197229993371`.**

### What the log says, verbatim

Attempts 1 and 2 (call ids `C-0000d57d`, `C-0000d57f`):
```
Executing [97229993371@T141_cos-all-post:1] NoOp("...", "No valid number found")
Executing [s@invalid-dest-cos:5] Playback("...", "silence/1&cannot-complete-as-dialed&check-number-dial-again,noanswer")
```

Attempts 3 and 4 (`C-0000d58a`, `C-0000d58b`) — these **did** reach the carriers:
```
Executing [01129993371@T141_cos-all-post:1] NoOp("...", "Outbound Route: Hanna eneh5c")
Executing [01129993371@trk-72-dial:42] Dial("...", "PJSIP/01129993371@0001,90,...")
app_dial.c: Everyone is busy/congested at this time (1:0/0/1)
Executing [s-162@T141_cos-all-post:7]  NoOp("...", "Hangup Cause: 38, Dial Status: CHANUNAVAIL")   <- Telocall (trunk 72 "0001")
Executing [s-162@T141_cos-all-post:10] NoOp("...", "Hangup Cause: 34, Dial Status: CONGESTION")    <- her VoIP.ms (trunk 166)
```

⛔ **Note the failover DID work** — trunk 0001 refused, the route moved on to her own
VoIP.ms trunk, and that refused too. Both trunks were offered a number whose country
code is missing, so neither refusal tells us anything about whether international is
permitted.

---

## 2. Everything on our side is correctly configured — verified, not assumed

- **Carrier lock is OFF.** Read-only `getSubAccounts` on 2026-09-01:
  `344022_Hannaeneh5c` → `lock_international: "0"`, `international_route: "1"`.
  The 2026-08-23 unlock is intact.
- **The dialplan carries `_011.`** and it matches a correct number. Proven with
  `dialplan show <n>@T141_cos-all-post`:

  | Dialed | Matches |
  |---|---|
  | `01197229993371` (correct) | ✅ `_011.` → *Outbound Route: Hanna eneh5c* |
  | `01129993371` (hers) | ✅ `_011.` → routed (carriers then refused) |
  | `97229993371` | ❌ falls to `app-termination` `_X.` → *No valid number found* |
  | `+97229993371` | ❌ **extension does not exist at all** |
  | `0097229993371` | ❌ `_X.` → *No valid number found* |

- **Trunk order on route 162** is `trk-72` ("0001", Telocall) → `trk-166` (her
  VoIP.ms), continuing to the second trunk unless the hangup cause is 16/17/19.
  Matches the standing 0001-primary rule.

---

## 3. ⛔ The real product bug this uncovered: the iOS app strips `+`

She is on the **iOS app** (`MobileDevice`: IOS, iPhone 14 Pro, last seen
2026-09-01 17:05:54Z — the registration immediately before these calls).

`apps/mobile/src/sip/mobileOutboundDial.ts:38`:

```ts
return trimmed.replace(/[()\-\s.+]/g, "");
```

**It strips `+`.** So `+972 2 999 3371` — the form a number is saved in on a phone,
and the form anyone in the UK would type — becomes exactly **`97229993371`**, which
is attempt #1, and which the dialplan cannot route. The customer sees *"your call
cannot be completed as dialed"* and concludes they are blocked.

⛔ **So every international call placed from the iOS/Android app in E.164 form fails
silently**, including tapping a contact saved as `+972…`. The portal is different but
no better: `normalizeDialTargetForSip` (`apps/portal/hooks/useSipPhone.ts:481`) keeps
the `+`, and `+97229993371` matches **no extension at all** on the PBX.

**Neither `+` nor `00` works anywhere. `011` is the only accepted international
prefix on this platform.** That is worth knowing for a customer sitting in the UK,
where `00` is the prefix they have used their whole life.

**Not fixed here** — it is a mobile build plus a dialplan decision, and it is Izzy's
call. The two candidate fixes:
1. Client-side: convert a leading `+` to `011` in `normalizeMobileDialTarget` (and
   the portal's `normalizeDialTargetForSip`) instead of deleting it.
2. PBX-side: add `_+.` and `_00.` patterns that rewrite to `011` before dialling —
   a per-route change on every tenant, so larger.

---

## 4. ⏳ What is NOT proven

**No correctly-formatted international call has ever been placed on this platform.**
`asterisk.cdr` over the last 45 days contains exactly **four** rows matching `dst LIKE
'011%'` — Hanna's two calls, each with its two trunk legs. Nothing else, from any
tenant, ever.

So: the routing is proven, the carrier lock is proven off, the failover is proven to
work — but **whether `01197229993371` actually completes is unproven**. Telocall's
cause 38 and VoIP.ms's cause 34 on a malformed number are consistent with "bad
number" and equally consistent with "international not carried on this trunk".

**The acceptance test is one real call** to a correct international number, watched
in the log. That spends money and is a live action, so it was deliberately not run.

---

## 5. What to tell Hanna

Dial **`011 972 2 999 3371`** — `011`, then `972`, then the number without its
leading `0`.

- Do **not** dial `00…` (the UK prefix) — the phone system is American and does not
  accept it.
- Do **not** rely on a contact saved as `+972…` — the app deletes the `+` and the
  call fails. Until the `+` handling is fixed, save the number as `01197229993371`.

---

## 6. Queries used

```bash
# her attempts today
grep -a "Dialing .* from 101" /var/log/asterisk/full | grep -a T141
grep -aoE "Executing \[[0-9*#+]+@T141_cos-all:1\]" /var/log/asterisk/full | sort | uniq -c

# what a given string would do (read-only, no call placed)
asterisk -rx "dialplan show 01197229993371@T141_cos-all-post"

# has international ever completed, platform-wide
mysql -N -e "SELECT calldate,src,dst,disposition,billsec FROM asterisk.cdr
             WHERE calldate >= NOW() - INTERVAL 45 DAY AND dst LIKE '011%'
             ORDER BY calldate DESC LIMIT 40;"
```

⛔ `/var/log/asterisk/full` holds **today only** — this trace existed only because the
calls were the same day.
