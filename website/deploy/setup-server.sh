#!/usr/bin/env bash
# One-time setup of the Loopcom website VPS. Safe to re-run.
set -euo pipefail
echo "==> Loopcom website server setup"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx curl ca-certificates rsync ufw >/dev/null
echo "    [ok] nginx, certbot, rsync installed"

# Node 22 LTS from NodeSource
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    [ok] node $(node --version)"

# service account, no login shell
id -u loopcom >/dev/null 2>&1 || useradd --system --home /var/www/loopcom --shell /usr/sbin/nologin loopcom
mkdir -p /var/www/loopcom /var/lib/loopcom /var/www/certbot /etc/loopcom
chown -R loopcom:loopcom /var/www/loopcom /var/lib/loopcom
chmod 750 /etc/loopcom
echo "    [ok] user + directories"

# credentials file, root-only, created empty so systemd never fails on it
if [ ! -f /etc/loopcom/website.env ]; then
  cat > /etc/loopcom/website.env <<'ENVEOF'
# SMTP for the quote form and chat relay. Fill these in to enable email.
# The site works without them: submissions are stored on disk regardless.
#LOOPCOM_SMTP_HOST=smtp.gmail.com
#LOOPCOM_SMTP_PORT=587
#LOOPCOM_SMTP_USER=onboarding@loopcom.net
#LOOPCOM_SMTP_PASS=
#LOOPCOM_SMTP_FROM=Loopcom Website <onboarding@loopcom.net>
LOOPCOM_FORM_TO=onboarding@loopcom.net
ENVEOF
  chmod 600 /etc/loopcom/website.env
fi
echo "    [ok] /etc/loopcom/website.env (600, root only)"

# firewall: ssh + web only
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 80/tcp   >/dev/null 2>&1 || true
ufw allow 443/tcp  >/dev/null 2>&1 || true
yes | ufw enable   >/dev/null 2>&1 || true
echo "    [ok] ufw: $(ufw status | head -1)"

echo
echo "Setup complete. Next: deploy.sh pushes the site, then certbot issues TLS."
