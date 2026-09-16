# ⛔ Relax Tires got extensions 102 + 103, and the APP (WebRTC) side of every future extension is now HARD-BLOCKED until the mirror's extension grants are installed (2026-09-16)

Izzy, 2026-09-15: *"create two new extensions for Relax Tires, fully billable
extensions. For these two people, send out invitation emails."* Then: *"And make
sure it goes into the next bill invoice."* Then, on hitting the licence:
*"Don't do it through the license. We have our own thing that we build."* and
*"Yes, never the license anymore. It's been canceled."*

Tenant **Relax Tires** `cmnlgryme000up9paz1w40fg0`, PBX tenant **25** (`T25`,
path `fcab1cd3482527c3`).

---

## 1. ✅ What is DONE and verified on the running system

| | Alex Silva | Felix Nieto |
|---|---|---|
| extension | **102** | **103** |
| PBX extension_id | 669 | 671 |
| desk endpoint | `T25_102` **live** | `T25_103` **live** |
| app endpoint | `T25_102_1` **live** | ⛔ **MISSING** |
| max_contacts | 5 / 5 | 5 (desk) |
| Connect Extension row | `cmu3elgbs01ekof137yx045pq` | `cmu3eob17022eof13zawqjx2o` |
| Connect user | `cmu3f48kt02nzqq1at3r0o41k` | `cmu3f48tj02o7qq1awzoq8pml` |
| email | **Alex.relaxtires@gmail.com** | fcnieto25@hotmail.com |
| invite | `USER_INVITE` **SENT** 01:24:41Z | `USER_INVITE` **SENT** 01:24:41Z |

Verified on the PBX itself, not from a panel 200: `pjsip show endpoints` shows
`T25_102`, `T25_102_1`, `T25_103`; `core show hints` has `102@T25…` and
`103@T25…`; `voicemail__50-25-main.conf` carries both mailboxes.

⛔⛔ **Alex's address is NOT what the request said.** The brief gave
`Alex@relaxtores.com`; **that domain does not exist** (NXDOMAIN on 8.8.8.8 —
the invite would have hard-bounced and nobody would have known).
`relaxtires.com` does exist (Microsoft 365 MX). Izzy then supplied
**`Alex.relaxtires@gmail.com`**, which is what was used. Check a customer email
domain in DNS before sending an invitation — it costs one lookup.

## 2. ✅ BILLING — the Sep 26 invoice was RE-ISSUED at $105.00 (Izzy's explicit choice)

`calculateTenantBillingUsage` counts only `/^\d{3}$/`, so 102 and 103 were
deliberately numbered three digits and **do** bill (Relax Tires' existing
`1002`/`1003` still bill nothing — see
[[relax-tires-billing-started-4digit-extension-gap]]). Replaying the DEPLOYED
engine through `POST /admin/billing/tenants/:id/invoices/preview` now returns
`extensionCount: 3`, extension line `3 × $30 = $90`, total **$105.00**.

**CC-202609-00004** (`cmtqqdrfkcws5rq21p8o3s7so`) was OPEN at $45, already
emailed to the customer on Sep 7, and autopay charges it on **Sep 26**. Izzy
chose *"Re-issue the Sep 26 invoice at $105"* over waiting for the Oct 26 cycle.
Done through the sanctioned `PUT /admin/billing/invoices/:id/line-items`:
extension line quantity **1 → 3** ($3000 → $9000), every other line and all
period dates byte-unchanged. Result: subtotal 10000, tax 500, total **10500**,
balance 10500, still **OPEN**, still due `2026-09-26T04:00:00Z`.
⛔ The fee lines do NOT scale with extension count (E911 is per_phone_number,
regulatory is flat_monthly) — $105 is the engine's own figure, not arithmetic.

- **Backup before the edit:** `loopcom:/root/relax-invoice-backup-20260916.json`
  (the invoice + all 5 line items as they were).
- **The customer was told:** `POST /admin/billing/invoices/:id/send` →
  EmailJob `cmu3f6m2103abqq1arlsdh2h2` **SENT** to relaxtires@gmail.com,
  subject *"Invoice CC-202609-00004 — $105.00 due"*. Leaving them a $45 email
  and a $105 charge was the outcome to avoid.
- ⏳ **NOT PROVEN: nothing has charged yet.** Acceptance is **Sep 26** — an
  APPROVED `PaymentTransaction` for $105.00 and a receipt.

