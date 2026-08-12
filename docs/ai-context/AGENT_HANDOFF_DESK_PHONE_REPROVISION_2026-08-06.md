# AGENT HANDOFF — a desk phone reassigned in the panel never hears about it (2026-08-06)

**Read this before diagnosing ANY "I changed the extension and the phone didn't
change" report, before touching VitalPBX provisioning, and before concluding
that a phone-to-extension assignment is broken.**

Reported by Izzy: *"gesheft 114 T53W phone: I assigned it yesterday to extension
101 … I rebooted the phone remotely, and he's saying it's still not ringing 101."*

Resolved live the same session. **No PBX config was written.** The only action
taken was one `pjsip send notify`, run by Izzy from a Run button.

---

## 1. The one-line answer

The panel change was correct and saved the whole time. **The handset never
downloaded it.** It had not fetched a settings file since **July 30, 02:20 AM** —
not when the change was made, not when it was rebooted, not since.

⛔ **A reboot is NOT a re-provision.** That is the entire trap, and it is
non-obvious enough that the reboot *appearing to work* is what made this look
like a PBX routing bug.

---

## 2. Why a reboot doesn't do it

VitalPBX can send a Yealink two different SIP NOTIFY messages. Both are already
defined in `/etc/asterisk/vitalpbx/pjsip_notify__10-default.conf`:

| Option | Event | What the phone does |
|---|---|---|
| `reboot-yealink` | `check-sync;reboot=true` | Restarts. Whether it then fetches settings depends on `static.auto_provision.power_on` **stored on the handset**. |
| `yealink-check-cfg` | `check-sync;reboot=false` | **Fetches settings immediately.** Does not consult `power_on` at all. |

The panel's reboot button sends the first one. On this phone `power_on` is off,
so it restarted and came back on its saved config — still extension 114.

⛔ **The PBX cannot fix that remotely by itself.** Dump the template's
provisioning block and every `auto_provision.*` key is **blank** except the
server URL and credentials:

```bash
mysql -N -B provisioning -e 'select provision from templates where id=<tid>;' \
  | python3 -c "import sys; d=sys.stdin.read().replace(chr(92)+'n',chr(10)); [print(l) for l in d.split(chr(10)) if 'auto_provision' in l and not l.strip().startswith('##')]"
```

A blank value in a Yealink config means *"keep whatever you already have."* So
`power_on`, `repeat.enable`, `weekly.enable` are all whatever the handset was
last set to by hand — the panel never asserts them. **You cannot read a phone's
provisioning behaviour off the template.**

---

## 3. ⛔ THE DIAGNOSTIC — the nginx log is the only honest witness

The PBX logs every settings download with **model and MAC** in the user agent.
This is what separates "the change never reached the phone" from every other
theory, in one grep:

```bash
# today
grep phoneprov /var/log/nginx/access.log
# full 14-day retention
zcat /var/log/nginx/access.log*.gz | grep phoneprov
# one specific phone (MAC, no colons)
{ zcat /var/log/nginx/access.log*.gz; cat /var/log/nginx/access.log{,.1}; } | grep -i 805e0c4d7e6b
```

Reading the result:

- `66.250.98.9 … "GET /phoneprov/<tenant_path>/<mac>.cfg" 200 139029 … "Yealink SIP-T53W 96.86.0.50 80:5e:0c:4d:7e:6b"`
  → **this is the phone taking the config.** Customer's public IP, phone user
  agent, MAC echoed back. This is proof.
- ⛔ `127.0.0.1 … "GET /provisioning/api/provision/<mac>" 200 54 … "VitalPBX"`
  → **this is only the panel rendering its own page.** 54 bytes. It proves
  nothing about the handset. This line is present and looks reassuring while the
  phone is completely out of date — do not read it as a provisioning event.
- **Silence from the customer's public IP** = the change never left the server,
  no matter how correct the panel and the database look.

Always sanity-check against other tenants in the same window. Here, several
other customers' phones fetched normally on Aug 5 while this one did not — which
ruled out "provisioning is broken" in one glance.

---

## 4. The fix — proven live

```bash
asterisk -rx "pjsip send notify yealink-check-cfg endpoint T8_114"
```

Sent at 13:43:30. Result, from the logs:

```
13:43:31  GET /phoneprov/106048d48cb4ddf6/805e0c4d7e6b.boot  200 246
13:43:31  GET /phoneprov/106048d48cb4ddf6/805e0c4d7e6b.cfg   200 139029
          → Yealink SIP-T53W 96.86.0.50 80:5e:0c:4d:7e:6b
```

and within seconds `pjsip show aor T8_101` gained
`sip:T8_101@66.250.98.9:5060;x-ast-orig-host=192.168.44.10:5060` while the same
LAN address disappeared from `T8_114`. **No reboot. Swapped in place.**

