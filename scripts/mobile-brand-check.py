#!/usr/bin/env python3
"""
Fail if the mobile app still shows the customer the word "Connect".

    python scripts/mobile-brand-check.py

Why this exists
---------------
The 2026-08-21 rebrand was reported complete while the app still opened on a
screen reading "Connect" / "Communications" in display type. Two reasons, and
this script exists to catch both:

  1. ⛔ THE SWEEP EDITED FILES THE APP DOES NOT USE. src/screens/ held six
     duplicate screens - LoginScreen, QrProvisionScreen, HomeScreen and three
     more - that nothing imported; the real ones live in src/screens/auth/ and
     src/screens/call/. The dead copies are deleted now, but the lesson is that
     "I changed LoginScreen.tsx" means nothing until you know it is routed.

  2. ⛔ THE BRAND NAME WAS SPLIT ACROSS TWO ELEMENTS. WelcomeScreen rendered
     <Text>Connect</Text> above <Text>Communications</Text>, so the string
     "Connect Communications" existed nowhere - not in the source, not in the
     shipped JS bundle. Searching for the full phrase came back clean and was
     believed. This scans for the WORD, never the phrase.

A single-line regex over quoted strings also misses multi-line template
literals and JSX text, which is how three permission prompts survived. This
walks every line instead.

Exit code 1 and a list if anything is found.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "apps" / "mobile" / "src"

# Identifiers, ids and API/vendor words that legitimately contain "Connect" and
# are never shown to a customer. ⛔ Notification channel ids and the ringtone id
# MUST stay as they are: renaming a channel id makes Android create a NEW
# channel and silently resets every customer's sound and vibration choices.
ALLOWED = re.compile(
    r"""
    Connected | Connecting | Connection | Connectivity | ConnectionService
  | connectcommunications                # the package id - permanent once on Play
  | connect-default | connect-calls | connect-messages
  | connect-voicemail | connect-missed-calls
  | connect_bg_keepalive | connect_in_call | connect_sip_keepalive
  | connect-silent-ringtone | connect-default-ringtone
  | ConnectTone | ConnectConnection | ConnectIncoming
  | connect\( | \.connect\b | reconnect | disconnect
    """,
    re.VERBOSE | re.IGNORECASE,
)

# Comments are allowed to say "Connect" - they are history, not UI.
COMMENT = re.compile(r"^\s*(//|/\*|\*|\*/)")


def main() -> int:
    if not SRC.is_dir():
        sys.exit(f"not found: {SRC}")

    findings: list[tuple[str, int, str]] = []
    for path in sorted(SRC.rglob("*")):
        if path.suffix not in (".ts", ".tsx") or not path.is_file():
            continue
        rel = path.relative_to(SRC.parent).as_posix()
        for n, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if COMMENT.match(line):
                continue
            for m in re.finditer(r"\bConnect\b", line):
                window = line[max(0, m.start() - 60): m.end() + 60]
                if ALLOWED.search(window):
                    continue
                findings.append((rel, n, line.strip()[:120]))
                break

    if findings:
        print("Customer-visible \"Connect\" still in the mobile app:\n")
        for rel, n, line in findings:
            print(f"  {rel}:{n}\n      {line}")
        print(f"\n{len(findings)} to fix.")
        return 1

    print("ok - no customer-visible \"Connect\" left in apps/mobile/src")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
