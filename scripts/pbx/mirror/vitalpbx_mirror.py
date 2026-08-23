#!/usr/bin/env python3
"""
VitalPBX mirror generator.

Reads the `ombutel` MySQL database (the same rows the VitalPBX panel writes) and
re-renders, byte for byte, the per-tenant Asterisk config files that VitalPBX's
(ionCube-encrypted, licence-gated) generator writes under
/etc/asterisk/vitalpbx/, plus the AstDB keys it seeds for the tenant.

Library:
    load_tenant(conn, tenant_id) -> model (dict)
    render_tenant(model)         -> {relative_filename: text}
    render_astdb(model)          -> {key: value}   (key = "/<family>/<key>")

CLI:
    vitalpbx_mirror.py render       --tenant N --out DIR
    vitalpbx_mirror.py render-astdb --tenant N

Only stdlib + pymysql. Python 3.11 compatible.

Every template below was cut from the real files VitalPBX generated on the
production PBX (baseline 2026-08-18) and the DB→text mapping was established
by comparing DB rows with the rendered text; see README.md in this folder.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Any, Dict, List, Optional

# --------------------------------------------------------------------------- #
# Constants that VitalPBX renders identically for every tenant
# --------------------------------------------------------------------------- #

BANNER = (
    "; *********************************************************************************\n"
    "; @Date : {date}\n"
    "; @Document : {doc}\n"
    "; @Author : VitalPBX\n"
    "; @Platform : VitalPBX\n"
    "; *********************************************************************************\n"
    "\n"
)

# The 14 file kinds VitalPBX writes per tenant (plus the 3 register/menu stubs).
# value = template body used when the tenant contributes nothing to the file
FILE_KINDS = [
    ("extensions__50-{t}-dialplan.conf", None),
    ("extensions__25-{t}-hints.conf", None),
    ("pjsip__50-{t}-extensions.conf", None),
    ("pjsip__50-{t}-trunks.conf", ""),
    ("voicemail__50-{t}-main.conf", None),
    ("queues__50-{t}-main.conf", None),
    ("musiconhold__50-{t}-main.conf", None),
    ("res_parking__50-{t}-extensions.conf", None),
    ("confbridge__50-{t}-profiles.conf", ""),
    ("confbridge__40-{t}-menu.conf", ""),
    ("manager__50-{t}-users.conf", "\n"),
    ("iax__50-{t}-extensions.conf", "\n"),
    ("iax__50-{t}-trunks.conf", ""),
    ("iax__20-{t}-registers.conf", "[general](+)\n"),
    ("sip__50-{t}-extensions.conf", "\n"),
    ("sip__50-{t}-trunks.conf", ""),
    ("sip__20-{t}-registers.conf", "[general](+)\n"),
]

FEATURE_CATEGORY_ALL = """include => feature-account_code
include => feature-boss_secretary
include => feature-attended_transfer
include => feature-one_touch_rec
include => feature-auth_code
include => feature-add_num_blacklist
include => feature-add_last_caller_blacklist
include => feature-remove_number_blacklist
include => feature-blind_transfer
include => feature-cancel_cc
include => feature-request_cc
include => feature-set_cfb_number
include => feature-toggle_cfb
include => feature-set_cfu_number
include => feature-toggle_cfu
include => feature-toggle_cfn
include => feature-set_cfn_number
;include => feature-spy_random_chn
include => feature-change_ext_pwd
include => feature-clear_all_diversions
include => feature-cust_recording
include => feature-dictation_services
include => feature-direct_vm
include => feature-direct_pickup
include => feature-disconnect_call
include => feature-dnd
include => feature-echo_test
include => feature-follow_me
include => feature-hot_desking
include => feature-dial_by_name_dir
include => feature-lock_unlock_phone
include => feature-nm_all
include => feature-park_call
include => feature-personal_assistant
include => feature-pickup_group
include => feature-rec_msg_pa
include => feature-reminder
include => feature-remote_substitution
include => feature-remote_vm
;include => feature-remote_wakeup_call
include => feature-say_date_time
include => feature-simulate_incoming_call
include => feature-speak_last_number
include => feature-speak_ext_number
;include => feature-spy_extension
;include => feature-spy_ext_whisper
include => feature-add_remove_queue_agent
include => feature-pause_unpause_queue_agent
include => feature-request_wakeup_call
include => feature-toggle_cfi
include => feature-set_cfi_number
include => feature-queues_login_logout
include => feature-queues-pause-unpause
include => feature-send_vm_msg
;include => feature-spy_ext_barge
include => feature-paging_and_intercom
include => feature-hot_desking_cc
include => feature-paging_duplex
include => feature-anonymous_calling
include => feature-auto_recording_switch_in
include => feature-auto_recording_switch_out
"""

# order + include/comment of the [T_applications] block; each entry: (suffix, module key)
APPLICATIONS_ORDER = [
    ("speedial", "speed_dials"),
    ("custom-application", "custom_applications"),
    ("custom-destination", "custom_destinations"),
    ("paging", "pages"),
    ("vmgroup", "vmgroups"),
    ("queues-priority", "queue_priorities"),
    ("disa", "ALWAYS"),
    ("ivr", "ivrs"),
    ("announcement", "announcements"),
    ("languages", "languages"),
    ("nightmode", "nightmodes"),
    ("call-back", "callbacks"),
    ("rec-management", "rec_management"),
    ("time-condition", "time_conditions"),
    ("ai-assistants", "ALWAYS"),
]

VM_EMAILBODY = (
    "emailbody=category:${VM_CATEGORY}\\nvm_name:${VM_NAME}\\nduration:${VM_DUR}"
    "\\nmsg_num:${VM_MSGNUM}\\ncid:${VM_CALLERID}\\ncid_name:${VM_CIDNAME}"
    "\\ncid_num:${VM_CIDNUM}\\ndate:${VM_DATE}\\nmsg_file:${VM_MESSAGEFILE}"
    "\\ntenant:%(hash)s\\nextension:%(ext)s\\nmailbox:${VM_MAILBOX}"
)


def vitalpbx_date(ts: Optional[float] = None) -> str:
    """PHP date('D M j G:i:s T Y') in GMT, e.g. 'Tue Aug 18 3:00:50 GMT 2026'."""
    tm = time.gmtime(ts if ts is not None else time.time())
    return "%s %s %d %d:%02d:%02d GMT %d" % (
        time.strftime("%a", tm), time.strftime("%b", tm), tm.tm_mday,
        tm.tm_hour, tm.tm_min, tm.tm_sec, tm.tm_year)


def banner(doc: str, date: Optional[str] = None) -> str:
    return BANNER.format(date=date or vitalpbx_date(), doc=doc)


# --------------------------------------------------------------------------- #
# DB access
# --------------------------------------------------------------------------- #

def connect(host="127.0.0.1", port=3307, user="root", password="mirror", db="ombutel"):
    import pymysql
    return pymysql.connect(host=host, port=port, user=user, password=password,
                           database=db, charset="utf8mb4",
                           cursorclass=pymysql.cursors.DictCursor, autocommit=True)


def q(conn, sql: str, args=()) -> List[Dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return list(cur.fetchall())


def q1(conn, sql: str, args=()) -> Optional[Dict[str, Any]]:
    rows = q(conn, sql, args)
    return rows[0] if rows else None


def yn(v) -> str:
    return "yes" if str(v).lower() in ("yes", "1", "true") else "no"


def nz(v, default="") -> str:
    return default if v is None else str(v)


# --------------------------------------------------------------------------- #
# Model loading
# --------------------------------------------------------------------------- #

def load_tenant(conn, tenant_id: int) -> Dict[str, Any]:
    t = tenant_id
    tenant = q1(conn, "select * from ombu_tenants where tenant_id=%s", (t,))
    if not tenant:
        raise SystemExit("tenant %s not found" % t)
    settings = {r["name"]: r["value"] for r in
                q(conn, "select name,value from ombu_tenant_settings where tenant_id=%s", (t,))}
    gsettings = {r["name"]: r["value"] for r in
                 q(conn, "select name,value from ombu_settings where module_id=128")}

    def dyn(name):
        v = gsettings.get("T%d_%s" % (t, name), gsettings.get(name))
        return v

    music_groups = {r["music_group_id"]: r for r in q(conn, "select * from ombu_music_groups")}
    cos_rows = q(conn, "select * from ombu_classes_of_service where tenant_id=%s order by class_of_service_id", (t,))
    dial_profiles = {r["dial_profile_id"]: r for r in
                     q(conn, "select * from ombu_dial_profiles where tenant_id=%s", (t,))}
    parking = q(conn, "select * from ombu_parking_lots where tenant_id=%s order by parking_lot_id", (t,))
    ars_own = q(conn, "select * from ombu_ars where tenant_id=%s order by ars_id", (t,))
    pickup_groups = q(conn, "select * from ombu_pickup_groups where tenant_id=%s order by pickup_group_id", (t,))
    pickup_members = {}
    for pg in pickup_groups:
        for m in q(conn, "select * from ombu_pickup_group_members where pickup_group_id=%s", (pg["pickup_group_id"],)):
            pickup_members.setdefault(m["extension_id"], []).append(pg)

    exts = q(conn, "select * from ombu_extensions where tenant_id=%s order by extension_id", (t,))
    for e in exts:
        eid = e["extension_id"]
        e["devices"] = q(conn, "select * from ombu_devices where extension_id=%s order by device_id", (eid,))
        for d in e["devices"]:
            d["pjsip"] = q1(conn, "select * from ombu_pjsip_devices where device_id=%s", (d["device_id"],))
            d["virtual"] = q1(conn, "select * from ombu_virtual_devices where device_id=%s", (d["device_id"],))
        e["vm"] = q1(conn, "select * from ombu_extensions_vm where extension_id=%s", (eid,))
        e["followme"] = q1(conn, "select * from ombu_followme where extension_id=%s", (eid,))
        e["diversions"] = q(conn, "select * from ombu_extension_diversions where extension_id=%s", (eid,))
        e["pea"] = q1(conn, "select * from ombu_extension_pea where extension_id=%s", (eid,))
        e["contact"] = q1(conn, "select * from ombu_extensions_contact_info where extension_id=%s", (eid,))
        e["pickup_groups"] = pickup_members.get(eid, [])
        e["cos"] = next((c for c in cos_rows if c["class_of_service_id"] == e["class_of_service_id"]), None)
        e["dial_profile"] = dial_profiles.get(e["dial_profile_id"])
        e["music_group"] = music_groups.get(e["music_group_id"])

    inbound = q(conn, "select * from ombu_inbound_routes where tenant_id=%s order by inbound_route_id", (t,))
    emergency_cats = q(conn, "select * from ombu_emergency_number_categories where tenant_id=%s order by id", (t,))
    for c in emergency_cats:
        c["numbers"] = q(conn, "select * from ombu_emergency_numbers where category_id=%s order by sort, id", (c["id"],))
        c["trunks"] = q(conn, "select * from ombu_emergency_trunks where category_id=%s order by trunk_id", (c["id"],))
    emergency_locations = q(conn, "select * from ombu_emergency_locations where tenant_id=%s order by id", (t,))
    custom_apps = q(conn, "select * from ombu_custom_applications where tenant_id=%s order by custom_application_id", (t,))
    custom_dests = q(conn, "select * from ombu_custom_destinations where tenant_id=%s order by custom_destination_id", (t,))
    ring_groups = q(conn, "select * from ombu_ring_groups where tenant_id=%s order by ring_group_id", (t,))
    for rg in ring_groups:
        rg["members"] = q(conn, "select * from ombu_ring_group_members where ring_group_id=%s order by id", (rg["ring_group_id"],)) \
            if _table_has(conn, "ombu_ring_group_members", "id") else \
            q(conn, "select * from ombu_ring_group_members where ring_group_id=%s", (rg["ring_group_id"],))
    queues = q(conn, "select * from ombu_queues where tenant_id=%s order by queue_id", (t,))
    for qu in queues:
        qu["members"] = q(conn, "select * from ombu_queue_members where queue_id=%s", (qu["queue_id"],))
    ivrs = q(conn, "select * from ombu_ivrs where tenant_id=%s order by ivr_id", (t,))
    time_conditions = q(conn, "select * from ombu_time_conditions where tenant_id=%s order by time_condition_id", (t,))
    time_groups = q(conn, "select * from ombu_time_groups where tenant_id=%s order by time_group_id", (t,))
    announcements = q(conn, "select * from ombu_announcements where tenant_id=%s order by announcement_id", (t,))
    pages = q(conn, "select * from ombu_pages where tenant_id=%s order by page_id", (t,))
    tenant_music_groups = [g for g in music_groups.values() if g["tenant_id"] == t]

    model = dict(
        conn=conn,
        tenant=tenant, t=t, prefix="T%d_" % t, hash=tenant["path"], slug=tenant["name"],
        settings=settings,
        dyn=dict(delete_used_records=dyn("delete_used_records"), digits_match=dyn("digits_match"),
                 expiration_time=dyn("expiration_time"), only_missed_calls=dyn("only_missed_calls")),
        music_groups=music_groups, tenant_music_groups=tenant_music_groups,
        cos=cos_rows, dial_profiles=dial_profiles, parking=parking, ars_own=ars_own,
        extensions=exts, inbound=inbound,
        emergency_cats=emergency_cats, emergency_locations=emergency_locations,
        custom_apps=custom_apps, custom_dests=custom_dests,
        ring_groups=ring_groups, queues=queues, ivrs=ivrs,
        time_conditions=time_conditions, time_groups=time_groups,
        announcements=announcements, pages=pages,
        pickup_groups=pickup_groups,
    )
    return model


_col_cache: Dict[str, set] = {}


def _table_has(conn, table: str, col: str) -> bool:
    if table not in _col_cache:
        _col_cache[table] = {r["Field"] for r in q(conn, "describe %s" % table)}
    return col in _col_cache[table]


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #

def moh_name(m, group_id) -> str:
    """music_group_id -> the MOH class name Asterisk uses (default / mohN)."""
    if group_id in (None, "", 0):
        return "default"
    g = m["music_groups"].get(int(group_id))
    if g is None:
        return "default"
    if g["name"] == "default" and g["tenant_id"] == 1 and int(group_id) == 1:
        return "default"
    return "moh%d" % int(group_id)


def dial_options(dp) -> str:
    """ombu_dial_profiles -> Dial() option string (AstDB dial_options)."""
    if not dp:
        return "ktr"
    opts = ""
    if dp.get("allow_parking") in ("called", "both"):
        opts += "k"
    if dp.get("allow_parking") in ("caller", "both"):
        opts += "K"
    if dp.get("allow_transfer") in ("called", "both"):
        opts += "t"
    if dp.get("allow_transfer") in ("caller", "both"):
        opts += "T"
    if dp.get("ringing_tone") == "yes":
        opts += "r"
    if dp.get("custom_options"):
        opts += dp["custom_options"]
    return opts


def ext_dial_string(m, e) -> str:
    """AstDB extensions/N/dial: PJSIP/<dev>[&...] and Local/<num>@T_cos-all for virtual devices."""
    parts = []
    for d in e["devices"]:
        if d.get("ring_device") != "yes":
            continue
        if d["technology"] == "pjsip":
            parts.append("PJSIP/%s%s" % (m["prefix"], d["user"]))
        elif d["technology"] == "virtual" and d.get("virtual"):
            parts.append("Local/%s@%s%s" % (d["virtual"]["number"], m["prefix"], cos_context(e)))
        elif d["technology"] == "sip":
            parts.append("SIP/%s%s" % (m["prefix"], d["user"]))
        elif d["technology"] == "iax":
            parts.append("IAX2/%s%s" % (m["prefix"], d["user"]))
    return "&".join(parts)


def cos_context(e) -> str:
    return "cos-%s" % (e["cos"]["cos"] if e.get("cos") else "all")


# --------------------------------------------------------------------------- #
# Destinations
# --------------------------------------------------------------------------- #

def dest_target(m, dest_id) -> Optional[str]:
    """Resolve an ombu_destinations id to the 'context,exten,priority' VitalPBX writes into Goto()."""
    if dest_id is None:
        return None
    conn = m["conn"]
    d = q1(conn, "select * from ombu_destinations where id=%s", (dest_id,))
    if not d:
        return None
    p = m["prefix"]
    cat, idx = int(d["category_id"]), d["index"]
    if cat == 1:  # extension
        e = q1(conn, "select extension, class_of_service_id, tenant_id from ombu_extensions where extension_id=%s", (idx,))
        if not e:
            return None
        cos = q1(conn, "select cos from ombu_classes_of_service where class_of_service_id=%s", (e["class_of_service_id"],))
        return "T%d_cos-%s,%s,1" % (e["tenant_id"], cos["cos"] if cos else "all", e["extension"])
    if cat == 31:  # inbound route "verify DID"
        return "verify-did,${CALL_DESTINATION},1"
    if cat == 24:  # terminate call
        return "app-termination,%s,1" % {"1": "hangup", "2": "busy", "3": "congestion", "4": "zapateller", "5": "playtone"}.get(str(idx), "hangup")
    if cat == 33:  # custom context
        cc = q1(conn, "select * from ombu_custom_contexts where cc_id=%s", (idx,))
        if cc:
            # NOTE: the panel renders Goto(T<t>_custom-contexts,cc-<id>,1); the connect-pbx-helper
            # bakes the real target in its place. We render the real target, which is what is on disk.
            return "%s,%s,%s" % (cc["context"], cc["extension"], cc["priority"])
        return None
    if cat == 6:  # custom destination
        return "%sapp-custom-destination,custom-dest-%s,1" % (p, idx)
    if cat == 5:  # custom application
        ca = q1(conn, "select * from ombu_custom_applications where custom_application_id=%s", (idx,))
        return "%sapp-custom-application,%s,1" % (p, ca["extension"]) if ca else None
    if cat == 13:  # ring group
        rg = q1(conn, "select * from ombu_ring_groups where ring_group_id=%s", (idx,))
        return "%sext-ringgroups,%s,1" % (p, rg["extension"]) if rg else None
    if cat == 14:  # queue
        qu = q1(conn, "select * from ombu_queues where queue_id=%s", (idx,))
        return "%sext-queues,%s,1" % (p, qu["extension"]) if qu else None
    if cat == 16:  # ivr
        return "%sapp-ivr,IVR-%s,1" % (p, idx)
    if cat == 17:  # time condition
        return "%sapp-time-condition,TC-%s,1" % (p, idx)
    if cat == 18:  # announcement
        return "%sapp-announcement,announcement-%s,1" % (p, idx)
    if cat == 25:  # voicemail direct
        return _vm_dest(m, idx, "VM")
    if cat == 26:  # voicemail busy
        return _vm_dest(m, idx, "VMB")
    if cat == 27:  # voicemail unavailable
        return _vm_dest(m, idx, "VMU")
    if cat == 28:  # follow me
        e = q1(conn, "select extension from ombu_extensions where extension_id=%s", (idx,))
        return "%sext-followme,FW%s,1" % (p, e["extension"]) if e else None
    if cat == 12:  # disa
        return "%sapp-disa,DISA-%s,1" % (p, idx)
    if cat == 11:  # callback
        return "%sapp-call-back,CB-%s,1" % (p, idx)
    if cat == 20:  # night mode
        return "%sapp-nightmode,NM-%s,1" % (p, idx)
    if cat == 19:  # languages
        return "%sapp-languages,LANG-%s,1" % (p, idx)
    if cat == 15:  # queue priority
        return "%sapp-queues-priority,QP-%s,1" % (p, idx)
    if cat == 4:  # conference
        c = q1(conn, "select * from ombu_conferences where conference_id=%s", (idx,))
        return "%sext-conferences,%s,1" % (p, c["extension"]) if c else None
    if cat == 9:  # speed dial
        return "%sapp-speedial,%s,1" % (p, idx)
    if cat == 8:  # parking
        return "%sext-parking,%s,1" % (p, idx)
    if cat == 34:  # dynamic destination
        return "%sapp-dynamic-destinations,DD-%s,1" % (p, idx)
    if cat == 35:  # queue callback
        return "QUEUE-CALLBACK-IVR-%s,s,1" % idx
    return "UNKNOWN-DEST-CATEGORY-%s,%s,1" % (cat, idx)


def _vm_dest(m, ext_id, kind) -> Optional[str]:
    e = q1(m["conn"], "select extension from ombu_extensions where extension_id=%s", (ext_id,))
    if not e:
        return None
    return "sub-extensions-vm,%s-%s,1" % (kind, e["extension"])


def goto(m, dest_id) -> str:
    tgt = dest_target(m, dest_id)
    return "Goto(%s)" % tgt if tgt else "Hangup()"


# --------------------------------------------------------------------------- #
# Renderers — dialplan
# --------------------------------------------------------------------------- #

def r_ext_followme(m) -> str:
    p, h = m["prefix"], m["hash"]
    out = ["[%sext-followme]\n" % p]
    for e in m["extensions"]:
        n = e["extension"]
        fm = e["followme"] or {}
        lines = [
            "exten => FW%s,1,NoOp(Follow Me: FW%s)" % (n, n),
            ' same => n,ExecIf($["${LEN(${INBOUND_LANGUAGE})}"!="0"]?Set(CHANNEL(language)=${INBOUND_LANGUAGE}):Set(CHANNEL(language)=${DB(${TENANT}/extensions/%s/language)}))' % n,
            " same => n,Set(__RETURN_ON_EXTERNAL=yes)",
            ' same => n,Set(__SKIP_PLAYBACK=${IF($["${QUEUE_CALL}"="TRUE"]?TRUE:${SKIP_PLAYBACK})})',
            " same => n,Set(CALLER_RECORDING=${ASTSPOOLDIR}/tmp/followme-${UNIQUEID}.wav)",
            " same => n,Set(__O_RING_TIME=%s)" % (fm.get("ringtime") or 30),
            " same => n,Set(__SKIP_CONTACT_SERVICES=TRUE)",
            ' same => n,Set(__SRC_APP=${IF($["${LEN(${SRC_APP})}"="0"]?FW%s:${SRC_APP})})' % n,
        ]
        if fm.get("enable_callee_prompt") == "yes":
            lines.append(" same => n,Set(__FWM_CONFIRMATION_CONTEXT=%sFW%s-confirm)" % (p, n))
        if fm.get("status_prompt_id"):
            lines.append(' same => n,ExecIf($["${SKIP_PLAYBACK}"!="TRUE"]?Playback(followme/status):)')
        if fm.get("pls_hold_prompt_id"):
            lines.append(' same => n,ExecIf($["${SKIP_PLAYBACK}"!="TRUE"]?Playback(followme/pls-hold-while-try):)')
        lines.append(" same => n(start-dialing),NoOp(Start Dialing)")
        lines.append(" same => n,Gosub(sub-set-moh,s,1(%s,YES))" % moh_name(m, fm.get("music_group_id")))
        nums = [x for x in (fm.get("followme_numbers") or "").replace("&", ",").split(",") if x.strip()]
        if nums:
            ring = fm.get("ringtime") or 30
            if fm.get("ring_strategy") == "ring_all":
                lines.append(" same => n,Dial(%s,%s,r)" % ("&".join("Local/%s@%s%s/n" % (x.strip(), p, cos_context(e)) for x in nums), ring))
            else:
                for x in nums:
                    lines.append(" same => n,Dial(Local/%s@%s%s/n,%s,r)" % (x.strip(), p, cos_context(e), ring))
            lines.append(" same => n,System(rm -f ${CALLER_RECORDING})")
        lines.append(" same => n,Set(__SKIP_CONTACT_SERVICES=FALSE)")
        lines.append(" same => n,Return()")
        out.append("\n".join(lines) + "\n\n")
    out.append("exten => h,1,NoOp(Finish Follow-me call)\n same => n,System(rm -f ${CALLER_RECORDING})\n\n")
    return "".join(out)


def r_fw_confirm(m) -> str:
    p = m["prefix"]
    out = []
    for e in m["extensions"]:
        n = e["extension"]
        fm = e["followme"] or {}
        lines = [
            "[%sFW%s-confirm]" % (p, n),
            "exten => s,1,NoOp(Confirm Call)",
            ' same => n,ExecIf($["${LEN(${INBOUND_LANGUAGE})}"!="0"]?Set(CHANNEL(language)=${INBOUND_LANGUAGE}):Set(CHANNEL(language)=${DB(${TENANT}/extensions/%s/language)}))' % n,
            " same => n,Set(DIALED_NUMBER=${CUT(DIALEDPEERNUMBER,@,1)})",
            ' same => n,Set(SOUND=${IF($["${LEN(${FWM_RECORDED_NAME})}"="0"]?followme/no-recording:followme/call-from&${FWM_RECORDED_NAME})})',
        ]
        if fm.get("enable_callee_prompt") == "yes":
            lines += [
                " same => n,Set(GOSUB_RESULT=CONTINUE)",
                " same => n,Read(CONFIRM,${SOUND}&followme/options,1,,1,5)",
                ' same => n(accept),Set(_GOSUB_RESULT=${IF($["${CONFIRM}" = "1"]?:${GOSUB_RESULT})})',
                " same => n,Return()",
            ]
        out.append("\n".join(lines) + "\n\n")
    return "".join(out)


def r_extvm_operator(m) -> str:
    p = m["prefix"]
    if not m["extensions"]:
        return ""
    out = ["[%sextvm-operator]\n" % p]
    for e in m["extensions"]:
        n = e["extension"]
        vm = e["vm"] or {}
        lines = ["exten => VMO%s,1,NoOp(Voicemail Operator for extension %s)" % (n, n)]
        if vm.get("operator_destination_id"):
            lines.append(" same => n,%s" % goto(m, vm["operator_destination_id"]))
        else:
            lines.append(" same => n,Playback(disabled)")
            lines.append(" same => n,Return()")
        lines.append(" same => n,Hangup()")
        out.append("\n".join(lines) + "\n\n")
    return "".join(out)


def r_extvm_greetings(m) -> str:
    """[T_sub-extvm-greetings] – only when some mailbox has a custom busy/unavailable greeting."""
    p, h = m["prefix"], m["hash"]
    entries = []
    for e in m["extensions"]:
        vm = e["vm"] or {}
        for col, kind, word in (("busy_greeting_id", "VMB", "busy"), ("unav_greeting_id", "VMU", "unavailable")):
            rid = vm.get(col)
            if rid:
                rec = q1(m["conn"], "select * from ombu_recordings where recording_id=%s", (rid,))
                if rec:
                    entries.append((e["extension"], kind, word, rec))
    if not entries:
        return ""
    out = ["[%ssub-extvm-greetings]\n" % p]
    for n, kind, word, rec in entries:
        out.append("exten => %s%s,1,NoOp(Playing %s message for extension %s)\n"
                   " same => n,Playback(/var/lib/vitalpbx/static/%s/recordings/%s)\n"
                   " same => n,Return()\n same => n,Hangup()\n\n" % (kind, n, word, n, h, rec["file"] if "file" in rec else rec.get("filename")))
    return "".join(out)


def r_custom_apps(m) -> str:
    p = m["prefix"]
    if not m["custom_apps"]:
        return ""
    out = ["[%sapp-custom-application]\n" % p]
    for ca in m["custom_apps"]:
        out.append("exten => %s,1,Gosub(sub-set-call-vars,app-incoming,1)\n"
                   " same => n,NoOp(Custom Application: %s)\n"
                   " same => n,%s\n"
                   " same => n,Hangup()\n\n" % (ca["extension"], ca["description"], goto(m, ca["destination_id"])))
    return "".join(out)


def r_custom_dests(m) -> str:
    p = m["prefix"]
    if not m["custom_dests"]:
        return ""
    out = ["[%sapp-custom-destination]\n" % p]
    for cd in m["custom_dests"]:
        # cid_name/cid_number are NULL on every live row; the form used when set is UNVERIFIED (see README)
        if cd.get("cid_name") or cd.get("cid_number"):
            cid = '"%s" <%s>' % (cd.get("cid_name") or "${CALLERID(name)}", cd.get("cid_number") or "${CALLERID(number)}")
        else:
            cid = '"${CALLERID(name)}" <${CALLERID(number)}>'
        # class_of_service_id may point at ANOTHER tenant's row (live: T105 rows carry cos id 2 = T2's);
        # the panel renders the tenant's own prefix + the referenced row's cos NAME.
        cos = q1(m["conn"], "select cos from ombu_classes_of_service where class_of_service_id=%s", (cd["class_of_service_id"],))
        ctx = "%scos-%s" % (p, cos["cos"] if cos else "all")
        out.append("exten => custom-dest-%s,1,NoOp(Custom Destination: %s)\n"
                   ' same => n,ExecIf($[$["${CALL_TYPE}"!="1"]&$["DISABLE_CF_AA"!="TRUE"]]?Answer():)\n'
                   ' same => n,ExecIf($["${CALL_TYPE}"="2"]?Set(__EXT_CID_CONSTRUCTED=yes):)\n'
                   " same => n,Set(CALLERID(all)=%s)\n"
                   " same => n,Goto(%s,%s,1)\n\n" % (cd["custom_destination_id"], cd["description"], cid, ctx, cd["destination"]))
    return "".join(out)


def r_parking(m) -> str:
    p, t = m["prefix"], m["t"]
    out = []
    for lot in m["parking"]:
        name = "parking-%d" % t if lot.get("defpark") == "yes" else "parking-%d-%s" % (t, lot["extension"])
        ext = int(lot["extension"])
        npos = int(lot["parkpos"])
        first, last = ext + 1, ext + npos
        out.append("[%sext-parking]\ninclude => %s-parkedcalls\n\n" % (p, name))
        out.append("exten => %s,1,NoOp(Parking Call)\n same => n,Park(%s,c(%s-callback,s,1))\n\n" % (ext, name, name))
        rec = yn(lot.get("record"))
        for pat in slot_patterns(first, last):
            out.append("exten => %s,1,NoOp(Slot: ${CALL_DESTINATION})\n"
                       " same => n,Set(RECORD_PARKING_LOT=%s)\n"
                       " same => n,Gosub(sub-parking-lots,s,1(${CALL_DESTINATION},%s,%s-parkedcalls))\n\n" % (pat, rec, name, name))
        out.append("[%s-parkedcallstimeout]\nexten => s,1,NoOp(Parking Timeout has been reached)\n"
                   " same => n,Gosub(app-termination,hangup,1)\n same => n,Hangup()\n\n" % name)
        out.append("[%s-callback]\nexten => s,1,NoOp(Returning Call)\n"
                   ' same => n,Set(CALLBACK_EXT=${IF($["${CALL_TYPE}"="3"]?${CALLER}:${DESTINATION_NUMBER})})\n'
                   " same => n,Set(CALLBACK_CTXT=${TRANSFER_CONTEXT})\n"
                   ' same => n,GotoIf($[$["${LEN(${CALLBACK_EXT})}"="0"]|$["${LEN(${CALLBACK_CTXT})}"="0"]]?end)\n'
                   " same => n,Goto(${CALLBACK_CTXT},${CALLBACK_EXT},1)\n"
                   " same => n(end),Hangup()\n\n" % name)
    return "".join(out)


def slot_patterns(first: int, last: int) -> List[str]:
    """VitalPBX writes _70[1-9] then _710 for 701-710. Generalised: one pattern per leading prefix."""
    pats = []
    n = first
    while n <= last:
        prefix, digit = str(n)[:-1], int(str(n)[-1])
        end = min(last, int(prefix + "9"))
        if end == n:
            pats.append("_%d" % n)
        else:
            pats.append("_%s[%d-%d]" % (prefix, digit, int(str(end)[-1])))
        n = end + 1
    return pats


def r_applications(m) -> str:
    p = m["prefix"]
    present = {
        "custom_applications": bool(m["custom_apps"]),
        "custom_destinations": bool(m["custom_dests"]),
        "pages": bool(m["pages"]),
        "ivrs": bool(m["ivrs"]),
        "announcements": bool(m["announcements"]),
        "time_conditions": bool(m["time_conditions"]),
    }
    lines = ["[%sapplications]" % p]
    for suffix, key in APPLICATIONS_ORDER:
        on = key == "ALWAYS" or present.get(key, False)
        lines.append("%sinclude => %sapp-%s" % ("" if on else ";", p, suffix))
    return "\n".join(lines) + "\n\n\n"


def r_extensions_include(m) -> str:
    p = m["prefix"]
    conf = "" if m.get("conferences") else ";"
    return ("[%sextensions]\n%sinclude => %sext-conferences\ninclude => %sext-parking\n"
            "include => %sext-ringgroups\ninclude => %sext-queues\n\n\n" % (p, conf, p, p, p, p))


def r_hot_desking(m) -> str:
    p, h, s = m["prefix"], m["hash"], m["slug"]
    def blk(exten, noop, tail):
        return ("exten => %s,1,Set(CDR(source)=${CALLERID(num)})\n"
                " same => n,Set(CDR(destination)=${EXTEN})\n"
                " same => n,Set(CDR(tenant)=%s)\n"
                " same => n,NoOp(%s)\n"
                " same => n,Set(__TENANT=%s)\n"
                " same => n,Set(__TENANT_PREFIX=%s)\n"
                "%s\n" % (exten, s, noop, h, p, tail))
    def blk2(exten, noop, feature):
        return ("exten => %s,1,Gosub(sub-get-device-tree,s,1)\n"
                " same => n,Set(__CALL_DESTINATION=${EXTEN})\n"
                " same => n,Set(CDR(source)=${CALLERID(num)})\n"
                " same => n,Set(CDR(destination)=${EXTEN})\n"
                " same => n,Set(CDR(tenant)=%s)\n"
                " same => n,NoOp(%s)\n"
                " same => n,Set(__TENANT=%s)\n"
                " same => n,Set(__TENANT_PREFIX=%s)\n"
                " same => n,Gosub(%sset-global-tenant-vars,s,1)\n"
                " same => n,Gosub(%s,${EXTEN},1)\n"
                " same => n,Hangup()\n\n" % (exten, s, noop, h, p, p, feature))
    out = ["[%shot-desking-context]\n" % p]
    out.append(blk("*80", "Hot Desking Feature",
                   " same => n,Gosub(%sset-global-tenant-vars,s,1)\n same => n,Gosub(sub-hot-desking,s,1)\n same => n,Hangup()\n" % p))
    out.append(blk2("_*80*[0-9]!", "Hot Desking Direct Feature", "feature-hot_desking"))
    out.append(blk2("*90", "Hot Desking CC Feature", "feature-hot_desking_cc"))
    out.append(blk2("_*90#[+*0-9]!", "Hot Desking CC Feature", "feature-hot_desking_cc"))
    out.append(blk2("_*90#[+*0-9]!#[*0-9].", "Hot Desking CC Feature", "feature-hot_desking_cc"))
    out.append(blk("_[-+*#0-9a-zA-Z].", "Hot Desking",
                   " same => n,Gosub(sub-hot-desking-call,s,1(${EXTEN}))\n"))
    return "".join(out)


def r_cos(m) -> str:
    """The [T_cos-<name>*] context family, one per class of service."""
    p, h, s, t = m["prefix"], m["hash"], m["slug"], m["t"]
    out = []
    default_park = next((l for l in m["parking"] if l.get("defpark") == "yes"), None)
    park = "parking-%d" % t if default_park else ""
    for c in m["cos"]:
        name = c["cos"]
        cid = c["class_of_service_id"]
        ctx = "%scos-%s" % (p, name)
        ars = "%sARS-%s" % (p, name)
        cat = "%sall-features-category" % p if c.get("feature_code_category_id") is None else "%sfeature-category-%s" % (p, c["feature_code_category_id"])
        out.append("[%s]\ninclude => %s-init\n\n\n" % (ctx, ctx))
        out.append("[%s-init]\n"
                   "exten => _[-+*#0-9a-zA-Z].,1,NoOp(More than on digit pattern)\n"
                   " same => n,Gosub(s,1(${EXTEN}))\n\n"
                   "exten => _[-+*#0-9a-zA-Z],1,NoOp(One Digit pattern)\n"
                   " same => n,Gosub(s,1(${EXTEN}))\n\n"
                   "exten => i,1,NoOp(Invalid dial on init section)\n"
                   " same => n,ForkCDR(e)\n"
                   ' same => n,ExecIf($[$["${FROM_QUEUE_CALLBACK}"="yes"]|$["${SRC_APP}"="IVR"]]?Hangup():)\n'
                   " same => n,Goto(invalid-dest-cos,s,1)\n\n"
                   "exten => h,1,NoCDR()\n"
                   " same => n,NoOp(Hanging Up the Call)\n"
                   " same => n,Hangup()\n\n"
                   "exten => s,1,Set(EXTENSION=${ARG1})\n"
                   " same => n,NoOp(Dialing ${EXTENSION} from ${CALLERID(num)})\n"
                   " same => n,Gosub(sub-set-global-vars,s,1(%s,${EXTENSION},%s))\n"
                   " same => n,Gosub(sub-set-call-vars,s,1(%s,${EXTENSION},%s,%s,%s))\n"
                   " same => n,Gosub(sub-construct-cid,s,1)\n"
                   " same => n,Gosub(%sset-global-tenant-vars,s,1)\n"
                   ' same => n,GotoIf($["${CALL_ORIGIN}"="RESTRICTED_IVR_CALL"]?local-dialing)\n'
                   " same => n,NoOp(Check if is an Emergency Call)\n"
                   " same => n,GotoIf($[${DIALPLAN_EXISTS(%semergency-calls,${EXTENSION},1)}=1]?%semergency-calls,${EXTENSION},1)\n"
                   " same => n,Gosub(sub-lockphone-check,s,1)\n"
                   " same => n(local-dialing),Gosub(sub-local-dialing,s,1)\n"
                   ' same => n,GotoIf($["${CALL_ORIGIN}"="RESTRICTED_IVR_CALL"]?end-call)\n'
                   " same => n,Set(OUTBOUND_PROFILE=${DB(${TENANT}/extensions/${CALL_SOURCE}/outbound_profile)})\n"
                   ' same => n,GotoIf($[$["${OUTBOUND_PROFILE}"="disabled"]|$["X${OUTBOUND_PROFILE}X"="XX"]]?post-dialing)\n'
                   " same => n,GotoIf($[${DIALPLAN_EXISTS(${OUTBOUND_PROFILE},${EXTENSION},1)}=1]?${OUTBOUND_PROFILE},${EXTENSION},1)\n"
                   " same => n(post-dialing),Goto(%s-post,${EXTENSION},1)\n"
                   " same => n(end-call),Hangup()\n\n"
                   % (ctx, h, park, h, cid, ctx, ars, p, p, p, ctx))
        out.append("[%s-custom]\nexten => fake-ext,1,NoOp(Fake extension for generate this context from VitalPBX)\n\n" % ctx)
        out.append("[%s-post]\n"
                   "include => %s\n"
                   "include => %sextensions\n"
                   "include => %sapplications\n"
                   "include => %s-custom\n"
                   "include => %s\n"
                   "include => not-allowed-features\n"
                   "include => app-termination\n\n"
                   "exten => i,1,NoOp(Invalid dial on post section)\n"
                   " same => n,ForkCDR(e)\n"
                   ' same => n,ExecIf($[$["${FROM_QUEUE_CALLBACK}"="yes"]|$["${SRC_APP}"="IVR"]]?Hangup():)\n'
                   " same => n,Goto(invalid-dest-cos,s,1)\n\n"
                   "exten => h,1,NoOp(Hanging Up the Call (Post))\n"
                   " same => n,Hangup()\n\n" % (ctx, cat, p, p, ctx, ars))
        out.append("[%s-trunk]\n"
                   "exten => _[-+*#0-9a-zA-Z].,1,NoOp(Class of Services Trunk: %s)\n"
                   " same => n,Gosub(sub-check-blacklist,s,1(%s,${CALLERID(num)}))\n"
                   " same => n,Gosub(sub-setup-call-type,s,1(incoming))\n"
                   " same => n,Gosub(sub-set-call-vars,s-incoming,1(${CALLERID(num)},${EXTEN},%s))\n"
                   " same => n,Goto(%s,${EXTEN},1)\n"
                   " same => n,Hangup()\n\n" % (ctx, c["description"], h, h, ctx))
    return "".join(out)


def r_set_global_tenant_vars(m) -> str:
    p, h, s = m["prefix"], m["hash"], m["slug"]
    default_cos = next((c for c in m["cos"] if c.get("default") == "yes"), m["cos"][0] if m["cos"] else None)
    dcos = "%scos-%s" % (p, default_cos["cos"]) if default_cos else "%scos-all" % p
    return ("[%sset-global-tenant-vars]\n"
            "exten => s,1,NoOp(Setting Global Vars for %s Tenant)\n"
            " same => n,Set(__TENANT_PATH=%s)\n"
            " same => n,Set(__TENANT_PREFIX=%s)\n"
            " same => n,Set(__QUEUE_AGENTS_CONTEXT=%squeue-call-to-agents)\n"
            " same => n,Set(__FOLLOWME_CONTEXT=%sext-followme)\n"
            " same => n,Set(__HINTS_CONTEXT=%sextension-hints)\n"
            " same => n,Set(__DEFAULT_COS=%s)\n"
            " same => n,Return()\n\n" % (p, s, h, p, p, p, p, dcos))


def r_all_features_category(m) -> str:
    return "[%sall-features-category]\n%s\n\n" % (m["prefix"], FEATURE_CATEGORY_ALL)


def r_ring_group_dial(m) -> str:
    p, h, s = m["prefix"], m["hash"], m["slug"]
    return ("[%sring-group-dial]\n"
            "exten => _[-+*#0-9].,1,NoOp(More than on digit pattern)\n"
            " same => n,Gosub(s,1(${EXTEN}))\n\n"
            "exten => _[-+*#0-9],1,NoOp(One Digit pattern)\n"
            " same => n,Gosub(s,1(${EXTEN}))\n\n"
            "exten => s,1,NoOp(Dialing Ring Group Member: ${ARG1})\n"
            " same => n,Set(EXTENSION=${ARG1})\n"
            " same => n,Set(TENANT=%s)\n"
            " same => n,Set(COS=${DB(${TENANT}/extensions/${EXTENSION}/context)})\n"
            ' same => n,GotoIf($["X${COS}X"="XX"]?no-cos)\n'
            " same => n,Set(__DISABLE_CF_AA=TRUE)\n"
            " same => n,Set(__SKIP_CONTACT_SERVICES=TRUE)\n"
            " same => n,Set(__NO_POST_SERVICES=TRUE)\n"
            " same => n,Set(__SKIP_PLAYBACK=TRUE)\n"
            " same => n,Set(__CALL_ORIGIN=ring-group)\n"
            " same => n,Gosub(${COS},${EXTENSION},1)\n"
            " same => n,Goto(end-r-dial)\n"
            " same => n(no-cos),NoOp(No COS defined for tenant %s! Avoiding infinite loop!)\n"
            " same => n(end-r-dial),Hangup()\n\n" % (p, h, s))


def r_ext_ringgroups(m) -> str:
    p = m["prefix"]
    out = ["[%sext-ringgroups]\n" % p]
    for rg in m["ring_groups"]:
        out.append(render_ring_group(m, rg))
    out.append("exten => i,1,Goto(invalid-dest,s,1)\n\n")
    return "".join(out)


def r_queue_call_to_agents(m) -> str:
    p, h = m["prefix"], m["hash"]
    return ("[%squeue-call-to-agents]\n"
            "exten => _[-+*#0-9].,1,NoOp(More than on digit pattern)\n"
            " same => n,Gosub(s,1(${EXTEN}))\n\n"
            "exten => _[-+*#0-9],1,NoOp(One Digit pattern)\n"
            " same => n,Gosub(s,1(${EXTEN}))\n\n"
            "exten => s,1,Set(EXTENSION=${ARG1})\n"
            " same => n,Set(TENANT=%s)\n"
            " same => n,Set(__SRC_APP=Q${QUEUE_NUMBER})\n"
            " same => n,Set(COS=${DB(${TENANT}/extensions/${EXTENSION}/context)})\n"
            " same => n,NoOp(Dialing Agent ${EXTENSION} from ${CALLERID(num)})\n"
            " same => n,Set(__DISABLE_CF_AA=TRUE)\n"
            ' same => n,GotoIf($["${LEN(${COS})}"="0"]?end)\n'
            " same => n,Gosub(${COS},${EXTENSION},1)\n"
            " same => n(end),Hangup()\n\n" % (p, h))


def r_ext_queues(m) -> str:
    p = m["prefix"]
    out = ["[%sext-queues]\n" % p]
    for qu in m["queues"]:
        out.append(render_queue(m, qu))
    out.append("exten => h,1,NoOp(Ending Queue Call)\n same => n,Hangup()\n\n")
    return "".join(out)


def r_ars(m) -> str:
    p = m["prefix"]
    out = []
    profiles = [x for x in (m["settings"].get("outbound_profiles") or "").split(",") if x.strip()]
    for c in m["cos"]:
        name = c["cos"]
        # per-COS ARS: the class may pin its own ars_id; else the tenant's outbound profiles
        if c.get("ars_id"):
            incl = ["ARS-%s" % c["ars_id"]]
        else:
            incl = ["ARS-%s" % x.strip() for x in profiles]
        if not incl and not profiles:
            continue
        out.append("[%sARS-%s]\n%s\n\n" % (p, name, "".join("include => %s\n" % i for i in incl)))
    for a in m["ars_own"]:
        out.append("[ARS-%s]\n"
                   'exten => i,1,ExecIf($["${FROM_QUEUE_CALLBACK}"="yes"]?Hangup():)\n'
                   " same => n,Goto(invalid-dest,s,1)\n\n" % a["ars_id"])
    return "".join(out)


def r_default_trunk(m) -> str:
    p, h = m["prefix"], m["hash"]
    return ("[%sdefault-trunk]\n"
            "exten => _[+*#0-9A-Za-z].,1,Gosub(%sset-global-tenant-vars,s,1)\n"
            " same => n,Gosub(sub-check-blacklist,s,1(%s,${CALLERID(num)}))\n"
            " same => n,Gosub(sub-stir-shaken-verify,s,1(%s,${CALLERID(num)}))\n"
            " same => n,Gosub(sub-setup-call-type,s,1(incoming))\n"
            " same => n,Gosub(dynamic-routing-in,s,1(${CALLERID(num)}))\n"
            ' same => n,ExecIf($["${LEN(${DID_NUMBER})}"="0"]?Set(__DID_NUMBER=${EXTEN}):)\n'
            " same => n,Goto(%sincoming-calls,${EXTEN},1)\n\n" % (p, p, h, h, p))


def r_incoming_calls(m) -> str:
    p, h = m["prefix"], m["hash"]
    out = ["[%sincoming-calls]\n" % p]
    routes = sorted(m["inbound"], key=lambda r: r["inbound_route_id"])  # plain id order, verified T104 + T2
    for r in routes:
        did = r["did"]
        if did in (None, ""):
            exten = "_[+*#0-9A-Za-z]."
        else:
            exten = "_%s" % did
            if r.get("cid_number"):
                exten += "/_%s" % r["cid_number"]
        lang = r.get("language") or "en"
        lines = ["exten => %s,1,NoOp(INBOUND_ROUTE: %s)" % (exten, r["description"]),
                 " same => n,Set(CHANNEL(language)=%s)" % lang,
                 " same => n,Set(__INBOUND_LANGUAGE=%s)" % lang]
        if r.get("music_group_id"):
            lines.append(" same => n,Gosub(sub-set-moh,s,1(%s,YES))" % moh_name(m, r["music_group_id"]))
        lines.append(" same => n,Gosub(sub-set-call-vars,s-incoming,1(${CALLERID(num)},${EXTEN},%s))" % h)
        if r.get("enablerecording") == "yes":
            lines.append(" same => n,Set(RECORD_UNBRIDGE_CHANNELS=yes)")
            lines.append(" same => n,Gosub(sub-setup-callrec-name,s,1)")
            lines.append(" same => n,Gosub(sub-call-recording,s,1(${TENANT},${CALL_SOURCE},${CALL_DESTINATION},yes))")
        lines.append(" same => n,Set(ICALL=yes)")
        lines.append(" same => n,%s" % goto(m, r["destination_id"]))
        lines.append(" same => n,Hangup()")
        out.append("\n".join(lines) + "\n\n")
    out.append("exten => fax,1,NoOp(Fax Detected)\n"
               " same => n,Set(FAXOPT(faxdetect)=no)\n"
               " same => n,Goto(${FAX_DEST_CONT},${FAX_DEST_EXT},${FAX_DEST_PRIO})\n\n"
               "exten => i,1,NoCDR()\n"
               " same => n,Goto(invalid-dest,s,1)\n\n"
               "exten => pm-failed,1,NoCDR()\n"
               " same => n,Answer()\n"
               " same => n,Playback(sorry&vm-goodbye,skip)\n"
               " same => n,Hangup()\n\n")
    return "".join(out)


def r_app_disa(m) -> str:
    p = m["prefix"]
    out = ["[%sapp-disa]\n" % p]
    for d in q(m["conn"], "select * from ombu_disa where tenant_id=%s order by disa_id", (m["t"],)):
        cos = q1(m["conn"], "select cos from ombu_classes_of_service where class_of_service_id=%s", (d["class_of_service_id"],))
        if d.get("cid_name") or d.get("cid_number"):
            cid = '"%s" <%s>' % (d["cid_name"], d["cid_number"])
        else:
            cid = '"${CALLERID(name)}" <${CALLERID(number)}>'
        lines = ["exten => DISA-%s,1,NoOp(DISA: %s)" % (d["disa_id"], d["description"]),
                 " same => n,Answer()"]
        if d.get("password"):
            lines.append(" same => n,Gosub(authenticate,s,1(%s))" % d["password"])
        lines += [" same => n,Playback(vpbx/disa-prompt)",
                  " same => n,Set(TIMEOUT(digit)=%s)" % (d.get("digit_timeout") or 5),
                  " same => n,Set(TIMEOUT(response)=%s)" % (d.get("resp_timeout") or 10),
                  ' same => n,ExecIf($["${CALL_TYPE}"="2"]?Set(__EXT_CID_CONSTRUCTED=yes):)',
                  " same => n,DISA(no-password,%scos-%s,%s)" % (p, cos["cos"] if cos else "all", cid),
                  " same => n,Hangup()"]
        out.append("\n".join(lines) + "\n\n")
    out.append("exten => i,1,NoCDR()\n"
               " same => n,Goto(invalid-dest,s,1)\n\n"
               "exten => t,1,NoCDR()\n"
               " same => n,Goto(timeout-reached,s,1)\n\n")
    return "".join(out)


def r_ivr_only_extensions(m) -> str:
    p = m["prefix"]
    default_cos = next((c for c in m["cos"] if c.get("default") == "yes"), m["cos"][0] if m["cos"] else None)
    dcos = "%scos-%s" % (p, default_cos["cos"]) if default_cos else "%scos-all" % p
    return ("[%sivr-only-extensions]\n"
            "exten => _[*#+0-9].,1,Set(__CALL_ORIGIN=RESTRICTED_IVR_CALL)\n"
            " same => n,Goto(%s,${EXTEN},1)\n"
            " same => n,Hangup()\n\n"
            "exten => h,1,NoOp(Ending DIRECT DIAL ON IVR)\n"
            " same => n,Hangup()\n\n" % (p, dcos))


def r_emergency(m) -> str:
    p = m["prefix"]
    if not m["emergency_cats"]:
        return ""
    out = ["[%semergency-calls]\n" % p]
    for c in m["emergency_cats"]:
        emails = c.get("email_addresses") or ""
        trunks = c["trunks"]
        for n in c["numbers"]:
            lines = ["exten => _%s,1,NoOp(Emergency Call to: %s)" % (n["number"], n["description"]),
                     ' same => n,Set(EMERGENCY_CALLER=${IF($["${LEN(${CALL_SOURCE})}"="0"]?${DEV_USER}:${CALL_SOURCE})})',
                     " same => n,Gosub(sub-setup-call-type,s,1(outgoing))",
                     " same => n,Gosub(sub-construct-cid,s-external,1(emergency))",
                     ' same => n,System(${SCRIPTS_PATH}/vitalpbx "NotifyEmergencyCall" "${TENANT}" "${EMERGENCY_CALLER}" "${EXTEN}" "${DISPATCHABLE_LOCATION}" "%s" > /dev/null 2>&1 &)' % emails,
                     " same => n,Set(__IS_EMERGENCY_CALL=yes)"]
            for tr in trunks:
                lines.append(" same => n,Gosub(trk-%s,${EXTEN},1(from-trk-grp))" % tr["trunk_id"])
                lines.append(" same => n,NoOp(Hangup Cause:${HANGUPCAUSE})")
            lines += [" same => n(finish),NoCDR()",
                      " same => n,Gosub(sub-hangup-cause,s,1(${HANGUPCAUSE}))",
                      " same => n,Hangup()"]
            out.append("\n".join(lines) + "\n\n")
    return "".join(out)


def r_app_ai_assistants(m) -> str:
    return ("[%sapp-ai-assistants]\n"
            "exten => h,1,NoOp(HangUp Virtual Assistant call)\n"
            ' same => n,ExecIf($["X${AUDIO_RESPONSE}X"!="XX"]?System(rm -f ${AUDIO_RESPONSE}.wav):)\n'
            ' same => n,ExecIf($["X${CALLER_RECORDING}X"!="XX"]?System(rm -f ${CALLER_RECORDING}):)\n'
            " same => n,Hangup()\n\n\n" % m["prefix"])


# stretch renderers (ring groups, queues, IVR, TG, TC, announcements, paging) live in mirror_features.py
from mirror_features import (render_ring_group, render_queue, r_app_ivr, r_ivrs, r_time_groups,  # noqa: E402,F811
                             r_app_announcement, r_app_time_condition, r_app_paging, r_queue_extras)


def render_dialplan(m) -> str:
    parts = [
        r_ext_followme(m),
        r_fw_confirm(m),
        r_extvm_operator(m),
        r_extvm_greetings(m),
        r_custom_apps(m),
        r_custom_dests(m),
        r_parking(m),
        r_app_paging(m),
        r_applications(m),
        r_extensions_include(m),
        r_hot_desking(m),
        r_cos(m),
        r_set_global_tenant_vars(m),
        r_all_features_category(m),
        r_ring_group_dial(m),
        r_ext_ringgroups(m),
        r_queue_call_to_agents(m),
        r_ext_queues(m),
        r_queue_extras(m),
        r_ars(m),
        r_default_trunk(m),
        r_incoming_calls(m),
        r_app_disa(m),
        r_app_ivr(m),
        r_ivrs(m),
        r_ivr_only_extensions(m),
        r_time_groups(m),
        r_app_announcement(m),
        r_app_time_condition(m),
        r_emergency(m),
        r_app_ai_assistants(m),
    ]
    return "".join(parts)


# --------------------------------------------------------------------------- #
# Renderers — hints, pjsip, voicemail, parking, moh, queues
# --------------------------------------------------------------------------- #

def render_hints(m) -> str:
    p, t = m["prefix"], m["t"]
    from mirror_features import hint_lines_for_extension
    out = ["[%sextension-hints]\n" % p]
    for e in m["extensions"]:
        n = e["extension"]
        devs = []
        for d in e["devices"]:
            if d["technology"] == "pjsip":
                devs.append("pjsip/%s%s" % (p, d["user"]))
            elif d["technology"] == "virtual":
                devs.append("Custom:VirtualDev%s" % d["device_id"])
            elif d["technology"] == "sip":
                devs.append("SIP/%s%s" % (p, d["user"]))
        devs.append("Custom:%sDND_%s" % (p, n))
        out.append("exten => %s,hint,%s\n\n" % (n, "&".join(devs)))
        out.append(hint_lines_for_extension(m, e))
    out.append("exten => unavailable,hint,%sunavailable\n\n" % p)
    out.append("exten => QAGENT,hint,Custom:%sQAGENT\n\n" % p)
    from mirror_features import hint_queue_login_pause, hint_time_conditions
    out.append(hint_queue_login_pause(m))          # QAL_/QAP_ per queue member (T2, T8) — before the park hints
    for lot in m["parking"]:
        name = "parking-%d" % t if lot.get("defpark") == "yes" else "parking-%d-%s" % (t, lot["extension"])
        ext, npos = int(lot["extension"]), int(lot["parkpos"])
        for slot in range(ext + 1, ext + npos + 1):
            out.append("exten => %s,hint,park:%s@%s-parkedcalls\n\n" % (slot, slot, name))
    out.append(hint_time_conditions(m))            # TC<n> hints come LAST (T2, T8, T9, T11, T18)
    return "".join(out) + "\n"


def pjsip_device_blocks(m, e, d) -> str:
    """The endpoint/auth/aor triple for ONE pjsip device, exactly as VitalPBX
    renders it. Factored out of render_pjsip_extensions (2026-08-22) so the
    surgical extension EDIT (mirror_writes.edit_extension) and the full render
    share ONE implementation — two copies would drift, and a drifted pjsip
    block is a phone that silently cannot register."""
    p, t = m["prefix"], m["t"]
    default_park = next((l for l in m["parking"] if l.get("defpark") == "yes"), None)
    pj = d["pjsip"] or {}
    prof = "p%s" % d["profile_id"]
    name = "%s%s" % (p, d["user"])
    dtmf = {"rfc2833": "auto"}.get(pj.get("dtmfmode"), pj.get("dtmfmode") or "rfc4733")
    lines = ["[%s](%s)" % (name, prof),
             "type=endpoint",
             "auth=auth%s" % name,
             "identify_by=username,auth_username",
             "outbound_auth=auth%s" % name,
             "aors=%s" % name,
             "deny=%s" % (pj.get("deny") or "0.0.0.0/0"),
             "contact_deny=%s" % (pj.get("deny") or "0.0.0.0/0"),
             "permit=%s" % (pj.get("permit") or "0.0.0.0/0"),
             "contact_permit=%s" % (pj.get("permit") or "0.0.0.0/0"),
             "dtmf_mode=%s" % dtmf,
             "message_context=messages",
             "set_var=DEVICENAME=%s" % name]
    if default_park:
        lines.append("set_var=CHANNEL(parkinglot)=parking-%d" % t)
    lines += ["subscribe_context=%sextension-hints" % p,
              "language=%s" % (e.get("language") or "en"),
              "moh_suggest=%s" % moh_name(m, e.get("music_group_id")),
              "context=%s%s" % (p, cos_context(e)),
              "mailboxes=%s" % (e.get("mailbox") or ""),
              "device_state_busy_at=%s" % (e.get("call_limit") or 0),
              "callerid=%s" % (e.get("internal_cid") or "")]
    for pg in e["pickup_groups"]:
        lines.append("named_call_group=%s" % pg["pickup_group_id"])
        lines.append("named_pickup_group=%s" % pg["pickup_group_id"])
    if pj.get("codecs"):
        lines.append("allow=!all,%s" % pj["codecs"])
    return ("\n".join(lines) + "\n\n"
            + "[auth%s]\ntype=auth\nauth_type=userpass\nusername=%s\npassword=%s\n\n" % (name, name, d["secret"])
            + "[%s](%s-aor)\ntype=aor\nmax_contacts=%s\n\n" % (name, prof, pj.get("max_contacts") if pj.get("max_contacts") is not None else 1))


def render_pjsip_extensions(m) -> str:
    out = []
    # VitalPBX writes the endpoint blocks in DEVICE id order across the whole tenant (T11: 102, 105_1, 102_1),
    # not grouped per extension.
    devs = sorted(((d, e) for e in m["extensions"] for d in e["devices"] if d["technology"] == "pjsip"),
                  key=lambda de: de[0]["device_id"])
    for d, e in devs:
        out.append(pjsip_device_blocks(m, e, d))
    return "".join(out) + "\n"


def voicemail_line(m, e) -> Optional[str]:
    """One extension's mailbox line (no context header), or None when voicemail
    is off. Factored out of render_voicemail (2026-08-22) for the same reason as
    pjsip_device_blocks: the surgical edit and the full render must agree byte
    for byte."""
    vm = e["vm"]
    if not vm or vm.get("enabled") != "yes":
        return None
    opts = "attach=%s|saycid=%s|sayduration=%s|envelope=%s|delete=%s|hidefromdir=%s|operator=%s" % (
        yn(vm["attach"]), yn(vm["saycid"]), yn(vm["sayduration"]), yn(vm["envelope"]),
        yn(vm["delete"]), yn(vm["hidefromdir"]), "yes" if vm.get("operator_destination_id") else "no")
    if vm.get("voicemail_timezone_id"):
        tz = q1(m["conn"], "select * from ombu_voicemail_timezones where voicemail_timezone_id=%s", (vm["voicemail_timezone_id"],))
        if tz:
            opts += "|tz=%s" % tz.get("name")
    opts += "|" + VM_EMAILBODY % dict(hash=m["hash"], ext=e["extension"])
    return "%s => %s,%s,%s,,%s\n" % (e["extension"], vm["password"], e["name"], e.get("email") or "", opts)


def render_voicemail(m) -> str:
    boxes = []
    for e in m["extensions"]:
        line = voicemail_line(m, e)
        if line is None:
            continue
        boxes.append((e["vm"]["context"], line))
    if not boxes:
        return ""
    ctx = boxes[0][0]
    return "[%s]\n%s" % (ctx, "".join(b[1] for b in boxes))


def render_res_parking(m) -> str:
    t = m["t"]
    out = []
    for lot in m["parking"]:
        name = "parking-%d" % t if lot.get("defpark") == "yes" else "parking-%d-%s" % (t, lot["extension"])
        ext, npos = int(lot["extension"]), int(lot["parkpos"])
        out.append("[%s]\nparkext=>%s\ncontext=>%s-parkedcalls\ncomebackcontext=%s-callback\ncourtesytone=beep\n"
                   "parkpos=>%s-%s\nparkedmusicclass=%s\nparkingtime=>%s\ncomebackdialtime=%s\nparkedplay=%s\n"
                   "parkedcalltransfers=%s\nparkedcallreparking=%s\nparkedcallhangup=%s\nfindslot=>%s\n"
                   "comebacktoorigin=no\nparkext_exclusive=yes\n\n" % (
                       name, ext, name, name, ext + 1, ext + npos,
                       "ringback" if not lot.get("music_group_id") else moh_name(m, lot["music_group_id"]),
                       lot["parkingtime"], lot["comebackdialtime"], lot["parkedplay"],
                       lot["parkedcalltransfers"], lot["parkedcallreparking"], lot["parkedcallhangup"], lot["findslot"]))
    return "".join(out)


def render_musiconhold(m) -> str:
    h = m["hash"]
    out = []
    for g in sorted(m["tenant_music_groups"], key=lambda g: g["music_group_id"]):
        gid = g["music_group_id"]
        srt = {"linear": "alpha", "shuffle": "random"}.get(g.get("order"), "alpha")
        out.append("[moh%d]\nmode=files\ndirectory=/var/lib/vitalpbx/static/%s/moh/moh%d\nsort=%s\n\n" % (gid, h, gid, srt))
    return "\n" + "".join(out) if out else "\n"


def render_queues_conf(m) -> str:
    try:
        from mirror_features import render_queues_conf as f
        return f(m)
    except Exception:
        return "\n"


def render_tenant(m, date: Optional[str] = None) -> Dict[str, str]:
    t = m["t"]
    files: Dict[str, str] = {}
    bodies = {
        "extensions__50-{t}-dialplan.conf": render_dialplan,
        "extensions__25-{t}-hints.conf": render_hints,
        "pjsip__50-{t}-extensions.conf": render_pjsip_extensions,
        "voicemail__50-{t}-main.conf": render_voicemail,
        "queues__50-{t}-main.conf": render_queues_conf,
        "musiconhold__50-{t}-main.conf": render_musiconhold,
        "res_parking__50-{t}-extensions.conf": render_res_parking,
    }
    for pattern, static in FILE_KINDS:
        name = pattern.format(t=t)
        body = bodies[pattern](m) if pattern in bodies else static
        files[name] = banner(name, date) + body
    return files


# --------------------------------------------------------------------------- #
# AstDB
# --------------------------------------------------------------------------- #

def render_astdb(m) -> Dict[str, str]:
    h, p, t = m["hash"], m["prefix"], m["t"]
    kv: Dict[str, str] = {}
    fam = "/%s" % h
    s = m["settings"]
    kv[fam + "/allow_recordings"] = yn(s.get("allow_recordings", "yes"))
    kv[fam + "/allowed_sim_calls"] = str(s.get("calls_limit") or "0")
    for c in m["cos"]:
        cid = c["class_of_service_id"]
        kv[fam + "/classes_of_service/%s/allowed_calls_by" % cid] = nz(c.get("allowed_calls_by"))
        kv[fam + "/classes_of_service/%s/private" % cid] = yn(c.get("private"))
        kv[fam + "/classes_of_service/%scos-%s" % (p, c["cos"])] = str(cid)
    cid_name, cid_number = s.get("cid_name") or "", s.get("cid_number") or ""
    kv[fam + "/default_external_cid"] = ('"%s" <%s>' % (cid_name, cid_number)) if (cid_name or cid_number) else ""
    for loc in m["emergency_locations"]:
        kv[fam + "/dispatchable_locations/%s/cid" % loc["id"]] = '"%s" <%s>' % (loc["cid_name"], loc["cid_number"])
    for e in m["extensions"]:
        n = e["extension"]
        divs = {d["name"]: d for d in e["diversions"]}
        for name in ("BOSS", "CC", "CFB", "CFI", "CFN", "CFU", "DND", "FWM"):
            d = divs.get(name, {})
            kv[fam + "/diversions/%s/%s/destination" % (n, name)] = nz(d.get("destination_id"))
            kv[fam + "/diversions/%s/%s/enable" % (n, name)] = yn(d.get("enable", "no"))
            kv[fam + "/diversions/%s/%s/time_group" % (n, name)] = nz(d.get("time_group_id"))
        d = divs.get("PEA", {})
        kv[fam + "/diversions/%s/PEA/enable" % n] = yn(d.get("enable", "no"))
        kv[fam + "/diversions/%s/PEA/time_group" % n] = nz(d.get("time_group_id"))
        kv[fam + "/diversions/%s/has_enable_diversions" % n] = "yes" if any(x.get("enable") == "yes" for x in e["diversions"]) else "no"
    kv[fam + "/dynamic_routing/settings/delete_used_records"] = yn(m["dyn"]["delete_used_records"] or "yes")
    kv[fam + "/dynamic_routing/settings/digits_match"] = str(m["dyn"]["digits_match"] or "0")
    kv[fam + "/dynamic_routing/settings/expiration_time"] = str(m["dyn"]["expiration_time"] or "8")
    kv[fam + "/dynamic_routing/settings/only_missed_calls"] = yn(m["dyn"]["only_missed_calls"] or "yes")
    for e in m["extensions"]:
        n = e["extension"]
        vm = e["vm"] or {}
        fm = e["followme"] or {}
        ek = fam + "/extensions/%s/" % n
        kv[ek + "absent_secretary"] = yn(e.get("absent_secretary"))
        kv[ek + "ask_vm_password"] = yn(vm.get("ask_password", "yes"))
        kv[ek + "call_waiting"] = yn(e.get("call_waiting"))
        kv[ek + "callgroup"] = ",".join(str(pg["pickup_group_id"]) for pg in e["pickup_groups"])
        kv[ek + "context"] = "%s%s" % (p, cos_context(e))
        kv[ek + "dial"] = ext_dial_string(m, e)
        kv[ek + "dial_options"] = dial_options(e["dial_profile"])
        kv[ek + "dictate/email"] = nz(e.get("email")) if e.get("dictate_auto_send") == "yes" else ""
        kv[ek + "dictate/enabled"] = yn(e.get("dictate_enable"))
        kv[ek + "dictate/format"] = e.get("dictate_format") or "wav"
        kv[ek + "dynamic_routing"] = yn(e.get("dynamic_routing"))
        kv[ek + "followme/ringtime"] = str(fm.get("initial_ringtime") if fm.get("initial_ringtime") is not None else 0)
        kv[ek + "hints"] = yn(e.get("generate_hints"))
        kv[ek + "hotdesking"] = yn(e.get("hot_desking"))
        kv[ek + "is_secretary"] = "yes" if e.get("_is_secretary") else "no"
        kv[ek + "language"] = e.get("language") or "en"
        kv[ek + "lock"] = yn(e.get("lock"))
        kv[ek + "moh"] = moh_name(m, e.get("music_group_id"))
        kv[ek + "name"] = e.get("name") or ""
        kv[ek + "notify_missed_calls"] = "yes" if e.get("notify_missed_calls") else "no"
        kv[ek + "password"] = nz(e.get("features_password"))
        kv[ek + "pickupgroup"] = ",".join(str(pg["pickup_group_id"]) for pg in e["pickup_groups"])
        kv[ek + "pinless"] = yn(e.get("pinless"))
        kv[ek + "ringtimer"] = str(e.get("ringtime") or 30)
        kv[ek + "secretary"] = nz(e.get("secretary"))
        kv[ek + "skip_vm_instructions"] = yn(vm.get("skip_instructions", "no"))
        kv[ek + "spyb"] = yn(e.get("nospy"))
        kv[ek + "virtual_devices"] = "yes" if any(d["technology"] == "virtual" for d in e["devices"]) else "no"
        kv[ek + "vm_password"] = nz(vm.get("password"))
        kv[ek + "vmenabled"] = yn(vm.get("enabled", "no")) if vm else "no"
        kv[ek + "voicemail"] = nz(e.get("mailbox"))
    kv[fam + "/force_default_external_cid"] = yn(s.get("force_default_external_cid", "no"))
    kv[fam + "/main"] = yn(m["tenant"].get("default"))
    kv[fam + "/name"] = m["slug"]
    kv[fam + "/prefix"] = p
    # secretary back-reference: an extension named as somebody's secretary is is_secretary=yes
    secretaries = {str(e.get("secretary")) for e in m["extensions"] if e.get("secretary")}
    for e in m["extensions"]:
        if str(e["extension"]) in secretaries:
            kv[fam + "/extensions/%s/is_secretary" % e["extension"]] = "yes"
    # CustomDevstate
    for e in m["extensions"]:
        n = e["extension"]
        for name in ("BOSS", "CC", "CFB", "CFI", "CFN", "CFU", "DND", "FWM", "PEA"):
            kv["/CustomDevstate/%s%s_%s" % (p, name, n)] = "UNAVAILABLE" if name == "DND" else "NOT_INUSE"
    kv["/CustomDevstate/%sQAGENT" % p] = "NOT_INUSE"
    kv["/CustomDevstate/%sunavailable" % p] = "BUSY"
    from mirror_features import astdb_extras
    kv.update(astdb_extras(m))
    return kv


def format_astdb_show(kv: Dict[str, str]) -> str:
    """Same layout as `asterisk -rx 'database show'` (%-50s: %-25s)."""
    return "".join("%-50s: %-25s\n" % (k, v) for k, v in sorted(kv.items()))


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("cmd", choices=["render", "render-astdb"])
    ap.add_argument("--tenant", type=int, required=True)
    ap.add_argument("--out", help="output dir for render")
    ap.add_argument("--host", default=os.environ.get("MIRROR_DB_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("MIRROR_DB_PORT", "3307")))
    ap.add_argument("--user", default=os.environ.get("MIRROR_DB_USER", "root"))
    ap.add_argument("--password", default=os.environ.get("MIRROR_DB_PASSWORD", "mirror"))
    ap.add_argument("--db", default=os.environ.get("MIRROR_DB_NAME", "ombutel"))
    a = ap.parse_args(argv)
    conn = connect(a.host, a.port, a.user, a.password, a.db)
    m = load_tenant(conn, a.tenant)
    if a.cmd == "render":
        if not a.out:
            ap.error("--out required")
        os.makedirs(a.out, exist_ok=True)
        files = render_tenant(m)
        for name, text in files.items():
            with open(os.path.join(a.out, name), "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
        print("wrote %d files to %s" % (len(files), a.out))
    else:
        sys.stdout.write(format_astdb_show(render_astdb(m)))


if __name__ == "__main__":
    main()
