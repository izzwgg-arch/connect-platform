#!/usr/bin/env bash
# diag-connect-vitalpbx-source.sh
# =============================================================================
# Read-only diagnostic for the VitalPBX source-of-truth surfaces that produce
# caller-leg MOH / `set_var` lines on this PBX.
#
# Hard guarantees this script provides:
#   - NEVER mutates MariaDB (no INSERT / UPDATE / DELETE / REPLACE / TRUNCATE).
#   - NEVER reloads asterisk / pjsip / dialplan.
#   - NEVER edits any file under /etc/asterisk/ or anywhere else.
#   - NEVER restarts services.
#   - Issues only SELECT / SHOW / DESCRIBE statements, plus filesystem ls/grep.
#
# Goal: answer three locked questions for the canary PBX so we can pick the
# implementation path:
#   A. Per-trunk MOH / "default music class" — does VitalPBX expose a
#      column on trunk 33 whose value templates priority 21 of `trk-33-dial`
#      (the line that today emits `Set(CHANNEL(musicclass)=default)`)?
#   B. Per-extension `set_var` / channel-variable rows — does VitalPBX
#      expose a table that lets us add `CHANNEL(musicclass)=<class>` and
#      `TRUNK_MOH_SET=yes` rows for extension `T3_103` (and tenant peers),
#      such that VitalPBX's PJSIP template emits them as `set_var = ...`
#      lines into `/etc/asterisk/vitalpbx/pjsip__*.conf`?
#   C. Documented regenerate / reload command — what does the platform
#      itself use to push DB changes through to generated config?
#
# Output: a structured RESULT block at the bottom with PASS/FAIL for each of
# the three questions plus the exact table.column evidence (or absence
# thereof) used to answer them.
#
# Usage (as root on the PBX):
#   sudo bash diag-connect-vitalpbx-source.sh [trunk_id] [extension]
#
# Defaults:
#   trunk_id  = 33
#   extension = T3_103
# =============================================================================

set -uo pipefail

TRUNK_ID="${1:-33}"
EXT_NAME="${2:-T3_103}"

