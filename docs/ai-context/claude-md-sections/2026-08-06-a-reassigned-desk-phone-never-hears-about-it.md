# ⛔ AGENT HANDOFF — a reassigned desk phone never hears about it (2026-08-06) — READ FIRST for "I changed the extension and the phone didn't change", VitalPBX provisioning, or any phone-to-extension assignment

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_DESK_PHONE_REPROVISION_2026-08-06.md`**
(Gesheft T53W stuck on 114 after being assigned to 101 — diagnosed and fixed
live. **No PBX config written**; the one action was a `pjsip send notify` run by
Izzy from a Run button.)

- ⛔ **A REBOOT IS NOT A RE-PROVISION.** The panel change was correct and saved
  the whole time; the handset simply never downloaded it — last fetch **July 30,
  02:20 AM**, nothing when the change was made, nothing when it was rebooted.
  The panel's reboot button sends `check-sync;reboot=true`, and whether the phone
  then fetches settings depends on `static.auto_provision.power_on` **stored on
  the handset**. The reboot *visibly working* is what made this read as a PBX
  routing bug.
- **The fix, proven live in ~2 seconds** —
  `asterisk -rx "pjsip send notify yealink-check-cfg endpoint T8_114"`
  (`check-sync;reboot=false` = "fetch now", a different code path that ignores
  `power_on`). The phone swapped to 101 **without rebooting**. Per-brand options
  (`poly-`/`snom-`/`cisco-check-cfg`, `reboot-*`) already exist in
  `/etc/asterisk/vitalpbx/pjsip_notify__10-default.conf`.
- ⛔ **THE DIAGNOSTIC: `grep phoneprov /var/log/nginx/access.log`** (+ `zcat` the
  `.gz` for 14 days). It records every download with **model and MAC** in the
  user agent, so it is the only honest witness to whether a change reached a
  phone. A hit from the customer's public IP with a `Yealink SIP-T53W … <mac>`
  agent IS the phone. ⛔ A hit from **`127.0.0.1` with agent `VitalPBX` (54
  bytes) is only the panel rendering its own page** and proves nothing —
  it sits there looking reassuring while the phone is weeks out of date.
  Silence from the customer's IP = the change never left the server. Always
  compare against other tenants in the same window before blaming provisioning.
- ⛔ **NOTIFY targets the EXTENSION, not one handset** — it fans out to every
  contact on the AOR (114 had two phones; both re-provisioned, harmlessly).
  Check `pjsip show aor <ep>` and warn the owner first.
- ⛔ **You cannot read provisioning behaviour off the template** — VitalPBX
  pushes every `auto_provision.*` key **blank** except the server URL, and blank
  means "keep what you have". Likewise the `description` field is a LABEL: this
  phone's record still reads `114` (template still named `Gesheft 114`) while
  correctly serving 101. Read `provisioning.accounts.phone_device_id` joined to
  `ombutel.ombu_devices.user`, never the description.
- ⛔ **`PbxEndpointRegistrationEvent` has NO `createdAt`** — order by
  `occurredAt` or `findMany` throws. It is how you prove a reboot happened
  independently of whether config changed (they are unrelated).
- **Sister failure — check BOTH:** [[createabox-102-blf-mac-mismatch]] is the
  same symptom from the opposite cause (phone fetched fine, panel had the WRONG
  MAC, so the rewritten file was one nothing downloads). The nginx log tells
  them apart in one grep — it shows the MAC the phone ASKS for.
- **OPEN, needs Izzy:** Gesheft is **two sites** (`75.99.30.60` holds 102-111 +
  897 + the ORIGINAL 101; `66.250.98.9` holds 114/115/116 + the moved phone), so
  **101 now rings in both places**. If the intent was to *move* 101 rather than
  add a second, the old phone needs unassigning. Also 114 still has a T26P on it
  whose record is labelled "118".
