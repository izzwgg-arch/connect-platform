#!/usr/bin/env python3
"""
VitalPBX mirror — the WRITE side.

Writes the same `ombutel` rows the VitalPBX panel writes, so that VitalPBX's own
regenerator (or our byte-identical renderer, vitalpbx_mirror.py) produces the
same files, without the panel's licence-gated save path ever running.

    create_tenant(...)            the row set the panel inserts for a NEW tenant
    add_extension(...)            an extension + desk device + WebRTC `_1` device (+vm/followme/diversions/...)
    add_did(...)                  DID + inbound route + destination bookkeeping
    render_and_install(...)       write the files (0644), AstDB `database put` list, reload commands
    insert_extension_surgical(...) pure-text insertion of ONE extension into EXISTING VitalPBX files

DRY-RUN BY DEFAULT. Every function builds a Plan; `plan.sql_script()` prints the
exact INSERT statements (as an executable MySQL script using session variables
for the auto-increment ids), and `plan.execute(conn)` runs them in one
transaction and returns the captured ids. Pass `--apply` on the CLI to execute.

Row spec (derived empirically from tenants 104/105/106, created by the panel on
2026-08-05/06/18, and cross-checked against 101/102 and the older tenants):
see README.md → "create_tenant row spec".

Only stdlib + pymysql. Python 3.11.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import string
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# --------------------------------------------------------------------------- #
# Plan: a list of INSERTs whose auto-increment ids can be referenced later
# --------------------------------------------------------------------------- #


class Ref:
    """Symbolic reference to an id captured earlier in the plan (e.g. Ref('tenant_id'))."""

    def __init__(self, name: str):
        self.name = name

    def __repr__(self):
        return "@%s" % self.name


class _Concat:
    """CONCAT('T', @tenant_id, '_reload') — a value that needs the captured tenant id spliced into a string."""

    def __init__(self, *parts):
        self.parts = parts

    def sql(self, lit) -> str:
        return "CONCAT(%s)" % ", ".join(lit(p) for p in self.parts)

    def value(self, ids) -> str:
        return "".join(str(ids[p.name]) if isinstance(p, Ref) else str(p) for p in self.parts)


class Plan:
    def __init__(self):
        self.steps: List[Tuple[str, List[str], List[Any], Optional[str]]] = []  # table, cols, values, capture
        self.notes: List[str] = []
        self.shell: List[str] = []  # filesystem / asterisk commands that accompany the rows

    def insert(self, table: str, row: Dict[str, Any], capture: Optional[str] = None) -> Optional[Ref]:
        cols = list(row.keys())
        vals = [row[c] for c in cols]
        self.steps.append((table, cols, vals, capture))
        return Ref(capture) if capture else None

    def note(self, text: str):
        self.notes.append(text)

    # ---- rendering ----
    @staticmethod
    def _lit(v) -> str:
        if v is None:
            return "NULL"
        if isinstance(v, Ref):
            return "@%s" % v.name
        if isinstance(v, _Concat):
            return v.sql(Plan._lit)
        if isinstance(v, bool):
            return "1" if v else "0"
        if isinstance(v, (int, float)):
            return str(v)
        s = str(v).replace("\\", "\\\\").replace("'", "\\'")
        return "'%s'" % s

    def sql_script(self) -> str:
        out = ["-- VitalPBX mirror write plan (dry run). Executable as a MySQL script.", "START TRANSACTION;"]
        for table, cols, vals, capture in self.steps:
            out.append("INSERT INTO `%s` (%s) VALUES (%s);" % (
                table, ", ".join("`%s`" % c for c in cols), ", ".join(self._lit(v) for v in vals)))
            if capture:
                out.append("SET @%s = LAST_INSERT_ID();" % capture)
        out.append("COMMIT;")
        if self.shell:
            out.append("")
            out.append("-- accompanying filesystem / asterisk commands (run on the PBX as root):")
            out += ["-- " + c for c in self.shell]
        if self.notes:
            out.append("")
            out += ["-- NOTE: " + n for n in self.notes]
        return "\n".join(out) + "\n"

    def execute(self, conn) -> Dict[str, int]:
        """Run every INSERT in ONE transaction; returns {capture_name: id}."""
        ids: Dict[str, int] = {}
        try:
            with conn.cursor() as cur:
                for table, cols, vals, capture in self.steps:
                    real = [ids[v.name] if isinstance(v, Ref) else v.value(ids) if isinstance(v, _Concat) else v
                            for v in vals]
                    cur.execute("INSERT INTO `%s` (%s) VALUES (%s)" % (
                        table, ", ".join("`%s`" % c for c in cols), ", ".join(["%s"] * len(cols))), real)
                    if capture:
                        ids[capture] = cur.lastrowid
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return ids

    def rows_by_table(self) -> Dict[str, int]:
        d: Dict[str, int] = {}
        for table, *_ in self.steps:
            d[table] = d.get(table, 0) + 1
        return d


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def q(conn, sql, args=()):
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return list(cur.fetchall())


def q1(conn, sql, args=()):
    r = q(conn, sql, args)
    return r[0] if r else None


def new_tenant_path(conn=None) -> str:
    """16 lowercase hex chars, unique in ombu_tenants.path (VitalPBX's tenant hash)."""
    while True:
        p = secrets.token_hex(8)
        if conn is None or not q1(conn, "select 1 from ombu_tenants where path=%s", (p,)):
            return p


def slugify(description: str) -> str:
    """The panel's tenant `name` for a description: lowercase, non-alnum -> '_' (matches Connect's toIvrSlug)."""
    s = re.sub(r"[^a-z0-9]+", "_", description.lower()).strip("_")
    return s or "tenant"


def random_password(n: int = 25) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


def random_features_password(n: int = 8) -> str:
    return "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(n))


TENANT_SETTINGS_DEFAULTS: List[Tuple[str, str]] = [
    # exactly the 21 rows the panel writes for a new tenant (T101/102/104/105/106 all have these, all '')
    ("addons", ""),
    ("allow_recordings", "yes"),
    ("allowed_outbound_routes", ""),
    ("allowed_tenant_trunks", ""),
    ("calls_limit", ""),
    ("cid_name", ""),
    ("cid_number", ""),
    ("conferences", ""),
    ("disable_trunks_prefix", "no"),
    ("extensions", ""),
    ("inbound_calls_limit", ""),
    ("ivrs", ""),
    ("mfa_allowed", "no"),
    ("outbound_profiles", ""),
    ("parking_lots", ""),
    ("queues", ""),
    ("restricted_cid", "disabled"),
    ("shared_trunks", ""),
    ("timezone", "system"),
    ("trunks", ""),
    ("vpbx_devices", ""),
]

QUEUED_CHANGE_MODULES = (42, 43, 110)  # iax_settings, sip_settings, pjsip_settings
# The panel's tenant SAVE also leaves the tenant's base modules pending, so the very next Apply
# Changes renders the whole per-tenant file set (parking, conferences, MOH, trunk stubs, the
# Default inbound route, hints). Proven on the clone 2026-08-19: rows alone rendered only the
# extension-driven files; queuing 99/11/8/48 rendered confbridge/moh/res_parking.
BASE_RENDER_MODULES = (99, 11, 8, 48, 26, 29, 1)  # tenants, parking, conferences, music_on_hold, trunks, inbound_route, extensions
PROVISIONING_INDEX_PHP = '<?php\nrequire_once(\'/usr/share/vitalpbx/www/includes/cli.php\');\n\nuse modules\\provisioning\\Device;\nuse vitalpbx\\tenant;\n\nerror_reporting(E_ALL);\nini_set(\'display_errors\', 0);\nini_set(\'html_errors\', false);\n\n$filename = arrayGet(\'filename\', $_GET);\n$mac_address = parse_mac_address(arrayget(\'mac\', $_GET));\nif ($filename !== null && $mac_address !== null) {\n    $dev = Device::getByMAC(format_mac_address($mac_address));\n    if($dev->id){\n        $devTenant = new tenant($dev->tenant);\n        if($devTenant->path === "TENANT_PATH"){\n\t        $file = $dev->getProvisioningFile();\n\t        //If the provisioning file doesn\'t exists, then, try to generating the provisioning file\n\t        if(!$file){\n\t           $dev->generateProvisioningFile();\n\t           $file = $dev->getProvisioningFile();\n\t        }\n\t\n\t        if($file){\n\t            header(\'Content-Type: text/plain\');\n\t            header(\'Content-Length: \' . filesize($file));\n\t            readfile($file);\n\t            exit;\n\t        }\n        }\n        \n        // --- Return 403 Forbidden for known device but no file ---\n\t    header(\'HTTP/1.1 403 Forbidden\');\n\t    echo "Forbidden: Unable to serve provisioning file.";\n\t    exit;\n    }\n}\n\nfunction format_mac_address($mac){\n    $mac = trim($mac);\n    if(strlen($mac) === 12)\n        $mac = implode(\':\',str_split($mac, 2));\n\n    return $mac;\n}\n\nfunction parse_mac_address($string) {\n        if (preg_match(\'/[0-9a-fA-F]{12}/\',$string,$m)) {\n                return strtolower($m[0]);\n        }\n        return null;\n}\n\nfunction arrayGet($name, &$array, $default = null) {\n    return $array[$name] ?? $default;\n}\n\n\n// --- Fallback: 404 for invalid or missing MAC/filename ---\nheader(\'HTTP/1.1 404 Not Found\');\necho "404 Not Found: Invalid provisioning request.";\nexit;'

TENANT_STATIC_DIRS = ["moh", "recordings", "pdf", "voicemail", "pictures",
                      "default_recordings", "dictations", "fax", "reminders"]

# --------------------------------------------------------------------------- #
# create_tenant
# --------------------------------------------------------------------------- #


def create_tenant(conn, description: str, *, name: Optional[str] = None, tenant_id: Optional[int] = None,
                  path: Optional[str] = None, user_id: int = 45, outbound_profile_ids: Sequence[int] = (),
                  cid_name: str = "", cid_number: str = "", allow_recordings: str = "yes",
                  timezone: str = "system", did: Optional[str] = None, did_description: str = "Main",
                  did_destination: Optional[Tuple[int, int, str]] = None,
                  dids: Sequence[str] = (), queue_base_modules: bool = True) -> Plan:
    """
    Build the plan for a new tenant, byte-for-byte the rows the panel writes.

    did_destination: (category_id, module_id, index) for the DID's inbound route, e.g. (1, 29, <extension_id>)
    for "ring extension", (33, 29, <cc_id>) for the Connect doorway custom context. When None and a did is
    given, the route is created pointing at the same "verify DID" pseudo-destination the Default route uses
    (31, 29, '1'); repoint it later (Connect's helper does that when the number is switched to Connect).
    """
    plan = Plan()
    name = name or slugify(description)
    if q1(conn, "select 1 from ombu_tenants where name=%s", (name,)):
        raise ValueError("tenant name %r already exists" % name)
    path = path or new_tenant_path(conn)
    if not re.fullmatch(r"[0-9a-f]{16}", path):
        raise ValueError("path must be 16 lowercase hex chars")

    # 1. ombu_tenants
    row = {"name": name, "description": description, "default": "no", "path": path, "prefix": None, "enabled": "yes"}
    if tenant_id is not None:
        row = {"tenant_id": tenant_id, **row}
    plan.insert("ombu_tenants", row, capture="tenant_id")
    T = Ref("tenant_id")

    # 2. ombu_tenants_users — the creating panel user gains access, never as its default tenant
    plan.insert("ombu_tenants_users", {"user_id": user_id, "tenant_id": T, "default": "no"})

    # 3. ombu_tenant_settings — the 21 rows
    overrides = {"outbound_profiles": ",".join(str(x) for x in outbound_profile_ids),
                 "cid_name": cid_name, "cid_number": cid_number,
                 "allow_recordings": allow_recordings, "timezone": timezone}
    for k, v in TENANT_SETTINGS_DEFAULTS:
        plan.insert("ombu_tenant_settings", {"tenant_id": T, "name": k, "value": overrides.get(k, v)})

    # 4. class of service "all" / All Permissions (default) — its id is what the dialplan's
    #    sub-set-call-vars carries and what every extension's class_of_service_id points at
    plan.insert("ombu_classes_of_service", {
        "cos": "all", "description": "All Permissions", "feature_code_category_id": None, "ars_id": None,
        "dialrule_id": None, "allowed_calls_by": None, "private": "no", "billing_app_id": None,
        "default": "yes", "tenant_id": T}, capture="class_of_service_id")

    # 5. dial profile "Default"
    plan.insert("ombu_dial_profiles", {
        "name": "Default", "music_group_id": None, "allow_parking": "called", "allow_transfer": "called",
        "call_screening": "disabled", "ringing_tone": "yes", "custom_options": None, "default": "yes",
        "tenant_id": T}, capture="dial_profile_id")

    # 6. maintenance defaults
    plan.insert("ombu_maintenance", {
        "cdr_preservation": 60, "recordings_preservation": 60, "voicemail_preservation": 30,
        "sms_preservation": None, "logger_preservation": None, "recordings_clear_less_nseconds": 5,
        "convert_recordings": "no", "conversion_quality": 16, "maintenance_cron": None,
        "enabled": "yes", "default": "no", "tenant_id": T})

    # 7. default parking lot 700 (slots 701-710) + its "hang up on timeout" destination
    #    (category 24 = terminate call, module 11 = parking owns the reference, index '1' = hangup)
    plan.insert("ombu_destinations", {"category_id": 24, "module_id": 11, "index": "1"}, capture="park_dest_id")
    plan.insert("ombu_parking_lots", {
        "extension": "700", "description": "Default Parking", "destination_id": Ref("park_dest_id"),
        "parkingtime": 45, "comebacktoorigin": "yes", "comebackdialtime": 20, "parkedplay": "caller",
        "parkpos": 10, "parkedcalltransfers": "no", "parkedcallreparking": "no", "parkedcallhangup": "no",
        "findslot": "first", "music_group_id": None, "defpark": "yes", "announce_space_number": "yes",
        "record": "no", "tenant_id": T}, capture="parking_lot_id")
    #    the used-number registry: module 11 (parking) claims 700..710
    for n in range(700, 711):
        plan.insert("ombu_numbers", {"module_id": 11, "number": str(n), "tenant_id": T})

    # 8. the tenant's own (empty) outbound-profile row — renders as [ARS-<id>] with only the `i` exten
    plan.insert("ombu_ars", {"description": "none", "default": "yes", "tenant_id": T}, capture="ars_id")

    # 9. Default inbound route -> "verify DID" pseudo-destination (category 31, module 29, index '1')
    plan.insert("ombu_destinations", {"category_id": 31, "module_id": 29, "index": "1"}, capture="default_route_dest_id")
    plan.insert("ombu_inbound_routes", _inbound_route_row(T, "Default", None, Ref("default_route_dest_id"), detectiontime=None),
                capture="default_route_id")

    # 10. pending-change bookkeeping the panel leaves for its own Apply Changes (iax/sip/pjsip settings)
    for mod in QUEUED_CHANGE_MODULES:
        plan.insert("ombu_queued_changes", {"tenant_id": T, "module_id": mod})
    if queue_base_modules:
        for mod in BASE_RENDER_MODULES:
            plan.insert("ombu_queued_changes", {"tenant_id": T, "module_id": mod})

    # 11. per-tenant reload flags in ombu_settings (every live tenant has them; value 'no' = nothing pending)
    #     NOTE: name embeds the numeric tenant id, so it needs the captured id -> CONCAT in SQL.
    plan.insert("ombu_settings", {"module_id": 108, "name": _Concat("T", T, "_reload_dialplan"), "value": "no"})
    plan.insert("ombu_settings", {"module_id": 96, "name": _Concat("T", T, "_reload"), "value": "no"})

    # 12. the tenant's numbers, exactly like the panel's tenant form `inbound_numbers[]`: ONLY
    #     ombu_tenant_dids rows. The per-DID inbound routes ("Main", "Main ported") are created
    #     afterwards by Connect's createInboundRoute, as today — writing a route here would give
    #     the DID two "Main" routes.
    for d in dids:
        d = re.sub(r"\D", "", str(d))
        if d:
            plan.insert("ombu_tenant_dids", {"tenant_id": T, "did": d, "description": ""})
    # 12b. legacy single-DID-with-route form (kept for scripts that want the route too)
    if did:
        add_did(conn, None, did, did_description, did_destination, plan=plan, tenant_ref=T)

    # filesystem side (the panel creates these at save time)
    plan.shell += tenant_fs_commands(path)
    plan.note("tenant path (AstDB family / static dir) = %s" % path)
    plan.note("outbound profiles (ombu_ars rows in Main tenant 1) are NOT created here — the panel still does "
              "trunk/route/ARS in Main; pass their ids in outbound_profile_ids")
    plan.note("no ombu_ami_users row: none of T101/102/104/105/106 has one (only tenants where a manager user was made)")
    plan.note("no ombu_settings T<t>_dynamic-routing rows: T104/T105 have none (renderer falls back to the global rows); "
              "T106 has four, created lazily")
    return plan




def _inbound_route_row(T, description, did, dest, detectiontime=5, language="en"):
    return {"cos_id": None, "description": description, "routing_method": "default", "did": did,
            "channel_id": None, "cid_management_id": None, "cid_lookup_id": None, "cid_number": None,
            "destination_id": dest, "language": language, "music_group_id": None, "alertinfo": None,
            "enablerecording": "no", "digits_to_take": None, "prepend": None, "append": None,
            "faxdetection": "no", "drop_anon_calls": "no", "detectiontime": detectiontime,
            "fax_destination_id": None, "privacyman": "no", "pmminlength": 10, "pmmaxretries": 3,
            "tenant_id": T}


def apply_tenant_fs(path: str, static_root: str = "/var/lib/vitalpbx/static",
                    prov_root: str = "/var/lib/vitalpbx/provisioning/provisioning_templates") -> Dict[str, Any]:
    """Create the per-tenant directories/files the panel creates at tenant save (idempotent).
    Ownership as in the production baseline; chown needs CAP_CHOWN (the helper has it)."""
    import grp
    import pwd
    import stat as _stat
    if not re.fullmatch(r"[0-9a-f]{16}", path):
        raise ValueError("path must be 16 lowercase hex chars")
    out = {"created": [], "chown_errors": []}

    def uid(u):
        return pwd.getpwnam(u).pw_uid

    def gid(g):
        return grp.getgrnam(g).gr_gid

    def own(p, u, g):
        try:
            os.chown(p, uid(u), gid(g))
        except Exception as exc:  # non-fatal: the ACL default already grants both users
            out["chown_errors"].append("%s: %s" % (p, exc))

    base = os.path.join(static_root, path)
    os.makedirs(base, mode=0o2775, exist_ok=True); os.chmod(base, 0o2775); own(base, "asterisk", "www-data")
    owners = {"dictations": ("asterisk", "www-data"), "fax": ("asterisk", "www-data"), "reminders": ("asterisk", "www-data"),
              "moh": ("www-data", "asterisk"), "recordings": ("www-data", "asterisk"), "default_recordings": ("www-data", "asterisk"),
              "pdf": ("www-data", "www-data"), "voicemail": ("www-data", "www-data"), "pictures": ("www-data", "www-data")}
    for d in TENANT_STATIC_DIRS:
        p = os.path.join(base, d)
        os.makedirs(p, mode=0o2775, exist_ok=True); os.chmod(p, 0o2775); own(p, *owners[d]); out["created"].append(p)
    prov = os.path.join(prov_root, path)
    os.makedirs(prov, mode=0o2775, exist_ok=True); os.chmod(prov, 0o2775); own(prov, "www-data", "www-data")
    for fname, content in (("aastra.cfg", "#Aastra Dummy File\n"), ("index.php", PROVISIONING_INDEX_PHP.replace("TENANT_PATH", path))):
        fp = os.path.join(prov, fname)
        with open(fp, "w", encoding="utf-8", newline="") as fh:
            fh.write(content)
        os.chmod(fp, 0o664); own(fp, "www-data", "www-data"); out["created"].append(fp)
    return out


def tenant_fs_commands(path: str) -> List[str]:
    cmds = []
    for d in TENANT_STATIC_DIRS:
        cmds.append("install -d -m 2775 /var/lib/vitalpbx/static/%s/%s" % (path, d))
    cmds += [
        "chown asterisk:www-data /var/lib/vitalpbx/static/%s /var/lib/vitalpbx/static/%s/{dictations,fax,reminders}" % (path, path),
        "chown www-data:asterisk /var/lib/vitalpbx/static/%s/{moh,recordings,default_recordings}" % path,
        "chown www-data:www-data /var/lib/vitalpbx/static/%s/{pdf,voicemail,pictures}" % path,
        "install -d -m 2775 -o www-data -g www-data /var/lib/vitalpbx/provisioning/provisioning_templates/%s" % path,
        "printf '#Aastra Dummy File\\n' > /var/lib/vitalpbx/provisioning/provisioning_templates/%s/aastra.cfg && chown www-data:www-data /var/lib/vitalpbx/provisioning/provisioning_templates/%s/aastra.cfg && chmod 664 /var/lib/vitalpbx/provisioning/provisioning_templates/%s/aastra.cfg" % (path, path, path),
        "sed 's/TENANT_PATH/%s/' /root/pbx-mirror-dev/mirror/provisioning_index.php.tmpl > /var/lib/vitalpbx/provisioning/provisioning_templates/%s/index.php && chmod 664 /var/lib/vitalpbx/provisioning/provisioning_templates/%s/index.php" % (path, path, path),
    ]
    return cmds


# --------------------------------------------------------------------------- #
# add_did
# --------------------------------------------------------------------------- #

def add_did(conn, tenant_id: Optional[int], did: str, description: str = "Main",
            destination: Optional[Tuple[int, int, str]] = None, *, plan: Optional[Plan] = None,
            tenant_ref: Optional[Ref] = None, language: str = "en") -> Plan:
    """ombu_tenant_dids + ombu_destinations + ombu_inbound_routes for one DID (detectiontime 5 like the panel)."""
    plan = plan or Plan()
    T = tenant_ref if tenant_ref is not None else tenant_id
    if T is None:
        raise ValueError("tenant_id or tenant_ref required")
    plan.insert("ombu_tenant_dids", {"tenant_id": T, "did": did, "description": ""})
    cat, mod, idx = destination or (31, 29, "1")
    cap = "did_%s_dest_id" % did
    plan.insert("ombu_destinations", {"category_id": cat, "module_id": mod, "index": str(idx)}, capture=cap)
    plan.insert("ombu_inbound_routes", _inbound_route_row(T, description, did, Ref(cap), detectiontime=5, language=language),
                capture="did_%s_route_id" % did)
    return plan


# --------------------------------------------------------------------------- #
# add_extension
# --------------------------------------------------------------------------- #

DIVERSION_NAMES = ("BOSS", "PEA", "FWM", "DND", "CC", "CFI", "CFB", "CFN", "CFU")


def add_extension(conn, tenant_id: int, ext: str, name: str, email: str = "",
                  desk_password: Optional[str] = None, webrtc_password: Optional[str] = None, *,
                  features_password: Optional[str] = None, vm_password: Optional[str] = None,
                  language: str = "en", music_group_id: int = 1, outgoing_rec: str = "yes",
                  incoming_rec: str = "yes", desk_device: bool = True, webrtc_device: bool = True,
                  desk_dtmf: str = "rfc4733", webrtc_dtmf: str = "rfc2833",
                  desk_max_contacts: int = 1, webrtc_max_contacts: int = 5) -> Plan:
    """
    Rows the panel's extension form / CSV import writes for one extension with a desk device
    (profile 1, user=<ext>) and a WebRTC device (profile 12, user=<ext>_1, vitxi_client=yes).
    Values match ombu_extensions 400/402/405 (T104/105/106) column for column.
    """
    plan = Plan()
    t = q1(conn, "select * from ombu_tenants where tenant_id=%s", (tenant_id,))
    if not t:
        raise ValueError("tenant %s not found" % tenant_id)
    if q1(conn, "select 1 from ombu_extensions where tenant_id=%s and extension=%s", (tenant_id, ext)):
        raise ValueError("extension %s already exists in tenant %s" % (ext, tenant_id))
    if q1(conn, "select 1 from ombu_numbers where tenant_id=%s and number=%s", (tenant_id, ext)):
        raise ValueError("number %s already used in tenant %s (ombu_numbers)" % (ext, tenant_id))
    cos = q1(conn, "select class_of_service_id from ombu_classes_of_service where tenant_id=%s and `default`='yes'", (tenant_id,))
    dp = q1(conn, "select dial_profile_id from ombu_dial_profiles where tenant_id=%s and `default`='yes'", (tenant_id,))
    if not cos or not dp:
        raise ValueError("tenant %s has no default class of service / dial profile" % tenant_id)
    slug = t["name"]
    desk_password = desk_password or random_password()
    webrtc_password = webrtc_password or desk_password  # live rows: both devices share one secret
    features_password = features_password or random_features_password()
    vm_password = vm_password if vm_password is not None else ext

    plan.insert("ombu_extensions", {
        "extension": ext, "name": name, "language": language, "email": email or "",
        "class_of_service_id": cos["class_of_service_id"], "dial_profile_id": dp["dial_profile_id"],
        "call_limit": 0, "internal_cid": '"%s" <%s>' % (name, ext), "external_cid": None, "emergency_cid": None,
        "ringtime": 0, "nospy": "no", "enabled_pa": "no", "answermode": "disable",
        "mailbox": "%s@%s-voicemail" % (ext, slug), "accountcode": None,
        "features_password": features_password, "portal_password": None, "sendcid": "yes",
        "generate_hints": "no", "hot_desking": "no", "secretary": None, "music_group_id": music_group_id,
        "rec_on_demand": "no", "internal_rec": "no", "outgoing_rec": outgoing_rec, "incoming_rec": incoming_rec,
        "dictate_enable": "no", "dictate_format": "wav", "dictate_auto_send": "no", "absent_secretary": "no",
        "lock": "no", "call_waiting": "yes", "dynamic_external_cid": "no", "cid_on_diversions": "caller",
        "pinless": "no", "dynamic_routing": "no", "sms_number_id": None, "notify_missed_calls": None,
        "callback_on_busy_transfer": "no", "tenant_id": tenant_id}, capture="extension_id")
    E = Ref("extension_id")
    plan.insert("ombu_numbers", {"module_id": 1, "number": ext, "tenant_id": tenant_id})

    if desk_device:
        plan.insert("ombu_devices", {
            "extension_id": E, "profile_id": 1, "user": ext, "secret": desk_password,
            "description": "Device %s" % ext, "emergency_cid_name": None, "emergency_cid_number": None,
            "ring_device": "yes", "technology": "pjsip", "assigned_exten": ext, "tenant_id": tenant_id,
            "vitxi_client": "no", "dispatchable_location_id": None, "send_welcome_email": "no",
            "mobile_client": "no"}, capture="desk_device_id")
        plan.insert("ombu_pjsip_devices", {"device_id": Ref("desk_device_id"), "codecs": None, "dtmfmode": desk_dtmf,
                                           "max_contacts": desk_max_contacts, "deny": "0.0.0.0/0", "permit": "0.0.0.0/0"})
    if webrtc_device:
        plan.insert("ombu_devices", {
            "extension_id": E, "profile_id": 12, "user": "%s_1" % ext, "secret": webrtc_password,
            "description": name, "emergency_cid_name": None, "emergency_cid_number": None,
            "ring_device": "yes", "technology": "pjsip", "assigned_exten": None, "tenant_id": tenant_id,
            "vitxi_client": "yes", "dispatchable_location_id": None, "send_welcome_email": "no",
            "mobile_client": "no"}, capture="webrtc_device_id")
        plan.insert("ombu_pjsip_devices", {"device_id": Ref("webrtc_device_id"), "codecs": None, "dtmfmode": webrtc_dtmf,
                                           "max_contacts": webrtc_max_contacts, "deny": "0.0.0.0/0", "permit": "0.0.0.0/0"})

    plan.insert("ombu_extensions_vm", {
        "extension_id": E, "voicemail_timezone_id": None, "password": vm_password,
        "context": "%s-voicemail" % slug, "alias": None, "skip_instructions": "no", "attach": "yes",
        "saycid": "yes", "sayduration": "yes", "envelope": "yes", "delete": "no", "hidefromdir": "no",
        "dialout": "no", "callback": "no", "create_hint": "no", "ask_password": "yes", "enabled": "yes",
        "operator_destination_id": None, "busy_greeting_id": None, "unav_greeting_id": None,
        "ai_transcription": "no"})
    plan.insert("ombu_followme", {
        "extension_id": E, "music_group_id": 1, "followme_numbers": None, "ringtime": 30, "initial_ringtime": 0,
        "ring_strategy": "one_by_one", "call_from_prompt_id": 1, "pls_hold_prompt_id": 1, "status_prompt_id": 1,
        "sorry_prompt_id": 1, "norecording_prompt_id": 1, "recname": "no", "enable_callee_prompt": "no",
        "internal_numbers_confirmation": "no"})
    for dname in DIVERSION_NAMES:
        plan.insert("ombu_extension_diversions", {"extension_id": E, "name": dname, "enable": "no",
                                                  "destination_id": None, "time_group_id": None})
    plan.insert("ombu_extensions_contact_info", {"extension_id": E, "mobile_number": None, "home_number": None,
                                                 "organization": None, "job_title": None})
    plan.note("ombu_extensions_vm.id and ombu_followme.id equal extension_id on every live row (auto_increment "
              "happens to track); we let auto_increment assign them")
    plan.note("no ombu_extension_pea row (table is empty platform-wide); no ombu_users portal login (portal_password NULL)")
    return plan


# --------------------------------------------------------------------------- #
# render_and_install
# --------------------------------------------------------------------------- #

RELOAD_COMMANDS = ["module reload res_pjsip.so", "dialplan reload", "voicemail reload", "module reload res_parking.so"]


def render_and_install(conn, tenant_id: int, target_dir: str, *, apply: bool = False,
                       astdb_apply: bool = False, date: Optional[str] = None) -> Dict[str, Any]:
    """
    Render tenant files with vitalpbx_mirror, write them 0644 into target_dir (chown www-data:www-data is
    the caller's job on the PBX; in dev we only set the mode), and return the AstDB `database put`
    command list plus the reload commands. Dry run prints; apply writes.
    """
    import vitalpbx_mirror as vm
    m = vm.load_tenant(conn, tenant_id)
    files = vm.render_tenant(m, date)
    kv = vm.render_astdb(m)
    puts = []
    for k, v in sorted(kv.items()):
        fam, key = k[1:].split("/", 1)
        puts.append('asterisk -rx "database put %s %s \\"%s\\""' % (fam, key, v.replace('"', '\\"')))
    result = {"files": sorted(files), "astdb_puts": puts, "reload": ["asterisk -rx \"%s\"" % c for c in RELOAD_COMMANDS],
              "target_dir": target_dir, "applied": apply}
    if apply:
        os.makedirs(target_dir, exist_ok=True)
        for name, text in files.items():
            p = os.path.join(target_dir, name)
            with open(p, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            os.chmod(p, 0o644)
        if astdb_apply:
            import subprocess
            for c in puts:
                subprocess.run(c, shell=True, check=False)
    return result


# --------------------------------------------------------------------------- #
def render_and_install_pbx(conn, tenant_id: int, *, reload: bool = True,
                          target_dir: str = "/etc/asterisk/vitalpbx") -> Dict[str, Any]:
    """PBX-side: render the tenant's files, install them 0644 owned www-data:root (VitalPBX conf
    ownership), seed the AstDB keys, and reload the affected Asterisk modules. Idempotent — safe to
    re-run; it re-renders the current DB state. Returns the file list + counts. Ownership + reload
    need CAP_CHOWN and the Asterisk control socket (the helper has both)."""
    import grp
    import pwd
    import subprocess
    res = render_and_install(conn, tenant_id, target_dir, apply=True, astdb_apply=True)
    # VitalPBX conf files are www-data:root 0644 so the panel can still rewrite them later.
    try:
        wd = pwd.getpwnam("www-data").pw_uid
        root_g = grp.getgrnam("root").gr_gid
        for name in res["files"]:
            fp = os.path.join(target_dir, name)
            try:
                os.chown(fp, wd, root_g)
            except Exception:
                pass
    except Exception:
        pass
    reloads = []
    if reload:
        for c in RELOAD_COMMANDS:
            r = subprocess.run(["asterisk", "-rx", c], capture_output=True, text=True)
            reloads.append({"cmd": c, "rc": r.returncode})
    res["reloads"] = reloads
    res["fileCount"] = len(res["files"])
    return res


# insert_extension_surgical — pure text
# --------------------------------------------------------------------------- #

def _ext_sort_key(n: str):
    return (0, int(n)) if n.isdigit() else (1, n)


def _split_blocks(text: str) -> List[str]:
    """Split a context body into blank-line separated blocks (each keeps its trailing '\\n\\n')."""
    blocks, cur = [], []
    for line in text.splitlines(True):
        cur.append(line)
        if line == "\n":
            blocks.append("".join(cur))
            cur = []
    if cur:
        blocks.append("".join(cur))
    return blocks


def _find_context(text: str, ctx: str) -> Tuple[int, int]:
    """(start, end) offsets of the body of [ctx] (after its header line, up to the next '[' header or EOF)."""
    m = re.search(r"^\[%s\]\n" % re.escape(ctx), text, re.M)
    if not m:
        raise ValueError("context [%s] not found" % ctx)
    start = m.end()
    m2 = re.compile(r"^\[", re.M).search(text, start)
    end = m2.start() if m2 else len(text)
    return start, end


def _insert_block_ordered(text: str, ctx: str, block: str, key_re: str, new_key: str,
                          order_by_extension_id: bool = False, position_after: Optional[str] = None) -> str:
    """
    Insert `block` into [ctx] among the blocks whose first line matches key_re (group 1 = extension number).
    VitalPBX orders per-extension blocks by extension_id (creation order) — a NEW extension therefore goes
    AFTER the last existing per-extension block, before any trailing non-extension block (e.g. `exten => h`).
    """
    start, end = _find_context(text, ctx)
    body = text[start:end]
    blocks = _split_blocks(body)
    last_idx = -1
    for i, b in enumerate(blocks):
        if re.match(key_re, b):
            last_idx = i
    if not block.endswith("\n\n"):
        block = block.rstrip("\n") + "\n\n"
    blocks.insert(last_idx + 1, block)
    return text[:start] + "".join(blocks) + text[end:]


def surgical_dialplan(text: str, prefix: str, ext: str) -> str:
    """Add FW<ext> (ext-followme), [T_FW<ext>-confirm], VMO<ext> (extvm-operator) for a plain new extension."""
    n = ext
    fw = ("exten => FW%s,1,NoOp(Follow Me: FW%s)\n"
          ' same => n,ExecIf($["${LEN(${INBOUND_LANGUAGE})}"!="0"]?Set(CHANNEL(language)=${INBOUND_LANGUAGE}):Set(CHANNEL(language)=${DB(${TENANT}/extensions/%s/language)}))\n'
          " same => n,Set(__RETURN_ON_EXTERNAL=yes)\n"
          ' same => n,Set(__SKIP_PLAYBACK=${IF($["${QUEUE_CALL}"="TRUE"]?TRUE:${SKIP_PLAYBACK})})\n'
          " same => n,Set(CALLER_RECORDING=${ASTSPOOLDIR}/tmp/followme-${UNIQUEID}.wav)\n"
          " same => n,Set(__O_RING_TIME=30)\n"
          " same => n,Set(__SKIP_CONTACT_SERVICES=TRUE)\n"
          ' same => n,Set(__SRC_APP=${IF($["${LEN(${SRC_APP})}"="0"]?FW%s:${SRC_APP})})\n'
          ' same => n,ExecIf($["${SKIP_PLAYBACK}"!="TRUE"]?Playback(followme/status):)\n'
          ' same => n,ExecIf($["${SKIP_PLAYBACK}"!="TRUE"]?Playback(followme/pls-hold-while-try):)\n'
          " same => n(start-dialing),NoOp(Start Dialing)\n"
          " same => n,Gosub(sub-set-moh,s,1(default,YES))\n"
          " same => n,Set(__SKIP_CONTACT_SERVICES=FALSE)\n"
          " same => n,Return()\n\n" % (n, n, n, n))
    text = _insert_block_ordered(text, prefix + "ext-followme", fw, r"exten => FW(\d+),1,", n)
    confirm = ("[%sFW%s-confirm]\nexten => s,1,NoOp(Confirm Call)\n"
               ' same => n,ExecIf($["${LEN(${INBOUND_LANGUAGE})}"!="0"]?Set(CHANNEL(language)=${INBOUND_LANGUAGE}):Set(CHANNEL(language)=${DB(${TENANT}/extensions/%s/language)}))\n'
               " same => n,Set(DIALED_NUMBER=${CUT(DIALEDPEERNUMBER,@,1)})\n"
               ' same => n,Set(SOUND=${IF($["${LEN(${FWM_RECORDED_NAME})}"="0"]?followme/no-recording:followme/call-from&${FWM_RECORDED_NAME})})\n\n'
               % (prefix, n, n))
    # confirm contexts sit between the last existing [T_FW*-confirm] and [T_extvm-operator]
    heads = list(re.finditer(r"^\[%sFW\d+-confirm\]\n" % re.escape(prefix), text, re.M))
    if heads:
        last = heads[-1]
        nxt = re.compile(r"^\[", re.M).search(text, last.end())
        pos = nxt.start() if nxt else len(text)
    else:
        pos = re.search(r"^\[%sextvm-operator\]\n" % re.escape(prefix), text, re.M).start()
    text = text[:pos] + confirm + text[pos:]
    vmo = ("exten => VMO%s,1,NoOp(Voicemail Operator for extension %s)\n"
           " same => n,Playback(disabled)\n same => n,Return()\n same => n,Hangup()\n\n" % (n, n))
    text = _insert_block_ordered(text, prefix + "extvm-operator", vmo, r"exten => VMO(\d+),1,", n)
    return text


def surgical_hints(text: str, prefix: str, ext: str, devices: Sequence[str]) -> str:
    """Add `exten => <ext>,hint,pjsip/T_<ext>&pjsip/T_<ext>_1&Custom:T_DND_<ext>` after the last extension hint."""
    line = "exten => %s,hint,%s&Custom:%sDND_%s\n\n" % (ext, "&".join("pjsip/%s%s" % (prefix, d) for d in devices), prefix, ext)
    return _insert_block_ordered(text, prefix + "extension-hints", line, r"exten => (\d+),hint,(?!park:)", ext)


def surgical_pjsip(text: str, prefix: str, ext: str, name: str, mailbox: str, tenant_num: int,
                   desk_password: str, webrtc_password: str, language: str = "en", moh: str = "default",
                   cos_ctx: str = "cos-all") -> str:
    """Append endpoint/auth/aor blocks for T_<ext> (p1) and T_<ext>_1 (p12) before the file's final blank line."""
    def blocks(user, prof, dtmf, maxc, pw):
        nm = prefix + user
        return ("[%s](%s)\ntype=endpoint\nauth=auth%s\nidentify_by=username,auth_username\noutbound_auth=auth%s\n"
                "aors=%s\ndeny=0.0.0.0/0\ncontact_deny=0.0.0.0/0\npermit=0.0.0.0/0\ncontact_permit=0.0.0.0/0\n"
                "dtmf_mode=%s\nmessage_context=messages\nset_var=DEVICENAME=%s\nset_var=CHANNEL(parkinglot)=parking-%d\n"
                "subscribe_context=%sextension-hints\nlanguage=%s\nmoh_suggest=%s\ncontext=%s%s\nmailboxes=%s\n"
                "device_state_busy_at=0\ncallerid=\"%s\" <%s>\n\n"
                "[auth%s]\ntype=auth\nauth_type=userpass\nusername=%s\npassword=%s\n\n"
                "[%s](%s-aor)\ntype=aor\nmax_contacts=%d\n\n"
                % (nm, prof, nm, nm, nm, dtmf, nm, tenant_num, prefix, language, moh, prefix, cos_ctx, mailbox,
                   name, ext, nm, nm, pw, nm, prof, maxc))
    add = blocks(ext, "p1", "rfc4733", 1, desk_password) + blocks(ext + "_1", "p12", "auto", 5, webrtc_password)
    body = text.rstrip("\n")
    return body + "\n\n" + add + "\n"


def surgical_voicemail(text: str, ext: str, name: str, email: str, vm_password: str, tenant_hash: str) -> str:
    """Append the mailbox line (VitalPBX orders by extension_id, i.e. a new one is last)."""
    import vitalpbx_mirror as vm
    line = "%s => %s,%s,%s,,attach=yes|saycid=yes|sayduration=yes|envelope=yes|delete=no|hidefromdir=no|operator=no|%s\n" % (
        ext, vm_password, name, email or "", vm.VM_EMAILBODY % dict(hash=tenant_hash, ext=ext))
    return text + line


def surgical_astdb(prefix: str, tenant_hash: str, ext: str, name: str, mailbox: str, features_password: str,
                   vm_password: str, cos_ctx: str = "cos-all", language: str = "en", moh: str = "default") -> Dict[str, str]:
    fam = "/%s" % tenant_hash
    kv: Dict[str, str] = {}
    for dn in ("BOSS", "CC", "CFB", "CFI", "CFN", "CFU", "DND", "FWM"):
        kv["%s/diversions/%s/%s/destination" % (fam, ext, dn)] = ""
        kv["%s/diversions/%s/%s/enable" % (fam, ext, dn)] = "no"
        kv["%s/diversions/%s/%s/time_group" % (fam, ext, dn)] = ""
    kv["%s/diversions/%s/PEA/enable" % (fam, ext)] = "no"
    kv["%s/diversions/%s/PEA/time_group" % (fam, ext)] = ""
    kv["%s/diversions/%s/has_enable_diversions" % (fam, ext)] = "no"
    ek = "%s/extensions/%s/" % (fam, ext)
    kv.update({
        ek + "absent_secretary": "no", ek + "ask_vm_password": "yes", ek + "call_waiting": "yes", ek + "callgroup": "",
        ek + "context": prefix + cos_ctx, ek + "dial": "PJSIP/%s%s&PJSIP/%s%s_1" % (prefix, ext, prefix, ext),
        ek + "dial_options": "ktr", ek + "dictate/email": "", ek + "dictate/enabled": "no", ek + "dictate/format": "wav",
        ek + "dynamic_routing": "no", ek + "followme/ringtime": "0", ek + "hints": "no", ek + "hotdesking": "no",
        ek + "is_secretary": "no", ek + "language": language, ek + "lock": "no", ek + "moh": moh, ek + "name": name,
        ek + "notify_missed_calls": "no", ek + "password": features_password, ek + "pickupgroup": "", ek + "pinless": "no",
        ek + "ringtimer": "30", ek + "secretary": "", ek + "skip_vm_instructions": "no", ek + "spyb": "no",
        ek + "virtual_devices": "no", ek + "vm_password": vm_password, ek + "vmenabled": "yes", ek + "voicemail": mailbox,
    })
    for dn in ("BOSS", "CC", "CFB", "CFI", "CFN", "CFU", "DND", "FWM", "PEA"):
        kv["/CustomDevstate/%s%s_%s" % (prefix, dn, ext)] = "UNAVAILABLE" if dn == "DND" else "NOT_INUSE"
    return kv


def insert_extension_surgical(existing: Dict[str, str], tenant_num: int, tenant_hash: str, ext: str, name: str,
                              email: str, desk_password: str, webrtc_password: str, features_password: str,
                              vm_password: Optional[str] = None, language: str = "en") -> Tuple[Dict[str, str], Dict[str, str]]:
    """
    existing: {'dialplan': text, 'hints': text, 'pjsip': text, 'voicemail': text} of the tenant's CURRENT
    VitalPBX-generated files. Returns (new_texts, astdb_puts) with only the per-extension blocks added,
    positioned where VitalPBX would put them (per-extension blocks are ordered by extension_id, so a new
    extension is appended after the last existing one).
    """
    prefix = "T%d_" % tenant_num
    slug_m = re.search(r"^\[([a-z0-9_]+)-voicemail\]", existing["voicemail"], re.M)
    if not slug_m:
        raise ValueError("voicemail file has no [<slug>-voicemail] context")
    slug = slug_m.group(1)
    mailbox = "%s@%s-voicemail" % (ext, slug)
    vm_password = vm_password if vm_password is not None else ext
    out = {
        "dialplan": surgical_dialplan(existing["dialplan"], prefix, ext),
        "hints": surgical_hints(existing["hints"], prefix, ext, [ext, ext + "_1"]),
        "pjsip": surgical_pjsip(existing["pjsip"], prefix, ext, name, mailbox, tenant_num, desk_password,
                                webrtc_password, language),
        "voicemail": surgical_voicemail(existing["voicemail"], ext, name, email, vm_password, tenant_hash),
    }
    kv = surgical_astdb(prefix, tenant_hash, ext, name, mailbox, features_password, vm_password, language=language)
    return out, kv


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def _connect(a):
    import pymysql
    kw = dict(user=a.user, password=a.password, database=a.db, charset="utf8mb4",
              cursorclass=pymysql.cursors.DictCursor, autocommit=False)  # Plan.execute is ONE transaction
    if getattr(a, "socket", None):
        return pymysql.connect(unix_socket=a.socket, **kw)
    return pymysql.connect(host=a.host, port=a.port, **kw)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for p in (ap,):
        p.add_argument("--host", default=os.environ.get("MIRROR_DB_HOST", "127.0.0.1"))
        p.add_argument("--port", type=int, default=int(os.environ.get("MIRROR_DB_PORT", "3307")))
        p.add_argument("--user", default=os.environ.get("MIRROR_DB_USER", "root"))
        p.add_argument("--password", default=os.environ.get("MIRROR_DB_PASSWORD", "mirror"))
        p.add_argument("--db", default=os.environ.get("MIRROR_DB_NAME", "ombutel"))
        p.add_argument("--socket", default=os.environ.get("MIRROR_DB_SOCKET", ""), help="unix socket (overrides host/port)")
        p.add_argument("--apply", action="store_true", help="execute (default: dry run, print SQL)")

    c = sub.add_parser("create-tenant")
    c.add_argument("--description", required=True)
    c.add_argument("--name", help="slug (default: derived from description)")
    c.add_argument("--tenant-id", type=int)
    c.add_argument("--path", help="16-hex tenant hash (default: random unique)")
    c.add_argument("--user-id", type=int, default=45)
    c.add_argument("--outbound-profiles", default="", help="csv of ombu_ars ids in Main")
    c.add_argument("--dids", default="", help="csv of numbers → ombu_tenant_dids rows only (the panel's inbound_numbers[]); Connect adds the routes later")
    c.add_argument("--no-base-modules", action="store_true", help="do NOT queue the base modules (99/11/8/48/26/29/1) for the next Apply")
    c.add_argument("--fs", action="store_true", help="with --apply: also create the static/provisioning dirs (needs root or CAP_CHOWN)")
    c.add_argument("--json", action="store_true", help="print one JSON object instead of the SQL script")
    c.add_argument("--did")
    c.add_argument("--did-description", default="Main")
    c.add_argument("--did-destination", help="category_id,module_id,index e.g. 1,29,<extension_id>")

    e = sub.add_parser("add-extension")
    e.add_argument("--tenant-id", type=int, required=True)
    e.add_argument("--ext", required=True)
    e.add_argument("--name", required=True)
    e.add_argument("--email", default="")
    e.add_argument("--desk-password")
    e.add_argument("--webrtc-password")
    e.add_argument("--features-password")
    e.add_argument("--vm-password")

    d = sub.add_parser("add-did")
    d.add_argument("--tenant-id", type=int, required=True)
    d.add_argument("--did", required=True)
    d.add_argument("--description", default="Main")
    d.add_argument("--destination", help="category_id,module_id,index")

    r = sub.add_parser("render-and-install")
    r.add_argument("--tenant-id", type=int, required=True)
    r.add_argument("--target-dir", required=True)
    r.add_argument("--astdb-apply", action="store_true")

    a = ap.parse_args(argv)
    conn = _connect(a)

    def dest(s):
        if not s:
            return None
        cat, mod, idx = s.split(",")
        return int(cat), int(mod), idx

    if a.cmd == "create-tenant":
        plan = create_tenant(conn, a.description, name=a.name, tenant_id=a.tenant_id, path=a.path,
                             user_id=a.user_id,
                             outbound_profile_ids=[int(x) for x in a.outbound_profiles.split(",") if x.strip()],
                             did=a.did, did_description=a.did_description, did_destination=dest(a.did_destination),
                             dids=[x for x in a.dids.split(",") if x.strip()], queue_base_modules=not a.no_base_modules)
        if a.json:
            out = {"ok": True, "dryRun": not a.apply, "rows": plan.rows_by_table(), "sql": plan.sql_script()}
            if a.apply:
                ids = plan.execute(conn)
                out["ids"] = ids
                row = q1(conn, "select tenant_id, name, path from ombu_tenants where tenant_id=%s", (ids.get("tenant_id"),))
                out.update({"tenantId": row["tenant_id"], "name": row["name"], "path": row["path"]})
                if a.fs:
                    out["fs"] = apply_tenant_fs(row["path"])
            print(json.dumps(out))
            return
    elif a.cmd == "add-extension":
        plan = add_extension(conn, a.tenant_id, a.ext, a.name, a.email, a.desk_password, a.webrtc_password,
                             features_password=a.features_password, vm_password=a.vm_password)
    elif a.cmd == "add-did":
        plan = add_did(conn, a.tenant_id, a.did, a.description, dest(a.destination))
    else:
        res = render_and_install(conn, a.tenant_id, a.target_dir, apply=a.apply, astdb_apply=a.astdb_apply)
        print(json.dumps(res, indent=2))
        return
    print(plan.sql_script())
    print("-- rows: %s" % json.dumps(plan.rows_by_table()))
    if a.apply:
        ids = plan.execute(conn)
        print("-- APPLIED. ids: %s" % json.dumps(ids))
    else:
        print("-- DRY RUN (nothing written). Re-run with --apply to execute.")


if __name__ == "__main__":
    main()
