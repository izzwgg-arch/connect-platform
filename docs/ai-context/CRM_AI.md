# CRM AI Lead Intelligence — Governance & Operations Guide

> This document covers **Phase 7 / 7B** of CRM lead document ingestion:
> AI report generation, tenant cost controls, governance rules, and operational limits.
>
> For the full CRM data model see `DATA_MODEL.md`.
> For API routes see `API_ROUTES.md`.
> For known limitations see `KNOWN_ISSUES.md`.

---

## Feature Overview

AI Lead Intelligence generates an **advisory** report for a CRM contact by aggregating:
- Contact details (name, company, existing phones/emails)
- Imported Google Drive documents (metadata + extracted text)
- Contact discovery records (phones/emails found in documents)

The report contains: executive summary, business overview, key findings, risk flags, missing
information, discovered entities, and a confidence score.

**Key safety principles:**
- Advisory output only — no contact data is modified automatically
- No raw document text, API keys, or prompt content is stored or returned to clients
- All generation is tenant-scoped with strict isolation
- All limits are configurable per tenant with hard server caps

---

## Data Models

### `CrmLeadIntelligenceReport`

One report per contact (`contactId` is unique). Upserted on regeneration.

| Field | Type | Notes |
|---|---|---|
| `id` | cuid | |
| `tenantId` | String | FK → Tenant |
| `contactId` | String unique | FK → Contact |
| `importBatchId` | String? | FK → CrmImportBatch |
| `status` | Enum | PENDING / PROCESSING / COMPLETE / FAILED |
| `summary` | String? | Executive summary (≤ 2000 chars) |
| `businessOverview` | String? | Full business overview (≤ 3000 chars) |
| `keyFindings` | JSON? | Structured counts and notes |
| `discoveredEntities` | JSON? | Phones, emails, addresses, websites found |
| `riskFlags` | JSON? | Array of risk flag keys |
| `missingInformation` | JSON? | Array of missing info keys |
| `confidenceScore` | Float? | 0.0–1.0 |
| `modelName` | String? | e.g. `gpt-4o-mini` |
| `providerName` | String? | e.g. `openai` |
| `generatedAt` | DateTime? | When generation completed |
| `error` | String? | Safe error message (≤ 500 chars; no AI response content) |
| `sourceDocumentCount` | Int? | Total imported documents for contact |
| `sourceTextCount` | Int? | Documents with extracted text |
| `sourceDiscoveryCount` | Int? | Phone + email discoveries |
| `promptCharCount` | Int? | Total characters sent to AI |
| `documentsIncluded` | Int? | Documents actually included in prompt |
| `documentsExcluded` | Int? | Documents excluded due to tenant limits |
| `generationDurationMs` | Int? | Wall-clock time of AI call (ms) |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |

**Never stored:**
- Raw prompt text
- API keys
- Document content

---

### `CrmAiSettings`

Per-tenant AI governance settings. Absence of a row means all defaults apply.

| Field | Type | Default | Hard Cap |
|---|---|---|---|
| `aiEnabled` | Boolean | `true` | — |
| `maxDocumentsPerReport` | Int | `5` | `10` |
| `maxCharsPerDocument` | Int | `2000` | `5000` |
| `maxTotalCharsPerReport` | Int | `10000` | `25000` |
| `allowBatchGeneration` | Boolean | `true` | — |
| `maxBatchReportsPerRun` | Int | `25` | `25` |
| `regenerationCooldownMinutes` | Int | `60` | none (min: 0) |

**Hard caps** are enforced server-side in `loadTenantAiSettings()` regardless of what is stored.
No API call can store a value above a hard cap.

---

## Governance Model

### Before Every Generation

`generateIntelligenceReport()` runs these checks in order before setting status to PROCESSING:

1. **`aiEnabled`** — if false, throw `ai_disabled` (HTTP 403)
2. **Contact ownership** — contact must belong to `tenantId`
3. **Existing report** — COMPLETE + `!force` → return skipped
4. **PROCESSING guard** — return skipped (prevents double-generation)
5. **Cooldown** — if `force=true`, `existing.status=COMPLETE`, and not admin:
   - Calculate `elapsedMs = now - generatedAt`
   - If `elapsedMs < regenerationCooldownMinutes * 60000` → throw `cooldown_active`
   - Error includes `retryAfterMs` and human message: "Report was generated N minutes ago. Retry allowed in M minutes."
   - CRM admin role (`ADMIN`, `TENANT_ADMIN`, `SUPER_ADMIN`) bypasses this check

