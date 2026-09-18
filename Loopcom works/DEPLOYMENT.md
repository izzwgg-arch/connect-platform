# Trim Pro - Deployment Guide

## Prerequisites

- Ubuntu 24.04+ server
- Node.js 20 LTS (installed via NVM)
- PostgreSQL 15+
- Redis 7+
- NGINX (configured)
- PM2 (for process management)
- Domain name (optional, for SSL)

## Server Setup

### 1. Database Setup

```bash
# Connect to PostgreSQL
sudo -u postgres psql

# Create database
CREATE DATABASE trimpro;
CREATE USER trimpro_user WITH ENCRYPTED PASSWORD 'your-secure-password';
GRANT ALL PRIVILEGES ON DATABASE trimpro TO trimpro_user;

# Exit PostgreSQL
\q
```

### 2. Redis Setup

```bash
# Redis should be installed and running
sudo systemctl status redis

# If not installed:
sudo apt install redis-server
sudo systemctl enable redis
sudo systemctl start redis
```

### 3. Application Setup

```bash
# Clone repository (or upload files)
cd /var/www
git clone <your-repo-url> trimpro
cd trimpro

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit environment variables
nano .env
```

### 4. Environment Variables

Configure all required environment variables in `.env`:

- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `JWT_SECRET` - Strong random secret for JWT
- `JWT_REFRESH_SECRET` - Strong random secret for refresh tokens
- Email provider credentials (SendGrid/Mailgun/SES)
- SOLA API credentials
- QuickBooks OAuth credentials
- VoIP.ms credentials
- S3 credentials (if using file uploads)

### 5. Database Migrations

```bash
# Generate Prisma client
npx prisma generate

# Push schema to database
npx prisma db push

# Or run migrations
npx prisma migrate deploy
```

### 6. Build Application

```bash
# Build Next.js application
npm run build
```

### 7. PM2 Configuration

```bash
# Start with PM2
pm2 start npm --name "trimpro" -- start

# Or use ecosystem file
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Setup PM2 startup
pm2 startup
```

**ecosystem.config.js:**
```javascript
module.exports = {
  apps: [{
    name: 'trimpro',
    script: 'npm',
    args: 'start',
    cwd: '/var/www/trimpro',
    instances: 1,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }],
}
```

### 8. NGINX Configuration

Create NGINX config file:

```bash
sudo nano /etc/nginx/sites-available/trimpro
```

**Configuration:**
```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Redirect to HTTPS (after SSL setup)
    # return 301 https://$server_name$request_uri;

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
        proxy_connect_timeout 300s;
    }
}

# SSL Configuration (after obtaining certificate)
# server {
#     listen 443 ssl http2;
#     server_name your-domain.com;
#
#     ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
#     ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
#
#     # SSL settings
#     ssl_protocols TLSv1.2 TLSv1.3;
#     ssl_ciphers HIGH:!aNULL:!MD5;
#     ssl_prefer_server_ciphers on;
#
#     location / {
#         proxy_pass http://127.0.0.1:3000;
#         proxy_http_version 1.1;
#         proxy_set_header Upgrade $http_upgrade;
#         proxy_set_header Connection 'upgrade';
#         proxy_set_header Host $host;
#         proxy_set_header X-Real-IP $remote_addr;
#         proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
#         proxy_set_header X-Forwarded-Proto $scheme;
#         proxy_cache_bypass $http_upgrade;
#     }
# }
```

Enable site:

```bash
sudo ln -s /etc/nginx/sites-available/trimpro /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 9. SSL Certificate (Let's Encrypt)

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal is configured automatically
sudo certbot renew --dry-run
```

### 10. Firewall Configuration

```bash
# Allow HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Check status
sudo ufw status
```

## Post-Deployment

### 1. Seed Database (Optional)

```bash
# Run seed script if available
npm run seed
```

### 2. Create Admin User

```bash
# Use API or create directly in database
# Example API call:
curl -X POST http://localhost:3000/api/users/invite \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin-token>" \
  -d '{
    "email": "admin@trimpro.com",
    "firstName": "Admin",
    "lastName": "User",
    "role": "ADMIN"
  }'
```

### 3. Verify Installation

- Check application: `https://your-domain.com`
- Check API health: `https://your-domain.com/api/health`
- Check PM2: `pm2 status`
- Check NGINX: `sudo systemctl status nginx`
- Check logs: `pm2 logs trimpro`

## Monitoring

### PM2 Monitoring

```bash
# View logs
pm2 logs trimpro

# View process info
pm2 info trimpro

# Monitor resources
pm2 monit
```

### NGINX Logs

```bash
# Access logs
sudo tail -f /var/log/nginx/access.log

# Error logs
sudo tail -f /var/log/nginx/error.log
```

### Application Logs

```bash
# PM2 logs
pm2 logs trimpro

# Or custom log files
tail -f /var/www/trimpro/logs/app.log
```

## Backup Strategy

### Database Backup

```bash
# Daily backup script
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
pg_dump -U trimpro_user trimpro > /backups/trimpro_$DATE.sql
# Keep last 30 days
find /backups -name "trimpro_*.sql" -mtime +30 -delete
```

### File Backup

```bash
# Backup uploaded files (if using local storage)
tar -czf /backups/files_$DATE.tar.gz /var/www/trimpro/public/uploads
```

## Updates

```bash
# Pull latest changes
cd /var/www/trimpro
git pull origin main

# Install new dependencies
npm install

# Run migrations (if any)
npx prisma migrate deploy

# Rebuild
npm run build

# Restart application
pm2 restart trimpro
```

## Troubleshooting

### Application Not Starting

1. Check PM2 logs: `pm2 logs trimpro`
2. Check environment variables: `cat .env`
3. Check database connection: `npx prisma db pull`
4. Check Redis connection: `redis-cli ping`

### NGINX Errors

1. Check syntax: `sudo nginx -t`
2. Check logs: `sudo tail -f /var/log/nginx/error.log`
3. Verify upstream: `curl http://127.0.0.1:3000`

### Database Issues

1. Check connection: `psql -U trimpro_user -d trimpro`
2. Check migrations: `npx prisma migrate status`
3. Verify schema: `npx prisma db pull`

## Security Checklist

- [ ] Strong JWT secrets configured
- [ ] Database password is secure
- [ ] Redis is not exposed publicly
- [ ] Firewall rules configured
- [ ] SSL certificate installed
- [ ] Fail2ban enabled
- [ ] Regular security updates
- [ ] Backup strategy in place
- [ ] Environment variables secured
- [ ] API rate limiting configured

## Performance Optimization

1. Enable NGINX caching
2. Use Redis for session storage
3. Enable database connection pooling
4. Configure PM2 clustering (if needed)
5. Use CDN for static assets
6. Enable gzip compression

## Support

For issues or questions, check:
- Application logs: `pm2 logs trimpro`
- System logs: `journalctl -xe`
- Database logs: PostgreSQL log files
- NGINX logs: `/var/log/nginx/`
