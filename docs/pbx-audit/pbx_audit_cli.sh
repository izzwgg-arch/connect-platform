#!/bin/bash
# Read-only PBX audit: output JSON only (channels + bridges).
# Install as: /usr/local/bin/pbx_audit_cli (chmod 755).
# Uses: sudo /usr/sbin/asterisk -rx "<command>"
# Forced-command / minimal PATH safe. No PBX config changes.

ASTERISK="/usr/sbin/asterisk"
TIMESTAMP=""
RAW_CHANNELS=""
RAW_BRIDGES=""
RAW_PJSIP=""
CHANNELS_JSON="[]"
BRIDGES_JSON="[]"
PARSE_FAILED=0

run_asterisk() {
  sudo "$ASTERISK" -rx "$1" 2>/dev/null
}

# ISO timestamp
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo '')"

# --- core show channels concise ---
RAW_CHANNELS="$(run_asterisk "core show channels concise")"
if [ -n "$RAW_CHANNELS" ]; then
  CHANNELS_JSON="$(echo "$RAW_CHANNELS" | awk '
    BEGIN { first=1; print "[" }
    /^Channel\s/ || /^$/ { next }
    {
      # Try ! delimiter first, then tab
      if (index($0, "!") > 0) {
        n = split($0, a, "!")
      } else {
        n = split($0, a, "\t")
      }
      if (n >= 9) {
        gsub(/"/, "\\\"", a[1]); gsub(/"/, "\\\"", a[2]); gsub(/"/, "\\\"", a[3])
        gsub(/"/, "\\\"", a[5]); gsub(/"/, "\\\"", a[6]); gsub(/"/, "\\\"", a[7])
        gsub(/"/, "\\\"", a[8]); gsub(/"/, "\\\"", a[9])
        if (!first) printf ","
        printf "{\"channel\":\"%s\",\"context\":\"%s\",\"exten\":\"%s\",\"state\":\"%s\",\"application\":\"%s\",\"callerid\":\"%s\",\"duration\":\"%s\",\"account\":\"%s\"}", a[1], a[2], a[3], a[5], a[6], a[7], a[8], a[9]
        first=0
      }
    }
    END { print "]" }
  ')"
  if [ -n "$RAW_CHANNELS" ] && { [ "$CHANNELS_JSON" = "[]" ] || [ -z "$CHANNELS_JSON" ]; }; then
    PARSE_FAILED=1
  fi
fi

# --- bridge show all ---
RAW_BRIDGES="$(run_asterisk "bridge show all")"
if [ -n "$RAW_BRIDGES" ]; then
  BRIDGES_JSON="$(echo "$RAW_BRIDGES" | awk '
    BEGIN { first=1; print "[" }
    /^Bridge\s/ {
      if (id != "") {
        if (!first) printf ","
        gsub(/"/, "\\\"", id); gsub(/"/, "\\\"", btype); gsub(/"/, "\\\"", tech)
        chjson = ""
        for (i=1;i<=chn;i++) { if (chjson != "") chjson = chjson ","; gsub(/"/, "\\\"", ch[i]); chjson = chjson "\"" ch[i] "\"" }
        printf "{\"bridge_id\":\"%s\",\"channels\":[%s],\"type\":\"%s\",\"technology\":\"%s\"}", id, chjson, btype, tech
        first=0
      }
      id = $2
      btype = ""; tech = ""
      if (match($0, /type:\s*[^,\)]+/)) { btype = substr($0, RSTART+6, RLENGTH-6); gsub(/^[ \t]+|[ \t]+$/, "", btype) }
      if (match($0, /technology:\s*[^\)]+/)) { tech = substr($0, RSTART+12, RLENGTH-12); gsub(/^[ \t]+|[ \t]+$/, "", tech) }
      if (btype == "" && NF >= 4) { btype = $3; tech = $4 }
      chn = 0
      next
    }
    /^\s+Channel:\s+/ {
      sub(/^\s+Channel:\s+/, ""); sub(/\r$/, ""); ch[++chn]=$0
      next
    }
    END {
      if (id != "") {
        if (!first) printf ","
        gsub(/"/, "\\\"", id); gsub(/"/, "\\\"", btype); gsub(/"/, "\\\"", tech)
        chjson = ""
        for (i=1;i<=chn;i++) { if (chjson != "") chjson = chjson ","; gsub(/"/, "\\\"", ch[i]); chjson = chjson "\"" ch[i] "\"" }
        printf "{\"bridge_id\":\"%s\",\"channels\":[%s],\"type\":\"%s\",\"technology\":\"%s\"}", id, chjson, btype, tech
      }
      print "]"
    }
  ')"
  if [ "$BRIDGES_JSON" = "[]" ] && echo "$RAW_BRIDGES" | grep -q "Bridge"; then
    PARSE_FAILED=1
  fi
fi

# --- pjsip show channels (for debug / validation) ---
RAW_PJSIP="$(run_asterisk "pjsip show channels")"

# --- summary counts ---
CHAN_COUNT="$(echo "$CHANNELS_JSON" | grep -o '"channel":' | wc -l)"
BRIDGE_COUNT="$(echo "$BRIDGES_JSON" | grep -o '"bridge_id":' | wc -l)"

# Escape raw for JSON (replace backslash and double-quote, newlines -> \n)
escape_json() {
  printf '%s' "$1" | awk 'BEGIN { s="" } { gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\r/,""); s=s $0 "\\n" } END { gsub(/\\n$/,"",s); print s }'
}
RAW_CHANNELS_ESC="$(escape_json "$RAW_CHANNELS")"
RAW_BRIDGES_ESC="$(escape_json "$RAW_BRIDGES")"
RAW_PJSIP_ESC="$(escape_json "$RAW_PJSIP")"

# Output only JSON (summary counts as integers)
SC=$((CHAN_COUNT))
BC=$((BRIDGE_COUNT))
if [ "$PARSE_FAILED" = "1" ] && { [ -n "$RAW_CHANNELS" ] || [ -n "$RAW_BRIDGES" ]; }; then
  printf '{"timestamp":"%s","channels":%s,"bridges":%s,"summary":{"channel_count":%d,"bridge_count":%d},"debug":{"raw_channels":"%s","raw_bridges":"%s","raw_pjsip":"%s"}}\n' \
    "$TIMESTAMP" "$CHANNELS_JSON" "$BRIDGES_JSON" "$SC" "$BC" "$RAW_CHANNELS_ESC" "$RAW_BRIDGES_ESC" "$RAW_PJSIP_ESC"
else
  printf '{"timestamp":"%s","channels":%s,"bridges":%s,"summary":{"channel_count":%d,"bridge_count":%d}}\n' \
    "$TIMESTAMP" "$CHANNELS_JSON" "$BRIDGES_JSON" "$SC" "$BC"
fi
