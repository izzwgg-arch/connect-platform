import os, json, datetime
ROOT = os.path.join(os.path.dirname(__file__), "project")
os.makedirs(ROOT, exist_ok=True)

LIGHT = dict(bg="#f6f8fb", panel="#ffffff", panel2="#f8fafc", ink="#0f172a", muted="#475569",
             line="rgba(15,23,42,0.12)", soft="rgba(15,23,42,0.07)", accent="#3b82f6", accsoft="rgba(59,130,246,0.14)",
             good="#0b8a5b", goodsoft="rgba(34,197,94,0.14)", warn="#b26a00", warnsoft="rgba(245,158,11,0.16)",
             crit="#c8324a", critsoft="rgba(239,68,68,0.14)", scheme="light")
DARK = dict(bg="#0c1218", panel="#141f2b", panel2="#1a2635", ink="#e1e9f1", muted="#8ea0b2",
            line="#26374a", soft="rgba(38,55,74,0.7)", accent="#22a8ff", accsoft="rgba(34,168,255,0.14)",
            good="#34c48b", goodsoft="rgba(52,194,123,0.14)", warn="#e0a04a", warnsoft="rgba(240,182,85,0.16)",
            crit="#f0788c", critsoft="rgba(234,96,104,0.14)", scheme="dark")

def helmet(t):
    return f"""<helmet>
<style>
body{{margin:0;background:{t['bg']};color:{t['ink']};font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:{t['scheme']}}}
a{{color:{t['accent']};text-decoration:none}} a:hover{{text-decoration:underline}}
.n{{font-family:ui-monospace,"Cascadia Mono","SF Mono",Consolas,monospace;font-variant-numeric:tabular-nums}}
.pill{{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:620;padding:3px 9px;border-radius:20px;white-space:nowrap}}
.pill::before{{content:"";width:5px;height:5px;border-radius:50%;background:currentColor}}
.pill.ok{{color:{t['good']};background:{t['goodsoft']}}} .pill.warn{{color:{t['warn']};background:{t['warnsoft']}}}
.pill.bad{{color:{t['crit']};background:{t['critsoft']}}} .pill.info{{color:{t['accent']};background:{t['accsoft']}}}
.pill.off{{color:{t['muted']};background:{t['soft']}}}
.card{{border:1px solid {t['line']};border-radius:10px;background:{t['panel']};overflow:hidden}}
.hd{{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 15px;border-bottom:1px solid {t['line']};background:{t['panel2']}}}
.hd h3{{margin:0;font-size:13.5px;font-weight:640;letter-spacing:-0.01em}}
.hint{{font-size:11.5px;color:{t['muted']}}}
table{{width:100%;border-collapse:collapse;font-size:13px}}
th{{text-align:left;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:{t['muted']};font-weight:660;padding:9px 15px;border-bottom:1px solid {t['line']};background:{t['panel2']};white-space:nowrap}}
td{{padding:10px 15px;border-bottom:1px solid {t['soft']};vertical-align:middle}}
tr:last-child td{{border-bottom:0}} td.r,th.r{{text-align:right}}
tr.grp td{{background:{t['panel2']};font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:680;color:{t['muted']};padding:7px 15px}}
tr.sum td{{font-weight:680;border-top:1px solid {t['line']}}}
.btn{{font-size:13px;font-weight:600;padding:7px 14px;border-radius:7px;border:1px solid {t['line']};background:{t['panel']};color:{t['ink']};cursor:pointer;font-family:inherit}}
.btn.primary{{background:{t['accent']};border-color:{t['accent']};color:#fff}}
.nav{{display:flex;gap:2px;padding-bottom:4px;border-bottom:1px solid {t['line']}}}
.nav a{{font-size:13px;font-weight:540;color:{t['muted']};padding:6px 12px;border-radius:7px}}
.nav a.on{{color:{t['accent']};background:{t['accsoft']};font-weight:650}}
.tile{{flex:1 1 0;min-width:0;padding:12px 14px;border:1px solid {t['soft']};border-radius:9px;background:{t['panel']}}}
.tile .k{{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:{t['muted']};font-weight:660}}
.tile .v{{font-size:22px;font-weight:660;letter-spacing:-.03em;margin-top:4px}}
.tile .s{{font-size:11.5px;color:{t['muted']};margin-top:3px}}
.src{{font-size:10.5px;color:{t['muted']}}}
.bar{{height:8px;border-radius:4px;background:{t['soft']};overflow:hidden}}
.bar i{{display:block;height:100%;background:{t['accent']}}}
.dim{{color:{t['muted']}}}
</style>
</helmet>"""

