#!/bin/bash
# Deployment script for Roles, Analytics & Dispatch features
# Run this on your server: bash deploy-new-features.sh

set -e  # Exit on error

echo "🚀 Starting deployment of new features..."
echo ""

# Load NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Navigate to app directory
cd ~/apps/trimpro || { echo "❌ Error: ~/apps/trimpro not found"; exit 1; }

echo "📦 Step 1: Installing dependencies..."
npm install

echo ""
echo "🗄️  Step 2: Running database migration..."
npx prisma migrate deploy || {
    echo "⚠️  Migration deploy failed, trying migrate dev..."
    npx prisma migrate dev --name add_roles_analytics_dispatch
}

echo ""
echo "🔧 Step 3: Generating Prisma client..."
npx prisma generate

echo ""
echo "🌱 Step 4: Seeding permissions and roles..."
npm run db:seed || {
    echo "⚠️  Seed failed, but continuing..."
}

echo ""
echo "🏗️  Step 5: Building application..."
npm run build

echo ""
echo "🔄 Step 6: Restarting PM2..."
pm2 restart trimpro || {
    echo "⚠️  PM2 restart failed, trying start..."
    pm2 start npm --name trimpro -- start
}

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Check PM2 status: pm2 status"
echo "   2. Check logs: pm2 logs trimpro"
echo "   3. Visit /dashboard/settings/roles to verify roles system"
echo "   4. Visit /dashboard/analytics to verify analytics"
echo ""
