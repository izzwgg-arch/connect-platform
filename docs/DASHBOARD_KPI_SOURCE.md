# Dashboard daily KPI – source of truth and fix summary

## Source of truth for each KPI

| KPI | Source | How it’s derived |
|-----|--------|-------------------|
| **Incoming Today** | VitalPBX `/api/v2/cdr` | CDR rows in “today” window with `calltype === 2` (or direction indicating inbound). |
| **Outgoing Today** | VitalPBX `/api/v2/cdr` | CDR rows in “today” window with `calltype === 3` (or direction indicating outbound). |
| **Internal Today** | VitalPBX `/api/v2/cdr` | CDR rows in “today” window with `calltype === 1` (or direction “internal”). |
| **Missed Today** | VitalPBX `/api/v2/cdr` | Inbound rows in “today” window where `disposition !== "ANSWERED"`. |

All four KPIs are computed in the **VitalPBX client** (`getCdrToday`) from the same CDR list response. The API does not expose a separate “KPI” endpoint; the existing `/pbx/live/combined` (tenant) and `/admin/pbx/live/combined` (admin) responses include a `summary` object with `incomingToday`, `outgoingToday`, `internalToday`, `answeredToday`, `missedToday`. The dashboard reads `combined.summary` and displays these values.

## Files changed

1. **`packages/integrations/src/vitalpbx/client.ts`**
   - Added `getTodayBoundsInTimezone(tz)` to compute start/end of “today” in an IANA timezone (no new dependency).
   - `getCdrToday(tenantId?, options?: { timezone?: string })` now:
     - Uses `options.timezone` to set the “today” window to the business day in that timezone; otherwise keeps UTC midnight to now.
     - Sends both `start_date` and `end_date` as ISO strings to the CDR API and filters rows by that range.
     - Parses response from `data.result` / `data.items` / `data.rows` / `data` / `envelope.result`.
     - Counts **missed** only for inbound calls that were not answered (not all non-answered calls).

2. **`apps/api/src/server.ts`**
   - `fetchPbxLiveSummaryForLink` now passes `{ timezone: process.env.PBX_TIMEZONE || undefined }` into `client.getCdrToday(...)`.

3. **`apps/api/.env.example`**
   - Documented optional `PBX_TIMEZONE` (e.g. `America/New_York`) for the “today” KPI window.

## Why the KPIs were zero before

1. **“Today” was UTC midnight**  
   The code used only `start_date` at UTC midnight and no `end_date`. For a business in e.g. America/New_York, in the evening local time it’s already the next calendar day in UTC, so the UTC “today” window didn’t match the local business day and often returned no (or wrong) CDR rows.

2. **No timezone configuration**  
   There was no way to set the PBX/business timezone, so “today” could not be aligned with the business day.

3. **Missed was overcounted**  
   Previously every non-answered call was counted as missed; the definition is “inbound calls not answered,” so only inbound + non-answered are now counted as missed.

## How to get non-zero values

1. **Set `PBX_TIMEZONE`** in the API environment to the PBX/business IANA timezone (e.g. `America/New_York`). See `apps/api/.env.example`.
2. Ensure the VitalPBX CDR API returns rows for that day (PBX has CDR enabled and there is call activity).
3. Tenant scope is unchanged: tenant view uses that tenant’s PBX link; admin view aggregates the same summary across allowed tenants.

No mocks, hardcoded numbers, or UI-only changes were added; the cards are wired to the same backend summary that now uses the correct “today” window and missed definition.
