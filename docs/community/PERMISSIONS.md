# Loopcom Community — permissions matrix

Generated from `src/organizations/permissions.ts`. Three layers, checked in order: platform (StaffGrant), organization (Membership role + explicit keys), relationship (degree/blocks/section visibility in `src/policy/graph.ts`).

## Organization roles × permission keys

| Key | OWNER | ADMIN | MANAGER | EMPLOYEE | RECRUITER | SALES | MARKETING | BILLING_ADMIN | MODERATOR | CUSTOM |
|---|---|---|---|---|---|---|---|---|---|---|
| `org.edit_page` | ✓ | ✓ | ✓ | — | — | — | ✓ | — | — | — |
| `org.manage_members` | ✓ | ✓ | — | — | — | — | — | — | — | — |
| `org.manage_roles` | ✓ | ✓ | — | — | — | — | — | — | — | — |
| `org.post` | ✓ | ✓ | ✓ | — | — | — | ✓ | — | — | — |
| `org.schedule_posts` | ✓ | ✓ | ✓ | — | — | — | ✓ | — | — | — |
| `org.quote` | ✓ | ✓ | ✓ | — | — | ✓ | — | — | — | — |
| `org.manage_rfqs` | ✓ | ✓ | ✓ | — | — | ✓ | — | — | — | — |
| `org.hire` | ✓ | ✓ | ✓ | — | ✓ | — | — | — | — | — |
| `org.manage_jobs` | ✓ | ✓ | ✓ | — | ✓ | — | — | — | — | — |
| `org.manage_listings` | ✓ | ✓ | ✓ | — | — | ✓ | — | — | — | — |
| `org.manage_events` | ✓ | ✓ | ✓ | — | — | — | ✓ | — | — | — |
| `org.billing` | ✓ | ✓ | — | — | — | — | — | ✓ | — | — |
| `org.verify` | ✓ | ✓ | — | — | — | — | — | — | — | — |
| `org.moderate` | ✓ | ✓ | — | — | — | — | — | — | ✓ | — |
| `org.view_analytics` | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ | — | — |
| `org.manage_locations` | ✓ | ✓ | ✓ | — | — | — | — | — | — | — |
| `org.delete` | ✓ | — | — | — | — | — | — | — | — | — |

CUSTOM roles carry an explicit `permissions[]` list; presets may also add keys. Owners cannot be demoted below one remaining owner. Platform staff: MODERATOR (moderation queue, reads), ADMIN (everything incl. flags/experiments/users/organizations).
