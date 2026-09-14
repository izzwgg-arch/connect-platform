# ⛔⛔ NEW TENANTS DEFAULT TO SIP-OVER-443, AND AN EMAIL CAN CARRY A FILE (2026-08-17) — READ FIRST before touching `webrtcRouteViaSbc`, the WebRTC bootstrap stamp, or before saying Connect cannot attach a file

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Commits `66dbaa9c` (attachments) + `8495d379` (443 default) on
`feat/ivr-migration-takeover`. ✅ **DEPLOYED and container-verified 2026-08-17**
(job `92a145f9`, container `f4dd8edd`), **both migrations applied**
(`20260817220000_email_job_attachments` 21:52Z,
`20260817230000_default_sip_route_via_443` 22:07Z).

✅ **Verified against the live database, not just the container:** the column
default really is `true` in `information_schema`, `EmailJob.attachments` is
`jsonb DEFAULT '[]'`, and — the check that mattered — **29 live tenants, still
exactly 5 on 443** (Loopcom Demo, inii mini, Gesheft, B Visible, Displaydex).
**No existing customer moved**, and **0 tenants on 443 carry an explicit
`sipWsUrl`**, which is the invariant the whole thing rests on.

- ✅ **`Tenant.webrtcRouteViaSbc` now `@default(true)`** (Izzy, 2026-08-17:
  *"every new phone that's created in the Connect web app and soft phone, by
  default, will go on 443 and that's it"*). ⛔ **The schema default is the lever
  on purpose** — five code paths create a tenant, and hooking each is exactly how
  the two IVR publish paths and the two SMS ingest paths shipped half-broken.
  ⛔ **Existing tenants are NOT migrated** — `SET DEFAULT` touches new rows only,
  and moving a live tenant makes its users sign out and back in before the app
  picks up the new address. **24 of 29 are still on 8089.**
- ⛔⛔ **THE DEFAULT ALONE DOES NOTHING, AND IT NEARLY SHIPPED THAT WAY.**
  `resolveWebrtcConfig` prefers a non-null `sipWsUrl` **over** the flag, and TWO
  bootstrap paths stamped the direct endpoint onto any tenant that had none
  (`pbxExtensionSync.ts` ~628, `server.ts` ~9520, both gated on
  `!webrtcEnabled`). **`PBX_WS_ENDPOINT` IS set in production**
  (`wss://209.145.60.79:8089/ws`) — so every brand-new tenant would have been
  stamped on its first extension sync and dialled the PBX direct **while the flag
  read true**. Both paths now skip that write for 443 tenants.
  `sipRouteDefault.test.ts` reads the schema AND both call sites; a unit test of
  any one function passes straight through this.
- ✅ **PROVEN BEFORE IT WAS MADE THE DEFAULT.** Lester Tan (B Visible ext 111)
  registered **from the Philippines** at 21:33Z over 443 —
  `T9_111_1/sip:…@45.14.194.179` is loopcom, so the PBX sees our whitelisted
  address and `blacklist_ph` never applies — while **both WireGuard peers built
  for him have never handshaken once**. ⛔ So a tunnel is now the FALLBACK, not
  the answer: the earlier Philippines peers date from **2026-07-29**, a week
  before the 443 route existed at all, which is the only reason they were needed.
- ✅ **AN EMAIL CAN CARRY A FILE NOW** — `EmailJob.attachments` +
  `queueEmailWithAttachments()` (`apps/api/src/emailAttachments.ts`).
  ⛔ **Correction to a claim made earlier in that session: the pipeline could
  already attach things**, just only ones it derived itself (invoice PDF,
  voicemail recording). What was missing was "send THIS file". **Both send paths
  (SendGrid + SMTP) must carry it** — the guard test reads `server.ts`'s source
  for two call sites, because that is the shape of every attachment bug here.
  ⛔ **Bytes live in the row as base64, never on disk** — a path needs a mounted
  volume in BOTH api compose blocks and getting it wrong is silent data loss at
  the next deploy. Hence caps: 5 files, 2 MB each, 5 MB total, refused **when the
  job is created** so a bad attachment is a loud error, not a 2am retry loop.
  ⛔ **A declared attachment that will not decode FAILS the send** — the derived
  loaders swallow errors because a PDF can be regenerated; these ARE the point of
  the email.
- ⏳ **NOT PROVEN: no tenant has been created since the deploy.** The acceptance
  test is one sign-up — confirm the new tenant reads `webrtcRouteViaSbc: true`
  **and that `sipWsUrl` is still null after its first extension sync.** ⛔ The
  null is the half that proves the guard; the flag on its own proves nothing.
  ⏳ **No email has been sent with an attachment yet** either — the plumbing is
  live, nothing has used it. ⛔ **Nothing was emailed to Lester**: he does not
  need WireGuard (Izzy, 2026-08-17), so his two peers sit unused as a spare key.
- ⚠️ **Lester's phone unregistered at 22:04–22:05Z, inside the deploy window,
  and had not come back 10 minutes later.** Reported honestly rather than
  waved off — but the api is **not** in the SIP path (phone → nginx `/sip` →
  PBX), and **five other app users were registered through the same 443 route
  throughout and stayed `Avail`** (T7_102_1, T8_101_1 ×3, T8_114_1), as did all
  five B Visible desk phones. His contact had also already rotated once
  (`r9iq2eaq` → `h4rjv962`), which is ordinary re-registration. Most likely he
  closed the app — it was ~06:05 local. **The check is whether he registers
  again next time he opens it.**
