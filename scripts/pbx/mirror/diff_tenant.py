#!/usr/bin/env python3
"""
Diff harness for the VitalPBX mirror generator.

    diff_tenant.py --tenant N [--baseline-dir DIR] [--astdb FILE] [--ignore-hand-edits] [--quiet]

Renders tenant N from the (dev) ombutel database, diffs every generated file
against the baseline copy of /etc/asterisk/vitalpbx/ and the AstDB family
against a `database show` dump, prints a unified diff per mismatching file and
one PASS/FAIL summary line. Exit status 0 only when everything matches.

Normalisation, deliberately minimal:
  * the `; @Date :` banner line (VitalPBX stamps generation time)
  * trailing whitespace on AstDB dump lines (`database show` pads values to 25 cols)
  * `--ignore-hand-edits` additionally drops the blocks that were hand-edited on
    the PBX under an Izzy mandate and therefore cannot come from the database
    (the `; connect-hd-inbound` opus block and the T7 aor *_expiration lines).
"""
from __future__ import annotations

import argparse
import difflib
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vitalpbx_mirror as vm  # noqa: E402

DATE_RE = re.compile(r"^; @Date : .*$", re.M)
HAND_EDIT_RES = [
    # the connect-hd-inbound opus block (comment + 3 lines) hand-baked 2026-07-30
    re.compile(r"^; connect-hd-inbound[^\n]*\n(?:allow=[^\n]*\n)?(?:codec_prefs_outgoing_offer=[^\n]*\n)?(?:outgoing_call_offer_pref=[^\n]*\n)?", re.M),
    # T7 registration-expiry cap staged by hand (2026-08-05 outage)
    re.compile(r"^(?:minimum_expiration|maximum_expiration|default_expiration)=[^\n]*\n", re.M),
]


def norm(text: str, hand_edits: bool = False) -> str:
    text = DATE_RE.sub("; @Date : X", text)
    if hand_edits:
        for r in HAND_EDIT_RES:
            text = r.sub("", text)
    return text


def load_astdb_family(path: str, prefixes) -> dict:
    """Read a `database show` dump; keep keys starting with any of `prefixes`."""
    kv = {}
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.startswith("/"):
                continue
            # format is '%-50s: %-25s' -> split on the first ' : ' after the padded key;
            # keys longer than 50 chars are followed directly by ': '.
            mobj = re.match(r"^(\S+)\s*: (.*)$", line)
            if not mobj:
                continue
            k, v = mobj.group(1), mobj.group(2).rstrip()
            if any(k.startswith(p) for p in prefixes):
                kv[k] = v
    return kv


