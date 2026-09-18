# Migration SQL for Roles, Analytics & Dispatch

Since the local environment uses SQLite but production uses PostgreSQL, here's the migration SQL that needs to be run on your PostgreSQL server.

## Run this on your server:

```bash
cd ~/apps/trimpro
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Option 1: Use Prisma migrate (recommended)
npx prisma migrate dev --name add_roles_analytics_dispatch

# Option 2: If migrate dev doesn't work, use migrate deploy
npx prisma migrate deploy

# Then generate client and seed
npx prisma generate
npm run db:seed
```

## Manual SQL (if needed):

The migration will create these tables:
- `roles`
- `permissions`
- `role_permissions`
- `user_roles`
- `permission_constraints`
- `reports`
- `report_schedules`
- `report_runs`
- `daily_stats`
- `dispatch_events`
- `tech_availability`
- `service_zones`

All with proper indexes, foreign keys, and constraints as defined in the schema.