def nav():
    return """<nav class="nav" aria-label="Billing"><a href="#m">This month</a><a href="#c">Customers</a><a class="on" href="#i">Invoices</a><a href="#p">Payments</a><a href="#n">Needs you</a><a href="#k">Catalog</a></nav>"""

def row(what, qty, rate, carrier, cost, src, srccls="info", note=""):
    n = f'<div class="src" style="margin-top:2px">{note}</div>' if note else ""
    return f"""<tr><td>{what}{n}</td><td class="r n">{qty}</td><td class="r n dim">{rate}</td><td>{carrier}</td><td class="r n">{cost}</td><td><span class="pill {srccls}">{src}</span></td></tr>"""

def cost_card(t, expanded=True):
    return f"""
<section class="card">
  <div class="hd">
    <div style="display:flex;align-items:center;gap:10px"><h3>What this customer cost us</h3><span class="pill warn">Office only</span><span class="hint">never on the customer's invoice, PDF or email</span></div>
    <div style="display:flex;align-items:center;gap:8px"><span class="hint">service Aug 3 – Sep 3, 2026 · period closed</span><button class="btn" type="button">By number &amp; day</button><button class="btn" type="button">Export CSV</button></div>
  </div>

  <div style="display:flex;gap:10px;padding:14px 15px 4px">
    <div class="tile"><div class="k">They paid us</div><div class="v n">$450.41</div><div class="s">invoice CC-202608-00026 · paid Sep 3</div></div>
    <div class="tile"><div class="k">It cost us</div><div class="v n">$221.36</div><div class="s">carriers $211.36 · services $10.00</div></div>
    <div class="tile" style="border-color:{t['good']}"><div class="k" style="color:{t['good']}">Margin</div><div class="v n" style="color:{t['good']}">$229.05</div><div class="s">50.9% of the invoice</div><div class="bar" style="margin-top:8px"><i style="width:51%;background:{t['good']}"></i></div></div>
  </div>

  <div style="display:flex;gap:10px;padding:10px 15px 14px">
    <div class="tile"><div class="k">Inbound minutes</div><div class="v n">11,036</div><div class="s">5,022 answered calls · <b>$99.32</b></div></div>
    <div class="tile"><div class="k">Outbound minutes</div><div class="v n">8,759</div><div class="s">6,031 answered calls · <b>$65.69</b></div></div>
    <div class="tile"><div class="k">Texts &amp; pictures</div><div class="v n">783</div><div class="s">780 in · 3 out · 10 with pictures · <b>$6.00</b></div></div>
    <div class="tile"><div class="k">Caller ID lookups</div><div class="v n">5,375</div><div class="s">94% of inbound calls named · <b>$43.00</b></div></div>
  </div>

  <table>
    <thead><tr><th>What we were charged for</th><th class="r">Quantity</th><th class="r">Rate</th><th>Carrier</th><th class="r">Our cost</th><th>How we know</th></tr></thead>
    <tbody>
      <tr class="grp"><td colspan="6">Calls</td></tr>
      {row("Inbound talk time", "11,036 min", "$0.0090 / min", "VoIP.ms · 845-244-9666", "$99.32", "Carrier CDR", "ok", "billed per started minute · 5,022 calls · 141 min avg per day")}
      {row("Outbound talk time", "8,759 min", "$0.0075 / min", "Telocall · shared 0001 trunk", "$65.69", "Our minutes × rate", "warn", "Telocall has no API — rate is what you set in Catalog → Carrier rates; true it up when their invoice comes")}
      {row("Outbound over the backup route", "0 min", "$0.0100 / min", "VoIP.ms (backup)", "$0.00", "Carrier CDR", "ok")}
      {row("Toll-free / international", "0 min", "—", "—", "$0.00", "Carrier CDR", "ok")}
      <tr class="grp"><td colspan="6">Texting</td></tr>
      {row("Texts received", "770", "$0.0075 each", "VoIP.ms", "$5.78", "Carrier count", "ok")}
      {row("Pictures received (MMS)", "10", "$0.0200 each", "VoIP.ms", "$0.20", "Carrier count", "ok")}
      {row("Texts sent", "3", "$0.0075 each", "VoIP.ms", "$0.02", "Carrier count", "ok")}
      <tr class="grp"><td colspan="6">Caller ID</td></tr>
      {row("Caller-name lookups on inbound calls (CNAM)", "5,375", "$0.0080 each", "VoIP.ms", "$43.00", "Carrier count", "ok", "one lookup per inbound call with a name — 19% of this customer's whole cost")}
      {row("Their own outbound caller name (CNAM listing)", "1 number", "$0.00 / mo", "VoIP.ms", "$0.00", "Carrier", "ok")}
      <tr class="grp"><td colspan="6">Numbers &amp; 911</td></tr>
      {row("Phone numbers", "1", "$0.85 / mo", "VoIP.ms", "$0.85", "Carrier", "ok", "845-244-9666 · per-minute plan")}
      {row("911 address registration", "1", "$1.50 / mo", "VoIP.ms", "$1.50", "Carrier", "ok")}
      {row("Texting registration (10DLC campaign)", "—", "$0.00 / mo", "Telnyx", "$0.00", "Carrier", "off", "starts when the number lands on Telnyx (port FOC Sep 22)")}
      <tr class="grp"><td colspan="6">Services we run for them</td></tr>
      {row("Voicemail transcription", "312 min", "$0.0060 / min", "OpenAI Whisper", "$1.87", "Estimated", "warn")}
      {row("Menu &amp; pay-line voices (text-to-speech)", "48,200 chars", "$16 / 1M chars", "Amazon Polly neural", "$0.77", "Estimated", "warn")}
      {row("Call recording storage", "6.1 GB", "$0.023 / GB-mo", "S3", "$0.14", "Estimated", "warn")}
      {row("Pay line (POS lookups, card runs)", "1,204 calls", "—", "Loopcom server", "$7.22", "Estimated", "warn", "server share by call minutes")}
      <tr class="grp"><td colspan="6">One-time this period</td></tr>
      {row("Nothing one-time this period", "", "", "", "$0.00", "—", "off")}
      <tr class="sum"><td colspan="4" class="r">Total cost to us</td><td class="r n">$221.36</td><td></td></tr>
      <tr class="sum"><td colspan="4" class="r">Invoice total (what they paid)</td><td class="r n">$450.41</td><td></td></tr>
      <tr class="sum"><td colspan="4" class="r" style="color:{t['good']}">Margin</td><td class="r n" style="color:{t['good']}">$229.05 · 50.9%</td><td></td></tr>
    </tbody>
  </table>
  <div style="padding:10px 15px;border-top:1px solid {t['line']};display:flex;gap:18px;flex-wrap:wrap" class="hint">
    <span><span class="pill ok">Carrier CDR</span> the carrier's own per-call record, pulled nightly</span>
    <span><span class="pill warn">Our minutes × rate</span> our call log times a rate you entered — no carrier feed exists</span>
    <span><span class="pill warn">Estimated</span> metered by us, priced at the vendor's list rate</span>
  </div>
</section>"""

