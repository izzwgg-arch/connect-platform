"""PBX Console direct writes — phone provisioning and the geo firewall.

⛔⛔ WHY THIS EXISTS. Both of these are refused by the VitalPBX panel once the
licence lapses ("You've reached the maximum number of provisioned devices" past
20 phones; "You may only block one country on the free version"), while
extensions and tenant edits keep working. Proven on the unlicensed clone
2026-08-19. So these two operations — and only these two — write their rows
directly and then render, exactly like the tenant mirror does.

⛔ THE KEY FINDING (clone, 2026-08-19): the cap lives in the panel's SAVE
controller, NOT in the renderer. `Device::generateProvisioningFile()` called
from PHP CLI on an unlicensed box holding 55 phones regenerated a config
**byte-identical** to the panel's own (same sha256), and produced a working
config for a brand-new 56th phone which nginx then served with 200. So the
sanctioned path is: write the rows ourselves, then let VitalPBX's OWN generator
render them. We never re-implement the 427-model config renderer.

⛔ A phone's config is a STATIC FILE. The pretty URL
`/phoneprov/<tenant-hash>/<mac>.cfg` is served by a plain nginx alias — there is
no on-demand generation on the way in (proven: removing the file makes the fetch
404). So a row change that is not followed by a render leaves the handset on its
old settings, silently, forever. Every write here renders.
"""
import os
import re
import subprocess

PROV_ROOT = "/var/lib/vitalpbx/provisioning/provisioning_templates"
IPSET_DIR = "/etc/firewalld/ipsets"
GEO_BUILD = "/usr/share/vitalpbx/scripts/build_geo_firewall"
PHP_BIN = "/usr/bin/php"
CLI_INCLUDE = "/usr/share/vitalpbx/www/includes/cli.php"

MAC_RE = re.compile(r"^[0-9A-Fa-f]{12}$")
ISO_RE = re.compile(r"^[A-Za-z]{2}$")


def norm_mac(raw):
    """`AA:BB:CC:00:11:22` — the format VitalPBX stores and looks up by."""
    hexonly = re.sub(r"[^0-9A-Fa-f]", "", str(raw or "")).upper()
    if not MAC_RE.match(hexonly):
        raise ValueError("invalid_mac")
    return ":".join(hexonly[i:i + 2] for i in range(0, 12, 2))


def mac_filename(mac):
    """The config filename a handset asks for: lowercase hex, no separators."""
    return re.sub(r"[^0-9a-f]", "", str(mac or "").lower())


def _prov_conn(read_conn_factory):
    """A connection with the `provisioning` schema selected.

    ⛔ The helper's own connection is bound to `ombutel`; provisioning lives in a
    second schema, so every statement here is schema-qualified instead of
    relying on the default database. That also means the grant is explicit and
    narrow (see the installer): INSERT/UPDATE/DELETE on exactly two tables.
    """
    return read_conn_factory()


def list_phones(conn, tenant_id=None):
    with conn.cursor() as cur:
        sql = ("SELECT d.id, d.mac, d.model_id, d.template_id, d.tenant, d.description, "
               "pm.model AS model, b.name AS brand "
               "FROM provisioning.devices d "
               "LEFT JOIN provisioning.phone_models pm ON pm.id = d.model_id "
               "LEFT JOIN provisioning.brands b ON b.id = pm.brand_id")
        args = []
        if tenant_id:
            sql += " WHERE d.tenant = %s"
            args.append(int(tenant_id))
        sql += " ORDER BY d.tenant, d.description, d.mac"
        cur.execute(sql, args)
        return list(cur.fetchall())


def tenant_path(conn, tenant_id):
    with conn.cursor() as cur:
        cur.execute("SELECT path FROM ombutel.ombu_tenants WHERE tenant_id = %s", (int(tenant_id),))
        row = cur.fetchone()
    if not row:
        raise LookupError("tenant_not_found")
    return str(row["path"])


RENDER_PHP = "/opt/connect-pbx-helper/render_phone.php"


def generate_config(mac):
    """Render one phone's config with VitalPBX's OWN generator.

    ⛔ This is the whole trick: the generator has no licence check, so it works
    on an unlicensed, over-cap box (proven on the clone at 55 phones against a
    cap of 20, output byte-identical to the panel's own).

    ⛔⛔ IT MUST RUN AS www-data. The generator reads
    /etc/vitalpbx/vitalpbx-maint.conf, which is `-rw------- www-data` — a
    credentials file that should stay that way. Run as the helper's own
    `asterisk` user it fails with a PHP warning and then `no_device` (it cannot
    reach the database at all), which is exactly what the first production
    attempt did: the row was written and the phone got NO config. So this one
    script is run as www-data through a narrow sudoers line.
    """
    mac = norm_mac(mac)
    # ⛔ Run IN PROCESS as the helper's own user. The obvious "sudo -u www-data"
    # cannot work: the helper unit sets NoNewPrivileges=yes, so sudo is refused
    # outright ("the no new privileges flag is set"). Two narrow grants make the
    # direct run work instead, both applied by the installer:
    #   • a read ACL on /etc/vitalpbx/vitalpbx-maint.conf (one 128-char API token
    #     the generator needs — NOT database credentials), and
    #   • /var/lib/vitalpbx/provisioning in the unit's ReadWritePaths, because
    #     ProtectSystem=strict otherwise makes the whole tree read-only.
    proc = subprocess.run([PHP_BIN, RENDER_PHP, mac], text=True, capture_output=True, timeout=120, check=False)
    if proc.returncode != 0:
        raise ValueError("generate_failed:%s:%s" % (proc.returncode, (proc.stderr or "").strip()[:200]))
    out = (proc.stdout or "").strip()
    if "|" not in out:
        raise ValueError("generate_failed:unexpected_output:%s" % out[:200])
    path, size = out.rsplit("|", 1)
    return {"file": path, "bytes": int(size)}


