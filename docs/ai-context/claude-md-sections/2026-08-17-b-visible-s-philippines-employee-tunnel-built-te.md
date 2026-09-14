# ⛔ AGENT HANDOFF — B Visible's Philippines employee: tunnel built, tenant moved to 443, extension NOT created (2026-08-17) — READ FIRST before adding a WireGuard peer, before assuming an address is geo-blocked, before quoting what an extra extension costs a customer, or before reading a "V" extension as a free slot

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_BVISIBLE_PH_EMPLOYEE_2026-08-17.md`**
(**Two live changes: two WireGuard peers on loopcom, and ONE Connect DB row.**
No PBX write, no deploy, no code change. ⏳ **The extension itself is NOT
created** — blocked on the employee's name and email.)

- ⛔ **107 AND 108 WERE BOTH TAKEN, and every "V" extension is a FORWARD, not a
  free slot.** Izzy asked for 107, then 108. T9 holds **101–110**: 101–106 are
  real phones, while **107 "Chesky Goldberger", 108 "102 V", 109 "104 V" and
  110 "101 V" are `technology=virtual` devices that ring an EXTERNAL number.**
  Deleting 108 would stop extension 102 ringing that outside phone. ⛔ 107 has
  **no pjsip device and no AOR**, so "no contact for 107" is normal, not a fault.
  **Decision: 111** (Izzy, 2026-08-17).
- ⛔⛔ **THE BLACKLIST TEST ALONE GIVES THE WRONG ANSWER — READ THE CHAIN ORDER.**
  `blacklist_ph` is real (1,628 entries, **77,886 packets dropped**), so a
  Philippine device genuinely cannot reach the PBX. But **loopcom
  (45.14.194.179) is ALSO in `blacklist_fr`** — the Connect server is in France —
  and it works anyway because `INPUT_direct` runs **`vpbx_white_list` BEFORE
  `geo_firewall`**. Testing an ipset without checking what precedes it reads as
  "our own server is blocked."
  ⛔ **The whitelist already holds four PH residential IPs** (`120.28.184.152`,
  `120.28.184.186`, `49.147.38.234`, `143.44.196.225`) — somebody has been
  hand-allowlisting a home address, which is exactly what the tunnel replaces —
  and the ipset is **`maxelem 31`, 15 used**. It cannot absorb that forever.
- ✅ **WireGuard peers BUILT AND LIVE**: computer `10.88.0.6`, phone
  `10.88.0.7`, configs + QR in `/root/wg-peers/bvisible-ph-*`, script
  `provision-bvisible-ph.sh` (refuses to run twice, backs up first, never touches
  an existing peer). ⛔ `SaveConfig=false`, so **both** the live `wg set` and the
  `[Peer]` block in `wg0.conf` are mandatory — a live-only peer vanishes on
  reboot. ⏳ **Nobody has connected with either config.**
- ✅ **B VISIBLE MOVED ONTO THE 443 ROUTE** (`webrtcRouteViaSbc` false→**true**,
  `sipWsUrl` →**null**; `sipDomain` was already the hostname so this was two
  fields, not three). ⛔ **This matters MORE than the tunnel**: the earlier
  Philippines employee's peers last handshook **4 and 5 days ago**, and a phone
  that must ring cannot depend on a user keeping a VPN up. The 443 route needs
  nothing installed. Doorway verified `101 Switching Protocols` **from loopcom**
  before flipping (⛔ plain curl returns 426 — wrong test; ⛔ Izzy's own line 403s
  the `app.` hostname). Read live per request — no deploy. ⛔ Desk phones
  unaffected; existing app users stay on 8089 until they **sign out and back in**.
- ⛔⛔ **ADDING THIS EXTENSION WILL NOT MOVE THEIR BILL — the normal rule is
  INVERTED here.** `metadata.billingFlatRate` is `{enabled:true,
  appliesTo:"extensions", amountCents:10500}`, and `buildExtensionInvoiceLine`
  returns **one $105 line, quantity 1**, however many extensions exist. Last two
  invoices **$140.00 PAID**, autopay on. **So the assistant's
  `action.add_extension` reconciliation — which refuses to report success unless
  the monthly total RISES — will complain on this tenant even though nothing is
  wrong.** Check for a flat rate before quoting any customer a per-extension price.
- ⛔⛔ **`POST /pbx/extensions` CANNOT CREATE AN EXTENSION ON THIS PBX — DO NOT
  DRIVE IT.** It was one command from being run on a live customer. **0
  `PBX_EXTENSION_CREATED` and 0 `PBX_EXTENSION_QUEUED` audit rows exist
  platform-wide** — it has never worked here. It POSTs `<baseUrl>/extensions`
  against **VitalPBX**, whose own client in this repo throws **`NOT_SUPPORTED` —
  "VitalPBX public docs do not expose extension create endpoint"**
  (`vitalpbx/client.ts:550`). ⛔ **The failure is the expensive part:** the route
  creates the **Connect Extension row FIRST** (`server.ts:9642`), then calls the
  PBX in a `try` — so a failure answers **202** and leaves a row that is
  **billable and in the directory for a line that does not exist**, plus a job
  retrying forever. ⛔ **The portal has no create button at all** (Extensions
  offers only assign / set-sip-password / sync), and **the agent's
  `action.add_extension` capability is built on this same route**, so it cannot
  work here either.
  ✅ **BUT THE PANEL PATH IS WIRED IN AND IT IS NOW A FUNCTION.** ⛔ Izzy had to
  correct this session: I checked only `/opt/connect-robot/provision-tenant.js`
  (whole-tenant only) and declared it manual, without looking at
  **`apps/api/src/onboarding/pbxTenantBuild.ts`**, which creates extensions
  through the panel in production for every onboarded customer. **Check the api's
  own onboarding code before declaring a PBX operation manual.**
  New export **`addExtensionToTenant(session, tenantPath, person, log)`** —
  extracted from `buildPbxTenant`'s per-person loop, which now CALLS it, so there
  is exactly one implementation (⛔ do not fork a second). Idempotent: adopts an
  existing extension, skips a device already present. 5 new tests, 33 pass / 0
  fail. **Proven live twice**: ext **199 "Claude Test"** on *Ezra stress test 1*
  (a throwaway, tested FIRST — it is still there), then **111 "Lester Tan"** on
  B Visible; both with PJSIP + WebRTC devices and rendered `[T9_111]` /
  `[T9_111_1]`, and all five existing B Visible phones still `Avail` after.
- ⛔⛔ **THE PBX SYNC SILENTLY CREATES A LOGIN NOBODY CAN USE.** Because the CSV
  carried `email`, `POST /pbx/extensions/sync` **created the Connect `User`
  itself** and made it the extension's owner — **`status: ACTIVE`, a password
  hash nobody knows, `forcePasswordReset: false`, no name, and NO invitation
  email.** The person has an account they cannot sign into and were never told
  about, and `POST /admin/users` then answers **409 `extension_already_assigned`**,
  which reads like a broken flow when it has actually already half-run.
  ✅ **Finish it with the real routes** (SUPER_ADMIN service token, the
  `injectAsService` pattern): `PATCH /admin/users/:id` for the name →
  **`POST /admin/users/:id/resend-invite`** (queues the real welcome email and
  sets INVITED + forcePasswordReset) → ⛔ **`POST /admin/users/:id/phone/provision`**,
  which is needed *because* the sync made the user: the "mark PROVISIONED if the
  link already has a SIP password" snapshot lives in `POST /admin/users`, the
  path that was refused, so the link sits **PENDING with a perfectly good
  password**. That route only flips the status and **never resets the extension
  password**, so live desk phones are safe.
- ⛔ **APPLY CHANGES FOR B VISIBLE WOULD BRIEFLY BREAK THREE OTHER CUSTOMERS.**
  It flushes pending changes for other tenants too, and VitalPBX cannot render the
  Connect doorway. B Visible itself is safe (**no Connect-mode routes**), but
  **A plus center (845-782-3064), Connect Communications (845-723-1213) and inii
  mini (646-984-6023)** are the platform's only Connect-mode numbers and would go
  to dead air. `rebakeConnectRoutesAfterRegen` only covers applies **Connect**
  fires (`POST /voice/forwards`); a human pressing the panel button gets the
  reconciler, so expect **up to ~10 minutes**. Bounded (no longer rate-limited),
  but do it outside business hours.
- ✅ **DONE for Lester Tan (`lt@bvisible.us`, iPhone): extension 111 is live**,
  his login is created and named, the invitation **`USER_INVITE` is SENT**
  (*"Welcome to Loopcom — Create Your Password"*, 21:06:49Z), his softphone is
  **PROVISIONED** (`T9_111_1`), and he is **INVITED** on TestFlight group
  **"Loopcom Testers"** `fe508ee6-4a3f-49dd-bf53-858839fa2f06` with build **52**
  attached — Apple sends that mail itself, so adding the tester IS the whole job.
  ⛔ Ask Apple which builds a group has the right way round:
  `GET /v1/builds?filter[betaGroups]={id}` — `GET /v1/betaGroups/{id}/builds`
  answers **empty even when builds are attached**.
- ⏳ **NOT PROVEN: nobody has signed in as Lester and no call has touched 111.**
  `T9_111` has no contact yet, which is correct — nothing has registered. ⛔ **Try
  him with WireGuard OFF first**: that is the real test of the 443 route, which
  has never been exercised from the Philippines.
- ⛔ **105, 106 and 107 still have NO Connect user** (`ownerUserId: null`) — those
  extensions carry no email on the PBX, which is exactly why the sync never
  invented users for them. "Add an extension" here has historically meant a PBX
  line with no app login.
- ⏳ **The agent's `action.add_extension` still points at the broken route.**
  Repointing it at `addExtensionToTenant` is the obvious follow-up and was NOT
  done. ⏳ Test extension **199 "Claude Test"** is still on *Ezra stress test 1* —
  left deliberately, since deleting an extension has its own fatal-crash trap.
- ⏳ **Housekeeping, not acted on:** Gesheft's Brazil peer `10.88.0.5` was flagged
  "revoke on return" on 2026-08-02 and has **never handshaken** — needs Izzy's
  word. And the earlier PH employee (`.3`/`.4`) is on a stale tunnel; **which
  tenant they belong to was never established.**
