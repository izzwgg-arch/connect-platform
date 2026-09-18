# Jupiter Restore Manifest

> **Snapshot name:** `jupiter`
> **Created:** 2026-03-13
> **Purpose:** Permanent restore point of the TrimPro web app and mobile app in their known-good, fully deployed state.
> **Do not modify this document without creating a new named snapshot.**

---

## 1. Git Identity

| Item | Value |
|------|-------|
| Tag | `jupiter` |
| Branch | `snapshot/jupiter` |
| Commit hash | `3f5b8dfd1bac63b8a12ffb4cf43671509836c111` |
| Commit message | `Snapshot: Jupiter` |
| Base branch | `master` |
| Remote | `https://github.com/izzwgg-arch/Trimpro.git` |

To verify the snapshot is intact:

```bash
git log --oneline jupiter
# should output: 3f5b8df Snapshot: Jupiter
```

---

## 2. Required Node Version

| Environment | Node version |
|-------------|-------------|
| **Production server** | `v18.20.8` (LTS) |
| **Local dev (tested)** | `v24.14.0` |
| **Minimum supported** | `v18.x LTS` |

Use [nvm](https://github.com/nvm-sh/nvm) or [nvm-windows](https://github.com/coreybutler/nvm-windows) to pin the version:

```bash
nvm install 18
nvm use 18
node --version  # should print v18.x.x
```

---

## 3. Package Manager and Lockfile

| Item | Value |
|------|-------|
| Package manager | `npm` |
| Lockfile | `package-lock.json` (root) |
| Lockfile | `apps/mobile/package-lock.json` (mobile) |
| npm version (production) | `9.x` (bundled with Node 18) |

> **Do not use `yarn` or `pnpm`** — the lockfiles are npm format. Using a different package manager will produce different dependency trees and may break the build.

---

## 4. Install Command

### Web app (root)

```bash
npm ci
```

`npm ci` uses the exact lockfile. Do **not** use `npm install` for a restore — it may upgrade packages.

### Mobile app

```bash
cd apps/mobile
npm ci
```

---

## 5. Web Build and Start Commands

### Development

```bash
npm run dev
# Starts Next.js dev server on http://localhost:3000
```

### Production build (exactly as deployed)

```bash
npm run build
# Generates .next/ optimized build
```

### Production start

```bash
npm run start
# Starts on 0.0.0.0:3000 (all interfaces)
# Equivalent: node -r dotenv/config node_modules/.bin/next start -H 0.0.0.0 -p 3000
```

### On the live server (PM2)

```bash
pm2 restart trimpro
# Process name: trimpro
# Working directory: /root/apps/trimpro
# PM2 pid: process 0
```

---

## 6. Mobile Build and Start Commands

The mobile app is an **Expo / React Native** project located at `apps/mobile/`.

### Local development

```bash
cd apps/mobile
npm run dev         # or: npx expo start
npm run android     # opens Android emulator / device
npm run ios         # opens iOS simulator (macOS only)
```

### EAS (cloud) builds

```bash
cd apps/mobile
npm run build:apk   # Android preview APK via EAS
npm run build:aab   # Android production AAB via EAS
```

Requires:
- EAS CLI: `npm install -g eas-cli`
- EAS project ID: `5d6344e3-86ce-4e96-93e8-13893313d47f`
- Android bundle ID: `com.trimpro.field`
- Logged in: `eas login`

### OTA update (push code without new build)

```bash
npm run ota:preview   # preview channel
npm run ota:prod      # production channel
```

### Mobile API URL

Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` to point to the web backend.  
In production builds, this defaults to `https://app.trimprony.com`.  
In dev, it defaults to `http://10.0.2.2:3000` (Android emulator localhost).

---

## 7. Required Environment Variables

Create a `.env` file in the **repo root** (never commit it). All keys below were confirmed present in the production `.env` at the time of the Jupiter snapshot.

### Core / Required — app will not start without these

```env
# Database
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/trimpro?schema=public"

# Auth & encryption — must be long random strings, kept consistent across restarts
JWT_SECRET="<random-64-char-string>"
JWT_REFRESH_SECRET="<random-64-char-string>"
ENCRYPTION_KEY="<random-64-char-string>"   # used for token signing, public PDF links, statement links

# App URL — used for email links, webhooks, redirect URIs
NEXT_PUBLIC_APP_URL="https://app.trimprony.com"   # or http://localhost:3000 for dev
PUBLIC_APP_URL="https://app.trimprony.com"
CANONICAL_PUBLIC_APP_URL="https://app.trimprony.com"
APP_URL="https://app.trimprony.com"

# Node environment
NODE_ENV="production"   # or "development"
```

### Redis (required for real-time dispatch)

```env
REDIS_URL="redis://localhost:6379"
```

### Security / reCAPTCHA

```env
RECAPTCHA_SECRET_KEY="<google-recaptcha-v3-secret>"
NEXT_PUBLIC_RECAPTCHA_SITE_KEY="<google-recaptcha-v3-site-key>"
RECAPTCHA_SITE_KEY="<same-as-above>"    # server-side fallback
# Optional: RECAPTCHA_MIN_SCORE="0.3"  # default; raise to 0.5 for stricter checks
```

### Email

```env
EMAIL_PROVIDER="resend"   # or "sendgrid", "mailgun", "google"
EMAIL_API_KEY="<api-key>"           # Resend or SendGrid key
# or:
RESEND_API_KEY="<resend-api-key>"
SENDGRID_API_KEY="<sendgrid-api-key>"

EMAIL_FROM="noreply@trimprony.com"
EMAIL_REPLY_TO="noreply@trimprony.com"
FROM_NAME="Trim Pro"
```

### Payment gateway (Cardknox / Sola)

Credentials are stored in the database via the Integrations settings page, not in `.env`.  
However, these env vars are used as fallbacks:

```env
SOLA_API_URL="https://api.cardknox.com"          # optional override
SOLA_API_KEY="<sola-or-cardknox-api-key>"         # optional fallback
SOLA_API_SECRET="<secret>"                         # optional fallback
```

The production Cardknox hosted form URL is: `https://secure.cardknox.com/trimprony`

### QuickBooks Online (QBO)

Credentials are stored in the database via Integrations settings.  
Optional env fallbacks:

```env
QBO_CLIENT_ID="<qbo-app-client-id>"
QBO_CLIENT_SECRET="<qbo-app-client-secret>"
QBO_REDIRECT_URI="https://app.trimprony.com/api/integrations/quickbooks/callback"
QBO_ENV="production"   # or "sandbox"
QBO_WEBHOOK_VERIFIER_TOKEN="<from-qbo-developer-portal>"
QBO_ACH_RECONCILE_SECRET="<random-secret-for-cron-endpoint>"
QUICKBOOKS_ACH_ENABLED="true"
```

### Google Maps

```env
GOOGLE_MAPS_SERVER_API_KEY="<server-side-key-no-referrer-restriction>"
GOOGLE_MAPS_API_KEY="<general-key>"
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY="<browser-key>"
```

### VoIP.ms (calling/SMS)

```env
VOIPMS_API_USERNAME="<voipms-account-username>"
VOIPMS_API_PASSWORD="<voipms-api-password>"
VOIPMS_DID="<phone-number-DID>"
```

### WhatsApp webhook (optional)

```env
WHATSAPP_VERIFY_TOKEN="trimpro_verify_token"
DEFAULT_TENANT_ID="<your-tenant-id>"
```

### Cron / scheduled tasks

```env
CRON_SECRET="<random-secret>"   # passed as bearer token to /api/tasks/reminders
```

### Mobile app APK distribution link (optional)

```env
TRIMPRO_FIELD_APK_URL="https://..."   # Direct download link for field APK, shown in invite emails
EXPO_ANDROID_APK_URL="https://..."    # Fallback
```

### Mobile app env (`apps/mobile/.env`)

```env
EXPO_PUBLIC_API_URL="https://app.trimprony.com"
```

---

## 8. Database and Migration Requirements

| Item | Detail |
|------|--------|
| Engine | PostgreSQL 14+ |
| ORM | Prisma 5.7.1 |
| Schema file | `prisma/schema.prisma` |
| Primary DB name | `trimpro` |

### Schema sync (non-destructive)

```bash
npx prisma db push
# Applies schema changes without migration files
# Safe for the Jupiter state
```

### Full migration (with history)

```bash
npx prisma migrate dev --name your-migration-name
```

### Generate Prisma client after schema change

```bash
npm run db:generate
# or: npx prisma generate
```

### Seed initial data

```bash
npm run db:seed
```

### Key schema changes included in Jupiter

- `Estimate.convertedPercent` (`Int?`) — stores the billing percentage when an estimate is marked `CONVERTED`
- `EstimateStatus.CONVERTED` enum value
- `InvoiceLineItem.notes` — stores per-line billing breakdown text
- `EstimateOptionalLineItem` model — customer-selectable optional items

### Production DB connection (server)

- Host: `localhost:5432`
- Schema: `public`
- Database: `trimpro`
- Connection is via `DATABASE_URL` in `/root/apps/trimpro/.env`

---

## 9. Services and Dependencies That Must Be Running

| Service | Required for | Notes |
|---------|-------------|-------|
| **PostgreSQL 14+** | All data operations | Must be running before `npm run build` or `npm start` |
| **Redis** | Real-time dispatch, socket events | `REDIS_URL` defaults to `redis://localhost:6379` |
| **PM2** | Process management on production | `pm2 restart trimpro` |
| **Nginx** | Reverse proxy on production server | Proxies `:80`/`:443` → `localhost:3000`; also serves `/uploads/` static files |
| **Puppeteer/Chromium** | PDF generation | Installed via `npm ci`; requires Chromium available on server (`puppeteer` v24) |
| **Cardknox** (external) | Payment processing | Hosted form at `https://secure.cardknox.com/trimprony` |
| **QuickBooks** (external) | Accounting sync | OAuth2 flow via QBO credentials in DB |
| **Resend / SendGrid** (external) | Email delivery | Key stored in DB integrations or `.env` |
| **Google Maps** (external) | Address autocomplete, geocoding | API key required |
| **VoIP.ms** (external) | Calls and SMS | API credentials in DB integrations |
| **Expo EAS** (external) | Mobile cloud builds | Only needed when building new mobile releases |

### File system requirements on production server

```
/root/apps/trimpro/public/uploads/    # user-uploaded files (logos, attachments)
```

> The `/root` directory must have world-execute permission (`chmod o+x /root`) so Nginx can traverse to `/root/apps/trimpro/public/uploads/`. This was required to fix logo 403 errors.

```bash
chmod o+x /root
chmod o+x /root/apps
chmod o+x /root/apps/trimpro
chmod o+x /root/apps/trimpro/public
```

---

## 10. Files Not in Git — Required for Full Behavior Reproduction

These files were intentionally excluded from the Jupiter snapshot (listed in `.gitignore`) but are required or useful in a running deployment:

| File/Path | Why excluded | How to restore |
|-----------|-------------|----------------|
| `.env` (root) | Contains secrets | Recreate manually from Section 7 above |
| `apps/mobile/.env` | Contains `EXPO_PUBLIC_API_URL` | Recreate from Section 7 |
| `public/uploads/` | User-uploaded content (logos, PDFs, attachments) | Copy from live server: `scp -r root@154.12.235.86:/root/apps/trimpro/public/uploads ./public/` |
| `node_modules/` | Installed packages | Restored via `npm ci` |
| `.next/` | Build artifacts | Restored via `npm run build` |
| `trimpro-deploy-*.tgz` | Deployment archives | Not needed for restore; re-run deploy if needed |
| `mobile-*.log`, `kbd-*.txt` | Debug/diagnostic logs | Not needed |

---

## 11. Exact Restore Procedure

> Use this procedure to restore to the exact Jupiter state on a new machine or after any corruption. This creates an isolated restore branch so `master` is never modified.

```bash
# Step 1 — Clone or reset the repo
git clone https://github.com/izzwgg-arch/Trimpro.git trimpro-restored
cd trimpro-restored

# Step 2 — Checkout a new restore branch from the Jupiter tag
#   (Never restore directly on master)
git checkout -b restore/jupiter-$(date +%Y%m%d) jupiter

# Verify you are on the correct commit
git log -1 --format="%H %s"
# Should print: 3f5b8dfd1bac63b8a12ffb4cf43671509836c111 Snapshot: Jupiter

# Step 3 — Restore environment file
cp /path/to/your-secure-env-backup/.env .env
cp /path/to/your-secure-env-backup/apps-mobile.env apps/mobile/.env

# Step 4 — Install exact dependencies
npm ci
cd apps/mobile && npm ci && cd ../..

# Step 5 — Sync database schema
npx prisma generate
npx prisma db push

# Step 6 — Restore user uploads (if needed)
scp -r root@154.12.235.86:/root/apps/trimpro/public/uploads ./public/

# Step 7 — Build
npm run build

# Step 8 — Start
npm run start
# or via PM2:
pm2 start npm --name trimpro -- run start:prod
```

---

## 12. Exact Rebuild Procedure (no source modifications)

> Use this to rebuild and redeploy the Jupiter snapshot to the production server without changing any source code.

```bash
# On local machine — ensure you are on the jupiter commit
git fetch origin
git checkout jupiter

# Confirm commit
git log -1 --format="%H %s"
# 3f5b8dfd1bac63b8a12ffb4cf43671509836c111 Snapshot: Jupiter

# Clean install
npm ci

# Build
npm run build

# Deploy to production server
# (Copies the entire project to the server and rebuilds there)
ssh -i ~/.ssh/trimpro_ed25519 root@154.12.235.86 \
  "cd /root/apps/trimpro && git fetch origin && git checkout jupiter && npm ci && npm run build && pm2 restart trimpro"

# Verify the server is running
ssh -i ~/.ssh/trimpro_ed25519 root@154.12.235.86 "pm2 status trimpro"
```

### Server details (production at time of Jupiter)

| Item | Value |
|------|-------|
| Server IP | `154.12.235.86` |
| SSH key | `~/.ssh/trimpro_ed25519` (Windows: `C:\Users\izzyw\.ssh\trimpro_ed25519`) |
| SSH user | `root` |
| App path | `/root/apps/trimpro` |
| PM2 process | `trimpro` (id: 0) |
| Node on server | `v18.20.8` |
| PM2 on server | `6.0.14` |
| URL | `https://app.trimprony.com` |

---

## Summary Checklist

Before calling a restore "complete," verify each item:

- [ ] `git log -1` shows commit `3f5b8df`
- [ ] `.env` recreated with all required keys from Section 7
- [ ] `npm ci` completed without errors
- [ ] `npx prisma db push` completed without errors
- [ ] `npm run build` completed without errors
- [ ] App starts and dashboard loads at the expected URL
- [ ] Branding logo loads (check Nginx permissions on `/root`)
- [ ] Estimates, invoices, and estimate approval flow work end-to-end
- [ ] Payment portal loads and pre-populates correctly
- [ ] Email sending works (check integration credentials in DB)
- [ ] QBO sync active (check integration credentials in DB)

---

*This document is part of the TrimPro Jupiter snapshot and should be kept in `docs/JUPITER_RESTORE.md` on the `snapshot/jupiter` branch.*
