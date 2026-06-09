\echo === Totals after push ===
SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE "tenantId" IS NULL)                AS tenantless,
       COUNT(*) FILTER (WHERE "ownershipConfidence" = 'unknown') AS unknown_conf,
       COUNT(*) FILTER (WHERE "ownershipConfidence" = 'exact')   AS exact_conf,
       COUNT(*) FILTER (WHERE "storageKey" IS NULL)              AS no_audio,
       COUNT(*) FILTER (WHERE "storageKey" LIKE 'tenants/%')     AS tenant_scoped_audio,
       COUNT(*) FILTER (WHERE "storageKey" IS NOT NULL AND "storageKey" NOT LIKE 'tenants/%') AS legacy_flat_audio
FROM "TenantPbxPrompt";

\echo
\echo === THE ISOLATION PROOF: every tenant that owns a recording called 'Main' ===
SELECT p."tenantId",
       t.name AS tenant,
       p."promptRef",
       p."displayName",
       p."ownershipConfidence",
       p."storageKey",
       p."sizeBytes",
       left(p.sha256, 12) AS sha_prefix
FROM "TenantPbxPrompt" p
LEFT JOIN "Tenant" t ON t.id = p."tenantId"
WHERE p."promptRef" = 'custom/Main'
ORDER BY t.name NULLS LAST;

\echo
\echo === B Visible catalog (user's current UI view) ===
SELECT p."promptRef", p."displayName", p."ownershipConfidence",
       (p."storageKey" IS NOT NULL) AS has_audio,
       p."storageKey"
FROM "TenantPbxPrompt" p
WHERE p."tenantId" = 'cmnlgryp8001lp9pajhatv3t9'
ORDER BY p."promptRef";

\echo
\echo === Trimpro catalog ===
SELECT p."promptRef", p."displayName", p."ownershipConfidence",
       (p."storageKey" IS NOT NULL) AS has_audio,
       p."storageKey"
FROM "TenantPbxPrompt" p
WHERE p."tenantId" = 'cmnlgryjk0003p9pabtu1z1oj'
ORDER BY p."promptRef";

\echo
\echo === Per-tenant row + audio counts ===
SELECT COALESCE(t.name, '(unassigned)') AS tenant,
       COUNT(*)                                        AS rows,
       COUNT(*) FILTER (WHERE p."storageKey" IS NOT NULL) AS with_audio,
       COUNT(*) FILTER (WHERE p."ownershipConfidence" = 'exact') AS confident
FROM "TenantPbxPrompt" p
LEFT JOIN "Tenant" t ON t.id = p."tenantId"
GROUP BY t.name
ORDER BY rows DESC, tenant;

\echo
\echo === Any cross-tenant sha256 collisions (same bytes, different tenant rows)? ===
SELECT sha256,
       COUNT(DISTINCT "tenantId") AS distinct_tenants,
       array_agg(DISTINCT "tenantId")
FROM "TenantPbxPrompt"
WHERE sha256 IS NOT NULL
GROUP BY sha256
HAVING COUNT(DISTINCT "tenantId") > 1
LIMIT 20;
