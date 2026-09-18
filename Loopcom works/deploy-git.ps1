# Trim Pro - Git Deployment Script (Windows)
# This script connects to the server and runs git-based deployment
# Run this from PowerShell in the project root directory

$ErrorActionPreference = "Stop"

$SERVER_IP = "154.12.235.86"
$SERVER_USER = "root"
$SSH_KEY = "$env:USERPROFILE\.ssh\contabo_trimpro"
$APP_DIR = "~/apps/trimpro"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Trim Pro - Git Deployment" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Check if SSH key exists
if (-not (Test-Path $SSH_KEY)) {
    Write-Host "❌ SSH key not found at: $SSH_KEY" -ForegroundColor Red
    Write-Host "   Please ensure your SSH key is in the correct location." -ForegroundColor Yellow
    Write-Host "   Trying alternative key locations..." -ForegroundColor Yellow
    
    # Try alternative key locations
    $altKeys = @(
        "$env:USERPROFILE\.ssh\cursor_contabo_new",
        "$env:USERPROFILE\.ssh\id_rsa",
        "$env:USERPROFILE\.ssh\id_ed25519"
    )
    
    $foundKey = $null
    foreach ($key in $altKeys) {
        if (Test-Path $key) {
            $foundKey = $key
            Write-Host "✅ Found SSH key at: $key" -ForegroundColor Green
            break
        }
    }
    
    if (-not $foundKey) {
        Write-Host "❌ No SSH key found. Please specify the correct path." -ForegroundColor Red
        exit 1
    }
    
    $SSH_KEY = $foundKey
} else {
    Write-Host "✅ SSH key found at: $SSH_KEY" -ForegroundColor Green
}

# Check if we're in the project directory
if (-not (Test-Path "package.json")) {
    Write-Host "❌ Error: package.json not found. Are you in the project root?" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Project directory confirmed" -ForegroundColor Green
Write-Host ""

# Test SSH connection
Write-Host "🔐 Testing SSH connection..." -ForegroundColor Yellow
try {
    $testResult = ssh -i $SSH_KEY -o ConnectTimeout=5 -o StrictHostKeyChecking=no "$SERVER_USER@$SERVER_IP" "echo 'SSH_OK'; hostname" 2>&1
    if ($testResult -match "SSH_OK") {
        Write-Host "✅ SSH connection successful" -ForegroundColor Green
        $hostname = ($testResult -split "`n")[-1]
        Write-Host "   Connected to: $hostname" -ForegroundColor Gray
    } else {
        throw "SSH connection failed"
    }
} catch {
    Write-Host "❌ SSH connection failed. Please check:" -ForegroundColor Red
    Write-Host "   1. Server is accessible" -ForegroundColor Yellow
    Write-Host "   2. SSH key is correct: $SSH_KEY" -ForegroundColor Yellow
    Write-Host "   3. Server IP: $SERVER_IP" -ForegroundColor Yellow
    Write-Host "   4. Server User: $SERVER_USER" -ForegroundColor Yellow
    exit 1
}

Write-Host ""

# Check if git repository exists on server
Write-Host "📂 Checking git repository on server..." -ForegroundColor Yellow
$gitCheck = ssh -i $SSH_KEY "$SERVER_USER@$SERVER_IP" "cd $APP_DIR; git rev-parse --is-inside-work-tree 2>&1" 2>&1

if ($gitCheck -match "true") {
    Write-Host "✅ Git repository found on server" -ForegroundColor Green
    Write-Host ""
    Write-Host "📥 Pulling latest changes from GitHub..." -ForegroundColor Yellow
    
    # Pull latest changes
    $pullResult = ssh -i $SSH_KEY "$SERVER_USER@$SERVER_IP" "cd $APP_DIR; git pull origin master 2>&1" 2>&1
    Write-Host $pullResult
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "⚠️  Warning: Git pull had issues, but continuing..." -ForegroundColor Yellow
    }
} else {
    Write-Host "⚠️  Git repository not found. Setting up repository..." -ForegroundColor Yellow
    
    # Create directory and clone
    ssh -i $SSH_KEY "$SERVER_USER@$SERVER_IP" "mkdir -p $APP_DIR; cd $APP_DIR; git clone https://github.com/izzwgg-arch/Trimpro.git . 2>&1" 2>&1 | Out-Null
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Repository cloned successfully" -ForegroundColor Green
    } else {
        Write-Host "❌ Failed to clone repository" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""

# Check if deployment script exists
Write-Host "📋 Checking deployment script..." -ForegroundColor Yellow
$scriptCheck = ssh -i $SSH_KEY "$SERVER_USER@$SERVER_IP" "if [ -f $APP_DIR/deploy-from-git.sh ]; then echo 'exists'; else echo 'missing'; fi" 2>&1

if ($scriptCheck -match "exists") {
    Write-Host "✅ Deployment script found" -ForegroundColor Green
} else {
    Write-Host "⚠️  Deployment script not found. It should be in the repository." -ForegroundColor Yellow
}

Write-Host ""

# Run deployment script
Write-Host "🚀 Starting deployment..." -ForegroundColor Cyan
Write-Host "   (This may take several minutes...)" -ForegroundColor Gray
Write-Host ""

$deployCommand = "cd $APP_DIR; chmod +x deploy-from-git.sh 2>/dev/null; ./deploy-from-git.sh"

# Run deployment and capture output
$deployOutput = ssh -i $SSH_KEY "$SERVER_USER@$SERVER_IP" $deployCommand 2>&1

# Display output
Write-Host $deployOutput

# Check deployment status
if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host "✅ Deployment Complete!" -ForegroundColor Green
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host ""
    
    # Check PM2 status
    Write-Host "📊 Checking application status..." -ForegroundColor Yellow
    $pm2Status = ssh -i $SSH_KEY "$SERVER_USER@$SERVER_IP" "pm2 status trimpro 2>&1" 2>&1
    Write-Host $pm2Status
    Write-Host ""
    
    Write-Host "🌐 Application should be running at: http://$SERVER_IP:3000" -ForegroundColor Cyan
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "❌ Deployment encountered errors. Check the output above." -ForegroundColor Red
    Write-Host ""
    Write-Host "📝 To troubleshoot, SSH into the server:" -ForegroundColor Yellow
    Write-Host "   ssh -i $SSH_KEY $SERVER_USER@$SERVER_IP" -ForegroundColor Gray
    Write-Host "   cd $APP_DIR" -ForegroundColor Gray
    Write-Host "   ./deploy-from-git.sh" -ForegroundColor Gray
    Write-Host ""
    exit 1
}
