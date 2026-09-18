#!/bin/bash
# Git-based Deployment Script for Trim Pro
# This script pulls the latest code from GitHub and deploys it
# Usage: ./deploy-from-git.sh [branch]

set -e  # Exit on error

APP_NAME="trimpro"
APP_DIR="${APP_DIR:-$HOME/apps/$APP_NAME}"
BRANCH=${1:-master}
GIT_REPO="https://github.com/izzwgg-arch/Trimpro.git"
PORT=3000

echo "=========================================="
echo "Trim Pro - Git Deployment"
echo "=========================================="
echo "Repository: $GIT_REPO"
echo "Branch: $BRANCH"
echo "App Directory: $APP_DIR"
echo ""

# Create app directory if it doesn't exist
if [ ! -d "$APP_DIR" ]; then
    echo "📁 Creating app directory: $APP_DIR"
    mkdir -p "$APP_DIR"
    cd "$APP_DIR"
    echo "📥 Cloning repository..."
    git clone "$GIT_REPO" .
else
    cd "$APP_DIR"
    echo "📥 Pulling latest changes from $BRANCH..."
    git fetch origin
    git checkout "$BRANCH"
    git pull origin "$BRANCH"
fi

# Load NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

echo ""
echo "📦 Step 1: Installing dependencies..."
npm install --legacy-peer-deps --production=false

echo ""
echo "🔧 Step 2: Generating Prisma Client..."
npx prisma generate

echo ""
echo "🔐 Step 2b: Syncing permission catalog + mobile role defaults..."
npx tsx scripts/sync-permissions.ts || echo "⚠️  Permission sync skipped/failed"
npx tsx scripts/add-default-mobile-permissions.ts || echo "⚠️  Mobile permission defaults skipped/failed"

echo ""
echo "🗄️  Step 3: Checking database connection..."
if ! npx prisma db push --skip-generate --accept-data-loss; then
    echo "⚠️  Warning: Database push failed. Check your DATABASE_URL in .env"
    echo "   You may need to run: npx prisma migrate deploy"
fi

echo ""
echo "🏗️  Step 4: Building Next.js application..."
# Next.js and Prisma load .env themselves; avoid bash `source` (breaks on "KEY= value" lines).
set +e
NEXT_TELEMETRY_DISABLED=1 npm run build
BUILD_EXIT=$?
set -e
# Next 14 occasionally fails the final 500.html rename on Linux; copy manually if needed.
if [ -f .next/export/500.html ] && [ ! -f .next/server/pages/500.html ]; then
    mkdir -p .next/server/pages
    cp .next/export/500.html .next/server/pages/500.html
fi
if [ "$BUILD_EXIT" -ne 0 ] && [ ! -f .next/BUILD_ID ]; then
    echo "❌ Build failed and no BUILD_ID was produced."
    exit "$BUILD_EXIT"
fi
if [ "$BUILD_EXIT" -ne 0 ]; then
    echo "⚠️  Build exited with code $BUILD_EXIT but artifacts look usable; continuing deploy."
fi

echo ""
echo "🔑 Fixing public directory permissions (nginx needs read access)..."
chmod 755 public 2>/dev/null || true

echo ""
echo "🔄 Step 5: Stopping existing PM2 process (if any)..."
pm2 stop $APP_NAME 2>/dev/null || true
pm2 delete $APP_NAME 2>/dev/null || true

echo ""
echo "🚀 Step 6: Starting application with PM2..."
# ecosystem.config.js loads .env via Node (handles spaces after = and special chars in values)
if [ -f ecosystem.config.js ]; then
    pm2 start ecosystem.config.js
else
    PORT=$PORT HOSTNAME=0.0.0.0 NODE_ENV=production pm2 start npm --name "$APP_NAME" -- start
fi

echo ""
echo "💾 Step 7: Saving PM2 configuration..."
pm2 save

echo ""
echo "=========================================="
echo "✅ Deployment Complete!"
echo "=========================================="
echo ""
echo "📊 Application Status:"
pm2 status $APP_NAME

echo ""
echo "📝 Useful commands:"
echo "   View logs:     pm2 logs $APP_NAME"
echo "   Restart:       pm2 restart $APP_NAME"
echo "   Stop:          pm2 stop $APP_NAME"
echo "   Monitor:       pm2 monit"
echo "   Pull & Deploy: cd $APP_DIR && git pull && ./deploy-from-git.sh"
echo ""
echo "🌐 Application should be running at: http://$(hostname -I | awk '{print $1}'):$PORT"
echo ""