Equivalent options exist for other brands in the same file: `poly-check-cfg`,
`polycom-check-cfg`, `snom-check-cfg`, `cisco-check-cfg`, `aastra-xml`,
`sipura-get-report`, plus `reboot-*` for a dozen vendors.

**It is self-verifying within ~2 seconds** — watch the nginx log. If nothing
appears, the handset's stored provisioning URL is stale/cleared and somebody has
to reach its web UI on the LAN (`Settings → Auto Provision → Autoprovision Now`),
or factory-reset it and re-enter the server address.

---

## 5. ⛔ Traps

- **NOTIFY targets the EXTENSION, not one handset.** It fans out to every
  contact on the AOR. Extension 114 had **two** phones registered; both
  re-provisioned. Harmless here — the second (a T26P) came back exactly as it
  was, its registration never even dropped — but **check `pjsip show aor <ep>`
  for extra contacts before firing on a live office**, and tell the owner.
- **Do not infer a reboot happened from the config not changing, or vice versa.**
  They are independent. Here the reboot demonstrably *did* reach the phone (its
  contact went UNREACHABLE on Aug 5 at 14:58 UTC and returned) and still changed
  nothing. Registration-event history on the Connect side is how you check:
  `PbxEndpointRegistrationEvent`, ordered by **`occurredAt`** — ⛔ that model has
  **no `createdAt`**, a `findMany` ordering on it throws.
- **The provisioning "description" field is a label, nothing more.** This phone's
  record is still described `114` and its template is still named `Gesheft 114`
  while it correctly serves extension 101. Never read the assignment off the
  description — read `provisioning.accounts.phone_device_id` and join it to
  `ombutel.ombu_devices.user`.
- **Firmware 404s are noise here.** Every one of these phones requests
  `/firmwares/<model>/<model>-current.rom` and gets a 301 → 404. It happened on
  the working July 30 fetch too, and again on the successful one. Unrelated to
  the config — but it means firmware upgrades have never worked on this PBX,
  which is its own (unlogged, unowned) issue.
- **Two provisioning entries may point at the same extension.** After the change,
  MACs `80:5E:C0:85:61:4F` *and* `80:5e:0c:4d:7e:6b` both had line 1 → extension
  101. That is legal (`max_contacts: 5`) and both phones ring — see §7.

---

## 6. Where the data lives

Two databases on the PBX, and you need both:

- **`provisioning`** — what a phone is *told to be*.
  `devices` (id, mac, tenant, description, template_id) →
  `accounts` (device_id, **phone_device_id**, one row per line key, in line order).
- **`ombutel`** — what the extension *is*.
  `ombu_devices` (device_id, **user** = extension number, extension_id, tenant_id),
  `ombu_tenants` (tenant_id, name, **path** — the hash in the provisioning URL).

The join that answers "what will this MAC become?":

```sql
select d.mac, d.description, a.phone_device_id
  from provisioning.accounts a
  join provisioning.devices d on d.id = a.device_id
 where d.tenant = 8;
-- then look phone_device_id up in ombutel.ombu_devices.device_id → .user
```

---

## 7. Gesheft (tenant 8) reference — state at handoff

Tenant path (the hash in every provisioning URL): `106048d48cb4ddf6`.

⛔ **Gesheft is TWO sites.** This is not obvious from the panel and it changes
what "assign it to 101" means:

| Public IP | Extensions registered there |
|---|---|
| `75.99.30.60` (LAN `192.168.7.x`) | 102, 103, 104, 105, 106, 107, 108, 111, 897, **and the original 101** |
| `66.250.98.9` (LAN `192.168.44.x`) | 114, 115, 116, **and now this T53W as 101** |

**OPEN — needs Izzy's decision.** Extension 101 now rings in **both** places:
the original phone (MAC `80:5E:C0:85:61:4F`, LAN `192.168.7.13`) and the newly
moved T53W (MAC `80:5e:0c:4d:7e:6b`, LAN `192.168.44.10`). Either can answer. If
the intent was to *move* 101 rather than *add* a second one, the old phone needs
unassigning. Raised with him; unanswered at handoff.

**Also open:** extension 114 still has a phone on it — the T26P
`00:15:65:48:31:47` at LAN `192.168.44.15`, whose provisioning record is
**labelled "118"** while its line 1 points at 114. Whether that is intended is
unknown. Extension 118 itself has no registration at all.

Prior known issue on this tenant, unrelated but same neighbourhood:
extensions **107 and 109** have the wrong owner in Connect and re-syncing can
never fix it — see the memory `pbx-sync-skips-owned-extensions`.

---

## 8. Guardrail note

The PBX stayed **read-only for the agent** throughout. Every finding above came
from reads (mysql selects, `asterisk -rx "pjsip show …"`, nginx logs). The single
state-changing action — the `pjsip send notify` — was handed to Izzy as a Run
button and executed by him. Keep it that way: a check-sync reaches into a live
customer's handset and can interrupt a call in progress, so it needs his word
even though it writes no config.
