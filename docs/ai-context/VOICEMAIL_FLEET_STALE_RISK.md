# Voicemail fleet stale risk — failure class, audit gap, hardening

> **Scope:** Multi-tenant voicemail **ingestion and visibility** (worker, API list, PBX helper).
> **Out of scope:** MOH, generated PBX dialplan files, manual SQL fixes.

---

## 1. Failure class: “silent stale voicemail detection”

**Symptom:** A tenant (e.g. Gesheft as canary) stops showing **new** voicemails in Connect (or shows misleading emptiness) while older tooling or spot checks still look “fine.”

**This is a class of failures**, not one tenant. Causes differ; the **observable** pattern is **staleness or mismatch between PBX truth, helper visibility, DB rows, and default UI filters.**

---

## 2. Why `voicemail-spool-audit.ts` can still look “healthy” (the production gap)

The legacy audit answers only:

> Among messages **returned by** `POST /voicemail/spool/list` with valid `origtime`, are any in the last **7d** **missing** a `Voicemail` row by `pbxMessageId`?

**Evidence-backed ways that returns “all clear” while the tenant is still broken:**

| Gap | What goes wrong | Why audit stays green |
|-----|-----------------|------------------------|
| **Helper / path drift** | Helper resolves the **wrong** Asterisk context or mailbox directory (slug drift, conf drift). | List is **empty** or shows **stale** messages only → **no** “missing” rows in 7d for files the helper never lists. |
| **Stale helper subset** | Disk has newer `msg*.txt` than the set the helper enumerates (implementation bug, permissions, partial scan). | Max `origtime` in response lags real PBX; if nothing “new” in 7d **in that list**, `missing_count_7d = 0`. |
| **REST-non-empty skips spool** | VitalPBX REST returns a **non-empty but wrong** list for a mailbox. Worker/API may **not** call the helper for that poll (`KNOWN_ISSUES.md`). | Audit **does** call the helper directly — it can still pass if helper list is empty/stale **and** there is no 7d message in the list to mismatch. |
| **Dedupe / ID mismatch** | Row exists under a **different** `pbxMessageId` than the helper now emits (caller id normalization, `msg_id` presence). | Less common; audit compares **current** helper IDs only. |
| **Default inbox-only UI** | `GET /voice/voicemail` defaults to **`folder=inbox`** (`apps/api/src/server.ts`). New or moved messages in **Old/Urgent** do not appear in the default list. | DB may have **fresh** `receivedAt` in non-inbox folders; user sees an **empty inbox**; audit may still be “healthy” if helper+DB agree on listed messages. |

**Conclusion:** “No missing messages in 7d in the helper list” ≠ “Tenant voicemail is healthy end-to-end.” The missing signal is **timeliness and alignment**: **newest PBX-visible timestamp vs newest DB timestamp vs inbox-scoped DB timestamp**, plus **volume vs baseline**.

---

## 3. Fleet report (implemented)

**Script:** `apps/worker/src/scripts/voicemail-fleet-stale-report.ts`

**Run (app host, `app-worker-1`):**

```bash
docker exec app-worker-1 bash -lc 'cd /app/apps/worker && pnpm exec tsx src/scripts/voicemail-fleet-stale-report.ts'
```

**Options:** `--tenant=`, `--extension=` (requires tenant), `--helper-delay-ms=`, `--min-risk=medium|high|critical`.

**Per mailbox JSON (`msg: voicemail-fleet-stale-row`), key fields:**

- `newest_pbx_vm_iso` — max valid `origtime` across **all** helper-listed messages (all folders returned).
- `newest_db_vm_iso` — `MAX(receivedAt)` for **non-deleted** rows, **any** folder.
- `newest_db_inbox_iso` — `MAX(receivedAt)` for `folder = 'inbox'` (aligns with **default** API/UI list).
- `newest_db_created_iso` — `MAX(createdAt)` (ingest event latency vs `receivedAt`).
- `delta_hours_pbx_minus_db` — positive ⇒ helper’s newest `origtime` is **ahead** of DB newest `receivedAt` (ingest lag or ID mismatch).
- `volume_7d`, `historical_avg_per_day_30d`, `expected_7d_from_baseline`.
- `mailbox_path`, `resolved_context`, `pbx_folder_max_origtime_sec` — evidence for path/folder drift.
- `stale_risk_level`, `likely_failure_mode` — ranked heuristics (not a substitute for log forensics).

