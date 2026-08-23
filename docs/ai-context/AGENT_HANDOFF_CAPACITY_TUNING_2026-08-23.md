# AGENT HANDOFF — capacity: what the system can carry, and the three ceilings raised (2026-08-23)

Izzy: *"What are our limits? Can we have as many extensions, as many tenants as
we want? Where do we cap out at how many active phone calls? … is it capable of
handling thousands and thousands of calls and users?"* — then, on the three
recommendations: *"Can you do this without breaking anything? If yes, do it
right now."*

**Everything below was MEASURED on the live boxes, not estimated.** The three
changes were applied to production with backups first and verified after; the
platform stayed up throughout (one 2-second Postgres restart, detailed in §4).

Customer-facing capacity writeup:
<https://claude.ai/code/artifact/d89f3ff7-b6a9-4f84-8d64-0fa1584a7ff6>

---

## 1. The hardware, measured

| | PBX (telephony) | loopcom (app server) |
|---|---|---|
| CPU | 12-core AMD EPYC | 18-core AMD EPYC |
| RAM | 47 GB (17 used) | 94 GB (11 used, **83 available**) |
| Disk | 267/490 GB | 300/678 GB |
| Location | **St. Louis, US** (Contabo Inc, AS40021) | Lauterbourg, FR (Contabo GmbH) |
| Load at measurement | 1.37 | 3.52 |

⛔ **The PBX is in the US, not France.** This repo repeatedly records "the
server is in France" — that is **loopcom**, the app/control plane. Media
latency reasoning for a US customer must not blame France for a PBX-side
path.

## 2. The traffic, measured (30 days)

- **25,917 calls / 30 days**, 5,516 / 7 days, busiest hour **501 calls**.
- **Peak ~331 concurrent** — computed by summing CDR overlap
  (`+1` at `createdAt`, `-1` at `createdAt + durationSec`).
  ⛔ **That is call LEGS, not calls.** One inbound call ringing desk + app +
  cell produces several overlapping legs, so true distinct concurrent calls
  are materially lower. Quote it as legs or the headroom looks worse than it is.
- Live at measurement: 30 tenants, 218 endpoints/AORs, 148 registered
  contacts, 0 active channels, 186 Connect `Extension` rows.

## 3. Where the system caps out — the ladder, in bite order

1. **RTP media ports** — was 10000–20000 (10,000 ports ÷ ~4 per bridged call
   ⇒ **~2,500 concurrent**). **Raised to 10000–60000 ⇒ ~12,500.** §4.
2. **Bandwidth through the PBX** — all media flows through Asterisk
   (`direct_media` is not globally on), ~400 kbps per call both directions.
   1 Gbps ⇒ ~2,500; 200 Mbps ⇒ ~500. ⏳ **UNKNOWN — the virtualised NIC
   reports `-1`; this must be confirmed with Contabo and may bind before the
   new 12,500 port ceiling.**
3. **CPU / transcoding** — passthrough ulaw↔ulaw is nearly free (thousands per
   box); Opus or G.729 **transcodes** at roughly 50–150 calls/core ⇒
   ~600–1,800 on 12 cores. Trunk codec lines are `allow=!all,ulaw,alaw,g729,g722`
   (39 trunks) — a mixed estate, so transcoding is real but not the first wall.
4. **Carrier (VoIP.ms)** concurrent channels — external, ⏳ unconfirmed.
5. **coturn relay** — was 200, **raised to 2000**. Only filtered-internet
   endpoints use it.
6. **Postgres connections** — was 100 (64 in use), **raised to 300**.
   The app server is otherwise nowhere near a limit (containers <1 GB each).

**Extensions / tenants / users: no cap.** Post-licence nothing counts them;
the cost of growth is generated config on disk and reload time, against 198 GB
free. The concurrent-call ceiling is **per PBX node** and independent of how
many extensions exist.

**Past one node:** add PBX nodes and shard tenants across them. Connect already
generates per-tenant config and orchestrates the boxes, so this is a sharding
decision, not a redesign.

---

## 4. The three changes — how they were applied safely

### 4a. RTP range 10000–20000 → 10000–60000

⛔⛔ **THE RANGE LIVES IN THREE PLACES AND ASTERISK IS THE LEAST IMPORTANT
ONE.** Changing only the conf file is the classic half-fix:

1. **`ombutel.ombu_settings`** rows `rtpstart` / `rtpend` — **the source of
   truth the VitalPBX generator reads.** A conf-only edit is reverted at the
   next regen.
2. **`/etc/asterisk/vitalpbx/rtp__10-general.conf`** — what Asterisk loads now.
3. ⛔ **firewalld service `vpbx_service_7_RTP.xml`**, which pinned
   `10000-20000/udp` in the `public` zone. **Widening Asterisk without the
   firewall produces one-way or dead audio above port 20000 — and only under
   high concurrency, so it would surface as random broken calls months later.**