### Document Selection

After fetching all IMPORTED documents for the contact:

```
includedDocs = allDocs.slice(0, maxDocumentsPerReport)
excludedDocsCount = allDocs.length - includedDocs.length
```

Per-document char limit: `snippet = raw.slice(0, maxCharsPerDocument).slice(0, remaining)`

Total char cap: loop stops adding snippets once `totalChars >= maxTotalCharsPerReport`

### Batch Generation

`generateBatchIntelligence()` checks:
1. `aiEnabled` — blocks with `ai_disabled`
2. `allowBatchGeneration` — blocks with `batch_generation_disabled`
3. `effectiveLimit = min(maxBatchReportsPerRun, requestedLimit)`
4. Contacts beyond `effectiveLimit` are counted as `skipped_limit`
5. Contacts with existing COMPLETE reports (no force) are counted as `skipped_existing`

### Audit Events

All events are written as structured JSON to stdout (captured by Pino in production).
Search logs for `"audit":true`.

| Event | When |
|---|---|
| `crm_ai_report_generated` | First successful generation |
| `crm_ai_report_regenerated` | Force-regeneration of COMPLETE report |
| `crm_ai_report_failed` | AI provider error or `ai_not_configured` |
| `crm_ai_batch_generation_started` | Before batch loop |
| `crm_ai_batch_generation_completed` | After batch loop with final counts |
| `crm_ai_limit_blocked` | `ai_disabled`, `cooldown_active`, `document_limit_exceeded` |

Audit log fields always include `tenantId`. Never include document text, API keys, or raw prompts.

---

## Provider Architecture

Interface: `LeadIntelligenceProvider` in `apps/api/src/crm/leadIntelligenceProvider.ts`

```typescript
interface LeadIntelligenceProvider {
  name: string;
  generateReport(input: IntelligenceInput): Promise<IntelligenceOutput>;
}
```

Current implementation: `OpenAiLeadIntelligenceProvider`
- Model: `gpt-4o-mini` (default) or `LEAD_INTELLIGENCE_MODEL` env var
- JSON output mode (`response_format: { type: "json_object" }`)
- Temperature: `0.3` for consistent structured output

To add a provider: implement the interface and update `getLeadIntelligenceProvider()`.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes (for AI) | — | OpenAI API key. Absence returns `ai_not_configured` (503). |
| `LEAD_INTELLIGENCE_MODEL` | No | `gpt-4o-mini` | OpenAI model override |

---

## Error Codes

| Code | HTTP | Cause |
|---|---|---|
| `ai_disabled` | 403 | `aiEnabled=false` in tenant settings |
| `ai_not_configured` | 503 | `OPENAI_API_KEY` not set |
| `cooldown_active` | 429 | Force-regen within cooldown window; includes `retryAfterMs` |
| `batch_generation_disabled` | 403 | `allowBatchGeneration=false` |
| `contact_not_found` | 404 | Contact not in tenant |
| `batch_not_found` | 404 | Batch not in tenant |
| `generation_failed` | 422 | AI provider error |

---

## Settings UI

**Path:** CRM Settings → AI Intelligence Settings section

**Access:** CRM admin role required for PUT. Any CRM user can view (GET).

Fields displayed with inline validation:
- AI Enabled (master toggle)
- Max Documents per Report (1–10)
- Max Chars per Document (100–5000)
- Max Total Chars per Report (500–25000)
- Max Batch Reports per Run (1–25)
- Regeneration Cooldown in minutes (0 = no cooldown)
- Allow Batch Generation (toggle)

---

## Contact Intelligence UI

**Tab:** AI Intelligence (contact page)

Shows when COMPLETE:
- Executive summary
- Provider + model
- Generation time (seconds)
- Documents analyzed / excluded
- Characters processed
- Confidence meter
- Business overview, key findings, risk flags, missing info
- Discovered entities

**Exclusion warning** — displayed when `documentsExcluded > 0`:
> "N documents were excluded due to AI document limits. Adjust limits in CRM Settings → AI Intelligence Settings."

**Cooldown message** — displayed on 429 Regenerate response:
> "Report was generated N minutes ago. Retry allowed in M minutes."
