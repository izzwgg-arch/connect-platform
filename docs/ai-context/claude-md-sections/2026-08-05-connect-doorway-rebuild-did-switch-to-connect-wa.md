# ⛔ AGENT HANDOFF — Connect doorway rebuild: DID switch-to-connect was broken platform-wide (2026-08-05) — READ FIRST for IVR Studio number switching, "published but callers hear the old routing", the PBX route helper, or the connect-doorway dialplan

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_CONNECT_DOORWAY_2026-08-05.md`**

- **Every switch-to-connect had been dead since ~May**: the PBX doorway
  destination (id 607, an April-era T21 custom app) was panel-deleted — FK
  cascade emptied `ombu_custom_contexts` — and the pinned env id made every
  flip fail `connect_destination_not_found`. Nobody flipped a number between
  April and August, so it surfaced only when Izzy tested the Studio.
- **Rebuilt as a global self-healing doorway** (helper v2026.08.05.1 DEPLOYED,
  backup `/root/helper-backup-doorway-20260805.py` on the PBX): Custom Context
  `connect-doorway` discovered BY NAME at flip time (stale pinned ids are
  skipped, never fatal), dialplan shim self-installs to
  `/etc/asterisk/vitalpbx/extensions__96-connect-doorway.conf` (verified live),
  rows self-create inside the retarget transaction, `POST /doorway-status` for
  health. Connect side at `e9ab55ca` (deployed api+portal): picker auto-fills
  from PBX-synced numbers, switch failures are LOUD in the Studio
  (`lastSwitchError` on the numbers list).
- ✅ **UNBLOCKED AND DONE 2026-08-05 (evening session)**: Izzy ran the GRANT +
  two helper installs via Run buttons. The doorway needed TWO more fixes to
  actually work, both shipped as helper **v2026.08.05.3** (deployed, commit
  `3399f0df`, backups `/root/helper-backup-{moduleid,bake}-20260805.py`):
  (1) the doorway `ombu_destinations` INSERT was missing `module_id`;
  (2) ⛔ **retarget/restore never regenerated the dialplan** — they updated the
  DB then ran the legacy apply (reload only), so every "successful" switch
  left callers on the OLD routing. Now both directions run the real
  per-tenant regen + Goto bake (agent_set pattern). The custom-context render
  IS `Goto(connect-doorway,s,1)` — proven live. Full connect→pbx→connect
  cycle proven on (845) 723-1213; left ON CONNECT.
- ⛔ **api-side: switches take ~35-40s now (full regen).** The 15s helper
  timeout filed phantom failures that the scheduler retry healed (noop
  convergence). Fixed to 90s in `pbxInboundRouteHelperClient.ts` (`3399f0df`)
  — ✅ **DEPLOYED 2026-08-06** inside api `7f7ec541`; the transient
  `helper_*_failed: operation was aborted` per switch should no longer appear.
- **Landau's mapping was stale** (said connect, PBX rings ext 101 directly —
  route was rebuilt as id 68) — corrected to `pbx` this session. PBX ssh that
  works: repo key `.connect-ssh/connect2_server2_ed25519`, port 22 (the `pbx`
  alias pins port 2222 and times out).
