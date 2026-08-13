# AGENT HANDOFF — turning SMS on for a customer (2026-08-07)

Proven end to end on **inii mini** (tenant `cmsgkl4y95grttd13yqhyf1gd`) on
2026-08-07: a text was sent from the customer's number and the carrier answered
**"Message delivered to handset"**, and a reply from the far end landed in the
customer's Connect inbox. Everything below is what that took — and, just as
important, the four things that look required and are not.

Part 3 is written for whoever is loading the **Connect Agent's** knowledge; it
is the same procedure in the agent's voice, ready to paste.

---

## 1. The whole job is four steps

Nothing here needs a deploy, a PBX write, or an Apply Changes.

**1 — Find the number's inventory row.** Every DID on the VoIP.ms account is
synced into `TenantSmsNumber` and sits there with `tenantId: null` until someone
claims it (today: 69 rows, 59 unassigned). Look it up by `phoneE164`
(`+1` + 10 digits). If it is missing, re-sync:
`POST /admin/apps/voip-ms/sync-dids` (super-admin).

**2 — Assign it to the customer.** Portal: **Admin → VoIP.ms numbers**. API:

```
PATCH /admin/apps/voip-ms/numbers/:id
{ "tenantId": "<tenant>", "assignedExtensionId": "<ext>", "isTenantDefault": true, "active": true }
```

Who sees the texts follows `resolveSmsInboxScope()` in
`packages/shared/src/smsInbox.ts`:

| What you set | Who gets the texts | Tenants shaped this way |
|---|---|---|
| `assignedExtensionId` | that extension's owner | Landau, Relax Tires, Trust, Displaydex, Luxure |
| `assignedUserId` | that user | inii mini |
| neither | shared company inbox | Gesheft, Fixup, Loopcom Demo, Ribit |

`isTenantDefault: true` makes it the number the company texts *from*. Setting it
clears the flag on the tenant's other numbers first.

**3 — Bill it.** `TenantBillingSettings.smsBillingEnabled = true`. The price is
already `smsPriceCents: 1000` ($10/month) on every onboarding-created tenant —
the sign-up quote stamps it whether or not messaging was bought. Verified on
inii mini: next invoice preview moved **$35 → $45** (line `SMS_PACKAGE`,
qty 1, $10.00). Nothing charges mid-cycle; it appears on the next monthly bill.

**4 — Confirm SMS is on at VoIP.ms.** `getDIDsInfo` for the DID must show
`sms_enabled: "1"`. Onboarding sets this (`enableSms()` in
`apps/api/src/onboarding/voipMsProvisioning.ts`) only when the wizard's
messaging add-on was picked. If it reads `0`:
`setSMS { did, enable: "1" }` — and expect `sms_wait_message` if another SMS
setting was changed in the last minute; pause and retry.

---

## 2. ⛔ Four things that look required and are not

Each of these cost time on 2026-08-07. None of them affect whether texting works.

**⛔ The per-DID webhook fields are a red herring — and `setSMS` lies about
them.** `getDIDsInfo` shows `webhook`, `webhook_enabled`,
`sms_url_callback`, `sms_url_callback_enabled`, and they read like the delivery
switch. They are not:

- **Gesheft (+1 845-244-9666) is the busiest inbound SMS number on the platform**
  — 224 of the last 300 inbound messages — with `webhook_enabled: "0"` and a
  `webhook` still pointing at an old 3CX host.
- `setSMS` answers `{"status":"success"}` and **never moves either `_enabled`
  flag.** Tried `webhook_enabled`+`webhook`, then `url_callback_enabled`+
  `url_callback`, then every documented field in one full-update call. The
  **URL** fields persist; the flags do not. A success status is not a result —
  re-read `getDIDsInfo` after any write.

**⛔ `tenant.smsSendMode` stays `TEST`.** LIVE belongs to the old SMS-campaign
path (`apps/api/src/server.ts` ~8790), which reads the **`phoneNumber`** table
and 10DLC approval. Every working tenant sits at `TEST`. Onboarding tenants have
**no `phoneNumber` rows at all** (their numbers live only in
`PbxTenantInboundDid`), so flipping LIVE would demand a sender number that does
not exist and break campaign sends without helping texting.

