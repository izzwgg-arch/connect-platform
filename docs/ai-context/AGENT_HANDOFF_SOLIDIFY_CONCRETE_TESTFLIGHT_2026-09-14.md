# AGENT HANDOFF — Solidify Concrete ext 101 added to TestFlight (2026-09-14)

Izzy, 2026-09-14: *"solidified concrete 101. Add him to test flight and send the email."*

## What was done (live, production ASC; no code, no deploy)

| | |
|---|---|
| Connect tenant | `cmnlgryjz0006p9pa60892fi9` **"Solidify Concrete"** (Izzy said "solidified"; this is the only match for solid%/concrete%) |
| Extension | 101 "Shlomo" `cmnmd7mzg000tp9b06gllyox5` → owner user `cmnmjhhf30015p96hgzoldhrx` |
| User | **sstern@solidifyconcrete.com**, role USER, status INVITED, lastLoginAt null |
| TestFlight | added to "Loopcom Testers" `fe508ee6-4a3f-49dd-bf53-858839fa2f06`, POST `/v1/betaTesters` **201**, state **INVITED** straight away |
| Builds attached | 59, 58, 56: all VALID, not expired |
| Scripts (loopcom) | `/root/.appstoreconnect/asc-add-sstern.mjs`, `asc-invite-sstern.mjs` (sed copies of the Hanna scripts) |

## Ext 102 added too (Izzy: "do one for extension 102 as well")

| | |
|---|---|
| Extension | 102 "Office" `cmnmd7mzo000xp9b04tcydksa` → owner user `cmnmjhhic001bp96he9te7e08` (also owns ext 103 "Toby Horowitz") |
| User | **office@solidifyconcrete.com**, USER, INVITED, never logged in. It is also the tenant's billing email |
| TestFlight | POST `/v1/betaTesters` **201**, state **INVITED**. **No first or last name** ("Office" isn't a person, and names can't be edited later) |
| Scripts | `/root/.appstoreconnect/asc-add-scoffice.mjs`, `asc-invite-scoffice.mjs` |

## Texting, shared inbox, 2-month backfill, 443 (Izzy, same day)

*"turn on text message for them. Make it a shared mailbox in both extensions, and backfill their text messages for the past 2 months in the chat. Make sure their phones all work on port 443."*

### SMS (runbook `AGENT_HANDOFF_SMS_ACTIVATION_2026-08-07.md`, shared shape §8)
- DID **+1 845-557-7879** is the tenant's only number (`PbxTenantInboundDid` inbound 357, T14). Inventory row `cmogdrtil007ypk5ey83h47e5` was unclaimed.
- Carrier read first: `sms_enabled "1"`, routing `account:344022_solidefyc`, so **no carrier write**. ⛔ `sms_email: izzwgg@gmail.com`, `sms_email_enabled "1"`: every inbound text is also forwarded to Izzy's personal Gmail. Untouched, and switching it off is Izzy's call. `sms_forward 8453002701` is disabled.
- One write: `PATCH /admin/apps/voip-ms/numbers/cmogdrtil007ypk5ey83h47e5 {tenantId, assignedExtensionId:null, assignedUserId:null, isTenantDefault:true, active:true}` → **200**, via a 60 s SUPER_ADMIN token in `app-api-1` (script `/root/solidify-sms.ts`). The worker picked it up on the next cycle: `[voipms-inbound] +18455577879: fetched=1`, numbers=17.
- ⛔ **Billing left OFF**: `smsBillingEnabled` false, `smsPriceCents` 1000, not on a flat rate. Enabling it adds a $10 `SMS_PACKAGE` line from billing day 26. Ask Izzy.

### Backfill
- The poller only looks back 2 days. One-off: `/root/solidify-backfill.ts` = a sed copy of `apps/worker/src/voipMsInboundSyncJob.ts` (dateFrom fixed to 2026-07-14 + `from` param, limit 1000) with a main appended that runs `fetchRecentSmsForDid` → `importInboundMessage` for the shared scope, **without** `sendSmsPush`. Run inside `app-worker-1` with the worker's tsx; the copy was removed from the container afterwards.
- Result: carrier rows **14** (07-30 11:58Z → 09-14 18:55Z, all inbound; VoIP.ms held no outbound), messages 1 → **14**, **12 threads**, all `smsInboxOwnerUserId ""`, **office@ and sstern@ both participants on all 12**, 0 duplicate `smsProviderMessageId`.
- ⛔ Run 1 (with `date_to`/`to`) → carrier **522**, nothing imported. Run 2 (`date_from` only, the worker's exact shape) → **1** row. Run 3 (added `from`) → 14. See memory `voipms-getsms-wants-from-not-date-from`. ⏳ Whether the live poller misses anything because of `date_from` is unchecked.
- MMS media older than ~7 days can't be mirrored (carrier URLs expire). None of the 14 carried media URLs in the thread counts above, but that wasn't separately checked.

### 443
- Before: `webrtcRouteViaSbc false`, `sipWsUrl wss://m.connectcomunications.com:8089/ws` (direct PBX). Backup `/root/solidify-sip-backup-20260914.json`.
- After: `webrtcRouteViaSbc true`, `sipWsUrl wss://sip.connectcomunications.com/sip`: the **pinned-existing-customer** value from the SIP hostname split (B Visible, Displaydex, Gesheft, inii mini, Loopcom Demo), not null. Null would take the global `sip.loopcom.net`, which has never carried a REGISTER. Probe from loopcom → **101**. `sipDomain` untouched. UPDATE was guarded on the old URL.
- Rollback: set both fields back to the backup values.
- ⏳ **Not moved yet**: PBX shows one contact, `T14_102_1` over wss from 38.105.205.181. It keeps its cached 8089 URL until that user **signs out and back in** (desktop app: full close incl. tray). Proof = `pjsip show contacts | grep T14_` showing the contact arriving from loopcom 45.14.194.179. No `MobileDevice` rows exist for the tenant; `T14_101/102/103` desk endpoints have no contacts. Desk phones register on 5060 and aren't affected by this flag.

## "Send the email", and why nothing else was sent

- The TestFlight invite email is sent **by Apple** when a tester is added to the external group. There is no separate send. The INVITED state (unlike Hanna's NOT_INVITED lag) confirms Apple sent it.
- The Loopcom portal invite (`USER_INVITE`, create-password link) had already gone out: EmailJob `cmu1mi9rm00xgmq12ka9iae0t` was SENT 2026-09-14 19:16:03 UTC by an earlier action the same day. office@solidifyconcrete.com got one at 19:17. It was not sent again, to avoid a duplicate.

## Honest gaps

- ⏳ He has not accepted or installed the app. If he says the email never came, re-run `node /root/.appstoreconnect/asc-invite-sstern.mjs`. It only re-invites while the state is NOT_INVITED or INVITED.
- lastName is **null on purpose**. "Stern" would be a guess from the address, and betaTesters have no PATCH (renaming = delete + re-add = second invite).
- If his iPhone's Apple Account uses a different email, the invite redeem may still work through the link. If it doesn't, add that address as its own tester (see the Eli handoff §TestFlight).
