#!/bin/bash
set -euo pipefail
cd /root/apps/trimpro
SECRET=$(grep '^QBO_ACH_RECONCILE_SECRET=' .env | tail -1 | cut -d= -f2-)
curl -sS -X POST "https://app.trimprony.com/api/payments/qbo/reconcile?secret=${SECRET}"
echo