**Summary line:** `msg: voicemail-fleet-stale-summary` with counts by risk level and `helper_errors`.

**Limits (honest):**

- “Newest PBX” is **only** as fresh as the helper list. It cannot see files the helper never returns (then rely on **empty list vs high baseline**, `mailbox_path` / `resolved_context`, and PBX disk forensics in `DEBUGGING.md`).
- Baseline uses a **30-day** window; tune thresholds in code if ops needs a longer seasonality window.

---

## 4. Silent failure modes mapped to signals

| Mode | Fleet report signals | Other evidence (no guessing) |
|------|----------------------|------------------------------|
| Helper path / slug drift | `helper_empty_or_zero_msgs_vs_high_historical_baseline`, empty `spool_message_count`, high `historical_avg_per_day_30d` | Helper JSON `mailboxPath`, `resolvedContext`; PBX `voicemail show users`; greeting diag (`DEBUGGING.md`) |
| Folder drift (INBOX vs Old) | `api_ui_default_inbox_stale_vs_other_folders`, large `pbx_folder_max_origtime_sec` spread | API query `folder` default `inbox`; DB folder column; user’s portal folder tab |
| Worker starvation / cap | `volume_collapse_vs_30d_baseline`; cross-check `voicemail-sync-cycle` `fair_helper_picks`, `fair_cursor` | Worker logs JSON (`TELEPHONY.md`) |
| REST-non-empty skip helper | Volume collapse + worker logs show `rest_count > 0`, `helper_count: 0` for mailbox | `KNOWN_ISSUES.md`, `DEBUGGING.md` §8 |
| Stale helper output | `db_newer_than_helper_max` or CRITICAL ingest lag with mismatched paths | Compare helper list to PBX disk `msg*.txt` mtime (read-only on PBX) |
| Soft-delete / UI | N/A in default row counts (report uses `deletedAt IS NULL`) | `DELETE /voice/voicemail/:id` soft-deletes; check `deletedAt` for support tickets |

---

## 5. Durable hardening plan (backlog)

**Alarms / SLA**

- Alert when **high-volume** tenant (e.g. `historical_avg_per_day_30d` ≥ threshold) has **zero** `Voicemail` inserts in **N** hours while PBX still signals VM (AMI / CDR / optional PBX metric).
- Alert when **`max(helper_origtime) - max(db.receivedAt)`** exceeds threshold **continuously** (requires storing last helper scan per mailbox in worker or metrics cache).

**Metrics (worker)**

- Gauge: `voicemail_newest_imported_at{tenant,extension}` (from DB or last successful upsert).
- Counter: `voicemail_ingest_total{tenant,source}` (rest vs helper).
- Histogram: helper list latency; `fair_helper_picks` vs `fair_needy_mailboxes`.

**Metrics (helper)**

- Expose **mailbox mtime** or **newest file timestamp** independently of full list (optional new read-only endpoint) to detect “list stale but disk fresh” without full enumeration.

**Admin / dashboard**

- Scheduled **fleet stale report** output (S3 or internal admin page) with sort by `stale_risk_level`.
- Drill-down: last `voicemail-sync-ext` lines for that mailbox, `VoicemailIngestIncident` rows.

**Ingestion SLA monitoring**

- Track time from PBX `origtime` to `Voicemail.createdAt` (p95 per tenant).
- Compare to REST-only vs helper fallback paths.

---

## 6. Related docs

- `DEBUGGING.md` — voicemail diagnostics flow (adds pointer to this doc).
- `KNOWN_ISSUES.md` — REST-non-empty, fair scheduler, inbox list behavior.
- `DEPLOYMENT.md` — operational recovery, worker deploy for new scripts.
- `TELEPHONY.md` — worker sync + helper architecture.

---

## 7. Gesheft-specific RCA (generalized)

Any single-tenant RCA must show **which row** of section 2 applied: helper list contents, `mailboxPath`, REST `voicemail_records` vs disk, default **inbox** API response vs DB by folder, and worker JSON for that cycle. **Do not** treat Gesheft as the only configuration of this failure class; use **`voicemail-fleet-stale-report.ts`** fleet-wide, then deep-dive **only** rows with elevated `stale_risk_level`.
