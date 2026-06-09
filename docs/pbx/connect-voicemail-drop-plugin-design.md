# Connect CRM Voicemail Drop — PBX plugin design

> Source of truth: the PBX repo snapshot in `docs/pbx-brain/` (extracted
> 2026-06-09, `pbx-full-brain-20260609-063057`). **No live PBX was touched** to
> produce this design. Install is a manual, human-approved step (AGENTS.md).

## 1. Problem recap (why the current feature can't work)

`POST /crm/voicemail-drops/drop` pushes the WAV to the PBX (works), then calls
telephony `play-prompt` → ARI `POST /ari/channels/{id}/play`. ARI media playback
requires the channel to be inside a **registered Stasis app**. Connect's
telephony ARI client is REST-only and never registers/joins a Stasis app, so
`GET /ari/applications` == `[]` and live dialplan channels are never in Stasis →
the play call returns `409` (`pbx_playback_failed`). DB proof: `usageCount = 0`,
zero `VOICEMAIL_DROP` timeline rows ever. (Full root cause: `TELEPHONY.md`.)

Note from the snapshot: `res_ari_events.so` (ARI WebSocket) **is** loaded on the
box (`asterisk-cli/modules.txt`), so the limitation is purely that *Connect's
client doesn't open the WS / register a Stasis app* — not a missing module.
Re-architecting telephony into a live Stasis media app is a large, high-risk
change; the AMI→dialplan path below matches every existing Connect overlay and
is the low-risk route.

## 2. PBX repo files inspected

Architecture/docs:
- `docs/pbx-brain/PBX_ARCHITECTURE.md`
- `docs/pbx-brain/VITALPBX_STRUCTURE.md`
- `docs/pbx-brain/TENANT_MODEL.md`
- `docs/pbx-brain/CONNECT_INTEGRATION_POINTS.md`

Extracted Asterisk config + CLI (`docs/pbx-brain/extracted-useful/pbx-full-brain-20260609-063057/` and the mirror under `docs/pbx-brain/etc-asterisk/`, `docs/pbx-brain/asterisk-cli/`):
- `etc-asterisk/asterisk/extensions.conf` — top-level include chain
- `etc-asterisk/asterisk/extensions__60_custom.conf` — Connect overlay (tail shows the MOH sentinel include pattern)
- `etc-asterisk/asterisk/extensions__65_connect_tenant_moh.conf` — Connect MOH overlay (header/pattern)
- `etc-asterisk/asterisk/vitalpbx/extensions__95-connect-vm-greeting.conf` — existing Connect-owned, wildcard-loaded overlay (the precedent we mirror)
- `etc-asterisk/asterisk/vitalpbx/pjsip__50-1-trunks.conf` … `pjsip__50-32-trunks.conf` — trunk endpoint naming (`<digits>_<name>`)
- `asterisk-cli/dialplan-show.txt` — loaded Connect contexts + Dial() channel shapes
- `asterisk-cli/modules.txt` — `app_amd.so`, `app_waitforsilence.so`, `res_ari*` all `Running`
- `asterisk-cli/ami-users.txt`, `ari-users.txt` — `connectcommsgefenu` (AMI), `connectcomms` (ARI)
- `services/asterisk-status.txt` — live `T<id>_<ext>` endpoint names

Connect installer reference:
- `scripts/pbx/install-connect-tenant-moh-dialplan.sh` — the proven idempotent install/check/rollback pattern this plugin's installer is modeled on.

Searched for an existing `[connect-vm-drop]` (or similar) context: **none exists**
(the only matches were the unrelated `connect-vm-greeting` recorder).

## 3. Exact include point for additive dialplan

**Primary (recommended):**
```
/etc/asterisk/vitalpbx/extensions__96-connect-vm-drop.conf
```
auto-loaded by `extensions.conf` line 1: `#include vitalpbx/extensions__*.conf`.
This is exactly how the existing `extensions__95-connect-vm-greeting.conf` (also
Connect-owned) is loaded. `__96` is uniquely named and above VitalPBX's
generated `__20`/`__50` range, so VitalPBX regeneration never collides.

