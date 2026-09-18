#!/bin/bash
set -euo pipefail

# Ubuntu Server Bootstrap Script for Node/Next.js Production
# Server IP: 154.12.235.86
# Domain: none yet

echo "========================================="
echo "Starting Ubuntu Server Bootstrap"
echo "========================================="

# A) Base OS setup
echo ""
echo "=== A) Base OS Setup ==="
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get upgrade -y

# Install essential packages
apt-get install -y \
    curl \
    git \
    build-essential \
    ufw \
    fail2ban \
    unattended-upgrades \
    ca-certificates \
    gnupg \
    lsb-release \
    htop \
    unzip \
    jq

# Set timezone to America/New_York
timedatectl set-timezone America/New_York
echo "Timezone set to: $(timedatectl show --property=Timezone --value)"

# B) Create deploy user
echo ""
echo "=== B) Create Deploy User ==="
if id "deploy" &>/dev/null; then
    echo "User 'deploy' already exists, skipping creation"
else
    useradd -m -s /bin/bash deploy
    usermod -aG sudo deploy
    echo "User 'deploy' created with sudo access"
fi

# Create .ssh directory for deploy user
mkdir -p /home/deploy/.ssh
chmod 700 /home/deploy/.ssh

# Add SSH public key
SSH_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBUeIzy0ZVIAQ1oYCKf8as7lSFYvj/ZJDL0gHKSsaCM8 izzyw@DESKTOP-51RKDLO"
echo "$SSH_PUBKEY" > /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh

echo "SSH key configured for deploy user"

# C) Secure SSH safely
echo ""
echo "=== C) Secure SSH (Keeping Password Auth Enabled) ==="
SSHD_CONFIG="/etc/ssh/sshd_config"
cp "$SSHD_CONFIG" "$SSHD_CONFIG.backup.$(date +%Y%m%d_%H%M%S)"

# Configure SSH settings
sed -i 's/#PermitRootLogin.*/PermitRootLogin prohibit-password/' "$SSHD_CONFIG"
sed -i 's/^PermitRootLogin.*/PermitRootLogin prohibit-password/' "$SSHD_CONFIG"

# Ensure PubkeyAuthentication is yes
sed -i 's/#PubkeyAuthentication.*/PubkeyAuthentication yes/' "$SSHD_CONFIG"
sed -i 's/^PubkeyAuthentication.*/PubkeyAuthentication yes/' "$SSHD_CONFIG"

# Keep PasswordAuthentication yes for now
sed -i 's/#PasswordAuthentication.*/PasswordAuthentication yes/' "$SSHD_CONFIG"
sed -i 's/^PasswordAuthentication.*/PasswordAuthentication yes/' "$SSHD_CONFIG"

systemctl restart sshd
echo "SSH restarted. Password authentication still enabled."
echo "IMPORTANT: Test key-based SSH as 'deploy' user before we disable password auth."

# D) Node + toolchain (as deploy user)
echo ""
echo "=== D) Install Node.js Toolchain ==="
sudo -u deploy bash << 'DEPLOY_SCRIPT'
export HOME=/home/deploy

# Install NVM
if [ ! -d "$HOME/.nvm" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
fi

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Install Node.js LTS
nvm install --lts
nvm use --lts
nvm alias default node

# Install pnpm
npm install -g pnpm

# Install PM2 and setup startup
npm install -g pm2
pm2 startup systemd -u deploy --hp /home/deploy

echo "Node.js $(node -v) installed"
echo "pnpm $(pnpm -v) installed"
echo "pm2 $(pm2 -v) installed"
DEPLOY_SCRIPT

# E) NGINX
echo ""
echo "=== E) Install and Configure NGINX ==="
apt-get install -y nginx

# Create NGINX reverse proxy template
cat > /etc/nginx/sites-available/app-template << 'NGINX_TEMPLATE'
# NGINX Reverse Proxy Template for Next.js/Node Apps
# Copy this file to /etc/nginx/sites-available/your-app
# Then create symlink: ln -s /etc/nginx/sites-available/your-app /etc/nginx/sites-enabled/
# Finally: nginx -t && systemctl reload nginx

server {
    listen 80;
    # listen 443 ssl http2;  # Uncomment when SSL is configured
    # ssl_certificate /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem;

    server_name YOUR_DOMAIN_OR_IP;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript application/x-javascript application/xml+rss application/json application/javascript;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
}
NGINX_TEMPLATE

# Remove default nginx site
if [ -f /etc/nginx/sites-enabled/default ]; then
    rm /etc/nginx/sites-enabled/default
fi

systemctl enable nginx
systemctl start nginx
echo "NGINX installed and started"

# F) SSL - Skipped (no domain yet)

# G) Firewall (UFW)
echo ""
echo "=== G) Configure Firewall (UFW) ==="
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
echo "UFW firewall configured and enabled"

# H) Fail2ban
echo ""
echo "=== H) Configure Fail2ban ==="
systemctl enable fail2ban
systemctl start fail2ban
echo "Fail2ban enabled and started"

# I) Postgres - Skipped (will ask user)

echo ""
echo "========================================="
echo "Bootstrap Complete!"
echo "========================================="
echo ""
echo "Next Steps:"
echo "1. Test SSH as deploy user from your PC"
echo "2. Once confirmed, we'll disable password authentication"
echo "3. Configure your app with PM2 and NGINX"
