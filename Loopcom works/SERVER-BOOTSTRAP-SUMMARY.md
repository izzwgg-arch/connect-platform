# Ubuntu Server Bootstrap Summary

**Server IP:** 154.12.235.86  
**Date:** January 14, 2025  
**Status:** ✅ Bootstrap Complete

---

## ✅ What Was Installed

### A) Base OS Setup
- ✅ System updated and upgraded
- ✅ Packages installed:
  - curl, git, build-essential
  - ufw (firewall)
  - fail2ban
  - unattended-upgrades
  - ca-certificates, gnupg, lsb-release
  - htop, unzip, jq
- ✅ Timezone set to: **America/New_York**

### B) User Setup
- ✅ Created user: **deploy** (with sudo access)
- ✅ SSH key configured for deploy user
- ✅ SSH directory permissions: 700
- ✅ authorized_keys permissions: 600

### C) SSH Security (Password Auth Still Enabled)
- ✅ `PermitRootLogin prohibit-password` (root can only use keys)
- ✅ `PubkeyAuthentication yes`
- ✅ `PasswordAuthentication yes` (kept enabled until you confirm key auth works)
- ✅ SSH service restarted

### D) Node.js Toolchain
- ✅ **NVM** installed for deploy user
- ✅ **Node.js v24.13.0** (LTS) installed
- ✅ **pnpm** installed globally
- ✅ **PM2 v6.0.14** installed globally
- ✅ PM2 startup configured for systemd

### E) NGINX
- ✅ NGINX installed and running
- ✅ Default site removed
- ✅ Reverse proxy template created at: `/etc/nginx/sites-available/app-template`

### F) SSL
- ⏭️ Skipped (no domain provided)

### G) Firewall (UFW)
- ✅ Default: deny incoming, allow outgoing
- ✅ Rules:
  - OpenSSH (port 22)
  - HTTP (port 80)
  - HTTPS (port 443)
- ✅ UFW enabled and active

### H) Fail2ban
- ✅ Service enabled and running
- ✅ SSH jail active (already protecting: 18 IPs banned)

---

## 🔍 Verification Commands (Run on Server)

```bash
# NGINX
nginx -t
systemctl status nginx --no-pager

# Firewall
ufw status verbose

# Fail2ban
fail2ban-client status sshd

# Node.js versions (as deploy user)
sudo -u deploy bash -c 'source ~/.nvm/nvm.sh && node -v && pnpm -v && pm2 -v'

# Listening ports
ss -tulpen | grep -E ':22|:80|:443|:3000'
```

---

## 📋 Critical Next Steps

### 1. Test SSH Access as Deploy User

**⚠️ IMPORTANT:** Before disabling password authentication, test that you can SSH into the server using your SSH key as the `deploy` user.

**From Windows PowerShell, run:**
```powershell
ssh -i $env:USERPROFILE\.ssh\cursor_contabo_new deploy@154.12.235.86
```

**Or add to your SSH config** (`C:\Users\<YourUser>\.ssh\config`):
```
Host deploy-contabo
    HostName 154.12.235.86
    User deploy
    IdentityFile ~/.ssh/cursor_contabo_new
    IdentitiesOnly yes
```

Then use: `ssh deploy-contabo`

**Once you confirm key-based SSH works, run this to disable password authentication:**
```bash
ssh root@154.12.235.86
# Then on server:
sed -i 's/^PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
exit
```

---

## 🚀 Deploying Your Next.js App

### Step 1: SSH as Deploy User
```powershell
ssh -i $env:USERPROFILE\.ssh\cursor_contabo_new deploy@154.12.235.86
```

### Step 2: Setup Your App Directory
```bash
# On server
cd ~
mkdir -p apps/my-app
cd apps/my-app

# Clone your repo or upload files
git clone <your-repo-url> .

# Or use scp from Windows:
# scp -i $env:USERPROFILE\.ssh\cursor_contabo_new -r ./local-app/* deploy@154.12.235.86:~/apps/my-app/
```

### Step 3: Install Dependencies & Build
```bash
# Load NVM
source ~/.nvm/nvm.sh

# Install dependencies
pnpm install

# Build your Next.js app
pnpm build
```

