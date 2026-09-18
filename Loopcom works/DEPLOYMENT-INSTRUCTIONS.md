# Deployment Instructions - Roles, Analytics & Dispatch

## Quick Deploy

### Option 1: Use the deployment script (Recommended)

1. Upload the script to your server:
   ```bash
   scp -i ~/.ssh/contabo_trimpro deploy-new-features.sh root@154.12.235.86:~/apps/trimpro/
   ```

2. SSH to your server and run:
   ```bash
   ssh -i ~/.ssh/contabo_trimpro root@154.12.235.86
   cd ~/apps/trimpro
   chmod +x deploy-new-features.sh
   bash deploy-new-features.sh
   ```

### Option 2: Manual deployment

SSH to your server and run these commands:

```bash
ssh -i ~/.ssh/contabo_trimpro root@154.12.235.86

# Navigate to app
cd ~/apps/trimpro

# Load NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Install dependencies (if needed)
npm install

# Run migration
npx prisma migrate deploy

# Generate Prisma client
npx prisma generate

# Seed permissions and roles
npm run db:seed

# Build application
npm run build

# Restart PM2
pm2 restart trimpro

# Check status
pm2 status
pm2 logs trimpro --lines 50
```

## What Gets Deployed

### Database Tables Created:
- `roles` - Custom and system roles
- `permissions` - Granular permission catalog (100+ permissions)
- `role_permissions` - Role-to-permission mappings
- `user_roles` - User-to-role assignments
- `permission_constraints` - Attribute-based access control
- `reports` - Custom and prebuilt reports
- `report_schedules` - Scheduled report delivery
- `report_runs` - Report execution history
- `daily_stats` - Materialized daily aggregations
- `dispatch_events` - Dispatch action timeline
- `tech_availability` - Technician availability blocks
- `service_zones` - Geographic service zones

### Features Enabled:
- ✅ Roles & Permissions management UI (`/dashboard/settings/roles`)
- ✅ Analytics dashboard (`/dashboard/analytics`)
- ✅ 7 System roles with pre-configured permissions
- ✅ Authorization layer protecting all routes
- ✅ Navigation updated with new menu items

## Verification

After deployment, verify:

1. **Roles System:**
   - Visit: `https://your-domain.com/dashboard/settings/roles`
   - Should see 7 system roles (Owner, Admin, Manager, Dispatcher, Tech, Accounting, ReadOnly)
   - Try creating a custom role

2. **Analytics:**
   - Visit: `https://your-domain.com/dashboard/analytics`
   - Should see analytics dashboard with charts

3. **Navigation:**
   - Check sidebar for new items: Analytics, Reports, Dispatch

4. **Permissions:**
   - Admin user should have Owner role with all permissions
   - Check API routes are protected

## Troubleshooting

### Migration fails:
```bash
# Check database connection
npx prisma db pull

# Try reset (WARNING: deletes data)
# npx prisma migrate reset
```

### Seed fails:
```bash
# Check if permissions already exist
npx prisma studio
# Navigate to permissions table

# Or manually run seed
npm run db:seed
```

### Build fails:
```bash
# Clear cache and rebuild
rm -rf .next node_modules/.cache
npm run build
```

### PM2 issues:
```bash
# Check PM2 status
pm2 status

# View logs
pm2 logs trimpro

# Restart
pm2 restart trimpro

# If needed, delete and recreate
pm2 delete trimpro
pm2 start npm --name trimpro -- start
```

## Rollback (if needed)

If something goes wrong:

```bash
# Stop the app
pm2 stop trimpro

# Revert to previous migration (if you have backups)
# Or restore from database backup

# Restart
pm2 restart trimpro
```

## Support

All new features are documented in:
- `IMPLEMENTATION-PLAN.md` - Original plan
- `IMPLEMENTATION-STATUS.md` - Current status
- `DEPLOYMENT-READY.md` - What's ready for production
