# Trim Pro - Quick Deploy to Remote Server

param(
    [string]$sshKey = "C:\Users\izzyw\.ssh\contabo_trimpro"
)

$SERVER_USER = "root"
$SERVER_IP = "154.12.235.86"
$APP_NAME = "trimpro"

Write-Host "==========================================" -ForegroundColor Green
Write-Host "Trim Pro - Remote Server Deployment" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host "Server: $SERVER_USER@$SERVER_IP" -ForegroundColor Yellow
Write-Host "SSH Key: $sshKey" -ForegroundColor Yellow
Write-Host ""

# Check if SSH key exists
if (-not (Test-Path $sshKey)) {
    Write-Host "❌ Error: SSH key not found at $sshKey" -ForegroundColor Red
    exit 1
}

Write-Host "🚀 Starting deployment to $SERVER_IP..." -ForegroundColor Cyan

# Simple deployment command
$deployCommand = @"
cd /root/apps/$APP_NAME 2>/dev/null || (mkdir -p /root/apps && cd /root/apps && git clone https://github.com/izzwgg-arch/Trimpro.git $APP_NAME && cd $APP_NAME)
git pull origin master
npm install --production=false
npx prisma generate
NEXT_TELEMETRY_DISABLED=1 npm run build
pm2 stop $APP_NAME 2>/dev/null || true
pm2 delete $APP_NAME 2>/dev/null || true
PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production pm2 start npm --name $APP_NAME -- start
pm2 save
echo "Deployment completed successfully!"
echo "Application running at: http://$SERVER_IP:3000"
"@

try {
    $result = ssh -o StrictHostKeyChecking=no -i $sshKey $SERVER_USER@$SERVER_IP $deployCommand
    Write-Host $result
    Write-Host ""
    Write-Host "✅ Deployment completed!" -ForegroundColor Green
    Write-Host "🌐 Access your application at: http://$SERVER_IP:3000" -ForegroundColor Yellow
} catch {
    Write-Host "❌ Deployment failed!" -ForegroundColor Red
    Write-Host "Error: $_" -ForegroundColor Red
    exit 1
}
