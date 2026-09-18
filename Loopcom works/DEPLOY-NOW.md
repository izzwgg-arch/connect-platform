# 🚀 Trim Pro - Production Deployment Guide

**Server IP:** 154.12.235.86  
**Server User:** root (or deploy if configured)

---

## 📋 Pre-Deployment Checklist

- [x] ✅ Build passes locally (`npm run build`)
- [x] ✅ Server is bootstrapped (NGINX, Node.js, PM2 installed)
- [ ] ⏳ PostgreSQL database set up
- [ ] ⏳ Redis installed and running
- [ ] ⏳ Environment variables configured
- [ ] ⏳ Files uploaded to server
- [ ] ⏳ Application deployed and running

---

## Step 1: Set Up Database on Server

SSH into your server:
```powershell
ssh contabo-trimpro
```

Install PostgreSQL (if not already installed):
```bash
sudo apt update
sudo apt install postgresql postgresql-contrib -y
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

Create database and user:
```bash
sudo -u postgres psql << EOF
CREATE DATABASE trimpro;
CREATE USER trimpro_user WITH ENCRYPTED PASSWORD 'YOUR_SECURE_PASSWORD_HERE';
GRANT ALL PRIVILEGES ON DATABASE trimpro TO trimpro_user;
ALTER DATABASE trimpro OWNER TO trimpro_user;
\q
EOF
```

**⚠️ IMPORTANT:** Replace `YOUR_SECURE_PASSWORD_HERE` with a strong password. Save it for the `.env` file.

Verify database:
```bash
sudo -u postgres psql -c "\l" | grep trimpro
```

---

## Step 2: Set Up Redis

Check if Redis is installed:
```bash
redis-cli ping
```

If not installed:
```bash
sudo apt install redis-server -y
sudo systemctl start redis-server
sudo systemctl enable redis-server
```

Verify Redis:
```bash
redis-cli ping
# Should return: PONG
```

---

## Step 3: Prepare Application Files

### Option A: Upload Files from Windows (Recommended for first deployment)

From your Windows machine, in PowerShell:
```powershell
cd "C:\dev\projects\trim pro 2"

# Create app directory on server
ssh contabo-trimpro "mkdir -p ~/apps/trimpro"

# Upload files (excluding node_modules, .next, etc.)
scp -i $env:USERPROFILE\.ssh\contabo_trimpro -r \
  --exclude="node_modules" \
  --exclude=".next" \
  --exclude=".git" \
  --exclude=".env" \
  * root@154.12.235.86:~/apps/trimpro/
```

**Note:** If `scp` doesn't support `--exclude`, use this alternative:
```powershell
# Create a temporary directory with only needed files
$tempDir = "C:\temp\trimpro-deploy"
New-Item -ItemType Directory -Force -Path $tempDir

# Copy files (manually exclude what you don't need)
Copy-Item -Path ".\*" -Destination $tempDir -Recurse -Exclude "node_modules",".next",".git",".env"

# Upload
scp -i $env:USERPROFILE\.ssh\contabo_trimpro -r "$tempDir\*" root@154.12.235.86:~/apps/trimpro/

# Cleanup
Remove-Item -Path $tempDir -Recurse -Force
```

### Option B: Use Git (if you have a repository)

```bash
ssh contabo-trimpro
cd ~/apps
git clone <your-repo-url> trimpro
cd trimpro
```

---

## Step 4: Configure Environment Variables

SSH into server and create `.env` file:
```bash
ssh contabo-trimpro
cd ~/apps/trimpro
nano .env
```

Copy the contents from `.env.example` and fill in your values:

**Required values to set:**
1. `DATABASE_URL` - Use the password you created in Step 1
   ```
   DATABASE_URL="postgresql://trimpro_user:YOUR_PASSWORD@localhost:5432/trimpro?schema=public"
   ```

2. `JWT_SECRET` and `JWT_REFRESH_SECRET` - Generate secure random strings:
   ```bash
   openssl rand -base64 32
   ```

3. `NEXT_PUBLIC_APP_URL` - Your server IP or domain
   ```
   NEXT_PUBLIC_APP_URL="http://154.12.235.86"
   ```

4. Other API keys as needed (you can add these later)

Save and exit (`Ctrl+X`, then `Y`, then `Enter`).

---

## Step 5: Deploy Application

SSH into server:
```bash
ssh contabo-trimpro
cd ~/apps/trimpro
```

Make deployment script executable:
```bash
chmod +x deploy-production.sh
```

Run deployment:
```bash
./deploy-production.sh
```

**Or manually:**
```bash
# Load NVM
source ~/.nvm/nvm.sh

# Install dependencies
npm install

# Generate Prisma client
npx prisma generate

# Push database schema
npx prisma db push

# Build application
NEXT_TELEMETRY_DISABLED=1 npm run build

# Start with PM2
PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production pm2 start npm --name "trimpro" -- start

# Save PM2 config
pm2 save
```

---

## Step 6: Configure NGINX

Create NGINX configuration:
```bash
ssh contabo-trimpro
sudo nano /etc/nginx/sites-available/trimpro
```

Paste this configuration:
```nginx
server {
    listen 80;
    server_name 154.12.235.86;  # Replace with your domain when ready

    # Increase timeouts for long-running requests
    proxy_read_timeout 300s;
    proxy_connect_timeout 300s;
    proxy_send_timeout 300s;

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
    }
}
```

Enable the site:
```bash
sudo ln -s /etc/nginx/sites-available/trimpro /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## Step 7: Verify Deployment

Check PM2 status:
```bash
pm2 status trimpro
pm2 logs trimpro --lines 50
```

Test the application:
```bash
curl http://localhost:3000
```

Test through NGINX:
```bash
curl http://154.12.235.86
```

Or open in browser: `http://154.12.235.86`

---

## Step 8: Create Admin User

You can create an admin user using the API:

```bash
curl -X POST http://localhost:3000/api/bootstrap/admin \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@trimpro.com",
    "password": "SecurePassword123!",
    "firstName": "Admin",
    "lastName": "User"
  }'
```

Or use the seed script:
```bash
npm run seed
```

---

## 🔧 Troubleshooting

### Application won't start
```bash
# Check PM2 logs
pm2 logs trimpro

# Check environment variables
cat .env | grep -v PASSWORD

# Test database connection
npx prisma db pull

# Test Redis connection
redis-cli ping
```

### NGINX errors
```bash
# Check NGINX syntax
sudo nginx -t

# Check NGINX logs
sudo tail -f /var/log/nginx/error.log

# Verify app is running
curl http://127.0.0.1:3000
```

### Database connection issues
```bash
# Test PostgreSQL connection
psql -U trimpro_user -d trimpro -h localhost

# Check PostgreSQL is running
sudo systemctl status postgresql
```

---

## 📝 Next Steps

1. **Set up SSL** (when you have a domain):
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d yourdomain.com
   ```

2. **Configure backups** for database and files

3. **Set up monitoring** (PM2 monitoring, log rotation)

4. **Add remaining API keys** (SOLA, QuickBooks, VoIP.ms, etc.)

---

## ✅ Deployment Complete!

Your Trim Pro application should now be running at:
- **Direct:** http://154.12.235.86:3000
- **Via NGINX:** http://154.12.235.86

Login with your admin credentials and start configuring your platform!
