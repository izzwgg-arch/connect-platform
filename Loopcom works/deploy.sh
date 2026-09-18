#!/bin/bash
# Deployment script for Next.js app on Contabo server
# Usage: ./deploy.sh <app-name> [port]

set -e

APP_NAME=${1:-my-app}
APP_PORT=${2:-3000}
APP_DIR="/home/deploy/apps/$APP_NAME"
NGINX_TEMPLATE="/etc/nginx/sites-available/app-template"
NGINX_CONFIG="/etc/nginx/sites-available/$APP_NAME"

echo "========================================="
echo "Deploying: $APP_NAME on port $APP_PORT"
echo "========================================="

# Check if app directory exists
if [ ! -d "$APP_DIR" ]; then
    echo "❌ App directory not found: $APP_DIR"
    echo "Please upload your app files first, or create the directory:"
    echo "  mkdir -p $APP_DIR"
    exit 1
fi

cd "$APP_DIR"

# Load NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

echo ""
echo "=== Installing Dependencies ==="
pnpm install --production=false

echo ""
echo "=== Building Application ==="
pnpm build

echo ""
echo "=== Stopping Existing PM2 Process ==="
pm2 delete "$APP_NAME" 2>/dev/null || echo "No existing process found"

echo ""
echo "=== Starting Application with PM2 ==="
# Start with binding to 0.0.0.0 so NGINX can reach it
PORT=$APP_PORT HOSTNAME=0.0.0.0 pm2 start "pnpm start" --name "$APP_NAME"

echo ""
echo "=== Saving PM2 Process List ==="
pm2 save

echo ""
echo "=== Configuring NGINX ==="
sudo cp "$NGINX_TEMPLATE" "$NGINX_CONFIG"
sudo sed -i "s/YOUR_DOMAIN_OR_IP/154.12.235.86/g" "$NGINX_CONFIG"
sudo sed -i "s/127.0.0.1:3000/127.0.0.1:$APP_PORT/g" "$NGINX_CONFIG"

# Enable site if not already enabled
if [ ! -L "/etc/nginx/sites-enabled/$APP_NAME" ]; then
    sudo ln -s "$NGINX_CONFIG" "/etc/nginx/sites-enabled/$APP_NAME"
fi

echo ""
echo "=== Testing NGINX Configuration ==="
sudo nginx -t

echo ""
echo "=== Reloading NGINX ==="
sudo systemctl reload nginx

echo ""
echo "========================================="
echo "✅ Deployment Complete!"
echo "========================================="
echo ""
echo "App is running at: http://154.12.235.86"
echo ""
echo "Useful commands:"
echo "  pm2 logs $APP_NAME          # View logs"
echo "  pm2 restart $APP_NAME       # Restart app"
echo "  pm2 status                  # Check status"
echo "  pm2 monit                   # Monitor dashboard"