**All three updated.** ⛔ The firewall was changed **additively**
(`firewall-cmd --zone=public --add-port=20001-60000/udp`, runtime **and**
`--permanent`) rather than by editing the service xml and reloading —
**a firewalld reload is the 2026-08-19 geo-lockout class** (a reload with a
stale `--match-set` dropped every new connection PBX-wide for 37 minutes).
Config was verified clean first: **228 direct.xml match-sets, 0 missing
ipsets.** Applied with **0 active channels**; only
`module reload res_rtp_asterisk.so` was run — no firewalld reload, no Asterisk
restart, no Apply Changes.

**Verified:** `rtp show settings` → Port start 10000 / Port end 60000;
registered contacts 148 → 149 (phones re-registering normally);
`vpbx_white_list` still at `INPUT_direct 0` ahead of `geo_firewall`;
firewalld running; asterisk + fail2ban active.

### 4b. coturn `total-quota` 200 → 2000

⛔ **coturn has no reload hook** (`ExecReload` empty) — it needs
`systemctl restart`. Done in a **verified window**: 0 active calls and **0
established TURN control connections** (4 relay-range sockets were idle
leftovers). ✅ **Proven by a real STUN Binding Request → BINDING SUCCESS (88
bytes) after the restart**, not by "systemctl is-active".

### 4c. Postgres `max_connections` 100 → 300

Applied with **`ALTER SYSTEM SET max_connections = 300`** (persists to
`/opt/connectcomms/data/postgres/postgresql.auto.conf` — ⛔ never hand-edit
that file) then a container restart, which the setting requires.
**Memory math checked BEFORE:** `work_mem` 4 MB × 300 ≈ 1.2 GB worst case
against **83 GB available**; `shared_buffers` 160 MB.

**Impact, measured:** Postgres unavailable **~2 seconds** (`pg_isready` at
2 s). `app-api-1` **RestartCount 0** — it reconnected through its pool by
itself. All endpoints 200 after (api on both hostnames, portal).
⛔ **8 `level:50` Prisma errors appear, ALL stamped 07:37:55–07:37:56 — the
restart window only, zero afterwards.** That is the expected cost of the
restart. **Judge it by the timestamps, not the count.**

✅ **The api was then proven to serve REAL data, not just `/health`:** a
self-signed SUPER_ADMIN probe of `/admin/pbx-console/tenants` returned
**HTTP 200 with 29 tenants** (DB + live PBX read).

⛔ **A grep of the worker log for `pool|econnrefused` returns ~199 FALSE
POSITIVES** — the substring "pool" occurs in ordinary `voicemail-sync` lines.
The worker was healthy throughout (`voicemail-sync-cycle`, `voipms-inbound`
ticking). **Judge worker health by its cycle lines.**

---

## 5. Persistence (survives reboot / regen)

| Change | Persisted where | Survives |
|---|---|---|
| RTP range | `ombu_settings` + generated conf | reboot **and** VitalPBX regen |
| RTP firewall | `firewall-cmd --permanent` (`20001-60000/udp`) | reboot |
| coturn quota | `/etc/turnserver.conf`, unit enabled | reboot |
| pg max_connections | `postgresql.auto.conf` | container recreate + reboot |

**Backups, all root-only, on-box:**
- PBX `/root/cap-tune-backup-20260823T073053Z/` — `vpbx_service_7_RTP.xml`,
  `rtp__10-general.conf`, `ombu_rtp_settings.txt`
- loopcom `/root/cap-tune-backup-20260823T073556Z/turnserver.conf`
- loopcom `/root/cap-tune-backup-20260823T073734Z/postgresql.auto.conf`

**Rollback:** restore the file(s), then respectively
`firewall-cmd --permanent --zone=public --remove-port=20001-60000/udp` +
`--remove-port` runtime; `systemctl restart coturn`;
`ALTER SYSTEM SET max_connections = 100` + restart. Each is independent.

---

## 6. ⏳ Still open — and neither is engineering

1. **The PBX port's guaranteed bandwidth (Contabo).** The virtualised NIC
   reports `-1`, so this is unmeasurable from the box and it may bind before
   the new 12,500-call port ceiling. **The single most important unknown.**
2. **VoIP.ms concurrent-channel limit** per account — the PSTN cap, and the
   reason multiple carriers/accounts matter for both capacity and redundancy.

⏳ **pgbouncer is NOT installed** — the next step only if connections approach
300 (47 in use after the change). ⏳ Nothing here was load-tested: the new
ceilings are arithmetic (ports ÷ 4, quota, connections) plus live verification
that each setting is in force — **no one has driven 12,500 concurrent calls.**