**⛔ `tenant.defaultSmsFromNumberId` stays null.** Null on all ten working
tenants. `isTenantDefault` on the `TenantSmsNumber` row is the real "text from
this number" setting.

**⛔ `tenant.smsPrimaryProvider` reads `TWILIO` and that is fine.** Every working
tenant reads TWILIO; the Connect Chat texting path goes through VoIP.ms
regardless. Do not "fix" it.

---

## 3. For the Connect Agent's knowledge — paste-ready

Plain English, no jargon ([[izzy-plain-english]]). Suggested title:
**"Turning texting on for a customer."**

> **What the customer asks for:** "Can we text from our number?" / "Turn on SMS."
>
> **What has to be true:**
> 1. The company has a phone number on the VoIP.ms account with texting switched
>    on at the carrier.
> 2. That number is claimed by their company in Connect, and pointed at whoever
>    should receive the texts — one person, or the whole company's shared inbox.
> 3. Texting is added to their bill: $10 a month, starting on their next invoice.
>    Nothing is charged mid-month.
>
> **What happens once it's on:** texts to that number appear in Connect within
> about a minute, and replies go out showing that same number. Nothing needs to
> be installed and no phone needs to be restarted.
>
> **Who can do it:** a Connect admin, from Admin → VoIP.ms numbers. It is not
> self-serve for the customer, and it is not something the agent performs — the
> agent explains it and hands it to staff.
>
> **What the agent must never tell a customer:** anything about our supplier,
> our supplier's account, or webhook settings. If texting is not working, the
> honest line is "we're setting that up on our side" — the same rule as the
> ElevenLabs failures (`customerMessage` never names the supplier).
>
> **If a customer says texting stopped:** it is almost never their phone. Check
> that the number is still claimed by their company and still marked active.

---

## 4. How inbound texts actually arrive — read before diagnosing

`apps/worker/src/voipMsInboundSyncJob.ts` polls VoIP.ms `getSMS` + `getMMS` on a
cycle for **every `TenantSmsNumber` with `tenantId` not null, `active`, and
`smsCapable`**. That query IS the wiring: the moment you assign the number, it
joins the poll. The log line to watch:

```
docker logs --since 15m app-worker-1 | grep voipms-inbound
[voipms-inbound] +18452605692: fetched=1
[voipms-inbound] cycle done: numbers=11 fetched=22
```

A number missing from that list is not connected, whatever the DB says.

There is also `POST /api/webhooks/voipms/sms` (nginx → api). It is **rarely
hit** — two hits in the current access log while the poller moved hundreds of
messages. ⛔ **Do not conclude "no texts arrived" from nginx logs.**

⛔ **Inbound `createdAt` is the carrier's timestamp, not ours.** The sync job
stamps `createdAt` from VoIP.ms's date string (`parseVoipMsDate`, America/New_York
wall time). So you **cannot** measure delivery lag by comparing the DB row to the
carrier time — they are the same clock by construction. An hour was spent
"proving" a lag that way; the numbers meant nothing.

---

## 5. Verification — the only proof that counts

Send a text and get a reply. Two places to read the result:

**VoIP.ms** (`getSMS`, `did` + `from`/`to` dates): `type: "0"` is outbound and
carries `carrier_status`; `type: "1"` is inbound. inii mini's proof:

```
type 0  "hello"   carrier_status: "Message delivered to handset."
type 1  "Hello"   carrier_status: "received"
type 0  "Hello."  carrier_status: "Message delivered to handset."
```

**Connect**: `connectChatThread` where `tenantSmsE164 = '+1…'`, with its
messages — outbound rows carry `deliveryStatus: "sent"` and a
`smsProviderMessageId`; the inbound row carries `voipms:<id>` and
`providerMetadata.source: "voipms_getSMS_getMMS"`.

