# ⛔ AGENT HANDOFF — the PBX helper's audit.jsonl is 84.8 GB and unbounded; rotation is DESIGNED (2026-09-15), NOT implemented — READ FIRST before touching `audit()`, before "fixing" the disk on the PBX, or before shipping any helper change that logs

Full design: **`docs/ai-context/AGENT_HANDOFF_VITALPBX_LICENSE_EXIT_ASSESSMENT_2026-08-18.md` §26**.
Status: **design only.** No code written, nothing installed, the PBX untouched (READ-ONLY box;
installs are Izzy's Run button via `scripts/pbx/install-vitalpbx-inbound-route-helper.sh`).

- **The fact (2026-09-15, read-only):** `/var/lib/connect-pbx-helper/audit.jsonl` =
  **84,808,228,474 bytes**. Disk 63%, 173 GB free — not urgent, but ~1.4 GB/day and unbounded.
- **Root cause:** `audit()` logs the **complete `result` of every POST**, and
  `/voicemail/spool/list` (polled continuously) returns whole mailbox listings — Gesheft 101
  ≈ 9,100 messages ≈ 1–2 MB of JSON **per poll**. Dominance inferred from code; the installer
  step prints a sampled per-action breakdown to confirm on the box.
- **The design, three parts (§26 has the full detail):**
  1. **Result-size cap in `audit()`** — `CONNECT_PBX_HELPER_AUDIT_RESULT_MAX_BYTES`
     (default 8 KB); oversized results become `{auditTruncated, resultBytes, resultKeys}`.
     ⛔ This cap, not rotation, is the real fix — rotation alone at 1.4 GB/day keeps under
     ONE day of history. ⛔ Don't drop read auditing instead: the line RATE proved the
     2026-08-12 flood fix.
  2. **In-process rename rotation** — `AUDIT_MAX_BYTES` 256 MB × `AUDIT_KEEP` 4, under a
     `threading.Lock`, `os.replace` shifts. Works because `audit()` opens per append (no
     held fd) and `/var/lib/connect-pbx-helper` is already in the unit's `ReadWritePaths`
     — **no root, no sudo (`NoNewPrivileges`), no logrotate, no new units** (§17a lesson:
     no root-side moving parts). Rotation failure must never fail the response
     (exactly-once invariant in the existing comment).
  3. **Backlog:** installer renames the 85 GB to `audit.jsonl.oversize-<date>` (instant,
     same fs) and **deletes ONLY with `CONNECT_PURGE_OLD_AUDIT=1`** — 85 GB of history is
     Izzy's call, default keep.
- ⛔ **Implementation traps (§26 list):** the helper source lives TWICE (standalone .py +
  `PYHELPER` heredoc in the installer) — change both byte-identical; build on the tip
  carrying **`526b56ba`** (`feat/ivr-migration-takeover`, helper 4,618 lines) — `main` and
  old `claude/*` branches hold a stale 863-line helper (the `1b0771bb` merge trap);
  `sha256sum` the live file vs the claimed base before install; guard tests assert on
  executable lines only (comment-trap, hit 3×); bump `VERSION`.
