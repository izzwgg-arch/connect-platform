# AGENT HANDOFF — B Visible: every seat has a WebRTC softphone now, and the panel's device-add silently burns a VitalPBX Connect licence slot (2026-08-24)

Izzy: *"Check all extensions on beVisible. Does everybody have a WebRTC phone
synced to connect? If not, set up for everybody, sync them to connect, and send
out an invitation email to everybody except Lester."*

**Live changes: 7 WebRTC devices created on PBX tenant 9, one Apply Changes
(with doorway re-bake), one Connect extension sync, four invitation emails.**
No code change, no deploy, no migration, no env change. Backups on the PBX at
`/root/bvisible-webrtc-20260824/`.

---

## 1. The answer to the question

**No — only Lester Tan (111) had one.** Read live from
`ombutel.ombu_devices` joined to `ombu_extensions`, and from Connect's
`PbxExtensionLink`:

| Ext | Name | Before | After |
|---|---|---|---|
| 101 | Front Desk | desk only | **+ WebRTC 1265** |
| 102 | Yosef Pinches Schnitzer | desk only | **+ WebRTC 1268** |
| 103 | Nechamya Weiss | desk only | **+ WebRTC 1263** |
| 104 | Yoel Perl | desk + cell forward | **+ WebRTC 1269** |
| 105 | Moshe Klein | desk + cell forward | **+ WebRTC 1266** |
| 106 | Gershon Felberboim | desk only | **+ WebRTC 1264** |
| 107 | Chesky Goldberger | cell forward ONLY | **+ WebRTC 1267** |
| 108/109/110 | "102 V" / "104 V" / "101 V" | forward legs | **deliberately untouched** |
| 111 | Lester Tan | desk + WebRTC | unchanged |

⛔ **108/109/110 are NOT people** — each is an extension whose only device is a
`virtual` forward to an outside number (845-304-9343, 845-776-1311,
845-637-7945), named after the extension it belongs to. Giving them softphones
would create seats nobody registers to. They were excluded on purpose.

⛔ **107 is a person with no handset** — Chesky Goldberger's extension is a pure
forward to 845-248-3888. He now has a WebRTC device too, so the app is an option
for him; nothing about his existing forward changed.

Connect side after the sync — all eight real seats:
`webrtcEnabled = true`, `pbxSipUsername = <ext>_1`, `pbxDeviceName = T9_<ext>_1`,
`provisionStatus = PROVISIONED`, SIP password stored.

---

## 2. ⛔⛔ THE FINDING THAT OUTLIVES THIS TENANT: `addDevice` inherits `mobile_client`, and that silently spends a VitalPBX Connect licence slot

`addDevice` (`apps/api/src/onboarding/pbxTenantBuild.ts:489`) adds the WebRTC
device by re-posting the **whole extension edit form** with `device_id=new`. It
sets `technology`, `profile_id`, `user`, `max_contacts` and `vitxi_client`
explicitly — **and never touches `mobile_client`.** So the new device inherits
whatever the currently-rendered device had.

On B Visible, extension 102's desk phone carries `mobile_client=yes` (it is
registered as a **VitalPBX Connect** mobile client — the vendor's own app, not
ours). Proven live: the form for ext 104 posted **`mobile_client = "1"`**.

Consequences, both real and both seen today:

1. **The new WebRTC device becomes a VitalPBX Connect mobile device.** Device
   **1268** (`102_1`) came out `vitxi_client=yes, mobile_client=yes` and the
   panel registered a real cloud account for it (`ombu_mobile_devices` id 107,
   `cloud_id 28619`). Every other WebRTC device on the platform — including
   Lester's proven-working 735 — is `mobile_client=no`.
2. **It consumes a per-tenant licence slot**, and when the slot is the last one
   the next add is **refused outright**.

⛔ **The quota is `ombu_tenant_settings` name `vpbx_devices`, per tenant.**
Read live 2026-08-24 — quota vs. `ombu_mobile_devices` rows in use:

