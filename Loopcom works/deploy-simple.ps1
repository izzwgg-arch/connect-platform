# Trim Pro - Simple Deploy to Remote Server
# Usage: .\deploy-simple.ps1

param(
    [string]$sshKey = "$env:USERPROFILE\.ssh\id_rsa"
)

# Configuration
$SERVER_USER = "root"
$SERVER_IP = "154.12.235.86"
$APP_NAME = "trimpro"
$APP_DIR = "/root/apps/$APP_NAME"

Write-Host "==========================================" -ForegroundColor Green
Write-Host "Trim Pro - Remote Server Deployment" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host "Server: $SERVER_USER@$SERVER_IP" -ForegroundColor Yellow
Write-Host "SSH Key: $sshKey" -ForegroundColor Yellow
Write-Host ""

# Check if SSH key exists
if (-not (Test-Path $sshKey)) {
    Write-Host "❌ Error: SSH key not found at $sshKey" -ForegroundColor Red
    Write-Host "Please update the SSH key path in the script" -ForegroundColor Red
    exit 1
}

Write-Host "🚀 Starting deployment to $SERVER_IP..." -ForegroundColor Cyan

# Create remote deployment commands as a here-string
$remoteCommands = @"
# Set up environment
set -e

# Navigate to app directory
if [ ! -d "$APP_DIR" ]; then
    echo "📁 Creating app directory: $APP_DIR"
    mkdir -p "$APP_DIR"
    cd "$APP_DIR"
    echo "📥 Cloning repository..."
    git clone https://github.com/izzwgg-arch/Trimpro.git .
else
    cd "$APP_DIR"
    echo "📥 Pulling latest changes..."
    git fetch origin
    git checkout master
    git pull origin master
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install --production=false

# Generate Prisma client
echo "🔧 Generating Prisma client..."
npx prisma generate

# Build application
echo "🏗️ Building application..."
NEXT_TELEMETRY_DISABLED=1 npm run build

# Stop existing PM2 process
echo "🔄 Stopping existing PM2 process..."
pm2 stop $APP_NAME 2>/dev/null || true
pm2 delete $APP_NAME 2>/dev/null || true

# Start application with PM2
echo "🚀 Starting application..."
PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production pm2 start npm --name "$APP_NAME" -- start

# Save PM2 configuration
echo "💾 Saving PM2 configuration..."
pm2 save

# Show status
echo "📊 Application status:"
pm2 status $APP_NAME

echo ""
echo "🎉 Trim Pro deployed successfully!"
echo "🌐 Application running at: http://$SERVER_IP:3000"
"@

Write-Host "🔐 Executing deployment commands on server..." -ForegroundColor Cyan

try {
    $result = ssh -o StrictHostKeyChecking=no -i $sshKey $SERVER_USER@$SERVER_IP $remoteCommands
    Write-Host $result
    Write-Host ""
    Write-Host "✅ Deployment completed!" -ForegroundColor Green
    Write-Host "🌐 Access your application at: http://$SERVER_IP:3000" -ForegroundColor Yellow
} catch {
    Write-Host "❌ Deployment failed!" -ForegroundColor Red
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
