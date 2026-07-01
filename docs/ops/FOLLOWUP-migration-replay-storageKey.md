# FOLLOW-UP: `prisma migrate deploy` cannot replay from an empty database

**Status:** Open — required cleanup, **not scheduled**.
**Severity:** Disaster-recovery / new-environment risk (does NOT affect running
production, which is already past the offending migration).
**Owner:** _TBD_
**Do NOT fix inside the MOH branch** unless explicitly approved. This is
tracked separately so it does not entangle the MOH per-call-source work.

---

## Summary

A from-scratch `prisma migrate deploy` (fresh/empty Postgres, full history
replay) **fails** at migration:

```
20260426020000_tenant_prompt_isolation
```

with:

```
Error: P3018  A migration failed to apply.
Database error code: 42703
ERROR: column "storageKey" of relation "TenantPbxPrompt" does not exist
  ...
  UPDATE "TenantPbxPrompt" SET "ownershipConfidence" = 'unknown';
  -- (then) null out audio pointers ...  <-- references storageKey
```

The migration references `TenantPbxPrompt.storageKey` (and/or other audio
pointer columns) that do not yet exist at that point in the migration history —
they are introduced by a **later** migration. So the ordered replay breaks.

## How it was discovered

During the MOH DB/API-layer validation (2026-06-30/07-01), against a **throwaway
local `postgres:16` container** (`localhost:55433`, DB `connect_stage`):

1. `npx prisma migrate deploy` from an empty DB → failed at
   `20260426020000_tenant_prompt_isolation` (P3018, as above).
2. Workaround for MOH validation only: `prisma db push` (materialize current
   schema, bypassing history) + isolated apply of the MOH `migration.sql` /
   `ROLLBACK.sql`. `prisma migrate diff` then reported **no drift**.

The MOH migration itself is clean. This failure is **pre-existing and unrelated**.

## Why it matters

- **Disaster recovery:** rebuilding the database purely from migration history
  (the canonical DR story) currently does not work end-to-end.
- **New environments:** any brand-new staging/dev/CI database created via
  `migrate deploy` (rather than `db push`) will fail at this migration.
- **CI:** any pipeline that provisions a DB via `migrate deploy` is affected.

Existing production/staging DBs that already applied this migration in order
(when the column existed at the time) are **not** affected going forward.

## Likely root cause

The `UPDATE`/pointer-nulling statements in
`20260426020000_tenant_prompt_isolation` assume `TenantPbxPrompt.storageKey`
exists, but in strict historical replay order that column is added by a later
migration. Either:
- the column was hand-added out-of-band on the environments where this migration
  was first run (so it "worked" there but the history is not self-consistent), or
- two migrations were authored/committed out of dependency order.

## Remediation options (pick one — needs approval)

1. **Guard the offending statements** so they no-op when the column is absent
   (e.g. wrap in a `DO $$ ... IF EXISTS (column) THEN ... END $$;` block). Lowest
   risk; makes the historical migration self-consistent without altering the
   already-applied end state.
2. **Reorder / split** so the column-creating migration precedes the migration
   that reads it. Higher risk; editing historical migrations already applied in
   production must preserve the final schema exactly.
3. **Baseline / squash** the historical migrations into a known-good baseline and
   mark it applied on existing environments (`prisma migrate resolve`). Larger
   effort; good long-term hygiene for an 80+ migration history.

Any chosen fix **must** be validated by a clean from-empty
`prisma migrate deploy` on a throwaway DB, and must leave the resolved schema
byte-identical to the current `schema.prisma` (verify with
`prisma migrate diff --exit-code`).

## Acceptance criteria

- [ ] `prisma migrate deploy` succeeds against a fresh empty Postgres.
- [ ] Resolved schema matches `schema.prisma` (`prisma migrate diff` exit 0).
- [ ] Existing environments require no destructive change (final schema unchanged).
- [ ] CI/DR docs updated if the provisioning path changes.

## Cross-references

- `docs/ai-context/KNOWN_ISSUES.md` → Database section (pointer entry).
- `docs/pbx/moh-db-validation.md` (where the failure surfaced).
- Migration: `packages/db/prisma/migrations/20260426020000_tenant_prompt_isolation/migration.sql`.
