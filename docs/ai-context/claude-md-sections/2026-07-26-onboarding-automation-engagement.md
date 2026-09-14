# AGENT HANDOFF — Onboarding automation engagement (2026-07-26 → 07-28)

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


The full handoff for the automated onboarding work (wizard → VoIP.ms number +
subaccount → VitalPBX tenant build → Connect sync → invite emails, plus the
stress-test wipe procedure) is committed at
**`docs/ai-context/AGENT_HANDOFF_ONBOARDING_AUTOMATION.md`** on branch
`feat/ai-agent`. Read it before touching `apps/api/src/onboarding/`, the
portal wizard, or before wiping test tenants.

Session-critical facts (details + evidence in the handoff doc):
- **Deploys ship from branch `feat/ai-agent`**, via
  `bash scripts/deploy-direct.sh api|portal --branch feat/ai-agent` on loopcom.
  Always verify the container commit afterwards.
- Live gates `VOIPMS_AUTO_PROVISION=on` / `ONBOARDING_PBX_AUTO_SETUP=on` are
  wired in `docker-compose.app.yml`; unset = silent dry-run (statuses
  `ready_dryrun` / `dry_run_done`).
- **VitalPBX panel deletes are TWO-STEP** (delete → re-POST the confirmation
  form's hidden inputs, `mode:"deleteConfirmed"`) and must be verified by
  re-listing — the single-step call "succeeds" without deleting (two earlier
  wipes left every trunk/route/ARS behind because of this). Reference
  implementation: `scripts/onboarding/_wipe-round2.mts`. Order: tenants
  (REST) → ars → trunk_group → trunks. REST `deleteTenant` may exceed 20 s —
  poll for absence on timeout.
- **VoIP.ms**: `setSubAccount` is a full update (partial `{id,password}`
  fails); `createSubAccount` `used_username` self-heals by reusing (commit
  `db4453f8`); subaccounts are `344022_<name>` — suffix-match, never prefix
  with the API login email; `device_type 1` = Asterisk (correct), `2` = IP
  phone (wrong); outages return Cloudflare 521/522 HTML — retry with backoff.
- ⛔ **VoIP.ms's WRITE path degrades on its own — healthy reads prove nothing**
  (handoff §10). 2026-08-05: every `setSubAccount` timed out for ~57 min while
  `getServersInfo` answered in 2 s. Worse, our retry re-entered that exact
  call: credentials were persisted only at the END of the number stage, so a
  later failure discarded a SUCCESSFUL password rotation and the next attempt
  rotated again — 4 watchdog attempts, 4 timeouts, 90 min of a paid customer
  with no phone. Fixed `b20fad30`: stored creds are reused first, a successful
  create/rotate is persisted immediately, and both subaccount writes get 120 s
  (the rotation that worked took **48 s**; aborting the request does NOT cancel
  VoIP.ms's operation). **General rule: a resumable stage persists each
  irreversible success the moment it happens, never at the end.** A stalled
  paid sign-up should be re-kicked via
  `POST /admin/onboarding/submissions/:id/retry-setup` (idempotent) rather than
  waiting out the watchdog's ~16-min spacing.
- ⛔ **Porting is LIVE and irreversible, and its parameters are only ever proven
  by a real filing (handoff §9).** First success 2026-08-05: **port order
  217760** (inii mini, Verizon), accepted 37 min after the api deploy that
  fixed the parameter names. `addLNPPort` takes the WSDL's `addLNPPortInput`
  set — `portType`/`numbers`/`isPartial`/`locationType`/`isMobile`/`pin`/`btn`/
  `services`/`tfType`/`statementName`/`firstName`/`lastName`/`address1`/`city`/
  `state`/`zip`/`country`/`providerName`/`providerAccount`/`notes` — and the
  old invented `did`/`carrier`/`account_number` names were rejected `invalid`
  on every attempt (rewritten in `ce54e40d`, `buildLnpPortParams()`). It
  answers `{"status":"success","port":N}`: we read `portid`/`port_id`, so the
  id stored `""` and the LOA/bill would have attached to an EMPTY order —
  nothing threw, because `vms()` checks only `status` (fixed `e98dad78`). The
  five integer codes in `LNP_CODES` are validated for a **local + mobile full
  port ONLY**; toll-free, partial and landline shapes are still guesses.
  `addLNPFile` is `{portid, file}` and nothing else.
- ⛔ **The wizard's port step collects the service address as FOUR fields** —
  street (`serviceAddress`), `serviceCity`, 2-letter `serviceState`, 5-digit
  `serviceZip` — plus an **`isMobile`** checkbox, which also makes the transfer
  PIN required. Never collapse them back into one box: `addLNPPort` takes them
  separately and the losing carrier matches each against the CSR. Drafts saved
  before 2026-08-06 still hold one free-text line, so `buildLnpPortParams()`
  falls back to `parseServiceAddressLine()` and passes the customer's original
  text through in `notes`. ⛔ That fallback is unit-tested only and has NEVER
  been filed — 217760's fields were hand-corrected into the structured shape
  first (recorded on the submission as
  `answers.provisioning.portFiledManuallyBy`).
- ⛔ **Never probe this API by submitting `addLNPPort`** — a complete request
  files a REAL port order against a REAL customer's number at a REAL carrier.
  Exercise parameter changes through the test suite's fake VoIP.ms, which now
  returns the real `{status, port}` shape.
- Test numbers are pre-owned STOCK: wipes re-route DIDs to `account:344022`,
  never cancel them. Spare DIDs show first in the wizard ("Ready now");
  the search cache holds only the purchasable list, spares always fresh.
- Reusable stress-test link token: `stress-WBcv2eWu8GzxdIIP2glmd6O2`
  (`/onboarding/test/<token>` spawns a fresh run). Invites only go out for
  emails never used anywhere on the platform (global uniqueness).
- Ezra's test IP `173.212.214.198` is allowlisted in
  `/etc/nginx/connectcomms/allowlist.conf` (nginx auto-ban hit it mid-test).
- **Toll-free & vanity numbers (2026-08-04, `73f990a0` — handoff §8)**: the
  wizard's number step sells `local | tollfree | vanity` (stored as
  `answers.phone.numberKind`); toll-free/vanity = $15/mo
  (`tollFreeNumberMonthlyCents`), first-number-free applies to LOCAL only,
  purchase branches to `orderTollFree`/`orderVanity`. ⛔ The month-2 $15 is
  stamped as a FLAT `customFee` — never "fix" it to `per_toll_free_did`
  (that basis counts phoneNumber rows onboarding never writes → bills $0).
  Taken-meanwhile replacements stay the same kind; port temp numbers skip
  toll-free spares.
- In THIS Cursor environment ssh/scp run directly from PowerShell (keys in
  `C:\Users\izzyw\.ssh\`); server scripts run via scp → `docker cp` →
  `tsx` inside `app-api-1`; DB one-liners pipe JS into
  `docker exec -i -w /app/packages/db app-api-1 node -`.
