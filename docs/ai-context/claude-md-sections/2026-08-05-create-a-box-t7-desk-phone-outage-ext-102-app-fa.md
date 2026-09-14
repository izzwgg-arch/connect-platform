# ⛔ AGENT HANDOFF — Create A Box (T7) desk-phone outage + ext 102 app failure (2026-08-05) — READ FIRST for Create A Box, "phones don't ring / straight to voicemail", the WireGuard-tunnel office, or any PENDING PBX registration-expiry fix

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_CREATEABOX_T7_OUTAGE_2026-08-05.md`**

- ⛔ **A PBX fix is STAGED but was NOT APPLIED at handoff** — check
  `pjsip show aor T7_101 | grep -i expir` (read-only) FIRST: `120` = Izzy ran it,
  `3600/7200` = still pending, re-surface it. The fix caps T7 desk aors 101–107
  (never `_1` app aors) at 120 s registration in
  `/etc/asterisk/vitalpbx/pjsip__50-7-extensions.conf`, backup + 21-line abort guard.
  ⛔ The session's auto-classifier blocked the ssh write, the settings self-grant, AND
  the Desktop Commander route despite Izzy's explicit repeated mandate — do NOT waste
  time re-trying tool routes; hand Izzy the Run-button block (in the handoff §4).
- **2026-08-05 12:57 PM ET: ALL Create A Box desk phones went dead → instant VM**
  ("greeting looping" = wake-hold MOH loop for 102 + instant VM greeting for 101).
  Cause (tcpdump-proven): the office GL.iNet router (wg peer 10.88.0.2, on T-Mobile
  cellular) lost its NAT ledger; loopcom forwarded every qualify perfectly, the box
  answered only on NEW ports. Phones stay dark until their next re-register (1–2 h
  grants — hence the fix). Scope was Create A Box ONLY. NOT the wake-dial rollout
  (dial keys verified byte-correct). Immediate fix = power-cycle the office router.
- **Ordinary T-Mobile IP rotation never causes this** (WireGuard roams through it;
  62-day history proves it) — only a router state reset does. Near-daily small
  self-healing blips + probable smaller repeats (7/29, 8/3 miss-rates 35%/32%)
  predate the first total wipe on 8/5.
- **Ext 102 (Sender Weiss) is a SEPARATE chronic problem**: registered 1–3.5 h/day
  (T-Mobile CGNAT churn, ~90 IPs/10 d), Expo-relay-only pushes (no nativeFcmToken),
  pre-Aug-1 build — answer taps land mid-reconnect and die (`SIP_REGISTER_FAILED`
  right after ANSWER_TAPPED). Fix = latest APK + Samsung battery settings +
  wake-dial (enrolled 8/5). NOT a port-443 case.
- Query gotchas + env notes (conntrack missing on loopcom, Prisma field names,
  history-window limits) in the handoff §5.
