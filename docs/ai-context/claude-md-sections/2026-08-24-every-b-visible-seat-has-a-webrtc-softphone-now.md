# ⛔⛔ AGENT HANDOFF — every B Visible seat has a WebRTC softphone now, and adding one SILENTLY SPENDS a VitalPBX Connect licence slot (2026-08-24) — READ FIRST before adding a WebRTC device to ANY existing extension, before believing a truncated panel refusal, or before resending an invitation

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_BVISIBLE_WEBRTC_FLEET_2026-08-24.md`**
(**7 WebRTC devices created on PBX tenant 9 under Izzy's explicit mandate, one
Apply Changes through `applyAndRebake`, one Connect extension sync, four
invitation emails.** No code change, no deploy, no migration, no env change.
Backups `/root/bvisible-webrtc-20260824/` on the PBX.)
Izzy, 2026-08-24: *"Does everybody have a WebRTC phone synced to connect? If not,
set up for everybody, sync them to connect, and send out an invitation email to
everybody except Lester."*

- ✅ **THE ANSWER WAS NO — only Lester (111) had one.** Now 101–107 and 111 all
  carry `T9_<ext>_1` (profile 12, rfc2833), rendered, loaded in Asterisk, and
  synced into Connect as `webrtcEnabled: true` / `pbxSipUsername <ext>_1` /
  `PROVISIONED`. ⛔ **108/109/110 were EXCLUDED on purpose — they are not
  people**, they are extensions whose only device is a `virtual` forward to an
  outside number, named after the extension they belong to ("102 V" → 845-304-9343).
  ⛔ **107 IS a person but has no handset** (Chesky Goldberger = a pure forward to
  845-248-3888); he got a device so the app is available to him.
- ⛔⛔ **THE FINDING THAT OUTLIVES THIS CUSTOMER: `addDevice` re-posts the whole
  extension form and NEVER sets `mobile_client`, so the new WebRTC device
  INHERITS it from the extension's existing device** — proven live, ext 104's
  form posted `mobile_client = "1"`. Two consequences: the device becomes a
  **VitalPBX Connect** mobile client (device 1268 got a real cloud account,
  `cloud_id 28619`, where every other WebRTC device on the platform — including
  Lester's proven-working 735 — is `mobile_client=no`), and it **spends a
  per-tenant licence slot**. ⛔ **The quota is `ombu_tenant_settings` name
  `vpbx_devices`.** B Visible's is **3**; it was 2 in use, my own 102 add took it
  to 3, and 104 was then refused as a 4th: *"You are not allowed to add more than
  3 mobile devices. Please, get in contact with your PBX provider."*
  ✅ **The fix is one pair: OMIT `mobile_client` from the post** (`dropPairs`) —
  the panel then answered `state: success` and 104's device came out correct and
  consumed no slot. ⛔ A checkbox is unticked by OMITTING it; `=no` TICKS it.
  ⛔ **16 extensions on 10 tenants are still exposed** (A plus center 104, ADDB
  201/202/203, Displaydex 102/104, Gesheft 103, Trimpro 101, McNamara Lion 101,
  Relax Tires 1003, Yossis 101/103/104/105/107, NY Garden 101) — and A plus
  center, ADDB, Displaydex, Yossis, McNamara Lion and NY Garden are **already at
  quota**, so an add there FAILS. **The durable fix is one line in `addDevice`
  and was deliberately NOT made** — it is on the onboarding path for every
  customer and needs its own trace, test and deploy.
- ⛔ **`assertSaved` truncates the panel's message at 200 chars
  (`panelClient.ts:252`), and the JSON envelope eats ~180 of them** — so the real
  refusal arrived as *"You've reached the maximum number of al"* and reads like
  the 12-extension free-tier cap. It is not: the clone said *"…allowed VitalPBX
  Connect devices"* and production said *"…more than 3 mobile devices."* **Print
  `r.text` in full before believing which cap you hit** — this cost a wrong
  diagnosis.
- ✅ **REHEARSED ON THE CLONE FIRST, and it earned its keep.** `vpbx-clone` holds
  a **byte-identical copy of tenant 9** (same path `2b9df1ace9927067`), and the
  shipped `pbxTenantBuild.ts`/`panelClient.ts` were confirmed **sha256-identical**
  to what `app-api-1` runs. It proved the real risk was absent: adding a WebRTC
  device to extensions with a desk device, a desk+virtual pair, and a
  virtual-only extension moved **only the new rows** — no desk DTMF flipped, no
  virtual forward number lost (fleet census: **45 of 45** desk devices with a
  WebRTC sibling are still `rfc4733`). Clone restored byte-identical afterwards.
  ⛔ **But the clone is Community edition, which allows ZERO Connect devices**, so
  it refused BOTH `mobile_client=yes` extensions while production refused only
  one. **A clone refusal on this path is not predictive of production.**
- ✅ **The Apply was fired ONCE for the batch through `applyAndRebake`** (every
  add ran `skipApply: true`): all three Connect-routed numbers re-baked,
  `linesChanged: 0`, `failed: 0`, and the doorway state is byte-identical before
  and after — **T2 1/0 · T35 1/0 · T105 2/0**. All five B Visible desk phones
  stayed `Avail` throughout; Lester stayed registered. ⛔ Ext 105's desk phone was
  already offline before this work and still is.
- ⛔⛔ **FOUR LOGINS HAD NEVER BEEN USABLE, and this is the April-sync trap from
  the 2026-08-17 handoff §7 still sitting on the tenant.** `sales@`, `printing@`,
  `nechamyaweiss@`, `artwork@` were created 2026-04-06 by the PBX sync, left
  **ACTIVE with a password hash nobody knows, `forcePasswordReset: false`, and
  never invited** — the only `USER_INVITE` this tenant ever received was
  Lester's. All four are now invited (**SENT**, with the APK link, greeting by
  extension name). ⛔⛔ **`resend-invite` writes `status: INVITED,
  forcePasswordReset: true`, so on a user who HAS set a password it destroys the
  one they use (the TYH case). It was safe here only because `lastLoginAt` is
  NULL on all four — CHECK THAT FIELD BEFORE EVERY RESEND.** Lester was excluded
  by Izzy's instruction and is exactly the account a resend would have harmed.
- ⏳ **BLOCKED, needs Izzy: 105 Moshe Klein, 106 Gershon Felberboim and 107
  Chesky Goldberger have NO email address anywhere** — no Connect user, no
  `ombu_extensions.email`, no `VoicemailEmailRecipient`. They have working WebRTC
  devices and are synced; they simply cannot be invited. One
  `POST /admin/users {tenantId, extensionId, role, email, sendInvite: true}` each
  finishes them once he supplies addresses.
- ⏳ **NOT PROVEN: nobody has signed in and no call has been answered on a new
  softphone.** Proven as PBX rows, rendered pjsip, endpoints loaded in Asterisk,
  Connect rows and four `SENT` emails — never by a human on a phone. ⛔ The
  negatives that matter most: the office desk phones must still ring, and **104's
  and 105's cell forwards (845-274-0395 / 347-578-1951) must still ring** — those
  virtual devices sat in the form that was re-posted.
