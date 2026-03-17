# PBX summary request failure — verification and fix

## How to get the exact failing point

1. **Dashboard:** When the Overview shows "PBX live metrics unavailable", the message under it is now the **exact API error** (e.g. `PBX_NOT_LINKED: No active PBX link for this tenant.` or `INVALID_API_KEY: …`).
2. **Run diagnostics (tenant scope only):** Click **"Run diagnostics"** below the error. The result shows:
   - **Step:** `link` | `decrypt` | `reach` | `ok`
   - **Message** and **Code**
   - **PBX host** (when available), **Has link**, **Instance enabled**
   - If step is `ok`, **Today KPIs** from CDR (proof of real numbers).
3. **Direct API:** `GET /pbx/live/diagnostics` (same auth as dashboard) returns the same structured payload.

## Answers to the 7 verification points

| # | Question | Answer in code |
|---|----------|----------------|
| 1 | **Tenant has a PBX link?** | `db.tenantPbxLink.findUnique({ where: { tenantId: user.tenantId }, include: { pbxInstance: true } })`. If `!link` → step `link`, code `PBX_NOT_LINKED`. |
| 2 | **Exact PBX base URL used?** | `link.pbxInstance.baseUrl`. Diagnostics returns `baseUrlHost` (hostname only). Full URL is in DB `PbxInstance.baseUrl`. |
| 3 | **API credentials valid?** | Credentials are decrypted from `link.pbxInstance.apiAuthEncrypted`. If decrypt throws → step `decrypt`, code `PBX_DECRYPT_FAILED`. If token missing → `PBX_MISSING_TOKEN`. If VitalPBX returns 401 → step `reach`, code `INVALID_API_KEY`. |
| 4 | **Connect backend can reach VitalPBX?** | Diagnostics (and combined) call `getVitalPbxClient(...).getCdrToday(...)`. If fetch fails / timeout / 5xx → step `reach`, code `PBX_UNREACHABLE` or `PBX_UNAVAILABLE`. |
| 5 | **Exact endpoint for “today” summary?** | VitalPBX client `getCdrToday(tenantId?, { timezone })` → `GET /api/v2/cdr` with query `start_date`, `end_date` (ISO), `limit`, `sort_by`, `sort_order`. Same CDR list as elsewhere; counts are computed client-side from `calltype` and `disposition`. |
| 6 | **Exact error returned now?** | Shown in dashboard error message (from 404/502 body). Diagnostics returns `step`, `message`, `code`. 404 = `PBX_NOT_LINKED`. 502 = `err.code` (e.g. `PBX_DECRYPT_FAILED`, `INVALID_API_KEY`, `PBX_UNREACHABLE`) and `err.message`. |
| 7 | **Timezone affecting totals?** | “Today” uses `PBX_TIMEZONE` env (IANA) if set; otherwise UTC midnight–now. Diagnostics returns `timezone: pbxTimezone ?? "UTC"`. If PBX is in another TZ, set `PBX_TIMEZONE` on the API server. |

## Failure → fix mapping

| Failing point | Code / step | Fix |
|---------------|--------------|-----|
| No PBX link | `PBX_NOT_LINKED`, step `link` | Configure a PBX link for the tenant (Settings / admin: link tenant to a PBX instance + optional tenant ID). |
| Instance disabled | `PBX_INSTANCE_DISABLED`, step `link` | Enable the PBX instance in admin. |
| Invalid base URL | `PBX_INVALID_BASE_URL` | Fix `PbxInstance.baseUrl` in DB (must be a valid URL). |
| Decrypt failed | `PBX_DECRYPT_FAILED`, step `decrypt` | Wrong or missing `CREDENTIALS_MASTER_KEY`; or re-save the PBX API token so it’s encrypted with the current key. |
| Missing token | `PBX_MISSING_TOKEN` | Re-save the PBX instance with a valid API token. |
| Invalid/expired API key | `INVALID_API_KEY`, step `reach` | Update the VitalPBX app-key (token) in the PBX instance and re-save. |
| Network/timeout | `PBX_UNREACHABLE` / `PBX_UNAVAILABLE`, step `reach` | Ensure the API server can reach the PBX base URL (firewall, DNS, TLS). |
| Timezone mismatch | N/A (totals zero but PBX has calls) | Set `PBX_TIMEZONE` on the API server to the PBX/business IANA timezone. |

## Files changed

- **apps/api/src/server.ts**
  - `GET /pbx/live/diagnostics`: runs link → decrypt → reach (getCdrToday) and returns step, message, code, baseUrlHost, and on success today KPIs.
  - `fetchPbxLiveSummaryForLink`: try/catch around decrypt; throws with `code: "PBX_DECRYPT_FAILED"` or `"PBX_MISSING_TOKEN"` so 502 body is explicit.
- **apps/portal/services/pbxLive.ts**: `loadPbxLiveDiagnostics()`, type `PbxLiveDiagnostics`.
- **apps/portal/app/(platform)/dashboard/page.tsx**: Error state shows actual API error message; tenant scope adds “Run diagnostics” and displays diagnostics result (step, message, code, host, and KPIs when step is `ok`).

After fixing the reported issue (e.g. adding the link or correcting credentials), reload the dashboard; the combined request should succeed and the KPI cards will show real numbers. If step is `ok` in diagnostics, the same CDR path is used for the main combined response.