### Step 4: Start App with PM2 (Bind to 0.0.0.0:3000)
```bash
# Start with PM2 - MUST bind to 0.0.0.0, not 127.0.0.1
PORT=3000 HOSTNAME=0.0.0.0 pm2 start npm --name "my-app" -- start

# Or if using next start:
PORT=3000 HOSTNAME=0.0.0.0 pm2 start "pnpm start" --name "my-app"

# Save PM2 process list
pm2 save
```

### Step 5: Configure NGINX
```bash
# Copy the template
sudo cp /etc/nginx/sites-available/app-template /etc/nginx/sites-available/my-app

# Edit the config
sudo nano /etc/nginx/sites-available/my-app
# Replace:
# - YOUR_DOMAIN_OR_IP with your domain or 154.12.235.86
# - Adjust proxy_pass port if needed

# Enable the site
sudo ln -s /etc/nginx/sites-available/my-app /etc/nginx/sites-enabled/

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

### Step 6: Verify Everything Works
```bash
# Check PM2 status
pm2 status
pm2 logs my-app

# Check NGINX
sudo systemctl status nginx
sudo tail -f /var/log/nginx/error.log

# Test from your PC
curl http://154.12.235.86
```

---

## 🔐 Setting Up SSL (When You Have a Domain)

1. **Point your domain DNS to:** `154.12.235.86`

2. **Install certbot:**
```bash
sudo apt-get update
sudo apt-get install -y certbot python3-certbot-nginx
```

3. **Get certificate:**
```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

4. **Verify auto-renewal:**
```bash
sudo certbot renew --dry-run
sudo systemctl status certbot.timer
```

---

## 📝 Useful Commands Reference

### PM2 Commands
```bash
pm2 list                    # List all apps
pm2 logs my-app            # View logs
pm2 restart my-app         # Restart app
pm2 stop my-app            # Stop app
pm2 delete my-app          # Remove from PM2
pm2 monit                  # Monitor dashboard
pm2 save                   # Save current process list
```

### NGINX Commands
```bash
sudo nginx -t              # Test configuration
sudo systemctl reload nginx # Reload without downtime
sudo systemctl restart nginx # Full restart
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### System Commands
```bash
# Check disk space
df -h

# Check memory
free -h

# Check running processes
htop

# View system logs
sudo journalctl -xe
```

---

## ⚠️ Important Notes

1. **SSH Key Authentication:** Password authentication is still enabled. Test key-based SSH first, then disable password auth for security.

2. **PM2 Startup:** PM2 startup script should already be configured. If you need to regenerate:
   ```bash
   pm2 startup systemd -u deploy --hp /home/deploy
   # Follow the displayed command (run as root)
   ```

3. **App Binding:** Your Next.js app **MUST** bind to `0.0.0.0:3000`, not `127.0.0.1:3000`, so NGINX can reach it.

4. **Firewall:** UFW is active. Ports 22, 80, and 443 are open. Port 3000 should NOT be exposed - only NGINX accesses it locally.

5. **Fail2ban:** Already protecting SSH. Check banned IPs with:
   ```bash
   fail2ban-client status sshd
   ```

---

## 🔧 Optional: Install PostgreSQL

If you need PostgreSQL, run:
```bash
ssh root@154.12.235.86
apt-get install -y postgresql postgresql-contrib
sudo -u postgres psql << EOF
CREATE DATABASE myapp_db;
CREATE USER myapp_user WITH ENCRYPTED PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE myapp_db TO myapp_user;
\q
EOF

# Configure to only listen on localhost (already default)
# Connection string:
# postgresql://myapp_user:your_secure_password@localhost:5432/myapp_db
```

---

## ✅ Bootstrap Checklist Summary

- [x] Base OS updated and packages installed
- [x] Deploy user created with SSH key
- [x] SSH secured (password auth still enabled - TEST FIRST)
- [x] Node.js v24.13.0 installed via NVM
- [x] pnpm installed
- [x] PM2 installed and configured
- [x] NGINX installed with reverse proxy template
- [x] UFW firewall configured (ports 22, 80, 443)
- [x] Fail2ban enabled and protecting SSH
- [ ] **YOU NEED TO:** Test SSH as deploy user
- [ ] **YOU NEED TO:** Disable password auth after confirming key works
- [ ] **YOU NEED TO:** Deploy your app when ready

---

**Server is ready for production Node.js/Next.js deployment! 🚀**
