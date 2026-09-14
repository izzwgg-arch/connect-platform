# ⛔⛔ AGENT HANDOFF — a factory-reset Yealink gets its provisioning folder FROM THE OFFICE MACHINE now: a STANDING PnP listener in the desktop app + HTTPS to phones (2026-09-02, `ba20d717` → `c54a333f`, desktop 0.1.17-rc.8) — READ FIRST before touching `apps/desktop/src/phoneSetup/pnp*.ts`, `PnpResidentHost`, before widening `isLoopcomProvisioningUrl`, before adding a capability op, or for "the reset phone sits on Preparing"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_DESK_PHONE_SETUP_WIZARD_2026-08-21.md` §20**
(`ba20d717` on `feat/ivr-migration-takeover` — desktop + api + portal. ✅ **api DEPLOYED
and container-verified** (`.build-commit` = `ba20d717`, `set_provisioning` ×5 +
`provisioningUrlFor` ×2 grepped in the running routes file, 0 restarts, health 200 both
hostnames). ✅ **portal DEPLOYED and container-verified** (`.build-commit` = `ba20d717`, the driver chunk carries `set_provisioning` and the *Unplug this phone* hint, `dps-hintline` in the shipped CSS, 0 restarts, `/settings/desk-phones` 200 on both hostnames). ⛔ Both deploys ran through the bundle → bare mirror route (GitHub still 401s the server's `git-upload-pack`); origin restored to GitHub and the mirror removed afterwards. ✅ **Desktop `Connect-Setup-0.1.17-rc.7.exe` BUILT
and artifact-verified** (100,329,304 bytes, sha256 `7a622190fff8513c…`, `verify:icon`
OK, the packed asar carries `pnp.js` with the multicast group and `set_provisioning` in
the capability) — ⛔ **NOT installed on any machine and NOT published** (feed stays
0.1.16); like rc.5/rc.6 it also carries the unpublished remote-desktop, coworker-hands and
elevated-support work, so publishing is fleet-wide. Both are Izzy's call. No migration,
no PBX write, no env change.) Memory: [[yealink-pnp-hands-a-reset-phone-its-folder]].
Izzy, 2026-09-02: *"Build the desktop operation that writes the URL into the phone."*

- ⛔⛔ **SUPERSEDED THE SAME EVENING BY `c54a333f` (handoff §21) — READ THIS BULLET
  FIRST. The one-shot 90-second hand-off below was run live at A plus center and
  could not be automation: the office app talked to phones over PLAIN HTTP ONLY, and a
  factory-reset T53W on 96.87 answers ONLY on 443 (port 80 closed — current Yealink
  firmware ships with HTTP off), so the app's own restart never reached the phone; the
  whole job then rested on a person unplugging the phone inside a window somebody else
  had started.** Izzy: *"if you have to do all that on the user's computer, that's not
  automated … working efficiently, sustainably, hard, and to last all of the years to
  come."* Now: **(1) HTTPS to phones** — `requestWithSchemeFallback` retries a REFUSED
  plain-HTTP connection once over HTTPS (self-signed accepted, private-address fenced);
  ⛔ a TIMEOUT is never retried (the phone may already be restarting — the two
  "never retried inside the adapter" guards pin it). **(2) A STANDING listener,
  `apps/desktop/src/phoneSetup/pnpResident.ts`** — one socket on UDP 5060 armed with the
  tenant's folder + the customer's OWN phones' hardware addresses (from the PBX
  records), answering a listed phone once per boot, **wizard or no wizard: a reset
  phone is provisioned the moment it is plugged in.** ⛔ Listed MACs only; a SUBSCRIBE
  that does not name its MAC is never answered by the resident; a different folder
  (tenant switch) resets list and log. Ops `arm_pnp { url, macs[] }` / `disarm_pnp`
  (eight ops now); `set_provisioning` arms the resident, optionally restarts, waits ≤15 s.
  **(3) `GET /desk-phones/pnp-config`** hands the app `{ url, macs }`; **(4)
  `PnpResidentHost`** (portal, `providers.tsx`) arms the desktop FULL window on load +
  hourly, stops on a 403, disarms on sign-out. **(5) The wizard** restarts at most
  twice, says "Plug this phone in now … keeps listening after you close this window",
  and waits an HOUR before halting to Support (was 5 × 90 s). ⛔ **What stays a
  person's job, and why:** a reset Yealink on defaults asks AT THE PHONE before obeying
  a restart from an unlisted address — Yealink's own security default, not ours to
  defeat — so plugging the phone in is the one physical step, and it is now the only
  one. ⛔ Earlier fixes the same evening: `4d421587` (a refusal such as
  `unknown_operation` from an OLD app never spends an attempt and says "update
  Loopcom", not "could not listen") and `c10a2b00` (the interim wider budget).
  ✅ **api + portal DEPLOYED and container-verified 2026-09-02 (both `app-api-1` and `app-portal-1` `.build-commit` = `c54a333f`, `verify: container commit c54a333f2299 matches target`, 0 restarts each; `pnp-config` grepped in the running api routes; the shipped portal chunks carry `arm_pnp` and "Plug this phone in now"; health + `/settings/desk-phones` 200 on both hostnames).** ⛔ Both deploys ran through the bundle → bare mirror route (GitHub still 401s the server's `git-upload-pack`); origin restored to GitHub afterwards. ✅ **Desktop `Connect-Setup-0.1.17-rc.8.exe` BUILT and artifact-verified** (100,337,297 bytes, sha256 `a3b8387ccdf394b1…`, `verify:icon` OK, the packed asar is version 0.1.17-rc.8 and carries `pnpResident.js`, `arm_pnp` ×8 in the capability, `node:https` in mainWiring), staged at `https://app.loopcom.net/desktop/Connect-Setup-0.1.17-rc.8.exe` — ⛔ **NOT installed on the A plus center machine and NOT published (feed stays 0.1.16)**; like rc.5–rc.7 it carries the unpublished remote-desktop, coworker-hands and elevated-support work, so publishing is fleet-wide. Both are Izzy's call. No migration, no PBX write, no env change.

- ⛔⛔ **THE MECHANISM IS PnP, NOT THE WEB UI.** A reset Yealink multicasts a SIP
  `SUBSCRIBE` for `Event: ua-profile` to `224.0.1.75:5060` **once per boot** and obeys
  whoever answers with a `NOTIFY` carrying a URL (`application/url`) — no password, no
  login. The web interface needs a per-firmware-line encrypted login (unbuildable
  blind); the PBX cannot NOTIFY a phone that is not registered to it. So the OFFICE
  MACHINE answers: `apps/desktop/src/phoneSetup/pnp.ts` (`startPnpHandoff`) binds
  0.0.0.0:5060, joins the group on the interface that sits on the phone's network,
  answers 200 OK + NOTIFY, and the phone fetches `<folder><mac>.cfg` — the exact file
  the PBX already serves (`f3df739ac62197cd/805e0c4d796d.cfg` exists today).
- ⛔⛔ **LISTEN FIRST, THEN REBOOT — the order is the feature.** PnP fires once per boot,
  so the sixth capability op `set_provisioning { ip, mac, url, credentialRef?, reboot? }`
  resolves `listening` BEFORE it sends the Action-URI reboot (default `admin/admin` on a
  reset phone, or the stored password by reference). A responder started after the
  reboot misses a fast phone. A refused reboot is not a failure: attempts 3–5 are
  listen-only with the hint *"Unplug this phone's power … we are listening for it"*.
- ⛔⛔ **THE URL IS THE ONE URL-SHAPED ARGUMENT THE CAPABILITY HAS EVER ACCEPTED, AND IT
  IS FENCED TWICE.** `isLoopcomProvisioningUrl` (`yealink.ts`): https only, a Loopcom
  host (`connectcomunications.com` / `loopcom.net` + sub-domains; lookalikes refused),
  pathname exactly `/phoneprov/<16 hex>/`, no port/userinfo/query/fragment — checked in
  the capability before any socket exists AND inside the NOTIFY builder. The host list is
  a deliberate COPY of the api's `ourProvisioningHosts`: the desktop must not take its
  fence from the server it is fencing. **Never widen it** — a phone downloads its whole
  config, including SIP credentials, from that folder. ⛔ **Only the TARGET phone is
  answered** (by MAC when the SUBSCRIBE names one — so a phone that came back on a new
  DHCP address still counts — else by the address it was found at), **and only once**; a
  stranger's SUBSCRIBE gets nothing.
- ⛔ **The api hands the URL out with the decision, best-effort.** `advance` returns
  `provisioningUrl` beside `set_provisioning` (new optional dep `provisioningUrlFor`;
  default reads `ombu_tenants.path` through connect_read on the photos' origin —
  `PBX_PHONEPROV_BASE_URL`, else `PBX_PHONE_IMAGE_BASE`'s origin + `/phoneprov`; cached
  10 min **on a hit only**). No URL ⇒ the driver waits; never a wrong URL. On `delivered`
  the driver reports the folder through the EXISTING `/discovered` path, so `advance`
  reads `provisioningIsOurs` off the row and climbs to `trigger_autop` /
  `verify_registration` by itself.
- ⛔ **Restarts are bounded and the give-up is server-side.** Two restarts from the
  machine, listen-only to five, then the driver sends `provisioningHandoffFailed: true`
  and `advance` turns `set_provisioning` into a **halt → Loopcom Support** (*"We could not
  point this phone at Loopcom from your computer."*). ⛔ The shared ladder
  (`escalation.ts`) is UNTOUCHED on purpose — the exhaustive invariant suite enumerates
  every `PhoneCondition` field and a new one doubles a 12.6M-decision run; the one
  caller-observed fact is acted on in the route.
- ⚠️ **WINDOWS FIREWALL WILL PROMPT ON THE FIRST INBOUND LISTEN, and Allow needs an
  administrator on that machine.** Every earlier UDP use was reply traffic; binding
  5060 to receive multicast is new. The hint says so; a machine that cannot bind answers
  `cannot_listen` and the wizard says that in plain words. The per-user NSIS installer
  cannot add a firewall rule (no elevation) — if this bites in the field, an elevated
  firewall-rule step is the durable fix and is Izzy's call.
- ✅ **Proven:** desktop 219/219 (27 new in `pnp.test.ts` against a fake socket — the
  full SUBSCRIBE → 200 OK → NOTIFY → ack exchange, a phone recognised on a new address, a
  stranger never answered, answered once, listen-before-reboot ORDER, the URL fence
  sweep, cannot-bind, spacing); portal 49/49 (delivered → `/discovered`, no URL → nothing,
  bounded restarts → listen-only → give-up, cannot-listen wording); api 91/91 (URL on the
  decision, no URL on other decisions, the give-up halt, folder-URL hex/base rules).
  Typechecks desktop 0 / portal 0 / api 81 = baseline; all four new source guards fail
  replayed against HEAD.
- ⏳ **NOT PROVEN: NO YEALINK HAS SEEN IT.** Nothing here has run against a handset.
  Acceptance is the A plus center T53W (ext 103, `80:5E:0C:4D:79:6D`, 192.168.0.121):
  install rc.7 on that machine over AnyDesk → tick only that phone → the live row should
  read "restarting … where Loopcom is", then Ready once `T2_103` registers. The negatives
  that matter: the sibling T53W (already registered) is NEVER answered or restarted, and
  a Windows "Block" on the firewall prompt must read as "could not listen", not as a dead
  phone.
