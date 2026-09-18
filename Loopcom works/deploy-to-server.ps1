# Trim Pro - Deploy to Remote Server (PowerShell)
# Usage: .\deploy-to-server.ps1 [-sshKey "path/to/ssh/key"]

param(
    [string]$sshKey = "$env:USERPROFILE\.ssh\id_rsa"
)

# Configuration
$SERVER_USER = "root"
$SERVER_IP = "154.12.235.86"
$APP_NAME = "trimpro"
$APP_DIR = "/root/apps/$APP_NAME"
$GIT_REPO = "https://github.com/izzwgg-arch/Trimpro.git"

Write-Host "==========================================" -ForegroundColor Green
Write-Host "Trim Pro - Remote Server Deployment" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host "Server: $SERVER_USER@$SERVER_IP" -ForegroundColor Yellow
Write-Host "SSH Key: $sshKey" -ForegroundColor Yellow
Write-Host "App Directory: $APP_DIR" -ForegroundColor Yellow
Write-Host ""

# Check if SSH key exists
if (-not (Test-Path $sshKey)) {
    Write-Host "❌ Error: SSH key not found at $sshKey" -ForegroundColor Red
    Write-Host "Please provide the correct SSH key path:" -ForegroundColor Red
    Write-Host "Usage: .\deploy-to-server.ps1 -sshKey 'path\to\ssh\key'" -ForegroundColor Yellow
    exit 1
}

Write-Host "🔐 Connecting to server and setting up deployment..." -ForegroundColor Cyan

# Create deployment script content
$deployScript = @"
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
export NVM_DIR="`$HOME/.nvm"
[ -s "`$NVM_DIR/nvm.sh" ] && . "`$NVM_DIR/nvm.sh"

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
"@

Write-Host "🔐 Executing deployment on server..." -ForegroundColor Cyan

# Execute deployment script on remote server
$sshCommand = "ssh -o StrictHostKeyChecking=no -i $sshKey $SERVER_USER@$SERVER_IP 'bash -s' <<< '$deployScript'"

try {
    Invoke-Expression $sshCommand
    Write-Host ""
    Write-Host "🎉 Deployment initiated!" -ForegroundColor Green
    Write-Host "📊 Check the application at: http://$SERVER_IP:3000" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "📊 To monitor deployment:" -ForegroundColor Cyan
    Write-Host "   ssh -i $sshKey $SERVER_USER@$SERVER_IP 'pm2 logs trimpro --lines 50 -f'" -ForegroundColor Gray
} catch {
    Write-Host "❌ Deployment failed!" -ForegroundColor Red
    Write-Host "Error: $($_" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "✅ Deployment process completed!" -ForegroundColor Green