def invoice_board(t, title):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
{helmet(t)}
<div style="width:1280px;height:1640px;box-sizing:border-box;padding:20px 24px;display:flex;flex-direction:column;gap:16px;background:{t['bg']};color:{t['ink']}">
  {nav()}
  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
    <div>
      <h2 style="margin:0;font-size:22px;letter-spacing:-.02em">CC-202608-00026</h2>
      <div class="hint" style="display:flex;gap:8px;align-items:center;margin-top:4px;font-size:13px"><span class="pill ok">Paid</span><a href="#g">Gesheft Supermarket</a><span>·</span><span>service Aug 3 – Sep 3, 2026</span><span>·</span><span>due Sep 3</span></div>
    </div>
    <div style="text-align:right"><div class="n" style="font-size:28px;font-weight:660;letter-spacing:-.03em">$450.41</div><div class="hint" style="font-size:13px">Paid Sep 3, 2026</div></div>
  </div>

  <section class="card">
    <div class="hd"><h3>Actions</h3></div>
    <div style="display:flex;gap:8px;padding:12px 15px;flex-wrap:wrap">
      <button class="btn" type="button" disabled>Charge card on file</button><button class="btn" type="button" disabled>Retry payment</button><button class="btn" type="button">Send invoice</button><button class="btn" type="button" disabled>Email payment link</button><button class="btn" type="button">Resend receipt</button><button class="btn" type="button" disabled>Mark as paid</button><button class="btn" type="button">Pause chasing</button><button class="btn" type="button">Download PDF</button><button class="btn" type="button" style="color:{t['crit']}">Void</button>
    </div>
  </section>

  <section class="card">
    <div class="hd"><h3>What they are being charged for</h3><span class="hint">4 lines · this is what the customer sees</span></div>
    <table>
      <thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Each</th><th class="r">Taxable</th><th class="r">Amount</th></tr></thead>
      <tbody>
        <tr><td>Phone system — 6 extensions</td><td class="r n">6</td><td class="r n">$35.00</td><td class="r"><span class="pill ok">Yes</span></td><td class="r n">$210.00</td></tr>
        <tr><td>Business texting on 845-244-9666</td><td class="r n">1</td><td class="r n">$15.00</td><td class="r"><span class="pill ok">Yes</span></td><td class="r n">$15.00</td></tr>
        <tr><td>Pay-by-phone line (POS integration)</td><td class="r n">1</td><td class="r n">$150.00</td><td class="r"><span class="pill ok">Yes</span></td><td class="r n">$150.00</td></tr>
        <tr><td>Call recording &amp; transcription</td><td class="r n">1</td><td class="r n">$40.00</td><td class="r"><span class="pill ok">Yes</span></td><td class="r n">$40.00</td></tr>
        <tr><td colspan="4" class="r" style="font-weight:620">Subtotal</td><td class="r n">$415.00</td></tr>
        <tr><td colspan="4" class="r" style="font-weight:620">Sales tax</td><td class="r n">$35.41</td></tr>
        <tr><td colspan="4" class="r" style="font-weight:700">Total</td><td class="r n" style="font-weight:700">$450.41</td></tr>
      </tbody>
    </table>
  </section>

  {cost_card(t)}
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1280,"height":1640}}}}'>
class Component extends DCLogic {{
  renderVals() {{ return {{}}; }}
}}
</script>
</body>
</html>"""

def drill_board(t):
    def nrow(num, label, inc_min, inc_cost, out_min, out_cost, sms, sms_cost, cnam, cnam_cost, fixed, total, pct):
        return f"""<tr><td><div style="font-weight:600" class="n">{num}</div><div class="src">{label}</div></td><td class="r n">{inc_min}<div class="src">{inc_cost}</div></td><td class="r n">{out_min}<div class="src">{out_cost}</div></td><td class="r n">{sms}<div class="src">{sms_cost}</div></td><td class="r n">{cnam}<div class="src">{cnam_cost}</div></td><td class="r n">{fixed}</td><td class="r n" style="font-weight:660">{total}</td><td style="width:140px"><div class="bar"><i style="width:{pct}%"></i></div></td></tr>"""
    days = [("Sun Aug 3",380,9),("Mon Aug 4",1710,12),("Tue Aug 5",1650,11),("Wed Aug 6",1590,11),("Thu Aug 7",1820,13),("Fri Aug 8",1120,7),("Sat Aug 9",0,0),("Sun Aug 10",410,3)]
    mx = 1820
    drows = "".join(f"""<tr><td>{d}</td><td class="r n">{m:,}</td><td style="width:260px"><div class="bar"><i style="width:{int(m/mx*100)}%"></i></div></td><td class="r n">${c:.2f}</td></tr>""" for d,m,c in [(d,m,m*0.0085+ (m and 1.1)) for d,m,_ in days])
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cost by number and by day</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
{helmet(t)}
<div style="width:1280px;height:1180px;box-sizing:border-box;padding:20px 24px;display:flex;flex-direction:column;gap:16px;background:{t['bg']};color:{t['ink']}">
  {nav()}
  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
    <div><h2 style="margin:0;font-size:22px;letter-spacing:-.02em">Gesheft Supermarket — cost by number and by day</h2>
    <div class="hint" style="display:flex;gap:8px;align-items:center;margin-top:4px;font-size:13px"><span class="pill warn">Office only</span><a href="#i">← invoice CC-202608-00026</a><span>·</span><span>service Aug 3 – Sep 3, 2026</span></div></div>
    <div style="display:flex;gap:8px"><button class="btn" type="button">Previous period</button><button class="btn" type="button">Next period</button><button class="btn" type="button">Export CSV</button></div>
  </div>

  <section class="card">
    <div class="hd"><h3>By number</h3><span class="hint">every number that carried this customer's traffic, including the shared outbound trunk</span></div>
    <table>
      <thead><tr><th>Number</th><th class="r">Inbound min</th><th class="r">Outbound min</th><th class="r">Texts</th><th class="r">Caller ID lookups</th><th class="r">Monthly fees</th><th class="r">Cost</th><th>Share</th></tr></thead>
      <tbody>
        {nrow("845-244-9666","Main line · VoIP.ms · 911 registered","11,036","$99.32","—","—","783","$6.00","5,375","$43.00","$2.35","$150.67",100)}
        {nrow("Shared trunk 0001","Outbound · Telocall · caller ID shows 845-244-9666","—","—","8,759","$65.69","—","—","—","—","—","$65.69",44)}
        {nrow("Internal / extension-to-extension","246 calls · 657 min · no carrier","—","$0.00","—","$0.00","—","—","—","—","—","$0.00",0)}
        <tr class="sum"><td colspan="6" class="r">Carrier total</td><td class="r n">$216.36</td><td></td></tr>
      </tbody>
    </table>
  </section>

  <div style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:16px">
    <section class="card">
      <div class="hd"><h3>By day</h3><span class="hint">talk minutes, both directions · Sabbath-quiet Saturdays are real</span></div>
      <table>
        <thead><tr><th>Day</th><th class="r">Minutes</th><th></th><th class="r">Cost</th></tr></thead>
        <tbody>{drows}<tr><td colspan="4" class="hint">… 23 more days · busiest day Thu Aug 21 (2,104 min, $19.98)</td></tr></tbody>
      </table>
    </section>
    <section class="card">
      <div class="hd"><h3>Where this month's money went</h3><span class="hint">share of the $221.36</span></div>
      <div style="padding:6px 15px 10px">
        <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid {t['soft']}"><span>Inbound calls</span><span class="n">$99.32 · 45%</span></div>
        <div class="bar" style="margin-bottom:6px"><i style="width:45%"></i></div>
        <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid {t['soft']}"><span>Outbound calls</span><span class="n">$65.69 · 30%</span></div>
        <div class="bar" style="margin-bottom:6px"><i style="width:30%"></i></div>
        <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid {t['soft']}"><span>Caller ID lookups</span><span class="n">$43.00 · 19%</span></div>
        <div class="bar" style="margin-bottom:6px"><i style="width:19%;background:{t['warn']}"></i></div>
        <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid {t['soft']}"><span>Services (transcription, voices, storage, pay line)</span><span class="n">$10.00 · 5%</span></div>
        <div class="bar" style="margin-bottom:6px"><i style="width:5%"></i></div>
        <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid {t['soft']}"><span>Texting</span><span class="n">$6.00 · 3%</span></div>
        <div class="bar" style="margin-bottom:6px"><i style="width:3%"></i></div>
        <div style="display:flex;justify-content:space-between;padding:9px 0"><span>Numbers &amp; 911</span><span class="n">$2.35 · 1%</span></div>
        <div class="bar"><i style="width:1%"></i></div>
        <div class="hint" style="margin-top:12px;padding:10px 12px;border:1px solid {t['warnsoft']};background:{t['warnsoft']};border-radius:8px;color:{t['ink']}">Caller-name lookups cost more than all texting and numbers together. If that surprises you, the same screen on every customer will show whether it is only Gesheft's call volume.</div>
      </div>
    </section>
  </div>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1280,"height":1180}}}}'>
class Component extends DCLogic {{
  renderVals() {{ return {{}}; }}
}}
</script>
</body>
</html>"""