step() { printf '\n=== %s ===\n' "$*"; }
note() { printf '  - %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
indent() { sed 's/^/    /'; }

if [[ "$(id -u)" -ne 0 ]]; then
  warn "must be run as root for /etc and DB credential read access."
  exit 1
fi

# Tracking. Each "RESULT_<key>" gets one of: PASS / FAIL / UNKNOWN with
# evidence. Printed in a structured block at the very end.
RES_A_STATUS="UNKNOWN"
RES_A_EVIDENCE="not yet probed"
RES_B_STATUS="UNKNOWN"
RES_B_EVIDENCE="not yet probed"
RES_C_STATUS="UNKNOWN"
RES_C_EVIDENCE="not yet probed"

# -----------------------------------------------------------------------------
# 0. environment
# -----------------------------------------------------------------------------
step "0. environment"
note "trunk id (TRUNK_ID)        = $TRUNK_ID"
note "extension (EXT_NAME)       = $EXT_NAME"
note "asterisk                   = $(asterisk -V 2>&1 | head -1)"
note "vitalpbx                   = $(rpm -q vitalpbx 2>/dev/null || dpkg-query -W -f='${Version}' vitalpbx 2>/dev/null || echo unknown)"
note "mariadb / mysql binary     = $(command -v mariadb || command -v mysql || echo missing)"
note "vitalpbx config dir        = $([[ -d /etc/vitalpbx ]] && echo /etc/vitalpbx || echo missing)"
note "vitalpbx share dir         = $([[ -d /usr/share/vitalpbx ]] && echo /usr/share/vitalpbx || echo missing)"
note "vitalpbx lib dir           = $([[ -d /var/lib/vitalpbx ]] && echo /var/lib/vitalpbx || echo missing)"

# -----------------------------------------------------------------------------
# 1. discover MariaDB read-only credentials
# -----------------------------------------------------------------------------
# Try, in order:
#   1. /root/.my.cnf  (the canonical root mysql credentials)
#   2. /etc/vitalpbx/db.conf or /etc/vitalpbx/vitalpbx.conf
#   3. /var/lib/vitalpbx/.passwd-mariadb-root or similar VitalPBX-stored creds
#   4. running 'mysql' with no creds (works on some all-in-one boxes)
#
# Picks whichever first answers `SELECT 1` with exit code 0. Stores a `mysql`
# wrapper command in $MYSQL so the rest of the script just calls $MYSQL.
step "1. MariaDB read-only credential discovery"

MYSQL=""
MYSQL_AUTH_DESC=""

try_mysql() {
  local desc="$1"; shift
  if "$@" -e 'SELECT 1' >/dev/null 2>&1; then
    MYSQL="$*"
    MYSQL_AUTH_DESC="$desc"
    return 0
  fi
  return 1
}

# 1a. /root/.my.cnf
if [[ -r /root/.my.cnf ]]; then
  if try_mysql "/root/.my.cnf" mysql --defaults-file=/root/.my.cnf; then
    note "using credentials from /root/.my.cnf"
  fi
fi

# 1b. VitalPBX-stored root credentials (paths vary by build)
if [[ -z "$MYSQL" ]]; then
  for cred_path in \
    /etc/vitalpbx/db.conf \
    /etc/vitalpbx/vitalpbx.conf \
    /var/lib/vitalpbx/.passwd-mariadb-root \
    /var/lib/vitalpbx/db.conf \
    /usr/local/vitalpbx/db.conf \
    ; do
    if [[ -r "$cred_path" ]]; then
      note "found candidate credential file: $cred_path"
      pw="$(awk -F'[=: ]+' '/^[[:space:]]*(password|pass|root_password|mariadb_root|db_pass)/ {gsub(/^[ \t"\047]+|[ \t"\047]+$/, "", $2); print $2; exit}' "$cred_path" 2>/dev/null)"
      if [[ -n "$pw" ]]; then
        if try_mysql "$cred_path (extracted password)" \
             mysql -u root -p"$pw"; then
          note "credentials from $cred_path validated"
          break
        fi
      fi
    fi
  done
fi

# 1c. socket / no-auth fallback
if [[ -z "$MYSQL" ]]; then
  if try_mysql "no-credential socket auth" mysql; then
    note "no-credential socket auth worked (Unix socket)"
  fi
fi

if [[ -z "$MYSQL" ]]; then
  warn "could not authenticate to MariaDB with any of: /root/.my.cnf,"
  warn "  /etc/vitalpbx/db.conf, /var/lib/vitalpbx/.passwd-mariadb-root,"
  warn "  socket auth. Aborting before any further probe."
  warn "Run on PBX:  ls -la /root/.my.cnf /etc/vitalpbx/ /var/lib/vitalpbx/"
  warn "Then re-run with the credential file path printed above."
  exit 3
fi
note "MariaDB connection: ok ($MYSQL_AUTH_DESC)"

# Convenience wrappers. All probes go through these so no probe ever forgets
# the auth wrapper. mysql_q strips headers; mysql_qh keeps them.
mysql_q()  { $MYSQL --batch --skip-column-names -e "$1" 2>&1; }
mysql_qh() { $MYSQL --batch -e "$1" 2>&1; }

# -----------------------------------------------------------------------------
# 2. database / schema discovery
# -----------------------------------------------------------------------------
step "2. database / schema inventory"

DB_LIST="$(mysql_q "SHOW DATABASES")"
note "databases visible to this account:"
printf '%s\n' "$DB_LIST" | indent

# Identify candidate VitalPBX databases. Common names: vitalpbx, vpbx, vpbxc.
VPBX_DB=""
for cand in vitalpbx vpbx vpbxc connect_vpbx; do
  if printf '%s\n' "$DB_LIST" | grep -Fxq "$cand"; then
    VPBX_DB="$cand"
    break
  fi
done

# If none match, take the first database whose name matches /vital|vpbx/i.
if [[ -z "$VPBX_DB" ]]; then
  VPBX_DB="$(printf '%s\n' "$DB_LIST" | grep -iE 'vital|vpbx' | head -n1)"
fi

if [[ -z "$VPBX_DB" ]]; then
  warn "could not identify a VitalPBX database from SHOW DATABASES output."
  warn "Re-run after manually setting VPBX_DB at the top of this script."
  RES_A_STATUS="FAIL"
  RES_A_EVIDENCE="VitalPBX database not found in SHOW DATABASES"
  RES_B_STATUS="FAIL"
  RES_B_EVIDENCE="VitalPBX database not found in SHOW DATABASES"
else
  note "VitalPBX database identified: $VPBX_DB"
fi

# -----------------------------------------------------------------------------
# 3. Option A — per-trunk MOH / music class column
# -----------------------------------------------------------------------------
step "3. Option A probe — per-trunk MOH / music class column for trunk $TRUNK_ID"

if [[ -n "$VPBX_DB" ]]; then
  TRUNK_TABLES="$(mysql_q "
    SELECT TABLE_NAME
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = '$VPBX_DB'
      AND ( TABLE_NAME LIKE '%trunk%'
         OR TABLE_NAME LIKE '%peer%'
         OR TABLE_NAME LIKE '%route%' )
    ORDER BY TABLE_NAME
  ")"
  note "candidate trunk-related tables in $VPBX_DB:"
  if [[ -n "$TRUNK_TABLES" ]]; then
    printf '%s\n' "$TRUNK_TABLES" | indent
  else
    note "  (none)"
  fi

  MOH_COL_HITS=""
  while IFS= read -r tbl; do
    [[ -z "$tbl" ]] && continue
    cols="$(mysql_q "
      SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = '$VPBX_DB'
        AND TABLE_NAME   = '$tbl'
        AND ( LOWER(COLUMN_NAME) LIKE '%moh%'
           OR LOWER(COLUMN_NAME) LIKE '%music%'
           OR LOWER(COLUMN_NAME) LIKE '%hold%' )
    ")"
    if [[ -n "$cols" ]]; then
      MOH_COL_HITS+="${tbl}:"$'\n'"${cols}"$'\n\n'
    fi
  done <<< "$TRUNK_TABLES"

  note "trunk-table columns whose name suggests MOH/music/hold:"
  if [[ -n "$MOH_COL_HITS" ]]; then
    printf '%s' "$MOH_COL_HITS" | indent
  else
    note "  (none — no MOH/music/hold column in any trunk-shaped table)"
  fi

  # Pull the actual row(s) for trunk $TRUNK_ID.
  echo
  note "rows for trunk id $TRUNK_ID across candidate tables (full columns):"
  while IFS= read -r tbl; do
    [[ -z "$tbl" ]] && continue
    idcol="$(mysql_q "
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = '$VPBX_DB'
        AND TABLE_NAME   = '$tbl'
        AND COLUMN_KEY   = 'PRI'
      ORDER BY ORDINAL_POSITION
      LIMIT 1
    ")"
    if [[ -z "$idcol" ]]; then
      idcol="id"
    fi
    safe_trunk="${TRUNK_ID//[^0-9]/}"
    [[ -z "$safe_trunk" ]] && safe_trunk=0
    rows="$(mysql_qh "SELECT * FROM \`$VPBX_DB\`.\`$tbl\` WHERE \`$idcol\` = $safe_trunk LIMIT 5" 2>&1)"
    if [[ -n "$rows" ]] && ! printf '%s' "$rows" | grep -qiE '^ERROR|Empty set'; then
      note "  $tbl (key=$idcol):"
      printf '%s\n' "$rows" | indent | indent
    fi
  done <<< "$TRUNK_TABLES"

  if [[ -n "$MOH_COL_HITS" ]]; then
    RES_A_STATUS="PASS"
    RES_A_EVIDENCE="$(printf '%s' "$MOH_COL_HITS" | head -8 | tr '\n' ' ')"
  else
    RES_A_STATUS="FAIL"
    RES_A_EVIDENCE="no MOH/music/hold column found in any of: $(printf '%s ' $TRUNK_TABLES)"
  fi
fi

# -----------------------------------------------------------------------------
# 4. Option B — per-extension set_var / channel-variable table
# -----------------------------------------------------------------------------
step "4. Option B probe — per-extension set_var rows for $EXT_NAME"

if [[ -n "$VPBX_DB" ]]; then
  EXT_TABLES="$(mysql_q "
    SELECT TABLE_NAME
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = '$VPBX_DB'
      AND ( TABLE_NAME LIKE '%extension%'
         OR TABLE_NAME LIKE '%endpoint%'
         OR TABLE_NAME LIKE '%device%'
         OR TABLE_NAME LIKE '%set_var%'
         OR TABLE_NAME LIKE '%setvar%'
         OR TABLE_NAME LIKE '%channel_var%'
         OR TABLE_NAME LIKE '%channelvar%'
         OR TABLE_NAME LIKE '%custom_var%'
         OR TABLE_NAME LIKE '%customvar%'
         OR TABLE_NAME LIKE '%variable%' )
    ORDER BY TABLE_NAME
  ")"
  note "candidate extension/endpoint/var tables in $VPBX_DB:"
  if [[ -n "$EXT_TABLES" ]]; then
    printf '%s\n' "$EXT_TABLES" | indent
  else
    note "  (none)"
  fi

  echo
  note "candidate var tables — column shapes:"
  EXT_VAR_HITS=""
  while IFS= read -r tbl; do
    [[ -z "$tbl" ]] && continue
    cols="$(mysql_qh "
      SELECT COLUMN_NAME, COLUMN_TYPE
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = '$VPBX_DB'
        AND TABLE_NAME   = '$tbl'
      ORDER BY ORDINAL_POSITION
    ")"
    note "  $tbl:"
    printf '%s\n' "$cols" | indent | indent
    has_extkey="$(printf '%s\n' "$cols" | awk 'NR>1{print tolower($1)}' \
      | grep -E '^(name|extension|device|peer|sip_user|endpoint|extension_id|user)$' | head -1)"
    has_varname="$(printf '%s\n' "$cols" | awk 'NR>1{print tolower($1)}' \
      | grep -E '^(var_name|variable_name|var|name|key|param|setting|attribute)$' | head -1)"
    has_varvalue="$(printf '%s\n' "$cols" | awk 'NR>1{print tolower($1)}' \
      | grep -E '^(var_value|variable_value|value|val|content|setting_value|attribute_value)$' | head -1)"
    if [[ -n "$has_extkey" && -n "$has_varname" && -n "$has_varvalue" ]]; then
      EXT_VAR_HITS+="${tbl} (extkey=$has_extkey varname=$has_varname varvalue=$has_varvalue)"$'\n'
    fi
  done <<< "$EXT_TABLES"

  echo
  note "tables that LOOK like per-extension key/value var stores:"
  if [[ -n "$EXT_VAR_HITS" ]]; then
    printf '%s' "$EXT_VAR_HITS" | indent
  else
    note "  (none — no clean ext-id + name + value triple in any candidate table)"
  fi

  # Pull the actual row(s) for $EXT_NAME from each candidate.
  echo
  note "rows for $EXT_NAME (or sample) across candidate tables:"
  # Sanitise extension name to alnum/underscore/dash only (no SQL injection).
  safe_ext="${EXT_NAME//[^A-Za-z0-9_-]/}"
  while IFS= read -r tbl; do
    [[ -z "$tbl" ]] && continue
    matched=0
    for col in name extension device peer sip_user endpoint user; do
      exists="$(mysql_q "
        SELECT COUNT(*)
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = '$VPBX_DB'
          AND TABLE_NAME   = '$tbl'
          AND LOWER(COLUMN_NAME) = '$col'
      ")"
      if [[ "$exists" = "1" ]]; then
        rows="$(mysql_qh "SELECT * FROM \`$VPBX_DB\`.\`$tbl\` WHERE \`$col\` = '$safe_ext' LIMIT 10" 2>&1)"
        if [[ -n "$rows" ]] && ! printf '%s' "$rows" | grep -qiE '^ERROR|Empty set'; then
          note "  $tbl (matched on $col = $safe_ext):"
          printf '%s\n' "$rows" | indent | indent
          matched=1
          break
        fi
      fi
    done
    if [[ $matched -eq 0 ]]; then
      rows="$(mysql_qh "SELECT * FROM \`$VPBX_DB\`.\`$tbl\` LIMIT 3" 2>&1)"
      if [[ -n "$rows" ]] && ! printf '%s' "$rows" | grep -qiE '^ERROR'; then
        note "  $tbl (sample, no $EXT_NAME match found):"
        printf '%s\n' "$rows" | indent | indent
      fi
    fi
  done <<< "$EXT_TABLES"

  if [[ -n "$EXT_VAR_HITS" ]]; then
    RES_B_STATUS="PASS"
    RES_B_EVIDENCE="$(printf '%s' "$EXT_VAR_HITS" | head -3 | tr '\n' ' ')"
  else
    RES_B_STATUS="FAIL"
    RES_B_EVIDENCE="no per-extension key/value var table in any of: $(printf '%s ' $EXT_TABLES)"
  fi
fi

# -----------------------------------------------------------------------------
# 5. Option C — documented regenerate / reload command
# -----------------------------------------------------------------------------
step "5. Option C probe — documented regenerate / reload command"

REGEN_HITS=""

# 5a. CLI helpers VitalPBX commonly ships.
note "VitalPBX CLI helpers under /usr/sbin, /usr/local/bin, /usr/local/sbin:"
for d in /usr/sbin /usr/local/bin /usr/local/sbin /opt/vitalpbx/bin; do
  [[ -d "$d" ]] || continue
  matches="$(ls -1 "$d" 2>/dev/null | grep -iE '^(vitalpbx|vpbx)' || true)"
  if [[ -n "$matches" ]]; then
    while IFS= read -r m; do
      [[ -z "$m" ]] && continue
      note "  $d/$m"
      REGEN_HITS+="$d/$m"$'\n'
    done <<< "$matches"
  fi
done

# 5b. Look for shell/php scripts under /usr/share/vitalpbx/ that mention
# 'reload', 'regenerate', 'apply config' patterns.
note "regenerate/reload-shaped strings under /usr/share/vitalpbx/ (first match per file):"
if [[ -d /usr/share/vitalpbx ]]; then
  hits="$(grep -RlIE 'asterisk[[:space:]]+-rx[[:space:]]+["'\''](pjsip|dialplan|core|module)' /usr/share/vitalpbx 2>/dev/null | head -20)"
  if [[ -n "$hits" ]]; then
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      first="$(grep -nE 'asterisk[[:space:]]+-rx' "$f" 2>/dev/null | head -1)"
      note "  $f"
      [[ -n "$first" ]] && printf '      %s\n' "$first"
      REGEN_HITS+="$f"$'\n'
    done <<< "$hits"
  else
    note "  (no asterisk -rx reload calls found under /usr/share/vitalpbx)"
  fi
else
  note "  (/usr/share/vitalpbx not present — checking /opt/vitalpbx instead)"
  if [[ -d /opt/vitalpbx ]]; then
    hits="$(grep -RlIE 'asterisk[[:space:]]+-rx' /opt/vitalpbx 2>/dev/null | head -20)"
    if [[ -n "$hits" ]]; then
      while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        first="$(grep -nE 'asterisk[[:space:]]+-rx' "$f" 2>/dev/null | head -1)"
        note "  $f"
        [[ -n "$first" ]] && printf '      %s\n' "$first"
        REGEN_HITS+="$f"$'\n'
      done <<< "$hits"
    fi
  fi
fi

# 5c. AMI / API hints for "Apply Config".
note "AMI / Apply Config routes referenced under /usr/share/vitalpbx:"
if [[ -d /usr/share/vitalpbx ]]; then
  api_hits="$(grep -RnIE 'apply.config|applyConfig|reload.config|reloadConfig|regenerate' /usr/share/vitalpbx 2>/dev/null | head -10)"
  if [[ -n "$api_hits" ]]; then
    printf '%s\n' "$api_hits" | indent
    REGEN_HITS+="$api_hits"$'\n'
  else
    note "  (no apply-config / regenerate strings found)"
  fi
fi

# 5d. Inspect generated pjsip files for writer fingerprint.
note "metadata + first 2 comment lines of generated pjsip files (writer fingerprint):"
for f in $(ls -1 /etc/asterisk/vitalpbx/pjsip__*.conf 2>/dev/null | head -4); do
  [[ -e "$f" ]] || continue
  note "  $f"
  ls -l "$f" 2>/dev/null | indent | indent
  head -2 "$f" 2>/dev/null | indent | indent
done

if [[ -n "$REGEN_HITS" ]]; then
  RES_C_STATUS="PASS"
  RES_C_EVIDENCE="$(printf '%s' "$REGEN_HITS" | head -3 | tr '\n' ' ')"
else
  RES_C_STATUS="FAIL"
  RES_C_EVIDENCE="no CLI helper, reload script, or apply-config route found under /usr/sbin or /usr/share/vitalpbx"
fi

# -----------------------------------------------------------------------------
# 6. structured RESULT
# -----------------------------------------------------------------------------
step "6. RESULT (structured — paste this block back to Cursor)"
cat <<EOF
RESULT_DB                = $VPBX_DB
RESULT_AUTH              = $MYSQL_AUTH_DESC
RESULT_TRUNK_ID          = $TRUNK_ID
RESULT_EXT_NAME          = $EXT_NAME

[A] per-trunk MOH/music column        : $RES_A_STATUS
    evidence                          : $RES_A_EVIDENCE

[B] per-extension set_var/var table   : $RES_B_STATUS
    evidence                          : $RES_B_EVIDENCE

[C] documented regenerate/reload cmd  : $RES_C_STATUS
    evidence                          : $RES_C_EVIDENCE
EOF

cat <<'TXT'

Interpretation guide:
  * [A] PASS              -> Option A is viable; the column listed above is
                             the source-of-truth for trk-NN-dial:21's
                             musicclass token. Patch will UPDATE that column
                             per tenant trunk on each Connect MOH publish.
  * [A] FAIL but [B] PASS -> Option B is the path. Patch will INSERT/UPDATE
                             two rows per tenant extension (CHANNEL(musicclass)
                             and TRUNK_MOH_SET=yes). The TRUNK_MOH_SET=yes
                             row is what neutralises trk-NN-dial:21's ExecIf.
  * Both [A] and [B] PASS -> A+B in tandem; A handles trunk-scoped paths,
                             B handles every outbound path the extension
                             takes. Highest robustness.
  * Both FAIL              -> Source-of-truth update is unavailable on this
                             build. Stop and re-open the architecture
                             question; do NOT proceed to wrapper/shadow
                             without a separately written approval.
  * [C] FAIL               -> Even if A or B PASS, we cannot push DB changes
                             through to generated config without a documented
                             regenerate command. Capture the exact mechanism
                             VitalPBX uses (likely an AMI 'CoreReload' or a
                             web-UI POST) before any patch.

This script is read-only. No DB mutations, no reloads, no edits.
TXT