RUNTIME_KEYS = ("/LASTCALLER/",)  # written by calls, not by the generator


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--tenant", type=int, required=True)
    ap.add_argument("--baseline-dir", default="/root/pbx-mirror-dev/etc/asterisk/vitalpbx")
    ap.add_argument("--astdb", default="/root/pbx-mirror-baseline-20260818/astdb.txt")
    ap.add_argument("--ignore-hand-edits", action="store_true")
    ap.add_argument("--quiet", action="store_true", help="only print the summary line")
    ap.add_argument("--host", default=os.environ.get("MIRROR_DB_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("MIRROR_DB_PORT", "3307")))
    ap.add_argument("--user", default=os.environ.get("MIRROR_DB_USER", "root"))
    ap.add_argument("--password", default=os.environ.get("MIRROR_DB_PASSWORD", "mirror"))
    ap.add_argument("--db", default=os.environ.get("MIRROR_DB_NAME", "ombutel"))
    a = ap.parse_args(argv)

    conn = vm.connect(a.host, a.port, a.user, a.password, a.db)
    m = vm.load_tenant(conn, a.tenant)
    files = vm.render_tenant(m)

    ok, bad = [], []
    for name in sorted(files):
        base_path = os.path.join(a.baseline_dir, name)
        if not os.path.exists(base_path):
            bad.append((name, "baseline file missing"))
            if not a.quiet:
                print("=== %s: MISSING in baseline" % name)
            continue
        with open(base_path, encoding="utf-8", errors="replace", newline="") as f:
            base = f.read()
        want = norm(base, a.ignore_hand_edits)
        got = norm(files[name], a.ignore_hand_edits)
        if want == got:
            ok.append(name)
            continue
        diff = list(difflib.unified_diff(want.splitlines(True), got.splitlines(True),
                                         "baseline/" + name, "mirror/" + name))
        nchg = sum(1 for l in diff if (l.startswith("+") or l.startswith("-")) and not l.startswith(("+++", "---")))
        bad.append((name, "%d differing lines" % nchg))
        if not a.quiet:
            print("=== %s: DIFF (%d lines)" % (name, nchg))
            sys.stdout.writelines(diff)
            print()

    # AstDB
    fam = "/%s/" % m["hash"]
    prefixes = (fam, "/CustomDevstate/%s" % m["prefix"])
    want_kv = {k: v for k, v in load_astdb_family(a.astdb, prefixes).items()
               if not any(r in k for r in RUNTIME_KEYS)}
    got_kv = vm.render_astdb(m)
    if a.ignore_hand_edits:
        # Connect's wake-and-wait enrollment rewrites extensions/N/dial to Local/T<t>_<n>_1@connect-mobile-wake-dial/n
        # and raises followme/ringtime (raise-only, in-lane AMI dbPut) — Connect writes, not VitalPBX output.
        for k in list(want_kv):
            mm = re.match(r"^%sextensions/(\d+)/dial$" % re.escape(fam), k)
            if mm and "@connect-mobile-wake-dial/n" in want_kv[k]:
                want_kv[k] = re.sub(r"Local/(T\d+_\d+_1)@connect-mobile-wake-dial/n", r"PJSIP/\g<1>", want_kv[k])
                rt = "%sextensions/%s/followme/ringtime" % (fam, mm.group(1))
                if rt in want_kv and rt in got_kv and want_kv[rt] != got_kv[rt]:
                    want_kv[rt] = got_kv[rt]
    # VitalPBX never deletes /CustomDevstate/T<t>_<X>_<n> when extension n is deleted or renumbered
    # (live: T105 still carries T105_*_1 from the ext 1 -> 101 renumbering). Such keys are residue,
    # not generator output; report them as a note and do not count them.
    live_exts = {str(e["extension"]) for e in m["extensions"]}
    stale = [k for k in list(want_kv) if k.startswith("/CustomDevstate/%s" % m["prefix"])
             and re.search(r"_(\d+)$", k) and re.search(r"_(\d+)$", k).group(1) not in live_exts]
    for k in stale:
        del want_kv[k]
    if stale and not a.quiet:
        print("note: ignoring %d stale /CustomDevstate keys for extensions that no longer exist: %s"
              % (len(stale), ", ".join(stale[:12]) + (" ..." if len(stale) > 12 else "")))
    missing = sorted(k for k in want_kv if k not in got_kv)
    extra = sorted(k for k in got_kv if k not in want_kv)
    wrong = sorted(k for k in want_kv if k in got_kv and want_kv[k] != got_kv[k])
    if missing or extra or wrong:
        bad.append(("astdb", "%d missing, %d extra, %d wrong" % (len(missing), len(extra), len(wrong))))
        if not a.quiet:
            print("=== astdb: DIFF")
            for k in missing:
                print("- %s : %s" % (k, want_kv[k]))
            for k in extra:
                print("+ %s : %s" % (k, got_kv[k]))
            for k in wrong:
                print("~ %s : baseline=%r mirror=%r" % (k, want_kv[k], got_kv[k]))
            print()
    else:
        ok.append("astdb")

    status = "PASS" if not bad else "FAIL"
    print("%s tenant %d: %d/%d files+astdb identical%s" % (
        status, a.tenant, len(ok), len(ok) + len(bad),
        "" if not bad else " — " + ", ".join("%s (%s)" % b for b in bad)))
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