| Tenant | Quota | In use |
|---|---|---|
| A plus center | 2 | **2 (full)** |
| Secro Selutions | 2 | 1 |
| ADDB Builders | 3 | **3 (full)** |
| Luxure Management | 2 | 0 |
| Displaydex | 3 | **3 (full)** |
| **B Visible** | **3** | **3 (full)** |
| Solidify Concrete | 2 | 1 |
| Trust Bookkeepings | 4 | 2 |
| Landau Home | 1 | **1 (full)** |
| McNamara Lion | 1 | **1 (full)** |
| Relax Tires | 2 | 1 |
| Yossis Wood Worx | 6 | **6 (full)** |
| NY Garden Sprinkler | 1 | **1 (full)** |

⛔ A **blank** quota (Create A Box, Gesheft, Trimpro, Fixup Group, RSBK, and
every mirror-built tenant) is not zero — those tenants hold 0–2 mobile devices
and have never been refused.

**What happened here, in order:** B Visible was 2 of 3 before this work (its two
desk phones, devices 66 and 68). Adding 102's WebRTC device inherited the flag
and took it to **3 of 3**. Extension 104's add — which would also have inherited
`mobile_client=yes` from its own desk phone — was then refused as a 4th:

> **VPBX Connect Devices** — *"You are not allowed to add more than 3 mobile
> devices. Please, get in contact with your PBX provider."*

✅ **The fix that worked, and it is one pair:** post the same form with
`mobile_client` **omitted**. `dropPairs(pairs, …, "mobile_client")` → the panel
answered `state: success`, and device **1269** (`104_1`) came out in the correct
shape (`vitxi_client=yes, mobile_client=no`), consuming **no** quota slot.
⛔ A checkbox is unticked by OMITTING it — sending `mobile_client=no` TICKS it.

### ⛔ Fleet exposure — 16 extensions on 10 tenants, NOT fixed

These carry a `mobile_client=yes` device and have **no** WebRTC device yet, so
the next `addDevice` against them repeats this. On the tenants already at quota
(A plus center, ADDB, Displaydex, Yossis, McNamara Lion, NY Garden) it will
**fail**; elsewhere it will silently spend a slot:

A plus center 104 · ADDB 201/202/203 · Displaydex 102/104 · Gesheft 103 ·
Trimpro 101 · McNamara Lion 101 · Relax Tires 1003 · Yossis 101/103/104/105/107 ·
NY Garden Sprinkler 101.

⛔ **The durable fix is one line in `addDevice` — set `mobile_client` explicitly
off for the `webrtc` kind — and it was DELIBERATELY NOT MADE HERE.** That
function is on the onboarding path for every customer; changing it needs its own
blast-radius trace, a test, and a deploy. It is the obvious follow-up.

---

## 3. ⛔ `assertSaved` truncates the panel's refusal at 200 characters, and that cost a wrong diagnosis

`panelClient.ts:252` — `"unexpected response: " + r.text.slice(0, 200)`. The
JSON envelope is ~180 characters of boilerplate before `text`, so the message
arrives cut mid-word:

```
"title": "Extensions", "text": "You've reached the maximum number of al
```

That reads as the **12-extension free-tier cap** and is nothing of the sort — the
full string on the clone was *"…maximum number of allowed **VitalPBX Connect
devices**"*, and on production *"…more than 3 mobile devices."* Two different
caps, one truncated prefix. **Print `r.text` in full before believing which cap
you have hit.**

---

## 4. The clone rehearsal — what it proved, and where it misleads

`vpbx-clone` on loopcom carries a **byte-identical copy of PBX tenant 9**, same
path `2b9df1ace9927067`, right down to Lester's device 735. The shipped
`pbxTenantBuild.ts` / `panelClient.ts` were confirmed **sha256-identical** to
what `app-api-1` runs, so a pass there is a statement about the shipped path.

