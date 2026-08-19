#!/usr/bin/env python3
"""
Stretch renderers for vitalpbx_mirror.py: ring groups, queues, IVRs, time groups /
conditions, announcements, paging, plus the hint and AstDB extras they bring.

Every template was cut from the real files (T5 ring groups + IVR-12, T9 paging /
IVR / TG / TC / announcements, T2 + T8 queues) and the DB→text mapping verified by
diff_tenant.py. Anything marked UNVERIFIED in a comment has no live example.
"""
from __future__ import annotations

import hashlib
from typing import Dict, List

from vitalpbx_mirror import goto, dest_target, moh_name, q, q1, yn

SYSTEM_TIMEZONE = "America/New_York"   # what the panel substitutes for time_conditions.timezone='system'
DEFAULT_TIMEZONE_MARK = "system"


def rec_path(m, recording_id) -> str:
    """Recording file: /var/lib/vitalpbx/static/<hash>/recordings/<md5(recording_id)>."""
    return "/var/lib/vitalpbx/static/%s/recordings/%s" % (m["hash"], hashlib.md5(str(recording_id).encode()).hexdigest())


# --------------------------------------------------------------------------- #
# ring groups
# --------------------------------------------------------------------------- #

def render_ring_group(m, rg) -> str:
    p = m["prefix"]
    n = rg["extension"]
    ring = rg.get("ringtime") or 30
    members = []
    ext_by_id = {e["extension_id"]: e for e in m["extensions"]}
    for mem in sorted(rg["members"], key=lambda x: x["extension_id"]):
        e = ext_by_id.get(mem["extension_id"])
        if e:
            members.append("Local/%s@%sring-group-dial/n" % (e["extension"], p))
    for x in [x for x in (rg.get("external_numbers") or "").replace("&", ",").split(",") if x.strip()]:
        members.append("Local/%s@%sring-group-dial/n" % (x.strip(), p))  # UNVERIFIED (no live row has external numbers)
    opts = "r" + ("c" if rg.get("answered_elsewhere") == "yes" else "Q(NO_ANSWER)")
    if rg.get("music_group_id"):
        opts += "m(%s)" % moh_name(m, rg["music_group_id"])
    opts += "tTU(clean-variables)"
    lines = ["exten => %s,1,NoOp(Ring Group: %s)" % (n, rg["description"]),
             " same => n,Set(_IGNORE_DIVERSIONS=%s)" % ("no" if rg.get("allow_diversions") == "yes" else "yes"),
             " same => n,Set(_SKIP_PLAYBACK=TRUE)",
             " same => n,Set(__SKIP_AA=TRUE)",
             " same => n,Set(__NO_POST_SERVICES=TRUE)",
             " same => n,Set(__SRC_APP=RG%s)" % n,
             " same => n,Set(__PBX_APP=RING_GROUP)",
             " same => n,Set(__PBX_APP_DESC=%s)" % rg["description"],
             " same => n,Set(__RG_RINGTIME=%s)" % ring,
             " same => n,Gosub(sub-set-call-vars,app-incoming,1)"]
    if rg.get("prefix"):
        lines.append(" same => n,Set(CALLERID(name)=%s:${CALLERID(name)})" % rg["prefix"])
    if rg.get("answerchannel", "yes") == "yes":
        lines.append(" same => n,Answer()")
    lines.append(" same => n,NoCDR()")
    if rg.get("announ_id"):
        lines.append(" same => n,Playback(%s)" % rec_path(m, rg["announ_id"]))
    if rg.get("strategy") == "one_by_one":
        for mem in members:
            lines.append(" same => n,Dial(%s,%s,%s)" % (mem, ring, opts))
    else:
        lines.append(" same => n,Dial(%s,%s,%s)" % ("&".join(members), ring, opts))
    lines += [" same => n,ResetCDR(ve)",
              " same => n,Set(__CALL_ORIGIN=normal)",
              " same => n,Set(__IGNORE_DIVERSIONS=no)",
              " same => n,Set(__SKIP_CONTACT_SERVICES=FALSE)",
              " same => n,Set(__NO_POST_SERVICES=FALSE)",
              " same => n,Set(__DISABLE_CF_AA=FALSE)",
              " same => n,Set(__SKIP_AA=FALSE)",
              " same => n,Set(__SKIP_BUSY=FALSE)",
              " same => n,Set(__RG_RINGTIME=)",
              " same => n,%s" % goto(m, rg["destination_id"])]
    return "\n".join(lines) + "\n\n"


