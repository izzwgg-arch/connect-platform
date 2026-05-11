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
| **Stale helper subset** | Disk has newer `msg*.txt` than the set the helper enumerates (implementation bug, permissions, partial scan). | **Fixed in helper `VERSION` `2026.05.10.1`+:** prior builds capped at **400** messages and walked **filename order**, so the returned set could miss the newest files entirely while still filling the cap (`spool_message_count == 400`). Newer helpers scan all folders, sort by **`origtime` desc**, paginate, and expose **`maxOrigtimeAll` / `truncated`**. |
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

---

## 8. Staged rollout — schema-2 PBX helper + Connect (`e78a0de`)

### 8.1 Root cause (why voicemails stayed missing after Connect shipped)

Connect **`e78a0de`** can **page and merge** helper responses (`fetchAllVoicemailSpoolMessages`). Production was still running helper **`2026.05.08.2`**, which **does not** implement schema **2**: it behaves like a **hard-capped, wrong-sorted** spool window (typically **400** rows, no **`maxOrigtimeAll`**). Busy mailboxes (e.g. Gesheft **101** / **102**) can therefore omit **newest** `origtime` files entirely while Connect “successfully” ingests only the stale subset.

**Required on-PBX:** helper **`VERSION` `2026.05.10.1`** or newer from the **same pinned installer** as commit **`e78a0de`** (`scripts/pbx/install-vitalpbx-inbound-route-helper.sh`).

### 8.2 Connect side (completed)

**Deploy queue:** `api` and `worker` deployed at **`e78a0de`** (log tails: `[deploy-api] done e78a0de …`, `[deploy-worker] done e78a0de …`). API loopback health `{"ok":true}`. Worker image includes **`fetchAllVoicemailSpoolMessages`** (`packages/integrations/src/pbxRouteHelperEnv.ts` in-container).

### 8.3 PBX side — automated agent limit (2026-05-11)

**From Connect app host** (`ssh connect`): **`curl -s http://209.145.60.79:8757/health`** still returned **`"version":"2026.05.08.2"`** — schema **2** **not** live.

**IDE / agent SSH:** **`root@209.145.60.79`** is **not** available from the Cursor agent environment (**`Permission denied (publickey)`**). **Operator with root (or jump host) on the PBX** must run §8.4–8.6.

### 8.4 Rollback **before** upgrade (PBX root; run first)

Pinned installer **re-writes** `/etc/connect-pbx-helper.env` from values loaded at start of the script; on a normal **re-run**, it **sources** the existing file first, so **`CONNECT_PBX_HELPER_SECRET`** and MySQL password **carry forward** — no silent rotation **if** `/etc/connect-pbx-helper.env` already exists.

**Caveats (read before `bash`):**

- The installer runs **`chown -R asterisk:asterisk /var/spool/asterisk/voicemail`** (permission repair). It does **not** delete messages, but it **does** touch the spool tree.
- On **first start** after upgrade, the embedded Python may run **`asterisk -rx "dialplan reload"`** **only if** the auto-managed VM-greeting drop-in content **changed** vs what is on disk (usually **no** reload when content is unchanged).

```bash
# PBX as root — snapshot BEFORE upgrade
TS=$(date +%Y%m%d-%H%M%S)
B=/root/connect-pbx-helper-backup-$TS
mkdir -p "$B"
cp -a /opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py "$B/" 2>/dev/null || true
cp -a /etc/connect-pbx-helper.env "$B/" 2>/dev/null || true
cp -a /etc/systemd/system/connect-pbx-helper.service "$B/" 2>/dev/null || true
cp -a /etc/asterisk/vitalpbx/extensions__95-connect-vm-greeting.conf "$B/" 2>/dev/null || true
echo "Backup dir: $B"
```

**Rollback procedure (if upgrade is bad):**

```bash
# PBX as root
B=/root/connect-pbx-helper-backup-<TS>   # use the path printed above
systemctl stop connect-pbx-helper
cp -a "$B/vitalpbx-inbound-route-helper.py" /opt/connect-pbx-helper/
cp -a "$B/connect-pbx-helper.env" /etc/connect-pbx-helper.env
chmod 0600 /etc/connect-pbx-helper.env
chown root:root /etc/connect-pbx-helper.env
# Optional: restore unit or drop-in if you backed them up and they differed
systemctl daemon-reload
systemctl start connect-pbx-helper
curl -s http://127.0.0.1:8757/health
```