**Fallback (only if a host doesn't honor the wildcard include):** append one
sentinel line to the already-loaded Connect overlay `/etc/asterisk/extensions__60_custom.conf`:
```
#include extensions__96-connect-vm-drop.conf
```
This mirrors what `install-connect-tenant-moh-dialplan.sh` does for `__65`. The
installer tries primary first, verifies, and only bridges if needed.

No existing VitalPBX-generated file is ever edited.

## 4. Safest context name

`[connect-vm-drop]` — `connect-` namespace prefix (matches every other Connect
context: `connect-tenant-router`, `connect-entry`, `connect-vm-greeting-*`),
unique, additive. Verified absent in the snapshot.

## 5. Channel identification strategy

From the snapshot, channel names are:
- **Agent / extension leg:** `PJSIP/T<tenantId>_<ext>-<hex>` (e.g. `PJSIP/T3_302-00000a93`).
- **Customer / PSTN trunk leg:** `PJSIP/<trunkDigits>_<name>-<hex>` (trunk endpoints are `<digits>_<name>`, e.g. `PJSIP/344022_Vaddb-00000a93`).
- `Local/…` and `Message/…` are plumbing, never targets.

Strategy (implemented as a pure, unit-tested helper
`apps/telephony/src/routes/voicemailDropLegs.ts` → `classifyVoicemailDropLegs`):
1. Drop `Local/`/`Message/` channels.
2. **Customer leg** = first `PJSIP/<digits>_…` trunk; else the first playable
   channel that is not the agent leg.
3. **Agent leg** = the `PJSIP/T<id>_<ext>…` endpoint; when the dialer passes the
   initiating agent's endpoint hint (`T3_302` or full channel name), that match
   wins and is never chosen as the customer leg (protects internal
   ext-to-ext calls).

Connect then: AMI `Setvar VMDROP_FILE` on the **customer leg**, AMI `Redirect`
the **customer leg** into `connect-vm-drop,s,1`, AMI `Hangup` the **agent leg**.
The redirect target channel is the channel **name** (AMI `Redirect`'s `Channel`
field), which the telephony `CallStateStore` already tracks per call.

## 6. Worker / install artifact path

- Installer: `scripts/pbx/install-connect-vm-drop-dialplan.sh`
  (`install` default, `--check`, `--dry-run`, `--rollback`, `--help`).
- Exact dialplan (review copy): `docs/pbx/connect-voicemail-drop-context.conf`
  (identical to the body the installer writes).
- Pure leg classifier + tests: `apps/telephony/src/routes/voicemailDropLegs.ts`,
  `…/voicemailDropLegs.test.ts`.

## 7. Exact install command (for later, manual, human-approved)

```bash
# Copy the installer to the PBX host, then as root:
chmod +x install-connect-vm-drop-dialplan.sh
sudo ./install-connect-vm-drop-dialplan.sh --dry-run     # review (writes nothing)
sudo ./install-connect-vm-drop-dialplan.sh               # install + reload + verify
sudo ./install-connect-vm-drop-dialplan.sh --check       # read-only health check
```
The installer writes `/etc/asterisk/vitalpbx/extensions__96-connect-vm-drop.conf`,
runs `asterisk -rx "dialplan reload"`, verifies `dialplan show connect-vm-drop`,
and restores its backup + aborts on failure.

## 8. Rollback command

```bash
sudo ./install-connect-vm-drop-dialplan.sh --rollback
# manual equivalent:
sed -i '/^#include extensions__96-connect-vm-drop\.conf$/d' /etc/asterisk/extensions__60_custom.conf
rm -f /etc/asterisk/vitalpbx/extensions__96-connect-vm-drop.conf
asterisk -rx "dialplan reload"
```
Removes only Connect-owned artifacts; never touches VitalPBX-generated config.

## 9. Beep / wait strategy (Choice B — pluggable)

The dialplan exposes `VMDROP_STRATEGY` (set per-drop by Connect via AMI Setvar):
- `fixed` (**default**) — `Wait(${VMDROP_WAIT})`, default 2s. The agent confirms
  voicemail was reached before clicking Drop. Deterministic, lowest risk.
- `waitsilence` — `WaitForSilence(${VMDROP_SILENCE_MS},1,${VMDROP_SILENCE_MAXMS})`
  then a short settle (`app_waitforsilence.so` is loaded).
- `amd` — `AMD()` then branch on `${AMDSTATUS}` (`app_amd.so` is loaded).

Each strategy is its own labeled block; the `play`/`Hangup` tail is shared, so a
future beep-detection improvement slots in without touching the play/end path.
**Default ships as `fixed`.** `amd`/`waitsilence` require their own live
validation pass before being enabled and are documented as not-yet-validated.

**Limitation:** there is no verified beep/answering-machine detection today. A
fixed pre-play wait can begin the message slightly before/after the beep on some
carriers. This is accepted for v1 (manual confirmation) and tracked for the
separate AMD/WaitForSilence validation.

## 10. Risks

- **Redirect into a missing context drops the live call.** Mitigation: Connect
  MUST verify `dialplan show connect-vm-drop` (AMI `Command`) before issuing the
  Redirect and refuse otherwise. Until the plugin is installed, the backend
  refuses the drop.
- **Wrong-leg selection** could play to the agent or hang up the customer.
  Mitigation: the unit-tested classifier + the agent-endpoint hint from the
  dialer; refuse when the customer leg can't be unambiguously identified.
- **Beep timing** (see §9) — accepted v1 limitation.
- **File not present on PBX** (push race). Mitigation: dialplan `STAT()` guard
  hangs up cleanly (failed drop), and Connect re-pushes before each drop.
- **VitalPBX regeneration** — none: unique `__96` filename, no edits to
  generated files.
- **Install is a PBX change** governed by AGENTS.md — manual, human-approved,
  not a deploy step; agents must not run it against the live PBX.

## 11. Tests run

- `pnpm --filter @connect/telephony test` → **48 pass / 0 fail** (includes 7 new
  `voicemailDropLegs` tests + the previously-orphaned `telephonyVoicemailDrop`
  route test, now wired into the test glob).
- `pnpm --filter @connect/telephony typecheck` → clean.
- Installer `--dry-run` is the safe local verification of the emitted dialplan
  (no PBX needed).

## 12. App-side wiring (BUILT — local only; PBX plugin still NOT installed)

Decision taken: floating dialer surface, CRM-gated per user, fire-and-forget
(backend hangs up the agent leg so the dialer frees instantly).

- **Telephony** (`apps/telephony/src/routes/telephony.ts`): new guarded internal
  route `POST /telephony/internal/calls/voicemail-drop`. Resolves the active call,
  classifies legs (`voicemailDropLegs.ts`), **hard-guards** on
  `Getvar DIALPLAN_EXISTS(connect-vm-drop,s,1)` (refuses `vm_drop_context_missing`
  when the plugin is not installed — never redirects into a void), `Setvar`
  `VMDROP_FILE`/`VMDROP_STRATEGY`/`VMDROP_WAIT`, `Redirect`s the customer leg into
  `connect-vm-drop,s,1`, then `Hangup`s the agent leg. Returns immediately.
- **API** (`apps/api/src/crm/voicemailDropRoutes.ts`): `POST /crm/voicemail-drops/drop`
  now calls the AMI route (not ARI play-prompt). `contactId` and `voicemailDropId`
  are optional — the dialer drops the tenant **default** recording; `contactId`,
  when present, gets a success/failure `CrmTimelineEvent` (no migration; reuses the
  existing timeline). Increments `usageCount`/`lastUsedAt`.
- **UI** (`apps/portal/components/FloatingDialer.tsx`): a CRM-gated
  (`can("can_view_section_crm")`) "Voicemail Drop" control in the active-call
  controls. Hidden entirely for non-CRM users. Shows dropping/done/error states;
  on success the backend ends the call and the dialer returns to idle.

Wait strategy is wired end-to-end (`strategy`/`waitSeconds` optional params, default
`fixed`). PBX install remains the only remaining gate to make it functional live —
the backend safely refuses until `[connect-vm-drop]` is installed.
