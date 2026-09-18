# Deployment Guide - Contabo Server

**Server IP:** 154.12.235.86  
**Deploy User:** deploy

---

## Quick Start

### Option 1: Deploy from Git Repository

```bash
# SSH into server
ssh deploy-contabo

# Create app directory
mkdir -p ~/apps/my-app
cd ~/apps/my-app

# Clone your repository
git clone <your-repo-url> .

# Load NVM and deploy
source ~/.nvm/nvm.sh
pnpm install
pnpm build

# Start with PM2 (IMPORTANT: bind to 0.0.0.0)
PORT=3000 HOSTNAME=0.0.0.0 pm2 start "pnpm start" --name "my-app"
pm2 save

# Configure NGINX
sudo cp /etc/nginx/sites-available/app-template /etc/nginx/sites-available/my-app
sudo sed -i 's/YOUR_DOMAIN_OR_IP/154.12.235.86/g' /etc/nginx/sites-available/my-app
sudo ln -s /etc/nginx/sites-available/my-app /etc/nginx/sites-enabled/my-app
sudo nginx -t && sudo systemctl reload nginx
```

### Option 2: Upload Files from Windows

```powershell
# From Windows PowerShell, in your app directory:
scp -i $env:USERPROFILE\.ssh\cursor_contabo_new -r * deploy@154.12.235.86:~/apps/my-app/
```

Then SSH in and run the build/deploy commands above.

---

## Deployment Script

I've created a `deploy.sh` script you can use. Upload it to your server:

```powershell
# Upload deploy script
scp -i $env:USERPROFILE\.ssh\cursor_contabo_new deploy.sh deploy@154.12.235.86:~/

# SSH in and use it
ssh deploy-contabo
chmod +x ~/deploy.sh
cd ~/apps/my-app
~/deploy.sh my-app 3000
```

---

## Important Configuration

### Next.js must bind to 0.0.0.0

Your `next.config.js` or start command must bind to `0.0.0.0`, not `127.0.0.1`:

```javascript
// next.config.js
module.exports = {
  // ... other config
}
```

Start command:
```bash
PORT=3000 HOSTNAME=0.0.0.0 pnpm start
```

Or in `package.json`:
```json
{
  "scripts": {
    "start": "next start -H 0.0.0.0 -p 3000"
  }
}
```

---

## Environment Variables

Create a `.env.production` file on the server:

```bash
ssh deploy-contabo
cd ~/apps/my-app
nano .env.production
```

Then restart PM2:
```bash
pm2 restart my-app
```

---

## Monitoring

```bash
# View logs
pm2 logs my-app

# Monitor dashboard
pm2 monit

# Check status
pm2 status

# Restart app
pm2 restart my-app

# Stop app
pm2 stop my-app
```

---

## NGINX Configuration

The template is at `/etc/nginx/sites-available/app-template`. For each app:

1. Copy template: `sudo cp /etc/nginx/sites-available/app-template /etc/nginx/sites-available/my-app`
2. Edit: `sudo nano /etc/nginx/sites-available/my-app`
3. Change `YOUR_DOMAIN_OR_IP` to your domain or IP
4. Change port if needed (default: 3000)
5. Enable: `sudo ln -s /etc/nginx/sites-available/my-app /etc/nginx/sites-enabled/my-app`
6. Test: `sudo nginx -t`
7. Reload: `sudo systemctl reload nginx`

---

## Troubleshooting

### App not accessible
- Check PM2: `pm2 status`
- Check logs: `pm2 logs my-app`
- Verify binding: `ss -tulpen | grep 3000` (should show 0.0.0.0:3000)
- Check NGINX: `sudo nginx -t && sudo systemctl status nginx`

### Port already in use
- Change port in PM2 start command
- Update NGINX config to match new port

### Permission issues
- Ensure deploy user owns app directory: `sudo chown -R deploy:deploy ~/apps/my-app`

---

## SSL/HTTPS Setup (When You Have a Domain)

```bash
# Install certbot
sudo apt-get install -y certbot python3-certbot-nginx

# Get certificate
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# Auto-renewal is automatic
```

---

Need help? Check `SERVER-BOOTSTRAP-SUMMARY.md` for complete server setup details.
