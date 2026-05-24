# Custom Roles — Architecture & Reference

> Added: 2026-06-03. Risk: HIGH (auth/permissions foundation).
> Read `CURSOR_START_HERE.md` before modifying anything in this file's scope.

---

## Overview

Custom roles allow tenant admins to create unlimited named permission sets
that are **additively unioned** with a user's built-in role bucket
(`END_USER` / `TENANT_ADMIN` / `SUPER_ADMIN`).

Key invariants:
- Custom roles **add** permissions. They never remove built-in permissions.
- Inactive roles (`active: false`) are **ignored** during resolution.
- `SUPER_ADMIN` users cannot be weakened by any custom role.
- All tenant isolation is enforced at the **backend API layer** only.
  Frontend hiding is supplementary, not a security boundary.

---

## Data Model

### `CustomRole`

Tenant-scoped. Schema: `packages/db/prisma/schema.prisma` (end of file).
Migration: `packages/db/prisma/migrations/20260603000000_custom_roles/`.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (cuid) | PK |
| `tenantId` | `String` | FK → `Tenant` (Cascade delete) |
| `name` | `String` | Max 80 chars. Unique per tenant. |
| `description` | `String?` | Optional. Max 500 chars. |
| `active` | `Boolean` | Default `true`. Inactive = ignored. |
| `permissions` | `Json` | Array of `PortalPermissionKey` strings. |
| `createdByUserId` | `String?` | FK → `User` (SetNull) |
| `updatedByUserId` | `String?` | FK → `User` (SetNull) |
| `createdAt` | `DateTime` | Auto. |
| `updatedAt` | `DateTime` | Auto-updated. |

Unique: `(tenantId, name)`.

### `UserCustomRole`

Assignment table. Schema: same file.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (cuid) | PK |
| `tenantId` | `String` | FK → `Tenant` (Cascade) |
| `userId` | `String` | FK → `User` (Cascade) |
| `customRoleId` | `String` | FK → `CustomRole` (Cascade) |
| `assignedByUserId` | `String?` | FK → `User` (SetNull) |
| `createdAt` | `DateTime` | Auto. |

Unique: `(userId, customRoleId)`.

---

## Permission Evaluation Rules

```
effective_permissions(user) =
  built_in_role_bucket_permissions(user.role)
  ∪ crm_permissions_if_enabled(user)
  ∪ union(customRole.permissions for each active custom role assigned to user)
```

The resolver is `resolvePortalPermissionsWithCrmUserAccess()` in
`apps/api/src/crm/portalCrmPermissions.ts`. This is the **single point**
that computes all effective permissions. Every API route permission check
flows through `hasEffectivePortalPermission()` →
`resolvePortalPermissionsWithCrmUserAccess()`.

**All existing permission checks automatically benefit from custom roles
without any code changes.**

The `/me` endpoint returns `portalPermissionSet` which includes custom role
permissions, so the portal sidebar and `PermissionGate` components reflect
custom roles immediately.

---

## Grantability Rules

| Actor | Can grant |
|---|---|
| `SUPER_ADMIN` | Any `PortalPermissionKey` |
| `TENANT_ADMIN` | Their own effective permissions minus `PROTECTED_PLATFORM_ADMIN_PERMISSIONS` |
| `END_USER` | Nothing — blocked at API level (403) |

`PROTECTED_PLATFORM_ADMIN_PERMISSIONS` (from `packages/shared/src/portalPermissions.ts`):
- `can_view_section_admin`
- `can_view_admin_permissions`
- `can_manage_global_settings`

Additionally, `TENANT_ADMIN` cannot grant `SUPER_ADMIN`-only keys
(`can_switch_tenants`, `can_manage_deploys`, `can_sync_voip_ms_numbers`,
`can_view_admin_deploy_center`) because these are absent from the TENANT_ADMIN
default permission set and therefore outside their grantable set.

Cross-tenant privilege escalation is prevented by scoping every write to the
actor's own `tenantId` (or, for `SUPER_ADMIN`, to the explicitly supplied
`tenantId`).

---

## API Routes

All routes require JWT auth. The `PORTAL_API_PERMISSION_RULES` hook in
`apps/api/src/server.ts` pre-checks `can_view_admin_roles` for every
`/admin/custom-roles/*` request.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/admin/custom-roles/permissions-catalog` | Permission catalog + actor's grantable set |
| `GET` | `/admin/custom-roles` | List roles. `?tenantId=` for SUPER_ADMIN. |
| `GET` | `/admin/custom-roles/:id` | Get single role |
| `POST` | `/admin/custom-roles` | Create role. Validates grantability. |
| `PUT` | `/admin/custom-roles/:id` | Update role. Validates grantability. |
| `DELETE` | `/admin/custom-roles/:id` | Hard delete (cascades assignments). |
| `POST` | `/admin/custom-roles/:id/duplicate` | Creates inactive copy. |
| `GET` | `/admin/custom-roles/:id/users` | List assigned users. |
| `GET` | `/admin/users/:userId/custom-roles` | List user's custom roles. |
| `PUT` | `/admin/users/:userId/custom-roles` | Replace user's custom role set. |
| `GET` | `/admin/users/:userId/effective-permissions` | Full resolved permission list. |

Route implementation: `apps/api/src/customRoleRoutes.ts`.

---

## UI Behavior

**List page**: `apps/portal/app/(platform)/admin/roles/page.tsx`

- Lists all custom roles for the current tenant.
- Shows permission count, user count, and active status.
- Actions: Edit, Duplicate (creates inactive copy), Delete.
- Accessible at `/admin/roles` (permission: `can_view_admin_roles`).

**Create/Edit page**: `apps/portal/app/(platform)/admin/roles/[id]/page.tsx`

- `/admin/roles/new` → create mode.
- `/admin/roles/:id` → edit mode.
- Permission matrix grouped by sidebar section + action keys.
- Permissions outside the actor's grantable set are greyed/disabled.
- Dangerous elevated permissions show a warning badge.

---

## Deny/Override

**Not implemented.** Permissions are additive only.
Deny/override semantics require significant API contract changes and
should be designed explicitly before implementing. Current behavior:
custom roles can only ADD to a user's built-in permission set.

---

## Backward Compatibility

- Existing users without custom role assignments behave identically to before.
- Existing JWT/static role logic is unchanged.
- `PlatformRolePermissionSnapshot` continues to control built-in bucket defaults.
- `can_view_admin_roles` is automatically included in the `can_view_admin`
  legacy expansion, so tenants with saved snapshots that include `can_view_admin`
  automatically get the new nav item.

---

## Rollback Plan

1. Set all `CustomRole.active = false` (no code change needed; DB update only).
   Custom roles are immediately ignored in all permission checks.
2. To fully remove:
   - Drop `UserCustomRole` table.
   - Drop `CustomRole` table.
   - Remove `getEffectiveCustomRolePermissions` call from
     `portalCrmPermissions.ts`.
   - Remove `registerCustomRoleRoutes` from `server.ts`.
   - Remove `can_view_admin_roles` from `portalPermissions.ts`.
   - Remove the portal UI pages.
3. No migration of existing user JWTs or role assignments required.
   Existing `SUPER_ADMIN` / `TENANT_ADMIN` / `END_USER` behavior is
   unaffected since custom roles are purely additive.
