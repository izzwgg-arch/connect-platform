# ⛔⛔ CAPACITY TUNING APPLIED (2026-08-23) — RTP range widened, coturn quota raised, Postgres connections raised — READ FIRST before changing the RTP range, the firewall's RTP service, `total-quota`, or `max_connections`

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Izzy asked "what are our limits… can we handle thousands of calls?", then
"do this without breaking anything". Measured first, then applied. Capacity
writeup: <https://claude.ai/code/artifact/d89f3ff7-b6a9-4f84-8d64-0fa1584a7ff6>

- **MEASURED CEILINGS (2026-08-23, both boxes read live).** PBX = 12-core
  EPYC / 47 GB / **St. Louis US** (⛔ NOT France — that is loopcom, the app
  server: 18-core / 94 GB / Lauterbourg). 30-day traffic: **25,917 calls,
  busiest hour 501, peak ~331 overlapping call LEGS** (legs, not calls —
  simultaneous ring to desk+app+cell inflates it). Tenants/extensions/users
  have **no cap** post-licence; the binding limit is **concurrent calls per
  PBX**.
- ✅ **RTP RANGE 10000–20000 → 10000–60000 (~2,500 → ~12,500 concurrent
  calls).** ⛔⛔ **THE TRAP: the range lives in THREE places and Asterisk is
  the least important one.** (1) `ombutel.ombu_settings` rtpstart/rtpend —
  **the source of truth the VitalPBX generator reads**, so editing only the
  conf file is reverted at the next regen; (2)
  `/etc/asterisk/vitalpbx/rtp__10-general.conf`; (3) ⛔ **firewalld service
  `vpbx_service_7_RTP.xml`, which pinned `10000-20000/udp`** — widening
  Asterisk WITHOUT the firewall gives **one-way/dead audio above port 20000**
  under load, appearing only at high concurrency. All three updated.
  ⛔ The firewall change was made **additively** (`--add-port=20001-60000/udp`
  runtime + permanent) and **NOT by editing the service xml + reload** —
  a firewalld reload is the 2026-08-19 geo-lockout class. **Zero disruption:
  no firewalld reload, registrations untouched.** Applied at 0 active calls;
  `module reload res_rtp_asterisk.so` only. Verified: `rtp show settings`
  reads 10000–60000, contacts 148→149, whitelist still ahead of geo.
- ✅ **coturn `total-quota` 200 → 2000.** ⛔ coturn has **no reload hook** —
  it needs `systemctl restart`, so it was done in a verified window (0 active
  calls, 0 established TURN control connections). **Proven by a real STUN
  Binding Success (88 bytes) after the restart**, not by "service is active".
- ✅ **Postgres `max_connections` 100 → 300** via **`ALTER SYSTEM`** (persists
  to `postgresql.auto.conf`; ⛔ never hand-edit that file) + container
  restart. Memory math checked first: work_mem 4 MB × 300 ≈ 1.2 GB against
  **83 GB available**. **Down ~2 seconds**; api never restarted (RestartCount
  0) and reconnected by itself. ⛔ **8 `level:50` Prisma errors are stamped
  07:37:55–07:37:56 — the restart window ONLY, zero since**; that is the
  expected cost of the restart, not a fault. ⏳ pgbouncer is still NOT
  installed — the next step if connections ever approach 300 (47 in use now).
- ⛔ **A grep for "pool|econnrefused" in the worker log returns ~199 FALSE
  POSITIVES** — the word "pool" appears in ordinary `voicemail-sync` lines.
  Judge worker health by its cycle lines, never that grep.
- **Backups (all on-box, root-only):** PBX
  `/root/cap-tune-backup-20260823T073053Z/` (RTP service xml, rtp conf, ombu
  settings); loopcom `/root/cap-tune-backup-20260823T073556Z/turnserver.conf`
  and `.../073734Z/postgresql.auto.conf`.
- ⏳ **STILL THE REAL CEILING, and neither is measurable from the box —
  Izzy's to confirm:** (1) **the PBX port's guaranteed bandwidth** (all media
  flows THROUGH the PBX at ~400 kbps/call: 1 Gbps ⇒ ~2,500 concurrent,
  200 Mbps ⇒ ~500 — this can bind BEFORE the new 12,500 port ceiling);
  (2) **VoIP.ms's concurrent-channel limit** per account. Past one node,
  capacity scales by **adding PBX nodes and sharding tenants** — the
  architecture already supports it (Connect generates per-tenant config).