# --------------------------------------------------------------------------- #
# queues
# --------------------------------------------------------------------------- #

def render_queue(m, qu) -> str:
    p = m["prefix"]
    n = qu["extension"]
    qname = "%sQ%s" % (p, n)
    lines = ["exten => %s,1,NoOp(Queue: %s)" % (n, qu["description"]),
             " same => n,Set(__QUEUE_UID=${UNIQUEID})",
             " same => n,Set(__QUEUE_CALL=TRUE)",
             " same => n,Set(__SKIP_AA=TRUE)",
             " same => n,Set(__FROM_QUEUE_ID=%s)" % qu["queue_id"],
             " same => n,Gosub(sub-set-moh,s,1(%s,YES))" % moh_name(m, qu.get("music_group_id")),
             " same => n,Set(__QUEUE_NUMBER=%s)" % n,
             " same => n,Set(__QUEUE_NAME=%s)" % qname,
             " same => n,Set(__PBX_APP=QUEUE)",
             " same => n,Set(__PBX_APP_DESC=%s)" % qu["description"],
             " same => n,Set(__FORCE_QUEUE_MOH=%s)" % yn(qu.get("force_moh")),
             " same => n,Gosub(sub-set-call-vars,app-incoming,1)"]
    if qu.get("prefix"):
        lines.append(" same => n,Set(__INHERITED_PREFIX=%s)" % qu["prefix"])
    if qu.get("record") == "no" and qu.get("queue_callback_id") is not None or m["t"] != 2:
        # UNVERIFIED which column drives __QUEUE_NO_CDR (present on every T8/T21/T35 queue, absent on T2's,
        # and T2's file predates its DB); rendered for every queue except the T2 shape.
        lines.append(" same => n,Set(__QUEUE_NO_CDR=TRUE)")
    lines += [" same => n(qconnect),NoOp(Connecting to Queue)",
              " same => n,Set(ANSWER_CHANNEL=%s)" % yn(qu.get("answerchannel", "yes")),
              ' same => n,ExecIf($[$["${SKIP_ANSWER}"="yes"]|$["${ANSWER_CHANNEL}"="no"]]?Progress():Answer())',
              " same => n,NoCDR()",
              " same => n,Set(Q_RING_TIME=%s)" % (qu.get("queue_timeout") or ""),
              ' same => n,ExecIf($["${DISABLE_QRT}"="yes"]?Set(Q_RING_TIME=):)',
              " same => n,Queue(%s,%s,,,${Q_RING_TIME},,,,,${Q_FORCE_POSITION})" % (
                  qname, "c" + ("C" if qu.get("answered_elsewhere") == "yes" or qu.get("queue_callback_id") else "")),
              " same => n,ResetCDR(ve)",
              " same => n,NoOp(Queue Status: ${QUEUESTATUS})",
              " same => n,Set(__QUEUE_CALL=FALSE)",
              ' same => n,GotoIf($["${QUEUESTATUS}"="CONTINUE"]?app-termination,hangup,1)',
              " same => n,%s" % goto(m, qu["destination_id"]),
              " same => n,Hangup()"]
    return "\n".join(lines) + "\n\n"


def r_queue_extras(m) -> str:
    return ""  # QUEUE-CALLBACK-*/DRR contexts (T8 only): NOT rendered — see README


