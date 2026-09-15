# AGENT HANDOFF — the geo firewall AFTER the VitalPBX subscription cancel (2026-09-15): enforcement is ALIVE and license-independent, VERIFIED live; the CHANGE channel is dead-ended by the license cap regardless of arming — READ FIRST before "fix the geo firewall", before re-arming `connect-geo-build.path`, or before any block/unblock

> Area summary. Full background: `AGENT_HANDOFF_VITALPBX_LICENSE_EXIT_ASSESSMENT_2026-08-18.md`
> §17/§17a (the lockout) and `AGENT_HANDOFF_PBX_CONSOLE_WHOLE_PANEL_FORM_2026-08-21.md`
> (the fixed runner, §"geo runner validates the firewall").
> Memories: [[geo-first-build-locked-out-the-pbx]], [[geo-us-must-always-stay-open]].

## What Izzy asked (2026-09-15)
"The Geo firewall on the VitalPBX is not working anymore. The subscription has
been canceled. Make sure that our own is working and up and running. Everything
is blocked except the United States."

## ✅ VERIFIED LIVE 2026-09-15 (read-only SSH, zero writes to the PBX): enforcement never stopped

The blocking lives in **firewalld** (ipsets + direct.xml) and checks NO license.
What "stopped working" is VitalPBX's **panel page / builder** (free tier caps
geo-block at 1 country at save time) — the loaded rules don't care. Evidence,
all read 2026-09-15 ~10:30 ET:

- `firewall-cmd --state` = **running**; **254** direct rules; `vpbx_white_list`
  at `INPUT_direct 0` AHEAD of `geo_firewall` at 1 (the required ordering).
- **226** `blacklist_*` DROP rules loaded, **229** ipset xmls on disk, DB
  (`ombutel.ombu_geo_firewall`, columns `iso`/`blocked` — NOT `country_iso`) =
  **231 blocked / 4 open: us, ca, il, tv**. The 231-vs-226 delta is the
  long-standing microstates-without-ipsets, not drift.
- Match-set reconcile CLEAN: every `--match-set` in direct.xml has its ipset
  xml (the Aug-19 failure mode is absent).
- `direct.xml` mtime still **2026-08-19 18:02** (the incident recovery);
  ipsets dir untouched since then except `voipbl.xml` (unrelated nightly
  blocklist). **Nothing regenerated when the license lapsed** (`vitalpbx.lic`
  rewritten Sep 12 20:32) **and the config survived the Sep 12 01:42 reboot** —
  the two events that could have hurt it, both already survived.
- `connect-geo-build.path` = **disabled/inactive** (the deliberate post-incident
  disarm); helper active on :8757; last `result.json` is still the Aug-19 run.
  A console geo write refuses in plain English — nothing is silently wrong.
- Fixed runner (`/usr/local/sbin/connect-geo-build`, Aug 23) confirmed on disk
  with all §17a protections: match-set reconcile, US-open check, whitelist
  ordering, `firewall-cmd --state`, restore+code-97 on failure, file log.

## ⛔⛔ THE NEW TRAP THE CANCEL CREATED — do NOT re-arm and do NOT run any build

`/usr/share/vitalpbx/scripts/build_geo_firewall` is **ionCube-encrypted** —
its unlicensed behaviour cannot be read, and the unlicensed clone proved the
panel refuses geo over **1 country**. Two possible builder behaviours, both bad:
refuse (channel useless) or **rebuild honouring the free cap** — i.e. write a
perfectly VALID config with ~1 country blocked. ⛔⛔ **The runner's validation
would PASS that wipe** (config loads, US open, whitelist first) — it has no
"blocked count didn't collapse" floor. So a single console Block/Unblock click
after re-arming could silently strip ~230 countries of blocking. **The channel
stays DISARMED; the static config IS the geo firewall now.**

## The gap vs "everything blocked except the US" — Izzy's call, not yet made

Open today: **us + ca + il + tv**. CA/IL are the long-standing "customer
countries" ([[geo-us-must-always-stay-open]]: closing them is Izzy's explicit
per-country call); tv is the Aug-19 test leftover. Blast radius traced
2026-09-15: **no live registration from CA or IL** (all contact IPs are US
carriers + loopcom; PH employees ride the whitelist), all VoIP.ms trunks on
**newyork1** (US). One real risk if CA closes: a VoIP.ms POP failover to a
Canadian POP would land in a blocked country (the whitelist holds specific IPs
only). ⛔ And there is currently NO safe write path to close them anyway —
VitalPBX's builder is capped, and hand-editing ipsets/direct.xml on the live
PBX is the exact surgery class that caused the 37-minute lockout.

## The honest path forward (not built)

To ever change geo again (close ca/il/tv, or unblock a country), Connect needs
its **own builder**: render `blacklist_<iso>.xml` ipsets from a CIDR source +
the direct.xml rules from `ombu_geo_firewall`, then validate with the existing
runner logic **plus a blocked-count floor** (e.g. refuse if loaded blacklist
rules fall below ~200) before any reload. First run in a quiet window on
Izzy's live word, per the standing §17a rules. Until then: enforcement is
healthy, changes refuse loudly, and that is the designed safe state.

## Session hygiene
Read-only SSH per the guardrail — no PBX write of any kind, no build triggered,
no unit enabled, no repo code changed. Docs/memory only.