def rates_board(t):
    def r(what, carrier, rate, unit, src, cls):
        return f"""<tr><td>{what}</td><td>{carrier}</td><td class="r"><input class="n" type="text" value="{rate}" aria-label="{what} rate" style="width:96px;text-align:right;font-size:13px;padding:5px 8px;border:1px solid {t['line']};border-radius:6px;background:{t['panel']};color:{t['ink']}"></td><td class="dim">{unit}</td><td><span class="pill {cls}">{src}</span></td></tr>"""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Catalog — carrier rates</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
{helmet(t)}
<div style="width:1280px;height:980px;box-sizing:border-box;padding:20px 24px;display:flex;flex-direction:column;gap:16px;background:{t['bg']};color:{t['ink']}">
  <nav class="nav" aria-label="Billing"><a href="#m">This month</a><a href="#c">Customers</a><a href="#i">Invoices</a><a href="#p">Payments</a><a href="#n">Needs you</a><a class="on" href="#k">Catalog</a></nav>
  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
    <div><h2 style="margin:0;font-size:22px;letter-spacing:-.02em">Catalog → What the carriers charge us</h2>
    <div class="hint" style="margin-top:4px;font-size:13px">One place for every rate the cost card multiplies by. A carrier feed overrides a typed rate automatically; a typed rate is only used where no feed exists.</div></div>
    <div style="display:flex;gap:8px"><button class="btn" type="button">Cancel</button><button class="btn primary" type="button">Save rates</button></div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:16px;align-items:start">
    <section class="card">
      <div class="hd"><h3>Calls</h3><span class="hint">per started minute</span></div>
      <table>
        <thead><tr><th>What</th><th>Carrier</th><th class="r">Rate</th><th>Unit</th><th>Where it comes from</th></tr></thead>
        <tbody>
          {r("Inbound to a per-minute number","VoIP.ms","0.0090","$ / min","Feed: per-call cost","ok")}
          {r("Inbound to a Telnyx number","Telnyx","0.0035","$ / min","Feed: per-call cost","ok")}
          {r("Outbound, primary","Telocall (0001)","0.0075","$ / min","Typed — no API","warn")}
          {r("Outbound, backup","VoIP.ms","0.0100","$ / min","Feed: per-call cost","ok")}
          {r("Outbound, Loopcom Demo only","SignalWire","0.0065","$ / min","Feed","ok")}
          {r("International","Telocall / VoIP.ms","by country","$ / min","Feed where it exists","warn")}
        </tbody>
      </table>
    </section>
    <section class="card">
      <div class="hd"><h3>Texting &amp; caller ID</h3><span class="hint">per message / per lookup</span></div>
      <table>
        <thead><tr><th>What</th><th>Carrier</th><th class="r">Rate</th><th>Unit</th><th>Where it comes from</th></tr></thead>
        <tbody>
          {r("Text sent or received","VoIP.ms","0.0075","$ each","Typed — list price","warn")}
          {r("Picture message sent or received","VoIP.ms","0.0200","$ each","Typed — list price","warn")}
          {r("Text sent","Telnyx","0.0040","$ each","Feed: cost on each message","ok")}
          {r("Text received","Telnyx","0.0000","$ each","Feed","ok")}
          {r("Caller-name lookup (CNAM)","VoIP.ms","0.0080","$ each","Typed — list price","warn")}
          {r("Caller-name lookup (CNAM)","Telnyx","0.0050","$ each","Feed","ok")}
        </tbody>
      </table>
    </section>
    <section class="card">
      <div class="hd"><h3>Monthly per number</h3></div>
      <table>
        <thead><tr><th>What</th><th>Carrier</th><th class="r">Rate</th><th>Unit</th><th>Where it comes from</th></tr></thead>
        <tbody>
          {r("Number, per-minute plan","VoIP.ms","0.85","$ / mo","Feed: DID info","ok")}
          {r("Number, flat-rate plan","VoIP.ms","4.25","$ / mo","Feed: DID info","ok")}
          {r("Number","Telnyx","1.00","$ / mo","Feed","ok")}
          {r("911 registration","VoIP.ms","1.50","$ / mo","Feed: DID info","ok")}
          {r("911 registration","Telnyx","1.00","$ / mo","Feed","ok")}
          {r("Texting registration campaign (10DLC)","Telnyx","1.50","$ / mo","Feed","ok")}
        </tbody>
      </table>
    </section>
    <section class="card">
      <div class="hd"><h3>Services we run</h3><span class="hint">vendor list price × what we metered</span></div>
      <table>
        <thead><tr><th>What</th><th>Vendor</th><th class="r">Rate</th><th>Unit</th><th>Where it comes from</th></tr></thead>
        <tbody>
          {r("Voicemail &amp; call transcription","OpenAI Whisper","0.0060","$ / min","Typed — list price","warn")}
          {r("Menu voices (neural)","Amazon Polly","16.00","$ / 1M chars","Typed — list price","warn")}
          {r("Menu voices (premium)","ElevenLabs","0.30","$ / 1k chars","Typed — plan price","warn")}
          {r("Recording storage","S3","0.023","$ / GB-mo","Typed — list price","warn")}
          {r("Assistant / agent answers","OpenAI &amp; Claude","by tokens","$","Feed: usage API","ok")}
        </tbody>
      </table>
      <div class="hint" style="padding:10px 15px;border-top:1px solid {t['line']}">Rates are versioned: changing one applies from today; closed periods keep the rate they were costed at.</div>
    </section>
  </div>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1280,"height":980}}}}'>