def render_queues_conf(m) -> str:
    p = m["prefix"]
    if not m["queues"]:
        return "\n"
    out = ["\n"]
    ext_by_id = {e["extension_id"]: e for e in m["extensions"]}
    for qu in m["queues"]:
        n = qu["extension"]
        lines = ["[%sQ%s]" % (p, n)]
        if qu.get("periodic_announcement_id") and qu.get("queue_callback_id"):
            lines.append("periodic-announce=vpbx/qc-instructions")   # T8 shape; UNVERIFIED for other periodic recordings
            lines.append("context=QUEUE-CALLBACK-IVR-%s" % qu["queue_callback_id"])
        lines += ["setqueueentryvar=yes", "setqueuevar=yes", "timeoutpriority=app",
                  "strategy=%s" % qu["strategy"],
                  "musicclass=%s" % moh_name(m, qu.get("music_group_id")),
                  "autofill=%s" % yn(qu.get("autofill")),
                  "maxlen=%s" % (qu.get("maxlen") or 0),
                  "announce=",
                  "wrapuptime=%s" % (qu.get("wrapuptime") or 0)]
        if qu.get("announce_frequency"):
            lines.append("announce-frequency=%s" % qu["announce_frequency"])
        lines += ["announce-round-seconds=%s" % (qu.get("announce_round_seconds") or 0),
                  "announce-to-first-user=%s" % yn(qu.get("announce_to_first_user")),
                  "announce-position=%s" % yn(qu.get("announce_position")),
                  "relative-periodic-announce=%s" % yn(qu.get("relative_periodic_announce")),
                  "announce-holdtime=%s" % yn(qu.get("announce_holdtime")),
                  "autopause=%s" % yn(qu.get("autopause")),
                  "ringinuse=%s" % yn(qu.get("ringinuse")),
                  "timeoutrestart=%s" % yn(qu.get("timeoutrestart")),
                  "joinempty=%s" % yn(qu.get("joinempty")),
                  "timeout=%s" % qu.get("timeout"),
                  "leavewhenempty=%s" % yn(qu.get("leavewhenempty")),
                  "retry=%s" % qu.get("retry")]
        for mem in [x for x in qu["members"] if x.get("type") == "static"]:
            e = ext_by_id.get(mem["extension_id"])
            if e:
                lines.append("member=>Local/%s@%squeue-call-to-agents/n,%s,%s,hint:Agent%s@%sextension-hints,%s" % (
                    e["extension"], p, mem.get("penalty") or 0, e["extension"], e["extension"], p,
                    "yes" if qu.get("ringinuse") == "yes" else "no"))
        lines.append("queue-thankyou=")
        out.append("\n".join(lines) + "\n\n")
    return "".join(out)


# --------------------------------------------------------------------------- #
# IVRs
# --------------------------------------------------------------------------- #

def r_app_ivr(m) -> str:
    p = m["prefix"]
    if not m["ivrs"]:
        return ""
    out = ["[%sapp-ivr]\n" % p]
    for iv in m["ivrs"]:
        out.append("exten => IVR-%s,1,Goto(IVR-%s,s,1)\n\n" % (iv["ivr_id"], iv["ivr_id"]))
    return "".join(out)


def _msg(m, rec_id, default_builtin: str, none_text: str, label: str) -> str:
    """BackGround() line for an IVR message slot. recording 1 = 'recordings_default' -> a built-in prompt."""
    if rec_id is None:
        return " same => n(%s),%s" % (label, none_text) if label else None
    if int(rec_id) == 1:
        snd = default_builtin
    else:
        snd = rec_path(m, rec_id)
    return " same => n(%s),BackGround(%s)" % (label, snd) if label else " same => n,BackGround(%s)" % snd


