# AGENT HANDOFF — Voicemail greeting upload + Call-to-Record (2026-08-04) — READ FIRST for greeting work

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_VM_GREETING_2026-08-04.md`**.

- **VERIFIED WORKING by Izzy 2026-08-04** on T21 "Landau Home" ext 101 (desktop +
  Android rang simultaneously; greeting saved on the PBX). Fix commits: api
  `707820cb` (instant-originate) + `b6034b7b` (UI push restore), helper
  v2026.08.04.2 `1f216a80` (ring-all contacts).
- ⛔ **The Android ring screen is PUSH-DRIVEN.** A bare SIP INVITE renders NO
  incoming-call UI — the synthetic `INCOMING_CALL` push (inviteId `vmr-<jobId>`)
  must be sent for every mobile device on every vm-record path. Only the WAKE
  push is skipped (it forces a SIP reconnect and churns the shared AOR mid-ring,
  which is what broke answering).
- ⛔ **Dial CONTACTS, not endpoints.** `Dial(PJSIP/<endpoint>)` creates one
  channel even when the AOR holds several registrations. The vm-greeting
  dispatch context expands `PJSIP_DIAL_CONTACTS(base)` + `(base_1)` at dial
  time. The dispatch dialplan lives in THREE synced copies: helper py + two
  embeds in `install-vitalpbx-inbound-route-helper.sh`.
- PBX rollback backups: `/root/helper-backup-20260804-141045.py` and
  `/root/vm-dialplan-backup-20260804-141045.conf` on the PBX.
