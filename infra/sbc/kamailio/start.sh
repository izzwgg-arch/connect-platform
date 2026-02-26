#!/bin/sh
set -eu

PBX_HOST="${SBC_PBX_HOST:-pbx}"
PBX_PORT="${SBC_PBX_PORT:-5060}"

printf '1 sip:%s:%s\n' "$PBX_HOST" "$PBX_PORT" > /etc/kamailio/dispatcher.list

exec kamailio -DD -E -f /etc/kamailio/kamailio.cfg
