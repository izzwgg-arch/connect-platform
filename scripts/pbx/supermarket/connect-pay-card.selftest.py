"""Self-test for connect-pay-card.py collect(): the stray pound, silence-is-not-wrong, and the wrong-answer cap.
Run: python3 scripts/pbx/supermarket/connect-pay-card.selftest.py  (no Asterisk needed — a fake AGI pipe with a fake clock)."""
import importlib.util, os, time, sys
spec = importlib.util.spec_from_file_location("agi", os.path.join(os.path.dirname(os.path.abspath(__file__)), "connect-pay-card.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class Fake:
    def __init__(self, answers):  # list of (value, seconds_it_took)
        self.answers = list(answers); self.asked = []; self.streamed = []
    def get_data(self, prompt, max_digits):
        v, dt = self.answers.pop(0)
        self.asked.append(prompt)
        # fake the clock instead of sleeping
        m.time = type("T", (), {"monotonic": staticmethod(lambda: Fake.now)})
        Fake.now += dt
        return v
    def stream(self, p): self.streamed.append(p)
Fake.now = 0.0
real_time = m.time

def run(answers, check=lambda v: len(v) == 4):
    Fake.now = 0.0
    f = Fake(answers)
    r = m.collect(f, "42_card_exp", 4, check)
    return r, len(f.asked), f.streamed

# 1) stray pound: empty after 1.2 s -> re-asked once, no "invalid", then the real answer
r, asks, streamed = run([("", 1.2), ("1126", 8.0)])
assert r == "1126" and asks == 2 and streamed == [], (r, asks, streamed)
# 2) a real timeout (empty after 14 s): replayed silently, no "invalid"; then answered
r, asks, streamed = run([("", 14.0), ("1126", 3.0)])
assert r == "1126" and asks == 2 and streamed == [], (r, asks, streamed)
# 3) three real silences -> give up "" without ever saying "invalid"
r, asks, streamed = run([("", 14.0), ("", 14.0), ("", 14.0)])
assert r == "" and asks == 3 and streamed == [], (r, asks, streamed)
# 4) stray + two silences + ... the stray is not counted: 1 re-ask + 3 silences = 4 asks
r, asks, streamed = run([("", 1.0), ("", 14.0), ("", 14.0), ("", 14.0)])
assert r == "" and asks == 4 and streamed == [], (r, asks, streamed)
# 5) a second early-empty (caller mashing #) counts as a silence, not an endless local loop
r, asks, streamed = run([("", 1.0), ("", 1.0), ("", 1.0), ("", 1.0)])
assert r == "" and asks == 4 and streamed == [], (r, asks, streamed)
# 6) three wrong answers -> "" with three "invalid" plays (unchanged behaviour)
r, asks, streamed = run([("12", 5.0), ("12", 5.0), ("12", 5.0)])
assert r == "" and asks == 3 and streamed == ["45_card_invalid"] * 3, (r, asks, streamed)
# 7) wrong, then stray-empty, then right
r, asks, streamed = run([("12", 5.0), ("", 0.5), ("1126", 4.0)])
assert r == "1126" and asks == 3 and streamed == ["45_card_invalid"], (r, asks, streamed)
# 8) hangup propagates
r, asks, streamed = run([(None, 2.0)])
assert r is None
# 9) luhn/exp helpers still fine
assert m.luhn_ok("4111111111111111") and not m.luhn_ok("341")
print("agi collect(): 9/9 ok")
