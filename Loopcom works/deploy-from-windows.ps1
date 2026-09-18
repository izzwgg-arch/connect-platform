# Trim Pro - Windows Deployment Script
# Run this from PowerShell in the project root directory

$ErrorActionPreference = "Stop"

$SERVER_IP = "154.12.235.86"
$SERVER_USER = "root"
$SSH_KEY = "$env:USERPROFILE\.ssh\trimpro_ed25519"
$APP_DIR = "~/apps/trimpro"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Trim Pro - Windows Deployment Script" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Check if SSH key exists
if (-not (Test-Path $SSH_KEY)) {
    Write-Host "❌ SSH key not found at: $SSH_KEY" -ForegroundColor Red
    Write-Host "   Please ensure your SSH key is in the correct location." -ForegroundColor Yellow
    exit 1
}

Write-Host "✅ SSH key found" -ForegroundColor Green

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
    $testResult = ssh -i $SSH_KEY -o ConnectTimeout=5 "$SERVER_USER@$SERVER_IP" "echo SSH_OK" 2>&1
    if ($testResult -match "SSH_OK") {
        Write-Host "✅ SSH connection successful" -ForegroundColor Green
    } else {
        throw "SSH connection failed"
    }
} catch {
    Write-Host "❌ SSH connection failed. Please check:" -ForegroundColor Red
    Write-Host "   1. Server is accessible" -ForegroundColor Yellow
    Write-Host "   2. SSH key is correct" -ForegroundColor Yellow
    Write-Host "   3. Server IP: $SERVER_IP" -ForegroundColor Yellow
    exit 1
}

Write-Host ""

# Create app directory on server
Write-Host "📁 Creating app directory on server..." -ForegroundColor Yellow
ssh -i $SSH_KEY "$SERVER_USER@$SERVER_IP" "mkdir -p $APP_DIR" | Out-Null
Write-Host "✅ Directory created" -ForegroundColor Green
Write-Host ""

# Upload deployment script
Write-Host "📤 Uploading deployment script..." -ForegroundColor Yellow
scp -i $SSH_KEY deploy-production.sh "$SERVER_USER@${SERVER_IP}:$APP_DIR/" 2>&1 | Out-Null
Write-Host "✅ Deployment script uploaded" -ForegroundColor Green
Write-Host ""

# Upload files (excluding node_modules, .next, .git, .env)
Write-Host "📤 Uploading application files..." -ForegroundColor Yellow
Write-Host "   (This may take a few minutes...)" -ForegroundColor Gray

# Create temporary directory for files to upload
$tempDir = Join-Path $env:TEMP "trimpro-deploy-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

try {
    # Copy files, excluding certain directories
    $excludeDirs = @("node_modules", ".next", ".git", ".env", "dist", "build", ".cache")
    $excludeFiles = @("*.log", ".DS_Store", "Thumbs.db")
    
    Get-ChildItem -Path . -Recurse | Where-Object {
        $relativePath = $_.FullName.Substring($PWD.Path.Length + 1)
        $shouldExclude = $false
        
        foreach ($exclude in $excludeDirs) {
            if ($relativePath -like "$exclude*" -or $relativePath -like "*\$exclude\*") {
                $shouldExclude = $true
                break
            }
        }
        
        if (-not $shouldExclude) {
            foreach ($exclude in $excludeFiles) {
                if ($_.Name -like $exclude) {
                    $shouldExclude = $true
                    break
                }
            }
        }
        
        -not $shouldExclude
    } | ForEach-Object {
        $destPath = Join-Path $tempDir $_.FullName.Substring($PWD.Path.Length + 1)
        $destDir = Split-Path $destPath -Parent
        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Force -Path $destDir | Out-Null
        }
        Copy-Item $_.FullName -Destination $destPath -Force
    }
    
    Write-Host "   Files prepared for upload" -ForegroundColor Gray
    
    # Upload files
    scp -i $SSH_KEY -r "$tempDir\*" "$SERVER_USER@${SERVER_IP}:$APP_DIR/" 2>&1 | Out-Null
    
    Write-Host "✅ Files uploaded successfully" -ForegroundColor Green
} finally {
    # Cleanup
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""

# Instructions for next steps
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "✅ File Upload Complete!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Use SSH to run deploy-production.sh on the server." -ForegroundColor Yellow
Write-Host "Server: $SERVER_USER@$SERVER_IP" -ForegroundColor Gray
Write-Host "App Dir: $APP_DIR" -ForegroundColor Gray
Write-Host ""