class Component extends DCLogic {{
  renderVals() {{ return {{}}; }}
}}
</script>
</body>
</html>"""

def customer_board(t):
    months = [("Sep 3 – Oct 3","in progress · day 15",450.41,112.40,None),("Aug 3 – Sep 3","CC-202608-00026",450.41,221.36,50.9),("Jul 3 – Aug 3","CC-202607-00019",450.41,205.12,54.5),("Jun 3 – Jul 3","CC-202606-00021",435.41,198.77,54.3),("May 3 – Jun 3","CC-202605-00014",435.41,176.03,59.6),("Apr 3 – May 3","CC-202604-00011",435.41,181.90,58.2)]
    rows=""
    for p,inv,rev,cost,m in months:
        if m is None:
            rows+=f"""<tr><td>{p}<div class="src">{inv}</div></td><td class="r n">${rev:.2f}</td><td class="r n">${cost:.2f}<div class="src">so far</div></td><td class="r n dim">—</td><td style="width:220px"><div class="bar"><i style="width:{int(cost/rev*100)}%;background:{t['muted']}"></i></div></td><td><span class="pill info">Running</span></td></tr>"""
        else:
            marg=rev-cost
            rows+=f"""<tr><td>{p}<div class="src"><a href="#i">{inv}</a></div></td><td class="r n">${rev:.2f}</td><td class="r n">${cost:.2f}</td><td class="r n" style="color:{t['good']}">${marg:.2f} · {m}%</td><td style="width:220px"><div class="bar"><i style="width:{int(cost/rev*100)}%"></i></div></td><td><span class="pill ok">Closed</span></td></tr>"""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Customer — cost and margin by month</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
{helmet(t)}
<div style="width:1280px;height:760px;box-sizing:border-box;padding:20px 24px;display:flex;flex-direction:column;gap:16px;background:{t['bg']};color:{t['ink']}">
  <nav class="nav" aria-label="Billing"><a href="#m">This month</a><a class="on" href="#c">Customers</a><a href="#i">Invoices</a><a href="#p">Payments</a><a href="#n">Needs you</a><a href="#k">Catalog</a></nav>
  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
    <div><h2 style="margin:0;font-size:22px;letter-spacing:-.02em">Gesheft Supermarket</h2>
    <div class="hint" style="display:flex;gap:8px;align-items:center;margin-top:4px;font-size:13px"><span class="pill ok">Autopay · day 3</span><span>Amex •1007</span><span>·</span><span>6 extensions · 1 number · texting on</span></div></div>
  </div>

  <section class="card">
    <div class="hd">
      <div style="display:flex;align-items:center;gap:10px"><h3>What they cost us, month by month</h3><span class="pill warn">Office only</span></div>
      <span class="hint">bar = cost as a share of what they paid · the whole customer list gets a "Margin" column from the same numbers</span>
    </div>
    <div style="display:flex;gap:10px;padding:14px 15px 4px">
      <div class="tile"><div class="k">Last 6 closed months</div><div class="v n">$2,657.46</div><div class="s">paid to us</div></div>
      <div class="tile"><div class="k">Cost us</div><div class="v n">$1,163.58</div><div class="s">43.8% of revenue</div></div>
      <div class="tile" style="border-color:{t['good']}"><div class="k" style="color:{t['good']}">Margin</div><div class="v n" style="color:{t['good']}">$1,493.88</div><div class="s">trend: cost up 22% since April — inbound minutes, mostly</div></div>
      <div class="tile" style="border-color:{t['warn']}"><div class="k" style="color:{t['warn']}">Watch</div><div class="v n n">CNAM</div><div class="s">$43/mo on lookups — 19% of their cost</div></div>
    </div>
    <table style="margin-top:8px">
      <thead><tr><th>Service period</th><th class="r">They paid</th><th class="r">Cost us</th><th class="r">Margin</th><th>Cost share</th><th>Period</th></tr></thead>
      <tbody>{rows}</tbody>
    </table>
  </section>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1280,"height":760}}}}'>
class Component extends DCLogic {{
  renderVals() {{ return {{}}; }}
}}
</script>
</body>
</html>"""

