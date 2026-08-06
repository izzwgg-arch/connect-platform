#!/usr/bin/env python3
"""Make Asterisk's own recordings playable from the Connect menu contexts.

The dialplan gates every prompt on
    STAT(e,/var/lib/asterisk/sounds/<ref>.ulaw|.wav)
but Asterisk's bundled recordings live one level down, under the LANGUAGE
directory: /var/lib/asterisk/sounds/en/pbx-invalid.ulaw. So for every built-in
the probe missed, the guard fell through to "replay the menu", and the caller
was never told anything -- which is why pressing an invalid option was silent,
and why the timeout message never played either.

Tenant recordings were unaffected: they really do live at sounds/custom/X.wav.
That is exactly why this hid for so long.

Fix: mirror each existing .wav probe with an identical probe against
sounds/en/. Same proven line shape, so there is nothing new for the parser to
choke on -- an earlier attempt that introduced CUT() into these conditions made
Asterisk reject the whole file and silently keep the previous dialplan.
"""
import io
import re
import sys

path = sys.argv[1]
src = io.open(path, encoding="utf-8").read()

if "sounds/en/" in src:
    print("already applied")
    raise SystemExit(0)

probe = re.compile(
    r'^([ \t]*same *=> *n,)'
    r'GotoIf\(\$\["\$\{STAT\(e,/var/lib/asterisk/sounds/\$\{(\w+)\}\.wav\)\}" = "1"\]\?(\w+)\)[ \t]*$',
    re.M,
)


def twin(m: "re.Match[str]") -> str:
    head, var, label = m.groups()
    en = (
        head
        + 'GotoIf($["${STAT(e,/var/lib/asterisk/sounds/en/${'
        + var
        + '}.ulaw)}" = "1"]?'
        + label
        + ")"
    )
    return m.group(0).rstrip() + "\n" + en


out, n = probe.subn(twin, src)
if n == 0:
    print("FATAL: no .wav probes matched -- layout changed, not patching blind")
    raise SystemExit(1)

io.open(path, "w", encoding="utf-8").write(out)
print("language-dir probes added:", n)
