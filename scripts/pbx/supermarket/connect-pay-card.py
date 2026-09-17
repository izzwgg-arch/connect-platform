#!/usr/bin/env python3
"""
Connect pay-by-phone — keyed-card collector (AGI), 2026-09-17.

Why an AGI and not the dialplan: Asterisk writes every dialplan step to the
full log WITH its substituted arguments, so a card number that ever sat in a
channel variable (Read() -> Set() -> CURL()) would be printed in
/var/log/asterisk/full in clear. AGI "GET DATA" answers travel on the AGI
pipe, which the verbose log does not print (agi debug is off), and this
script posts them straight to the api over HTTPS. The digits exist in this
process's memory and in the api's memory vault, nowhere else.

Args (from the dialplan):  <url-of-card-door> <tenantId> <callId> <callerNumber>
Reads the shared secret from AstDB itself (connect/system/wake_api_secret).
Sets PAY_CARD=ok|fail|error on the channel and returns; the dialplan then
goes back to its normal step loop.

Rules kept here on purpose:
- never log a digit (only "invalid"/"ok" and lengths);
- three tries per field, then give up -> the api hands the caller to a person;
- Luhn + expiry checked here first so a mistype costs the caller a retry, not
  a register credit.
"""
import json
import ssl
import sys
import urllib.request
from datetime import date

PROMPT_DIR = "/var/lib/asterisk/sounds/connect-pay/en-male"
TRIES = 3
GET_TIMEOUT_MS = 15000


class Agi:
    def __init__(self):
        self.env = {}
        while True:
            line = sys.stdin.readline()
            if not line or line.strip() == "":
                break
            k, _, v = line.strip().partition(": ")
            self.env[k] = v

    def cmd(self, s):
        sys.stdout.write(s + "\n")
        sys.stdout.flush()
        return sys.stdin.readline().strip()

    def get_data(self, prompt, max_digits):
        # "200 result=<digits> (timeout)" / "200 result=-1" on hangup
        r = self.cmd('GET DATA %s/%s %d %d' % (PROMPT_DIR, prompt, GET_TIMEOUT_MS, max_digits))
        if "result=" not in r:
            return None
        v = r.split("result=", 1)[1].split(" ", 1)[0].strip()
        if v == "-1":
            return None
        return "".join(ch for ch in v if ch.isdigit())

    def stream(self, prompt):
        self.cmd('STREAM FILE %s/%s ""' % (PROMPT_DIR, prompt))

    def set_var(self, name, value):
        self.cmd('SET VARIABLE %s "%s"' % (name, value))

    def db_get(self, family, key):
        r = self.cmd('DATABASE GET %s %s' % (family, key))
        # "200 result=1 (value)"
        if "result=1" in r and "(" in r:
            return r[r.index("(") + 1 : r.rindex(")")]
        return ""


def luhn_ok(s):
    if not s.isdigit() or not 13 <= len(s) <= 19:
        return False
    total, dbl = 0, False
    for ch in reversed(s):
        d = ord(ch) - 48
        if dbl:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        dbl = not dbl
    return total % 10 == 0


def exp_ok(s):
    if len(s) != 4 or not s.isdigit():
        return False
    mm, yy = int(s[:2]), int(s[2:])
    if not 1 <= mm <= 12:
        return False
    today = date.today()
    year = 2000 + yy
    return (year, mm) >= (today.year, today.month)


def collect(agi, prompt, max_digits, check):
    for _ in range(TRIES):
        v = agi.get_data(prompt, max_digits)
        if v is None:
            return None  # hangup
        if check(v):
            return v
        agi.stream("45_card_invalid")
    return ""


def main():
    agi = Agi()
    args = sys.argv[1:]
    if len(args) < 4:
        agi.set_var("PAY_CARD", "error")
        return
    url, tenant_id, call_id, caller = args[0], args[1], args[2], args[3]
    secret = agi.db_get("connect/system", "wake_api_secret")

    number = collect(agi, "41_card_number", 19, luhn_ok)
    exp = collect(agi, "42_card_exp", 4, exp_ok) if number else number
    cvv = collect(agi, "43_card_cvv", 4, lambda v: 3 <= len(v) <= 4) if exp else exp
    zipc = collect(agi, "44_card_zip", 5, lambda v: len(v) == 5) if cvv else cvv

    if number is None or exp is None or cvv is None or zipc is None:
        agi.set_var("PAY_CARD", "hangup")
        return

    body = {"tenantId": tenant_id, "callId": call_id, "callerNumber": caller}
    if number and exp and cvv and zipc:
        body["card"] = {"number": number, "expMonth": int(exp[:2]), "expYear": int(exp[2:]), "cvv": cvv, "zipCode": zipc}
    else:
        body["cardFailed"] = True

    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"content-type": "application/json", "x-cdr-secret": secret},
            method="POST",
        )
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=20, context=ctx) as res:
            out = json.loads(res.read().decode("utf-8") or "{}")
        agi.set_var("PAY_CARD", "ok" if out.get("ok") else "fail")
    except Exception:
        agi.set_var("PAY_CARD", "error")
    finally:
        # nothing about the card may survive this process
        number = exp = cvv = zipc = None
        body = None


if __name__ == "__main__":
    main()