Credentials for a read-only probe live encrypted in `GlobalVoipMsConfig` and
decrypt with `CREDENTIALS_MASTER_KEY` (AES-256-GCM envelope, see
`packages/security/src/index.ts`). ⛔ The api container has **no built
`packages/security/dist`** — `require("@connect/security")` fails inside
`docker exec … node -`; inline the ~6-line decrypt instead, or run through
`apps/api/node_modules/.bin/tsx`.

---

## 6. Worked example — inii mini, and its one open loose end

| | |
|---|---|
| Tenant | `cmsgkl4y95grttd13yqhyf1gd` ("inii mini") |
| User / extension | `sales@iniimini.com` · ext **101** (baila) |
| SMS number row | `cmopedhek02jwtd4cjnds0kj9` → **+1 845-260-5692** |
| Assigned | user + ext 101, tenant default, active |
| Billing | `smsBillingEnabled: true`, $10/mo, first appears on the Sep 5 invoice |
| VoIP.ms | `sms_enabled: "1"`, routing `account:344022_iniimi92gh2m` |

✅ **UPDATE 2026-08-12: the port LANDED and SMS was moved to the real number.**
Port order 217760 reads `post_status: completed`; the two filing risks (missing
bill, weak PIN) never bit. Steps 1–4 were repeated on **646-984-6023** that day:
the DID arrived routed to the MASTER account (`account:344022`) with
`sms_enabled: "0"` — both fixed (`setDIDRouting` → `account:344022_iniimi92gh2m`,
`setSMS enable=1`, re-read verified). New `TenantSmsNumber` row assigned
user+ext 101, **tenant default moved to the real number**; the temp row stays
active but is no longer default. Worker poll picked it up
(`[voipms-inbound] +16469846023` in the cycle). **CALLS went live the same day**
(second session, Izzy's mandate): inbound route **240** created in tenant 105
via the onboarding panel-automation path (`createInboundRoute` shape, dest ext
101), DidRouteMapping `cmsqf9ksm6l2gpb13yfa0ybqa` → IVR "New menu"
(`cmsgxycu3019ns1139yvetiih`), switched via the real
`/voice/did/:id/switch-to-connect` (service JWT, same as the scheduler) + full
`/voice/ivr/publish` (183 keys, numbersSynced 2). Probe call traced end to end:
`connect-doorway` → `connect-tenant-ivr` → `connect-menu` playing
`custom/main_greeting_fc10c9`. ⛔ The switch 502'd
(`pbx_helper_read_failed: aborted due to timeout`) until
**`connect-pbx-helper` was restarted on the PBX — it had leaked to 1024/1024
FDs and 761 threads since Aug 6** (every open failed `Errno 24`, responses took
~25-30s vs the 15s inspect timeout; suspect: voicemail-spool polling). ✅ **Temp number
845-260-5692 RETIRED 2026-08-12** — automatically, by the new port watchdog's
first sweep (routed back to the master spare pool, SMS row un-claimed, mapping
deleted; see `AGENT_HANDOFF_PORT_AUTOMATION_2026-08-12.md`). Its old "Main"
PBX inbound route on tenant 105 is the one leftover (+$3/mo E911 until deleted
in the panel). Still open: no live text sent from the new number yet (wiring
fully verified; a text+reply is the last proof).

Original filing notes (for history): filed 2026-08-05; no phone bill was ever
attached (the upload was destroyed by an api deploy before the volume fix), and
the transfer PIN we sent was the number's last four rather than a Verizon
6-digit Number Transfer PIN. See `AGENT_HANDOFF_ONBOARDING_AUTOMATION.md` §9.

**Left deliberately as-is:** the number is scoped to baila personally
(`assignedUserId` set), which is the one shape difference from the other
tenants. With one user on the account it behaves identically. If inii mini adds
staff who should all see the company's texts, clear `assignedUserId` and leave
only `assignedExtensionId` — or clear both for a fully shared inbox.