✅ **What it proved — the thing actually worth testing.** `addDevice` re-posts
the whole extension form, and the PBX Console handoff records that re-posting
rendered device fields can flip a desk phone's DTMF. It does not: the clone diff
after adding WebRTC devices to 101 (desk only), 105 (desk + virtual) and 107
(virtual only) showed **only the new rows** — every desk device still `rfc4733`,
every virtual device still carrying its exact forward number. Backed by a
fleet-wide census: **45 of 45** desk devices that have a WebRTC sibling are
still `rfc4733`. The clone was then restored **byte-identical**.

⛔ **Where it misleads: the clone is Community edition, which allows ZERO
VitalPBX Connect devices.** So on the clone, extensions 102 and 104 — the two
carrying `mobile_client=yes` — were refused, while production allowed 102 and
refused only 104. **A clone refusal on this path is not predictive of
production**, and a clone success is not a licence guarantee either. What the
clone is good for here is proving that neighbouring devices survive.

---

## 5. The Apply, and the three numbers it could have broken

One Apply Changes for the whole batch (`skipApply: true` on every add), fired
through **`applyAndRebake`**, which re-bakes every Connect-routed number on the
platform — not just the tenant being applied.

```
[APPLY_REBAKE] ... attempted:1 rebaked:1 linesChanged:0   (A plus center)
[APPLY_REBAKE] ... attempted:1 rebaked:1 linesChanged:0   (Connect Communications)
[APPLY_REBAKE] ... attempted:1 rebaked:1 linesChanged:0   (inii mini)
[PBX_CONSOLE] apply + doorway re-bake complete tenants:3 attempted:3 rebaked:3 linesChanged:0 failed:0
```

`linesChanged: 0` means the regen did not in fact wipe those renders this time —
the same measurement the 2026-08-17 run got. ⛔ **Do not turn that into a rule:**
the re-bake is cheap and the failure mode is a customer on dead air.

Doorway state before and after, identical: **T2 1/0 · T35 1/0 · T105 2/0**
(doorway Gosubs / `cc-` wipes).

Verified after: all 8 `T9_<ext>_1` endpoints rendered `(p12)` + `(p12-aor)` and
**loaded in Asterisk**; all five B Visible desk phones still `Avail` from the
office (47.17.126.158); Lester still registered through loopcom on the 443 route.
⛔ Ext **105's desk phone was already offline before this work started** and
still is — pre-existing, not caused here.

---

## 6. The four logins that had never been usable

⛔ This is the trap from §7 of `AGENT_HANDOFF_BVISIBLE_PH_EMPLOYEE_2026-08-17.md`
still sitting on the tenant: the April 2026 PBX sync created Connect users from
the CSV `email` column and **never invited them**. Read live before touching
anything:

| Ext | Email | status | forcePasswordReset | lastLoginAt |
|---|---|---|---|---|
| 101 | sales@bvisible.us | ACTIVE | false | **never** |
| 102 | printing@bvisible.us | ACTIVE | false | **never** |
| 103 | nechamyaweiss@gmail.com | ACTIVE | false | **never** |
| 104 | artwork@bvisible.us | ACTIVE | false | **never** |
| 111 | lt@bvisible.us | ACTIVE | false | 2026-08-20 |

`EmailJob` confirms it: the **only** `USER_INVITE` ever sent to this tenant was
Lester's, on 2026-08-17. Four accounts had existed for 4½ months, ACTIVE, with a
password hash nobody knows, and nobody had ever been told.

✅ All four invited — `USER_INVITE` **SENT**, *"Welcome to Loopcom — Create Your
Password"*, all four carrying the Android APK link, greeting by extension name.
Status is now INVITED + `forcePasswordReset: true`.

⛔⛔ **Why `resend-invite` was safe here and is NOT safe in general.** It does not
merely re-send: it writes `status: INVITED, forcePasswordReset: true`, so for a
user who has **set their own password** it destroys the password they use — the
recorded TYH Industries case. It is correct here precisely because
`lastLoginAt` is **null** on all four: there is no password to destroy.
**Check `lastLoginAt` before every resend.** Lester was excluded by Izzy's
instruction and he is exactly the account that would have been harmed.

