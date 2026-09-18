# Quick Deployment Guide

## Deploy to Server Using Git

### First Time Setup (if not already done)

SSH into your server and run:

```bash
# Navigate to apps directory
cd ~/apps

# Clone the repository
git clone https://github.com/izzwgg-arch/Trimpro.git trimpro

# Navigate into the project
cd trimpro

# Make deployment script executable
chmod +x deploy-from-git.sh

# Create/update .env file with your production environment variables
nano .env

# Run deployment
./deploy-from-git.sh
```

### Regular Deployment (After Initial Setup)

SSH into your server and run:

```bash
cd ~/apps/trimpro
git pull origin master
./deploy-from-git.sh
```

Or as a one-liner:

```bash
cd ~/apps/trimpro && git pull && ./deploy-from-git.sh
```

### What the Deployment Script Does

1. ✅ Pulls latest code from GitHub
2. ✅ Installs/updates dependencies
3. ✅ Generates Prisma Client
4. ✅ Updates database schema
5. ✅ Builds Next.js application
6. ✅ Restarts PM2 process

### Quick Commands

```bash
# View application logs
pm2 logs trimpro

# Restart application
pm2 restart trimpro

# Check application status
pm2 status trimpro

# Monitor application
pm2 monit
```

### Troubleshooting

If deployment fails:

1. Check your `.env` file has all required variables
2. Check database connection: `npx prisma db push`
3. Check Node.js version: `node --version` (should be 18+)
4. View PM2 logs: `pm2 logs trimpro --lines 100`
