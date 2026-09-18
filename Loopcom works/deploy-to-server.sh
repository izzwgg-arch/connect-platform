#!/bin/bash

# Trim Pro - Deploy to Remote Server
# Usage: ./deploy-to-server.sh [ssh-key-path]

set -e  # Exit on error

# Configuration
SERVER_USER="root"  # Change if needed
SERVER_IP="154.12.235.86"
APP_NAME="trimpro"
APP_DIR="/root/apps/$APP_NAME"
GIT_REPO="https://github.com/izzwgg-arch/Trimpro.git"
SSH_KEY_PATH="${1:-~/.ssh/id_rsa}"  # Use provided key or default

echo "=========================================="
echo "Trim Pro - Remote Server Deployment"
echo "=========================================="
echo "Server: $SERVER_USER@$SERVER_IP"
echo "SSH Key: $SSH_KEY_PATH"
echo "App Directory: $APP_DIR"
echo ""

# Check if SSH key exists
if [ ! -f "$SSH_KEY_PATH" ]; then
    echo "❌ Error: SSH key not found at $SSH_KEY_PATH"
    echo "Please provide the correct SSH key path:"
    echo "Usage: ./deploy-to-server.sh /path/to/your/ssh/key"
    exit 1
fi

echo "🔐 Connecting to server and setting up deployment..."

# Create deployment script on the server
cat > /tmp/deploy-remote.sh << 'EOF'
#!/bin/bash
set -e

APP_NAME="trimpro"
APP_DIR="/root/apps/$APP_NAME"
GIT_REPO="https://github.com/izzwgg-arch/Trimpro.git"

echo "🚀 Starting Trim Pro deployment on server..."

# Install Node.js if not present
if ! command -v node &> /dev/null; then
    echo "📦 Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Install PM2 if not present
if ! command -v pm2 &> /dev/null; then
    echo "📦 Installing PM2..."
    npm install -g pm2
fi

# Create app directory if it doesn't exist
if [ ! -d "$APP_DIR" ]; then
    echo "📁 Creating app directory: $APP_DIR"
    mkdir -p "$APP_DIR"
    cd "$APP_DIR"
    echo "📥 Cloning repository..."
    git clone "$GIT_REPO" .
else
    cd "$APP_DIR"
    echo "📥 Pulling latest changes..."
    git fetch origin
    git checkout master
    git pull origin master
fi

# Load NVM if available
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && \. "\$NVM_DIR/nvm.sh"

echo ""
echo "📦 Step 1: Installing dependencies..."
npm install --production=false

echo ""
echo "🔧 Step 2: Generating Prisma Client..."
npx prisma generate

echo ""
echo "🗄️  Step 3: Checking database connection..."
if ! npx prisma db push --skip-generate --accept-data-loss; then
    echo "⚠️  Warning: Database push failed. Check your DATABASE_URL in .env"
    echo "   You may need to run: npx prisma migrate deploy"
fi

echo ""
echo "🏗️  Step 4: Building Next.js application..."
NEXT_TELEMETRY_DISABLED=1 npm run build

echo ""
echo "🔄 Step 5: Stopping existing PM2 process (if any)..."
pm2 stop $APP_NAME 2>/dev/null || true
pm2 delete $APP_NAME 2>/dev/null || true

echo ""
echo "🚀 Step 6: Starting application with PM2..."
# Load environment variables from .env file if it exists and export them
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

# Use ecosystem file if it exists, otherwise start directly
if [ -f ecosystem.config.js ]; then
    pm2 start ecosystem.config.js
else
    PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production pm2 start npm --name "$APP_NAME" -- start
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
echo "🌐 Application should be running at: http://$SERVER_IP:3000"
echo ""

echo "📝 Useful commands:"
echo "   View logs:     pm2 logs $APP_NAME"
echo "   Restart:       pm2 restart $APP_NAME"
echo "   Stop:          pm2 stop $APP_NAME"
echo "   Monitor:       pm2 monit"
echo "   Pull & Deploy: cd $APP_DIR && git pull && ./deploy-from-git.sh"
echo ""

# Display application URL
echo "🎉 Trim Pro is now live at: http://$SERVER_IP:3000"
EOF

echo "📤 Uploading deployment script to server..."
scp -o StrictHostKeyChecking=no -i "$SSH_KEY_PATH" /tmp/deploy-remote.sh $SERVER_USER@$SERVER_IP:/tmp/

echo "🔐 Executing deployment on server..."
ssh -o StrictHostKeyChecking=no -i "$SSH_KEY_PATH" $SERVER_USER@$SERVER_IP "chmod +x /tmp/deploy-remote.sh && /tmp/deploy-remote.sh"

echo ""
echo "🎉 Deployment initiated! Check the application at: http://$SERVER_IP:3000"
echo ""
echo "📊 To monitor deployment:"
echo "   ssh -i $SSH_KEY_PATH $SERVER_USER@$SERVER_IP 'pm2 logs trimpro --lines 50 -f'"
echo ""

# Clean up temporary files
rm -f /tmp/deploy-remote.sh

echo "✅ Deployment process completed!"