---

## 7. ⏳ BLOCKED — three people have no email address anywhere

**105 Moshe Klein · 106 Gershon Felberboim · 107 Chesky Goldberger.**

They have a WebRTC device and are synced to Connect, but they have **no Connect
user, no `ombu_extensions.email`, and no `VoicemailEmailRecipient` row** — there
is no address on the platform to invite. Checked all three sources.

**To finish each one** (needs the address from Izzy):
`POST /admin/users` with `{ tenantId, extensionId, role, email, sendInvite: true }`
— pure Connect DB + email, no PBX. ⛔ It refuses an extension that already has an
owner (409 `extension_already_assigned`); these three have `ownerUserId` null, so
it will work.

---

## 8. Also true, not acted on

- ⛔ **B Visible's VitalPBX Connect quota is now full at 3/3**, and one of the
  three (device 1268) is spent on a Connect-app device that does not need it.
  Clearing `mobile_client` on 1268 would free it — but that device now has a live
  VitalPBX cloud registration (`cloud_id 28619`), so it should be unticked
  **through the panel**, which runs the vendor's own cleanup, not by a direct DB
  write. Not done: it changes nothing a customer can feel today.
- ⛔ Extensions **102 and 104 already had VitalPBX's own mobile client** before
  this work (devices 66 and 68). That is a different product from the Loopcom
  app and was left alone.
- ✅ The fleet-wide orphan check for the 2026-08-13 delete-crash shape
  (`mobile_client='yes'` with no `ombu_mobile_devices` row) is **empty** — this
  work did not create one; the panel wrote a proper record for 1268.
- ⚠️ Ext **105's desk phone is not registered** and was not before this work.
- ⚠️ B Visible's billing is a **flat $105 for extensions**, so none of this moves
  their bill — and per `AGENT_HANDOFF_BVISIBLE_PH_EMPLOYEE_2026-08-17.md` §6 the
  assistant's `reconcileBillingAfterAddition` would complain about that even
  though nothing is wrong.

---

## 9. ⏳ Acceptance test — NOT DONE

Nobody has signed into any of these seats and **no call has been answered on a
new softphone.** This is proven as: PBX rows, rendered `pjsip` config, endpoints
loaded in Asterisk, Connect rows reading `webrtcEnabled: true`, and four emails
recorded `SENT` — **not by a human using a phone.**

1. One of the four opens their invitation, sets a password, signs in.
2. Their softphone registers — check the **PBX**, not the app:
   `asterisk -rx "pjsip show contacts" | grep T9_1` should show a
   `T9_<ext>_1` contact `Avail`. B Visible is on the **443 route**, so the
   contact IP will be loopcom `45.14.194.179`, as Lester's is.
3. Ring that extension and answer it in the app.
4. ⛔ **The negatives that matter most:** the office desk phones must still ring
   and still be `Avail`, and **104's and 105's cell forwards (845-274-0395 /
   347-578-1951) must still ring** — those virtual devices sat in the form that
   was re-posted.

---

## 10. Rollback

Backups: `/root/bvisible-webrtc-20260824/prod-before.sql` (full dump of
`ombu_devices`, `ombu_pjsip_devices`, `ombu_virtual_devices`, `ombu_extensions`,
`ombu_extensions_vm`) and `devices-before.txt`.

The seven added devices are **1263–1269**. Removing them is
`delete from ombutel.ombu_pjsip_devices where device_id between 1263 and 1269;`
then the same on `ombu_devices` (and `ombu_mobile_devices` id 107 for 1268),
followed by an Apply through `applyAndRebake` — ⛔ never a bare `applyChanges`.
Nothing else was written on the PBX.

On the Connect side the sync is idempotent: re-running
`POST /pbx/extensions/sync {tenantId}` after a rollback returns the rows to
`webrtcEnabled: false`. The four invitations cannot be recalled; the accounts can
be returned to ACTIVE with `POST /admin/users/:id/enable` if that is ever wanted,
but they had no usable password before, so INVITED is strictly better.