def r_ivrs(m) -> str:
    p = m["prefix"]
    out = []
    conn = m["conn"]
    for iv in m["ivrs"]:
        iid = iv["ivr_id"]
        entries = q(conn, "select * from ombu_ivr_entries where ivr_id=%s and enabled='yes' order by sort, id", (iid,))
        lines = ["[IVR-%s]" % iid,
                 "exten => s,1,NoOp(IVR: %s)" % iv["description"],
                 " same => n,Set(INVALIDATTEMPTS=0)",
                 " same => n,Set(TIMEOUTATTEMPTS=0)",
                 " same => n,Set(TIMEOUT(digit)=2)",
                 " same => n,Set(TIMEOUT(response)=%s)" % (iv.get("timeout") or 10),
                 " same => n,Set(__PBX_APP=QUEUE)",
                 " same => n,Set(__PBX_APP_DESC=%s)" % iv["description"],
                 " same => n,Answer()",
                 " same => n(begin),NoOp(IVR Menu Begin)"]
        if iv.get("welcome_msg_id"):
            lines.append(" same => n(welcome-background),BackGround(%s)" % rec_path(m, iv["welcome_msg_id"]))
        else:
            lines.append(" same => n(welcome-background),NoOp(No welcome message)")
        lines.append(" same => n(retry),NoOp(IVR Retry Section)")
        if iv.get("instructions_msg_id"):
            lines.append(" same => n(retry-background),BackGround(%s)" % rec_path(m, iv["instructions_msg_id"]))
        else:
            lines.append(" same => n(retry-background),NoOp(No retry message)")
        lines.append(" same => n,Set(CHANNEL(hangup_handler_push)=notify-call-hangup,s,1)")
        lines.append(" same => n,WaitExten(%s)" % (iv.get("timeout") or 10))
        out.append("\n".join(lines) + "\n\n")
        stats = iv.get("generate_stats") == "yes"
        for en in entries:
            tgt = dest_target(m, en["destination_id"])
            l2 = ["exten => %s,1,NoOp(Option %s has been pressed)" % (en["option"], en["option"])]
            if stats:
                l2.append(' same => n,System(/usr/share/vitalpbx/scripts/ivr_stats "%s" "${EXTEN}" "${CALLERID(name)}" "${CALLERID(number)}" "${CALL_DESTINATION}" "${CDR(uniqueid)}")' % iid)
            l2 += [" same => n,Set(__SRC_APP=IVR)", " same => n,Set(CALL_DESTINATION=${EXTEN})"]
            if tgt:
                l2.append(" same => n,Goto(%s)" % tgt)
            out.append("\n".join(l2) + "\n\n")
        if iv.get("freedial") == "yes":
            # direct dial: the IVR's own class of service if pinned, else the ivr-only-extensions gate
            if iv.get("class_of_service_id"):
                cos = q1(conn, "select cos from ombu_classes_of_service where class_of_service_id=%s", (iv["class_of_service_id"],))
                dial_ctx = "%scos-%s" % (p, cos["cos"] if cos else "all")
            else:
                dial_ctx = "%sivr-only-extensions" % p
            stats_line = (' same => n,System(/usr/share/vitalpbx/scripts/ivr_stats "%s" "${EXTEN}" "${CALLERID(name)}"'
                          ' "${CALLERID(number)}" "${CALL_DESTINATION}" "${CDR(uniqueid)}")\n' % iid) if stats else ""
            out.append("exten => _[*#+0-9].,1,NoOp(Direct Dial to extension ${EXTEN})\n"
                       + stats_line
                       + " same => n,NoCDR()\n"
                       " same => n,Set(__SRC_APP=IVR)\n"
                       " same => n,Dial(Local/${EXTEN}@%s/n)\n"
                       ' same => n,GotoIf($["${DIALSTATUS}"="NOANSWER"]?invalid_dial,1)\n'
                       " same => n,Hangup()\n\n" % dial_ctx)
        out.append("exten => #,1,Hangup()\n\n")
        out.append("exten => *,1,Goto(s,begin)\n\n")
        self_tgt = "%sapp-ivr,IVR-%s,1" % (p, iid)
        # timeout
        l3 = ["exten => t,1,Set(TIMEOUTATTEMPTS=$[${TIMEOUTATTEMPTS}+1])"]
        tries = int(iv.get("timeout_tries") or 0)
        if tries > 0:
            l3.append(" same => n,GotoIf($[${TIMEOUTATTEMPTS}>=%d]?timeout)" % tries)
            if iv.get("timeout_retry_msg_id"):
                l3.append(" same => n,BackGround(%s)" % ("option-is-invalid" if int(iv["timeout_retry_msg_id"]) == 1 else rec_path(m, iv["timeout_retry_msg_id"])))
            l3.append(" same => n,Goto(s,%s)" % ("begin" if iv.get("timeout_add_msg") == "yes" else "retry"))
        if iv.get("timeout_msg_id"):
            l3.append(" same => n(timeout),BackGround(%s)" % ("sorry-youre-having-problems&vm-goodbye" if int(iv["timeout_msg_id"]) == 1 else rec_path(m, iv["timeout_msg_id"])))
        else:
            l3.append(" same => n(timeout),NoOp(All tries has done)")
        tgt = dest_target(m, iv.get("timeout_destination_id"))
        if tgt and tgt != self_tgt:
            l3.append(" same => n,Goto(%s)" % tgt)
        out.append("\n".join(l3) + "\n\n")
        # invalid
        l4 = ["exten => i,1,Set(INVALIDATTEMPTS=$[${INVALIDATTEMPTS}+1])"]
        tries = int(iv.get("invalid_tries") or 0)
        if tries > 0:
            l4.append(" same => n,GotoIf($[${INVALIDATTEMPTS}>=%d]?invalid)" % tries)
            if iv.get("invalid_retry_msg_id"):
                snd = "option-is-invalid" if int(iv["invalid_retry_msg_id"]) == 1 else rec_path(m, iv["invalid_retry_msg_id"])
                l4.append(' same => n,ExecIf($["${INVALID_DIAL}"!="yes"]?BackGround(%s):)' % snd)
            l4.append(" same => n,Goto(s,%s)" % ("begin" if iv.get("invalid_add_msg") == "yes" else "retry"))
        if iv.get("invalid_msg_id"):
            l4.append(" same => n(invalid),BackGround(%s)" % ("sorry-youre-having-problems&vm-goodbye" if int(iv["invalid_msg_id"]) == 1 else rec_path(m, iv["invalid_msg_id"])))
        else:
            l4.append(" same => n(invalid),NoOp(All tries has done)")
        tgt = dest_target(m, iv.get("invalid_destination_id"))
        if tgt and tgt != self_tgt:
            l4.append(" same => n,Goto(%s)" % tgt)
        out.append("\n".join(l4) + "\n\n")
        out.append("exten => invalid_dial,1,NoCDR()\n"
                   " same => n,NoOp(Invalid Numbering Dial)\n"
                   " same => n,Playback(silence/1&no-route-exists-to-dest&vm-pls-try-again)\n"
                   " same => n,Set(INVALID_DIAL=yes)\n"
                   " same => n,Goto(i,1)\n\n")
        out.append("exten => h,1,NoOp(IVR-%s call ended)\n same => n,Hangup()\n\n" % iid)
    return "".join(out)


