#!/bin/bash

# Trim Pro - Simple Deployment Script
# Usage: ./deploy-simple.sh

set -e

SERVER_USER="root"
SERVER_IP="154.12.235.86"
SSH_KEY="$HOME/.ssh/contabo_trimpro"

echo "=========================================="
echo "Trim Pro - Simple Deployment"
echo "=========================================="
echo "Server: $SERVER_USER@$SERVER_IP"
echo ""

if [ ! -f "$SSH_KEY" ]; then
    echo "❌ Error: SSH key not found at $SSH_KEY"
    echo "Please update the SSH_KEY path in this script"
    exit 1
fi

echo "🚀 Starting deployment to $SERVER_IP..."

# Simple deployment command
ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "$SERVER_USER@$SERVER_IP" << 'DEPLOY_SCRIPT'
echo '🚀 Trim Pro Deployment Started'

# Update system
apt-get update -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# Install PM2
npm install -g pm2

# Install PostgreSQL
apt-get install -y postgresql postgresql-contrib -y

# Start PostgreSQL
systemctl start postgresql
systemctl enable postgresql

# Create database and user
sudo -u postgres psql -c "CREATE DATABASE trimpro; CREATE USER trimpro_user WITH ENCRYPTED PASSWORD '<REDACTED-legacy-trimpro-db-password-2026-09-18>'; GRANT ALL PRIVILEGES ON DATABASE trimpro TO trimpro_user; ALTER DATABASE trimpro OWNER TO trimpro_user;"

# Install Redis
apt-get install -y redis-server -y

# Start Redis
systemctl start redis-server
systemctl enable redis-server

# Create app directory
mkdir -p /root/apps
cd /root/apps

# Clone repository if not exists
if [ ! -d "trimpro" ]; then
    git clone https://github.com/izzwgg-arch/Trimpro.git trimpro
fi

cd trimpro

# Pull latest changes
git pull origin master

# Install dependencies
npm install --production=false

# Generate Prisma client
npx prisma generate

# Create environment file
cat > .env << EOF
DATABASE_URL="postgresql://trimpro_user:<REDACTED-legacy-trimpro-db-password-2026-09-18>@localhost:5432/trimpro?schema=public"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="trimpro-jwt-secret-$(openssl rand -base64 32 | tr -d '\n')"
JWT_REFRESH_SECRET="trimpro-refresh-secret-$(openssl rand -base64 32 | tr -d '\n')"
NEXT_PUBLIC_APP_URL="http://154.12.235.86:3000"
NODE_ENV="production"
EOF

# Push database schema
npx prisma db push --skip-generate

# Build application
NEXT_TELEMETRY_DISABLED=1 npm run build

# Start with PM2
pm2 stop trimpro 2>/dev/null || true
pm2 delete trimpro 2>/dev/null || true
PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production pm2 start npm --name trimpro -- start

# Save PM2 configuration
pm2 save

echo ''
echo '✅ Deployment completed!'
echo '🌐 Application running at: http://154.12.235.86:3000'
echo '📊 PM2 Status:'
pm2 status trimpro
echo ''
echo '📝 Useful Commands:'
echo '  View logs:     pm2 logs trimpro'
echo '  Restart:       pm2 restart trimpro'
echo '  Stop:          pm2 stop trimpro'
echo '  Monitor:       pm2 monit'
DEPLOY_SCRIPT

echo ""
echo "🎉 Deployment completed!"
echo "🌐 Access your application at: http://$SERVER_IP:3000"