**Rollback used in this thread:** **not used** (no successful PBX upgrade executed from the agent).

### 8.5 Preflight (PBX root)

```bash
curl -s http://127.0.0.1:8757/health
systemctl status connect-pbx-helper --no-pager -l || true
test -f /etc/connect-pbx-helper.env && echo "env: ok" || echo "env: MISSING"
# Optional fingerprint only (do not paste secret): shasum /etc/connect-pbx-helper.env
```

Record **before** version (expect **`2026.05.08.2`** until upgraded).

### 8.6 Upgrade (PBX root) — pin **`e78a0de`**

```bash
curl -fsSL https://raw.githubusercontent.com/izzwgg-arch/connect-platform/e78a0de/scripts/pbx/install-vitalpbx-inbound-route-helper.sh -o /root/install-vitalpbx-inbound-route-helper-e78a0de.sh
bash /root/install-vitalpbx-inbound-route-helper-e78a0de.sh
curl -s http://127.0.0.1:8757/health
```

The script ends with **`systemctl restart connect-pbx-helper`** (helper only). **Do not** `systemctl restart asterisk` unless ops has a separate break-glass reason.

### 8.7 Verify schema 2 (PBX loopback or app host)

Authenticated **`POST /voicemail/spool/list`** for Gesheft (**`tenantId` `8`**, extensions **`101`** and **`102`**) must show at least:

- **`spoolListSchema`: 2**
- **`totalCount`**, **`returnedCount`**, **`truncated`**, **`maxOrigtimeAll`** (non-empty), **`sort`: `origtime_desc`**, **`folderMsgCounts`**
- **`totalCount` ≥** prior ~**400** when the mailbox is larger than the old cap
- First page **`messages`** newest-first by **`origtime`**

Use header **`x-connect-pbx-helper-secret`** matching **`CONNECT_PBX_HELPER_SECRET`** on the PBX (aligns with Connect **`PBX_ROUTE_HELPER_*`** for that instance). **Do not** paste secrets into tickets.

**Probes from Connect:** prefer **`docker exec app-worker-1`** + **`voicemail-spool-audit.ts`** / **`voicemail-fleet-stale-report.ts`** (same env as production). A raw `curl` using only **`app-api-1`** global **`PBX_ROUTE_HELPER_SECRET`** may return **`unauthorized`** when **`PBX_ROUTE_HELPER_BY_INSTANCE_JSON`** supplies the real secret.

### 8.8 Backfill + fleet (app host, `app-worker-1`)

After §8.7 passes:

```bash
docker exec app-worker-1 bash -lc 'cd /app/apps/worker && pnpm exec tsx src/scripts/voicemail-spool-backfill.ts --tenant=cmnlgnumu0001p9g6xyl1pbdd --extension=101'
docker exec app-worker-1 bash -lc 'cd /app/apps/worker && pnpm exec tsx src/scripts/voicemail-spool-backfill.ts --tenant=cmnlgnumu0001p9g6xyl1pbdd --extension=102'
docker exec app-worker-1 bash -lc 'cd /app/apps/worker && pnpm exec tsx src/scripts/voicemail-fleet-stale-report.ts --min-risk=medium'
```

Expect Gesheft **101**/**102** **`helper_spool_list_schema`: 2** and **no** stale **`HIGH`** driven solely by the old **400**-row cap / missing **`maxOrigtimeAll`**. Confirm **inserted > 0** when DB was missing rows the helper can now see; confirm portal/mobile lists.

### 8.9 Pre-upgrade evidence (Connect worker, legacy helper)

With helper still **`2026.05.08.2`**, **`voicemail-spool-audit.ts`** for Gesheft **101**/**102** showed **`spool_total`: 400**, **`helper_max_origtime_all`: null**, **`helper_pagination_complete`: true** (single legacy page). **`voicemail-spool-backfill.ts`** reported **400** messages and **0 inserts** (already ingested for that subset). **`voicemail-fleet-stale-report.ts`** (`--min-risk=medium`) left **Gesheft 101**/**102** at **`stale_risk_level`: HIGH** with **`spool_message_count`: 400** and **`helper_spool_list_schema`: null**.

**Post-PBX-upgrade transcript:** operator should paste **before/after** `/health`, sample redacted **`spool/list`** metadata for **101**/**102**, backfill **`inserted`** counts, and fleet summary **after** §8.8 into the ticket (replace §8.9 numbers).