files = {
 "Main.dc.html": invoice_board(LIGHT, "Invoice — office view, light"),
 "Invoice-dark.dc.html": invoice_board(DARK, "Invoice — office view, dark"),
 "By-number-and-day.dc.html": drill_board(LIGHT),
 "Carrier-rates.dc.html": rates_board(LIGHT),
 "Customer-months.dc.html": customer_board(DARK),
}
for name, html in files.items():
    with open(os.path.join(ROOT, name), "w", encoding="utf-8", newline="\n") as f:
        f.write(html)

canvas = {
  "v": 3,
  "createdOnFiles": {"v": 1, "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
  "title": "Customer Cost Breakdown",
  "launch": {"view": "canvas"},
  "pages": [],
  "boards": {
    "Main.dc.html": {"x": 0, "y": 0, "w": 1280, "h": 1640, "title": "1 · Invoice page with the cost card (light)"},
    "Invoice-dark.dc.html": {"x": 1360, "y": 0, "w": 1280, "h": 1640, "title": "1b · Same, dark theme"},
    "By-number-and-day.dc.html": {"x": 0, "y": 1760, "w": 1280, "h": 1180, "title": "2 · Drill-down: by number and by day"},
    "Carrier-rates.dc.html": {"x": 1360, "y": 1760, "w": 1280, "h": 980, "title": "3 · Catalog: the rates we multiply by"},
    "Customer-months.dc.html": {"x": 0, "y": 3060, "w": 1280, "h": 760, "title": "4 · Customer page: month by month"},
  },
  "order": ["Main.dc.html", "Invoice-dark.dc.html", "By-number-and-day.dc.html", "Carrier-rates.dc.html", "Customer-months.dc.html"],
  "notes": {
    "t1": {"x": 0, "y": -240, "text": "What each customer costs us — office-only, on their invoice", "kind": "title1", "maxW": 2640},
    "s1": {"x": 1360, "y": 3060, "w": 560, "text": "Volumes are Gesheft's REAL Aug 3 – Sep 3 numbers from our call log and chat table (11,036 inbound min, 8,759 outbound, 783 texts, 5,375 named inbound calls). The rates and the service costs are illustrative until the carrier feeds are wired and Izzy confirms the Telocall rate. The customer never sees any of this: the card is not in the PDF, the email, or the customer portal.", "color": "orange"},
    "s2": {"x": 1960, "y": 3060, "w": 560, "text": "Three honesty tiers on every line — Carrier CDR (their per-call record), Our minutes × rate (Telocall has no API), Estimated (we metered it, priced at list). Outbound goes over the shared 0001 trunk, so it can only ever be our minutes × the Telocall rate unless Telocall gives us an export.", "color": "blue"}
  },
  "designSystems": []
}
with open(os.path.join(ROOT, "canvas.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(canvas, f, indent=1)
print("ok", list(files))