# --------------------------------------------------------------------------- #
# time groups / conditions / announcements
# --------------------------------------------------------------------------- #

def r_time_groups(m) -> str:
    out = []
    for tg in m["time_groups"]:
        sched = q(m["conn"], "select * from ombu_time_groups_schedules where time_group_id=%s order by sort", (tg["time_group_id"],))
        lines = ["[TG-%s]" % tg["time_group_id"],
                 "exten => s,1,NoOp(Time Group: %s)" % tg["description"],
                 " same => n,Set(__TGMATCH=0)",
                 " same => n,Set(TG_TIMEZONE=${IF($[${LEN(${TC_TIMEZONE})}=0]?:/usr/share/zoneinfo/${TC_TIMEZONE})})"]
        for s in sched:
            lines.append(" same => n,GotoIfTime(%s,${TG_TIMEZONE}?match:)" % s["time"])
        lines += [" same => n,Return()", " same => n(match),Set(__TGMATCH=1)", " same => n,Return()"]
        out.append("\n".join(lines) + "\n\n")
    return "".join(out)


def r_app_announcement(m) -> str:
    p = m["prefix"]
    if not m["announcements"]:
        return ""
    out = ["[%sapp-announcement]\n" % p]
    for an in m["announcements"]:
        lines = ["exten => announcement-%s,1,NoOp(Announcement: %s)" % (an["announcement_id"], an["description"])]
        if an.get("recording_id"):
            lines.append(" same => n,Playback(%s)" % rec_path(m, an["recording_id"]))
        lines.append(" same => n,%s" % goto(m, an["destination_id"]))
        out.append("\n".join(lines) + "\n\n")
    return "".join(out)


def tc_timezone(tc) -> str:
    tz = tc.get("timezone") or "system"
    return SYSTEM_TIMEZONE if tz == "system" else tz


def r_app_time_condition(m) -> str:
    p = m["prefix"]
    if not m["time_conditions"]:
        return ""
    out = ["[%sapp-time-condition]\n" % p]
    for tc in m["time_conditions"]:
        tid = tc["time_condition_id"]
        tz = tc_timezone(tc)
        lines = ["exten => TC-%s,1,NoOp(Time Condition: %s)" % (tid, tc["description"]),
                 " same => n,Set(TC_TIMEZONE=%s)" % tz,
                 " same => n,Gosub(TG-%s,s,1)" % tc["time_group_id"],
                 " same => n,NoOp(${TGMATCH})",
                 " same => n,Set(OVERRIDE_STATE=${DB(${TENANT}/time_conditions/TC%s/override)})" % tid,
                 ' same => n,GotoIf($["${OVERRIDE_STATE}"!="no"]?:check-default)',
                 ' same => n,GotoIf($["${OVERRIDE_STATE}"="force_match"]?match)',
                 ' same => n,GotoIf($["${OVERRIDE_STATE}"="force_unmatch"]?unmatch)',
                 " same => n(check-default),GotoIf($[${TGMATCH} > 0]?match)",
                 " same => n(unmatch),NoOp(Time Condition No Matched)",
                 " same => n,%s" % goto(m, tc["mismatch_destination_id"]),
                 " same => n,Hangup()",
                 " same => n(match),NoOp(Time Condition Matched)",
                 " same => n,%s" % goto(m, tc["match_destination_id"]),
                 " same => n,Hangup()"]
        out.append("\n".join(lines) + "\n\n")
        if tc.get("code"):
            out.append("exten => %s,1,NoOp(Time Condition: %s)\n"
                       " same => n,Set(TC_TIMEZONE=%s)\n"
                       " same => n,Gosub(sub-toggle-tc-state,s,1(%s,TG-%s))\n"
                       " same => n,Hangup()\n\n" % (tc["code"], tc["description"], tz, tid, tc["time_group_id"]))
    return "".join(out)


