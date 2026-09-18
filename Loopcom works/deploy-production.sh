#!/bin/bash
# Trim Pro - Production Deployment Script
# Run this script on the server after uploading files

set -e  # Exit on error

APP_NAME="trimpro"
APP_DIR="$HOME/apps/$APP_NAME"
PORT=3000

echo "=========================================="
echo "Trim Pro - Production Deployment"
echo "=========================================="

# Check if we're in the app directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Are you in the app directory?"
    exit 1
fi

# Load NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

echo "📦 Step 1: Installing dependencies..."
npm install --production=false

echo "🔧 Step 2: Generating Prisma Client..."
npx prisma generate

echo "🗄️  Step 3: Checking database connection..."
if ! npx prisma db push --skip-generate --accept-data-loss; then
    echo "⚠️  Warning: Database push failed. Check your DATABASE_URL in .env"
    echo "   You may need to run: npx prisma migrate deploy"
fi

echo "🏗️  Step 4: Building Next.js application..."
NEXT_TELEMETRY_DISABLED=1 npm run build

echo "🔄 Step 5: Stopping existing PM2 process (if any)..."
pm2 stop $APP_NAME 2>/dev/null || true
pm2 delete $APP_NAME 2>/dev/null || true

echo "🚀 Step 6: Starting application with PM2..."
PORT=$PORT HOSTNAME=0.0.0.0 NODE_ENV=production pm2 start npm --name "$APP_NAME" -- start

echo "💾 Step 7: Saving PM2 configuration..."
pm2 save

echo "✅ Step 8: Deployment complete!"
echo ""
echo "📊 Application Status:"
pm2 status $APP_NAME

echo ""
echo "📝 Useful commands:"
echo "   View logs:     pm2 logs $APP_NAME"
echo "   Restart:       pm2 restart $APP_NAME"
echo "   Stop:          pm2 stop $APP_NAME"
echo "   Monitor:       pm2 monit"
echo ""
echo "🌐 Next steps:"
echo "   1. Configure NGINX reverse proxy"
echo "   2. Test the application: http://$(hostname -I | awk '{print $1}'):$PORT"
echo "   3. Create admin user via API or seed script"
