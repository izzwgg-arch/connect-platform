#!/usr/bin/env bash
set -euo pipefail

cd /root/apps/trimpro

CRON_SECRET="$(sed -n 's/^CRON_SECRET=//p' .env | tr -d '\r' | awk 'NR==1{print; exit}')"
if [[ -z "${CRON_SECRET}" ]]; then
  CRON_SECRET="$(date +%s%N)"
  echo "CRON_SECRET=${CRON_SECRET}" >> .env
fi

(
  crontab -l 2>/dev/null | sed '/trimpro-tasks-reminders/d;/trimpro-issues-reminders/d;/trimpro-measuring-reminders/d'
  echo "0 8-19/4 * * * curl -fsS -X POST -H \"x-cron-secret: ${CRON_SECRET}\" https://app.trimprony.com/api/tasks/reminders >/dev/null 2>&1 # trimpro-tasks-reminders"
  echo "0 */2 * * * curl -fsS -X POST -H \"x-cron-secret: ${CRON_SECRET}\" https://app.trimprony.com/api/issues/reminders >/dev/null 2>&1 # trimpro-issues-reminders"
  echo "0 */2 * * * curl -fsS -X POST -H \"x-cron-secret: ${CRON_SECRET}\" https://app.trimprony.com/api/measuring-requests/reminders >/dev/null 2>&1 # trimpro-measuring-reminders"
) | crontab -

crontab -l