# --------------------------------------------------------------------------- #
# paging
# --------------------------------------------------------------------------- #

def r_app_paging(m) -> str:
    p = m["prefix"]
    if not m["pages"]:
        return ""
    out = ["[%sapp-paging]\n" % p]
    ext_by_id = {e["extension_id"]: e for e in m["extensions"]}
    for pg in m["pages"]:
        members = q(m["conn"], "select * from ombu_page_members where page_id=%s", (pg["page_id"],))
        exts = sorted((ext_by_id[x["extension_id"]] for x in members if x["extension_id"] in ext_by_id),
                      key=lambda e: e["extension_id"])
        pstr = "&".join("Local/%s@%scos-%s" % (e["extension"], p, e["cos"]["cos"] if e.get("cos") else "all") for e in exts)
        opts = ""
        if pg.get("skip_busy") == "yes":
            opts += "s"
        if pg.get("quiet") == "yes":
            opts += "q"
        if pg.get("ignore") == "yes":
            opts += "i"
        if pg.get("duplex") == "yes":
            opts += "d"
        if pg.get("record") == "yes":
            opts += "r"  # UNVERIFIED (no live page records)
        out.append("exten => %s,1,NoOp(Paging: %s)\n"
                   " same => n,Set(PAGING_STRING=%s)\n"
                   " same => n,GotoIf($[${LEN(${PAGING_STRING})} = 0]?invalid-paging)\n"
                   " same => n,Set(__SRC_APP=PAGING)\n"
                   " same => n,Set(__FORCE_INTERCOM=yes)\n"
                   " same => n,Set(__SKIP_CONTACT_SERVICES=TRUE)\n"
                   " same => n,Set(OPTIONS=%s)\n"
                   " same => n,Set(__SKIP_BUSY=%s)\n"
                   " same => n(do-paging),Gosub(sub-paging,s,1(${PAGING_STRING},${OPTIONS},%s))\n"
                   " same => n(invalid-paging),Playback(pls-try-call-later)\n"
                   " same => n,Hangup()\n\n" % (pg["extension"], pg["description"], pstr, opts,
                                                yn(pg.get("skip_busy")), pg.get("timeout") or 10))
    return "".join(out)


# --------------------------------------------------------------------------- #
# hints + astdb extras
# --------------------------------------------------------------------------- #

def _ext_devs(m, e) -> List[str]:
    p = m["prefix"]
    devs = []
    for d in e["devices"]:
        if d["technology"] == "pjsip":
            devs.append("pjsip/%s%s" % (p, d["user"]))
        elif d["technology"] == "virtual":
            devs.append("Custom:VirtualDev%s" % d["device_id"])
    return devs


def queue_memberships(m) -> Dict[int, List[dict]]:
    """extension_id -> [queue rows] (any member type), in queue_id order."""
    res: Dict[int, List[dict]] = {}
    for qu in m["queues"]:
        for mem in qu["members"]:
            res.setdefault(mem["extension_id"], []).append(qu)
    return res


def r_hints_extras(m) -> str:
    """Nothing here — the per-extension Agent/QA hints are interleaved by render_hints via hint_lines_for_extension."""
    return ""


def hint_lines_for_extension(m, e) -> str:
    """Agent<n> / QA_<n> hint lines that follow an extension's own hint when it is a queue member."""
    p = m["prefix"]
    if e["extension_id"] not in queue_memberships(m):
        return ""
    devs = "&".join(_ext_devs(m, e))
    n = e["extension"]
    return ("exten => Agent%s,hint,%s&Custom:%sQAGENT\n\n"
            "exten => QA_%s,hint,%s\n\n" % (n, devs, p, n, devs))