def remove_config(conn, mac, tenant_id):
    """Delete a phone's cached config so a stale file can never be served."""
    fn = mac_filename(mac)
    removed = []
    try:
        path = tenant_path(conn, tenant_id)
    except LookupError:
        path = None
    if path:
        for suffix in (".cfg", "-phone.cfg", ".boot", ".xml"):
            p = os.path.join(PROV_ROOT, path, fn + suffix)
            if os.path.exists(p):
                try:
                    os.remove(p)
                    removed.append(p)
                except OSError:
                    pass
    return removed


def save_phone(conn, *, phone_id=None, mac, tenant_id, model_id, template_id=None,
               description="", accounts=None, keys=None, phonebook=None, expansion=None):
    """Create or update one provisioned phone, then render its config.

    `accounts` is the ordered list of `ombu_devices.device_id` values (or None
    for an empty line key) that register on this handset's lines.
    """
    mac = norm_mac(mac)
    tenant_id = int(tenant_id)
    model_id = int(model_id)
    with conn.cursor() as cur:
        # A MAC is the handset's identity — it may exist exactly once.
        cur.execute("SELECT id, tenant FROM provisioning.devices WHERE mac = %s", (mac,))
        clash = cur.fetchone()
        if clash and (phone_id is None or int(clash["id"]) != int(phone_id)):
            raise ValueError("mac_already_used")
        if phone_id:
            cur.execute(
                "UPDATE provisioning.devices SET mac=%s, model_id=%s, template_id=%s, tenant=%s, description=%s "
                "WHERE id=%s",
                (mac, model_id, template_id, tenant_id, description or "", int(phone_id)))
            new_id = int(phone_id)
        else:
            cur.execute(
                "INSERT INTO provisioning.devices (model_id, template_id, mac, tenant, description, `keys`, phonebook, expansion_module_keys) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (model_id, template_id, mac, tenant_id, description or "", keys, phonebook, expansion))
            cur.execute("SELECT LAST_INSERT_ID() AS id")
            new_id = int(cur.fetchone()["id"])
        if accounts is not None:
            cur.execute("DELETE FROM provisioning.accounts WHERE device_id = %s", (new_id,))
            for dev in accounts:
                cur.execute(
                    "INSERT INTO provisioning.accounts (device_id, phone_device_id) VALUES (%s, %s)",
                    (new_id, int(dev) if dev not in (None, "", "0") else None))
    conn.commit()
    # ⛔ Render AFTER the commit: the generator reads the database itself.
    # ⛔⛔ And if the render fails on a CREATE, take the row back out. A phone row
    # with no config file is the worst state to leave behind — the console lists
    # a phone, the handset gets nothing, and nobody finds out until somebody
    # plugs it in (this happened for real on the first production attempt). An
    # EDIT keeps its row, because that phone already has a working config and
    # silently undoing the edit would be a second surprise; either way it raises.
    remove_config(conn, mac, tenant_id)
    try:
        rendered = generate_config(mac)
    except Exception:
        if not phone_id:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM provisioning.accounts WHERE device_id = %s", (new_id,))
                cur.execute("DELETE FROM provisioning.devices WHERE id = %s", (new_id,))
            conn.commit()
        raise
    return {"phoneId": new_id, "mac": mac, "rendered": rendered}


def delete_phone(conn, phone_id):
    with conn.cursor() as cur:
        cur.execute("SELECT id, mac, tenant FROM provisioning.devices WHERE id = %s", (int(phone_id),))
        row = cur.fetchone()
        if not row:
            raise LookupError("phone_not_found")
        cur.execute("DELETE FROM provisioning.accounts WHERE device_id = %s", (int(phone_id),))
        cur.execute("DELETE FROM provisioning.devices WHERE id = %s", (int(phone_id),))
    conn.commit()
    removed = remove_config(conn, row["mac"], row["tenant"])
    return {"deletedPhoneId": int(phone_id), "mac": row["mac"], "filesRemoved": removed}


# ── geo firewall ─────────────────────────────────────────────────────────────

def _blocked_isos(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT iso FROM ombutel.ombu_geo_firewall WHERE blocked = 'yes' ORDER BY id")
        return [str(r["iso"]).lower() for r in cur.fetchall()]


def geo_state(conn):
    """What is blocked, and — only when we can actually tell — which of those the
    firewall can enforce.

    ⛔ A country with no ipset file cannot be enforced and is silently dropped by
    VitalPBX's own builder (5 of prod's 232 are in that state), which is the
    difference between the panel's "232 blocked" and the 227 rules that exist.
    ⛔⛔ BUT `/etc/firewalld` is root-only and this helper runs as `asterisk`, so
    the check itself can fail. When the directory cannot be read we say
    `ipsetDirReadable: false` and return NO enforceability verdict — an earlier
    version happily reported all 232 as "missing", which is a confident lie in
    the most alarming possible direction.
    """
    isos = _blocked_isos(conn)
    readable = os.path.isdir(IPSET_DIR) and os.access(IPSET_DIR, os.R_OK | os.X_OK)
    if not readable:
        return {"blocked": isos, "ipsetDirReadable": False, "enforceable": None, "missingIpset": None}
    enforceable, missing = [], []
    for iso in isos:
        (enforceable if os.path.exists(os.path.join(IPSET_DIR, "blacklist_%s.xml" % iso)) else missing).append(iso)
    return {"blocked": isos, "ipsetDirReadable": True, "enforceable": enforceable, "missingIpset": missing}


def geo_build_available():
    """Can we actually rebuild the firewall? The builder writes /etc/firewalld and
    reloads firewalld, so it needs root.

    ⛔⛔ NEVER PROBE BY RUNNING THE BUILDER. An earlier version ran
    `sudo -n <builder> --connect-probe` and treated "no error" as "available" —
    which would have REBUILT AND RELOADED THE LIVE FIREWALL just to answer a
    capability question, on a PBX carrying calls. It also mis-read the refusal:
    under `NoNewPrivileges=yes` sudo says "the no new privileges flag is set",
    which matched none of the strings it looked for, so it reported the build as
    available and the caller wrote flags it could not enforce.
    `sudo -l` ASKS without executing, which is the only safe question.
    """
    if os.geteuid() == 0 and os.access(GEO_BUILD, os.X_OK):
        return ["direct"]
    probe = subprocess.run(["sudo", "-n", "-l", GEO_BUILD], text=True,
                           capture_output=True, timeout=30, check=False)
    return ["sudo"] if probe.returncode == 0 else None


def set_geo_blocks(conn, *, block=(), unblock=()):
    """Set/clear the blocked flag for whole countries, then rebuild the firewall.

    ⛔ The rebuild is VitalPBX's OWN `build_geo_firewall`, for the same reason the
    provisioning render is: it is the thing that already produces the live rules,
    and re-implementing a firewall is how you lock everybody out. The caller gets
    the before/after rule counts so a build that silently produced nothing is
    visible instead of being reported as success.
    """
    block = [str(x).strip().lower() for x in (block or []) if ISO_RE.match(str(x).strip())]
    unblock = [str(x).strip().lower() for x in (unblock or []) if ISO_RE.match(str(x).strip())]
    if not block and not unblock:
        raise ValueError("nothing_to_change")
    overlap = set(block) & set(unblock)
    if overlap:
        raise ValueError("iso_both_block_and_unblock:%s" % ",".join(sorted(overlap)))
    # ⛔ REFUSE rather than write a flag we cannot enforce. Setting `blocked` with
    # no rebuild leaves the console saying "blocked" while the firewall lets the
    # traffic straight through — worse than refusing, because nobody looks again.
    runner = geo_build_available()
    if not runner:
        raise ValueError("geo_build_not_permitted: the firewall rebuild needs root "
                         "(add the sudoers line the installer ships), so the block was NOT applied")
    before = geo_state(conn)
    with conn.cursor() as cur:
        if block:
            cur.execute("UPDATE ombutel.ombu_geo_firewall SET blocked='yes' WHERE lower(iso) IN (%s)"
                        % ",".join(["%s"] * len(block)), block)
        if unblock:
            cur.execute("UPDATE ombutel.ombu_geo_firewall SET blocked='no' WHERE lower(iso) IN (%s)"
                        % ",".join(["%s"] * len(unblock)), unblock)
    conn.commit()
    after = geo_state(conn)
    cmd = [GEO_BUILD] if runner == ["direct"] else ["sudo", "-n", GEO_BUILD]
    build = subprocess.run(cmd, text=True, capture_output=True, timeout=900, check=False)
    # ⛔ `enforceable`/`missingIpset` are None when /etc/firewalld cannot be read
    # (see geo_state) — len(None) is what turned an honest refusal into a Python
    # error in the caller's face.
    n = lambda v: (len(v) if v is not None else None)
    return {
        "blockedBefore": n(before["blocked"]), "blockedAfter": n(after["blocked"]),
        "enforceableBefore": n(before["enforceable"]), "enforceableAfter": n(after["enforceable"]),
        "missingIpset": after["missingIpset"],
        "build": {"via": runner[0], "code": build.returncode, "out": (build.stdout or "").strip()[:400],
                  "err": (build.stderr or "").strip()[:400]},
    }


def whitelist_state(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT firewall_whitelist_id AS id, host, description, `default` AS is_default "
                    "FROM ombutel.ombu_firewall_whitelist ORDER BY firewall_whitelist_id")
        return list(cur.fetchall())
