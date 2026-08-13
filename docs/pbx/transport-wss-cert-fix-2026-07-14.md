# transport-wss cert fix — applied & verified 2026-07-14 (certfix loop closure)

Applied by Cowork/Claude with Izzy's explicit chat authorization, over the sanctioned sandbox SSH
channel documented in CLAUDE.md. This closes the certfix loop (phases 1–3 in
`C:\dev\ai-workspace\.ai-platform\reports\`).

## What was actually wrong (differs from the original task premise)

- `pjsip.conf` `[transport-wss]` had **already** been repointed to the Let's Encrypt pair
  (Option B was in place at the file level), and `transport-wss` was loaded.
- The real TLS server for WSS :8089 is **Asterisk's built-in HTTP server**
  (`http.conf` → `vitalpbx/http__10-general.conf`), not the PJSIP transport cert lines.
  `http.conf` already pointed at the correct LE bundle too.
- Asterisk had simply never re-read the renewed cert: it was serving the **pre-renewal cert
  (notAfter Aug 2 2026) from memory** since before the Jul 5 renewal — a ticking outage for every
  WebRTC client on Aug 2. `module reload res_pjsip.so` does **not** refresh it; `module reload http`
  **does**.

## Actions taken (before/after evidence in the Cowork session)

1. Backup: `/etc/asterisk/pjsip.conf.bak.20260714-cowork`.
2. Added benign `websocket_write_timeout=105` to `[transport-wss]` (attempt to force a transport
   recreate; harmless, left in place).
3. `module reload res_pjsip.so` — clean; no effect on the served cert (expected in hindsight).
4. `module reload http` — cert served on :8089 flipped from notAfter **Aug 2 2026** to
   **Oct 3 2026** (the renewed LE cert).

## Verification (Izzy's constraint: hardphones & trunks must not break)

- Trunk registrations: **52 Registered / 3 Rejected before AND after** (identical; the 3 Rejected
  had been failing for days prior — pre-existing, unrelated).
- Contacts: 128 → 127 (normal churn); active calls kept flowing throughout (104279 → 104291
  processed).
- All 17 established WSS connections survived both reloads; `T21_101_1` contact Avail, 41 ms RTT after.
- No errors in `/var/log/asterisk/full` around the reloads.

## Remaining follow-ups

1. **Renewal gap persists**: the next LE renewal (~Oct 2026) will again leave a stale in-memory
   cert unless `module reload http` runs after renewal. Add a renewal hook or a scheduled
   idempotent ensure-script: compare the cert served on :8089 against `cert.pem` on disk; run
   `module reload http` only when they differ; alert if still mismatched afterwards.
2. `/etc/asterisk/keys/` is still absent; nothing references it anymore.
3. **Client-side bug**: the Connect desktop UI showed "Connecting" (yellow) while the PBX showed the
   extension registered, authed, and answering qualifies — the status pill/state sync lies after a
   watchdog UA rebuild. Belongs with the active dev session working `useSipPhone.ts`.
4. Outside-in monitoring (synthetic WSS REGISTER probe + cert-expiry alert) still recommended —
   this whole class of failure was invisible until a human noticed yellow pills.