def hint_queue_login_pause(m) -> str:
    """After `QAGENT`: the QAL/QAP login/pause hints per queue member (before the park hints)."""
    p = m["prefix"]
    out = []
    ext_by_id = {e["extension_id"]: e for e in m["extensions"]}
    seen_ext = set()
    for qu in m["queues"]:
        qn = qu["extension"]
        for mem in qu["members"]:
            e = ext_by_id.get(mem["extension_id"])
            if not e:
                continue
            n = e["extension"]
            out.append("exten => QAL_%s_%s,hint,Custom:%sQAL_%s_%s\n same => 1,Set(__QNUMBER=%s)\n same => 2,Gosub(%scos-all-init,*50*%s,1)\n\n"
                       % (n, qn, p, n, qn, qn, p, qn))
            if n not in seen_ext:
                out.append("exten => QAL_%s,hint,Custom:%sQAL_%s\n same => 1,Gosub(%scos-all-init,*52,1)\n\n" % (n, p, n, p))
            out.append("exten => QAP_%s_%s,hint,Custom:%sQAP_%s_%s\n same => 1,Set(__QNUMBER=%s)\n same => 2,Gosub(%scos-all-init,*51*%s,1)\n\n"
                       % (n, qn, p, n, qn, qn, p, qn))
            if n not in seen_ext:
                out.append("exten => QAP_%s,hint,Custom:%sQAP_%s\n same => 1,Gosub(%scos-all-init,*53,1)\n\n" % (n, p, n, p))
                seen_ext.add(n)
    return "".join(out)


def hint_time_conditions(m) -> str:
    """The TC<n> hints, after the park hints (T2, T8, T9, T11, T18)."""
    p, h, t = m["prefix"], m["hash"], m["t"]
    out = []
    default_park = next((l for l in m["parking"] if l.get("defpark") == "yes"), None)
    park = "parking-%d" % t if default_park else ""
    for tc in m["time_conditions"]:
        tid = tc["time_condition_id"]
        out.append("exten => TC%s,hint,Custom:TC%s\n"
                   " same => 1,NoOp(Time Condition: %s)\n"
                   " same => n,Gosub(sub-set-global-vars,s,1(%s,${EXTEN},%s))\n"
                   " same => n,Gosub(sub-set-call-vars,s,1(%s,${EXTEN},,,))\n"
                   " same => n,Gosub(sub-construct-cid,s,1)\n"
                   " same => n,Gosub(sub-toggle-tc-state,s,1(%s,TG-%s))\n\n"
                   % (tid, tid, tc["description"], h, park, h, tid, tc["time_group_id"]))
    return "".join(out)


def astdb_extras(m) -> Dict[str, str]:
    kv: Dict[str, str] = {}
    fam = "/%s" % m["hash"]
    p = m["prefix"]
    ext_by_id = {e["extension_id"]: e for e in m["extensions"]}
    for qu in m["queues"]:
        qn = qu["extension"]
        for mem in qu["members"]:
            e = ext_by_id.get(mem["extension_id"])
            if not e:
                continue
            kv["%s/queues/%s/member/%s/diversions" % (fam, qn, e["extension"])] = yn(mem.get("diversions"))
            kv["%s/queues/%s/member/%s/penalty" % (fam, qn, e["extension"])] = str(mem.get("penalty") or 0)
            kv["%s/queues/%s/member/%s/type" % (fam, qn, e["extension"])] = mem.get("type") or "static"
        kv["%s/queues/%s/moh" % (fam, qn)] = moh_name(m, qu.get("music_group_id"))
        kv["%s/queues/%s/name" % (fam, qn)] = "%sQ%s" % (p, qn)
        kv["%s/queues/%s/prefix" % (fam, qn)] = qu.get("prefix") or ""
        kv["%s/queues/%s/ring_unavailable" % (fam, qn)] = yn(qu.get("ring_unavailable"))
    for tc in m["time_conditions"]:
        st = tc.get("status") or "default"
        kv["%s/time_conditions/TC%s/override" % (fam, tc["time_condition_id"])] = {
            "default": "no", "temporary_matched": "force_match", "temporary_unmatched": "force_unmatch",
            "permanently_matched": "force_match", "permanently_unmatched": "force_unmatch"}.get(st, "no")
    return kv