## 3. ⛔⛔ THE FINDING THAT OUTLIVES THIS TASK — `/mirror/extension-add` HAS NEVER BEEN ABLE TO RUN ON PRODUCTION

**The panel door is shut.** Adding a WebRTC/app device now returns
`extensions.vitxi_clients.max_reached` — *"You've reached the maximum number of
Mobile/WebRTC clients allowed for your current license."* Alex's `102_1` took
the last slot (count went 61 → 62); Felix's was refused. ⛔ **Freeing a slot did
NOT reopen it** — one was unlinked and the panel still refused at 61, and again
20 minutes later, so the usage figure the panel checks is not a live
`SELECT COUNT(*)`. Treat the panel's app-device door as permanently closed.

**The mirror door is also shut, for a different reason.** `/mirror/extension-add`
answered:

```
(1142, "INSERT command denied to user 'connect_route_helper'@'localhost'
        for table `ombutel`.`ombu_extensions`")
```

⛔⛔ **This does NOT mean the mirror is unbuilt or untested — it is built and it
was stress-proven.** What was proven ran on the **clone as MySQL root**:
`scripts/pbx/mirror/add-extension-accept.py` opens `pymysql.connect(user="root")`
and *refuses to run if a licence file exists*. The production grant file,
`mirror-grants-20260819.sql`, predates the extension-add endpoint and covers the
**tenant-create tables only**. Nobody ever extended the helper's own MySQL user
to the extension tables, and until today nothing had asked it to.

✅ **The fix is written and waiting for Izzy's Run button:**
**`scripts/pbx/mirror/mirror-extension-grants-20260916.sql`** — idempotent,
additive, INSERT only (no DELETE, no widened UPDATE), on exactly the seven
tables `mirror_writes.add_extension` inserts into: `ombu_extensions`,
`ombu_devices`, `ombu_pjsip_devices`, `ombu_extensions_vm`,
`ombu_extensions_contact_info`, `ombu_followme`, `ombu_extension_diversions`
(`ombu_numbers` is already granted). ⛔ It is a PBX write, so it is HIS to run —
the same Run button as the 2026-08-19 grants.

⛔ **Until it is run, EVERY new extension platform-wide is desk-phone-only.**
That is not a Relax Tires problem; it is the next customer's problem too.

## 4. ⛔ Two side effects a later session must not be confused by

- **One VitXi device was removed and NOT put back:** device `733` = `199_1`, the
  app device of extension **199 "Claude Test" on `Ezra stress test 1` (T101)** —
  a throwaway extension on the throwaway test tenant, never registered. It was
  unlinked to free a licence slot before we learned the panel's count is not
  live. Re-add it through the mirror once the grants above are installed, or
  leave it; nothing depends on it.
- **Extension 103 was created, deleted and recreated**, so its PBX
  `extension_id` moved 670 → **671** and its device is **1277**. The Connect
  row and its `PbxExtensionLink` were re-synced and are correct.

## 5. How the work was actually done (the routes, so nobody reinvents them)

Everything went through the deployed product's own doors, signed as SUPER_ADMIN
against `127.0.0.1:3001` inside `app-api-1`:

- `POST /admin/pbx-console/extensions` `{pbxTenantId: 25, extension, name,
  devices:[pjsip, webrtc]}` — creates + applies + `syncConnectExtensions`.
  ⛔ Pass **no email**: the sync would otherwise create a Connect `User` itself
  (ACTIVE, unknown password, no invite) and `POST /admin/users` then answers
  409 — see [[extensions-are-created-through-the-panel]].
- `POST /admin/users` `{tenantId, extensionId, role: "USER", email, firstName,
  lastName, sendInvite: true}` — makes the user, marks the link PROVISIONED
  because the sync already stored a SIP password, and queues the real welcome
  invite (the one that now carries the Google Play badge).
- ⛔ A `PATCH /admin/pbx-console/extensions/:id` that only touches EXISTING
  devices is the way to force an Apply after a failed create — a create that
  throws at the device step leaves rows on the PBX and **nothing in Asterisk**.
  That is how 103's desk line was made live. Always check
  `pjsip show endpoints`, never the panel's 200.

## 6. ⏳ What is NOT done

1. **Felix has no app/softphone** (mobile or browser) until the grants run and
   `/mirror/extension-add` — or a mirror device-add — gives `103` its `103_1`.
   His desk phone works today.
2. Nothing has charged on Sep 26 yet.
3. Neither invitee has signed in.
