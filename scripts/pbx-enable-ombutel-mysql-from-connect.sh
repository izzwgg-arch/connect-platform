#!/usr/bin/env bash
# Run on the VitalPBX host (209.145.60.79) as root — opens read-only MySQL for the Connect app server.
# Connect app server IP (source of API container traffic):
CONNECT_APP_IP="${CONNECT_APP_IP:-45.14.194.179}"
MYSQL_OSBU_USER="${MYSQL_OSBU_USER:-connect_read}"
MYSQL_OSBU_PASS="${MYSQL_OSBU_PASS:?set MYSQL_OSBU_PASS}"

set -euo pipefail

if ! command -v mysql >/dev/null 2>&1; then
  echo "mysql client not found; install mariadb-client or use mysql from PATH" >&2
  exit 1
fi

# Detect socket or localhost auth (typical VitalPBX / MariaDB).
MYSQL_ADMIN=(mysql -uroot)

echo "[1] Ensuring MariaDB/MySQL listens on all interfaces (VitalPBX default is often 127.0.0.1 only)"
CFG_CANDIDATES=(/etc/mysql/mariadb.conf.d/50-server.cnf /etc/my.cnf.d/server.cnf /etc/mysql/my.cnf)
for f in "${CFG_CANDIDATES[@]}"; do
  if [[ -f "$f" ]]; then
    if grep -q '^bind-address' "$f" 2>/dev/null; then
      sed -i.bak-ombutel 's/^bind-address.*/bind-address = 0.0.0.0/' "$f" || true
    else
      printf '\n# ombutel-connect-read\nbind-address = 0.0.0.0\n' >>"$f"
    fi
  fi
done

if command -v systemctl >/dev/null 2>&1; then
  systemctl restart mariadb 2>/dev/null || systemctl restart mysql 2>/dev/null || true
fi

echo "[2] Creating/upgrading read-only user for ombutel (from ${CONNECT_APP_IP})"
"${MYSQL_ADMIN[@]}" <<SQL
CREATE USER IF NOT EXISTS '${MYSQL_OSBU_USER}'@'${CONNECT_APP_IP}' IDENTIFIED BY '${MYSQL_OSBU_PASS}';
ALTER USER '${MYSQL_OSBU_USER}'@'${CONNECT_APP_IP}' IDENTIFIED BY '${MYSQL_OSBU_PASS}';
GRANT SELECT ON ombutel.* TO '${MYSQL_OSBU_USER}'@'${CONNECT_APP_IP}';
FLUSH PRIVILEGES;
SQL

echo "[3] Firewall: allow 3306/tcp from Connect app server only"
if command -v ufw >/dev/null 2>&1; then
  ufw allow from "${CONNECT_APP_IP}" to any port 3306 proto tcp comment 'Connect Ombutel read-only' || true
  ufw reload || true
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-rich-rule="rule family='ipv4' source address='${CONNECT_APP_IP}' port port='3306' protocol='tcp' accept" || true
  firewall-cmd --reload || true
else
  echo "No ufw/firewalld; add iptables rule manually, e.g.:" >&2
  echo "  iptables -I INPUT -p tcp -s ${CONNECT_APP_IP} --dport 3306 -j ACCEPT" >&2
fi

echo "[4] Verify listener"
ss -lntp | grep -E ':3306\b' || netstat -lntp 2>/dev/null | grep 3306 || true

echo "Done. From Connect server test: nc -zv 209.145.60.79 3306"
echo "Then in API container OMBU_MYSQL_URL=mysql://${MYSQL_OSBU_USER}:****@209.145.60.79:3306/ombutel"
