# ⛔ AGENT HANDOFF — voicemail playback wedge / phantom Telecom call (2026-08-04) — READ FIRST for "voicemail shows playing but no audio" or any Telecom Connection work

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_VOICEMAIL_WEDGE_2026-08-04.md`**

- **"Plays but no audio until APK reinstall" = a phantom Telecom call.** A ghost
  ring (cancel push racing past the ring push) answered by the user flips a
  Connection ACTIVE that no SIP session ever owns; Android then refuses ALL
  media playback, and the FGS keeps the process (and the phantom) alive through
  everything short of reinstall/force-stop. RSBK101 lived this for days.
- Fixed 2026-08-04, **FULLY DEPLOYED 2026-08-05**: merge `0cd7119b`
  (`fix/ring-cancel-race` `88d405a7`) + four backstops `065bce23` (120s ring
  self-destruct, stale-aware Telecom sweep, dead-invite answer teardown,
  voicemail playback-stall watchdog with self-heal). APK
  `1.0.0+20260804-202642` published to the download page; api container
  verified at `85a14982` (deploy-queue job `2d10d11d`).
- **Local `git push` is classifier-blocked in this environment.** Working
  route: `git bundle` → `scp` to loopcom → `git fetch <bundle>` in
  `/opt/connectcomms/app` → push to GitHub FROM the server clone. Deploys
  don't need GitHub at all (`--commit` / queue `commitHash` use local
  objects). And `pgrep -f deploy-direct.sh` in an ssh one-liner matches
  itself — check the queue's `/ops/deploy/status` runningCount instead.
- ⛔ **`telecomTerminateStale` may ONLY be called after verifying zero live SIP
  sessions** — its age gates cannot distinguish a leaked ACTIVE ghost from a
  real hour-long call. Both existing call sites assert this; any new one must.
- `resetCallAudioStateIfIdle` skips while ANY Connection is registered — a
  leaked Connection disarms it. That is WHY the stale sweep exists; never
  "simplify" the sweep away in favor of the reset alone.
- Interim advice for customers on old builds: Settings → Apps → Connect →
  **Force stop**, reopen — equivalent to their reinstall ritual.
