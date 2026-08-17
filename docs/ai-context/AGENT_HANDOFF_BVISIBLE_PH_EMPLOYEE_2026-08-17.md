# AGENT HANDOFF — B Visible's Philippines employee: tunnel built, tenant moved to 443, extension NOT yet created (2026-08-17)

Izzy's request: *"set up another extension for him. That employee is in the
Philippines, so we're gonna have to set up a wire guard for him for mobile and
his computer."*

**Live changes made:** two WireGuard peers on loopcom, and one Connect DB row
(B Visible onto the 443 SIP route). **No PBX write. No deploy. No code change.**
⏳ **The extension itself is NOT created** — blocked on the employee's name and
email address.

---

## 1. Who B Visible is (verified live 2026-08-17)

- Connect tenant `cmnlgryp8001lp9pajhatv3t9`, created 2026-04-05.
- VitalPBX tenant **9** — code `T9`, slug `b_visible`, path `2b9df1ace9927067`.
- `TenantPbxLink` status `LINKED`, pbxInstance `cmmi7huxy0000qq3igj493o5q`.
- DIDs: **8452380478**, **8665797575** (toll-free), **8457761311**.
- Office egress: **47.17.126.158** (five desk phones registered from it).

---

## 2. ⛔ 107 AND 108 ARE BOTH TAKEN — and every "V" extension is a forward, not a phone

Izzy asked for **107**, falling back to **108**. Both are occupied. The full T9
map, read from `ombutel.ombu_extensions` joined to `ombu_devices`:

| Ext | Name | Devices |
|---|---|---|
| 101 | Front Desk | pjsip |
| 102 | Yosef Pinches Schnitzer | pjsip |
| 103 | Nechamya Weiss | pjsip |
| 104 | Yoel Perl | pjsip **+ virtual** |
| 105 | Moshe Klein | pjsip **+ virtual** |
| 106 | Gershon Felberboim | pjsip |
| **107** | **Chesky Goldberger** | **virtual ONLY** (device 82) |
| **108** | **"102 V"** | **virtual ONLY** (device 72) |
| 109 | "104 V" | virtual only (device 73) |
| 110 | "101 V" | virtual only (device 83) |

⛔ **A `virtual` device is not a phone — it rings an EXTERNAL number** (the
`number` field / CSV `virtual_number`, see `connect-panel-automation-contract`).
So 107 is a live forward for Chesky Goldberger with no handset behind it, and
108/109/110 are the outside-number forwards belonging to 102/104/101. Deleting
108 would stop extension 102 ringing that outside phone.

**Decision (Izzy, 2026-08-17): use 111** — the next genuinely free number.

⛔ **107 also has NO pjsip device and NO AOR on the PBX**, so it cannot register
and shows no contact. Do not read "no contact for 107" as a fault.

---

## 3. ⛔ THE PHILIPPINES BLOCK IS REAL — and so is the way around it

Proven read-only on the PBX, not assumed:

- `iptables` chain `geo_firewall` carries a per-country blacklist ipset per
  country. **`blacklist_ph` has 1,628 entries and has dropped 77,886 packets.**
  A Philippine address (`49.147.60.42`) tests positive in it. So a device there
  genuinely cannot reach the PBX directly.
- ⛔ **`45.14.194.179` (loopcom) is ALSO in `blacklist_fr`** — the Connect server
  is in France. It works anyway because `INPUT_direct` runs
  **`vpbx_white_list` BEFORE `geo_firewall`**, and loopcom is in the
  `vpbx_white_list` ipset. **Read the chain order before concluding an address is
  blocked** — the blacklist test alone gives the wrong answer for our own server.
- ⛔ **The whitelist already contains four Philippine residential addresses**
  (`120.28.184.152`, `120.28.184.186`, `49.147.38.234`, `143.44.196.225`) —
  somebody has been hand-allowlisting a PH employee's home IP. That is the
  fragile approach the tunnel exists to replace (chasing a changing residential
  address), and ⛔ **the ipset is `maxelem 31` with 15 entries used** — it cannot
  absorb this forever.
- ⛔ The PBX is read-only, so adding a whitelist entry was never an option here
  anyway.

---

## 4. ✅ WireGuard peers — BUILT AND LIVE on loopcom

Script `/root/wg-peers/provision-bvisible-ph.sh` (refuses to run twice, refuses
on IP collision, backs up `wg0.conf` first, never touches an existing peer).

| Device | Tunnel IP | Client config |
|---|---|---|
| Computer | `10.88.0.6` | `/root/wg-peers/bvisible-ph-pc.conf` |
| Phone | `10.88.0.7` | `/root/wg-peers/bvisible-ph-phone.conf` (+ `bvisible-ph-phone.png` QR) |

Both are in the running kernel (`wg show wg0`) **and** persisted into
`/etc/wireguard/wg0.conf` — ⛔ `SaveConfig=false`, so a live-only peer vanishes
on reboot; both steps are mandatory. Backup:
`/etc/wireguard/wg0.conf.bak-20260817-*-bvisible`. `wg-quick strip wg0` validates.

Split tunnel, unchanged from the existing recipe:
`AllowedIPs = 209.145.60.79/32, 10.88.0.0/24` — only PBX traffic rides the
tunnel; the portal on loopcom is not geo-blocked and goes direct.

Peer map now: `.2` GL.iNet box (Create A Box office) · `.3`/`.4` the earlier
Philippines employee · `.5` Gesheft ext 101 Brazil **temporary** · `.6`/`.7`
this employee.

⏳ **Nobody has connected with either config.** They are proven as valid
WireGuard configuration, not as a working tunnel.

---

## 5. ✅ B Visible moved onto the 443 SIP route

⛔ **Why this matters more than the tunnel:** the earlier Philippines employee's
peers last handshook **4 and 5 days ago**. A phone that must ring cannot depend
on the user keeping a VPN up. The 443 route removes the VPN from the path
entirely — the app's SIP rides `wss://app.connectcomunications.com/sip`, nginx on
loopcom proxies it to `m.connectcomunications.com:8089/ws`, and the PBX sees
loopcom's whitelisted address. Same mechanism as the tunnel, with nothing to
install and nothing to keep connected.

Applied (Izzy chose "both — 443 route **and** keep WireGuard as backup"):

```
webrtcRouteViaSbc  false -> true
sipWsUrl           "wss://m.connectcomunications.com:8089/ws" -> null
sipDomain          m.connectcomunications.com   (already correct, untouched)
```

⛔ **Nulling `sipWsUrl` is not optional** — `resolveWebrtcConfig` prefers an
explicit `tenant.sipWsUrl`, so leaving the 8089 URL makes the flag a silent
no-op. B Visible's `sipDomain` was already the hostname (not an IP literal), so
this was two fields, not the three the Loopcom Demo case needed.

Verified before flipping: `curl --http1.1` upgrade to
`https://app.connectcomunications.com/sip` → **`101 Switching Protocols`** with
`Sec-WebSocket-Protocol: sip`. ⛔ A plain `curl` returns **426** — that is the
wrong test, not a fault. ⛔ Run it **from loopcom**; Izzy's own line 403s the
`app.` hostname through his content filter.

Read live per request — **no deploy, no restart**. Row now matches Gesheft,
Displaydex, Loopcom Demo and inii mini exactly.

⛔ **Desk phones are unaffected** — they register to 5060 from handset settings.
The flag only changes what the *app* is told at sign-in.
⛔ **Nobody is kicked off, and nobody moves until they sign out and back in** —
the apps never refresh a cached `sipWsUrl`. That is why the flip is safe and also
why it changes nothing today.

---

## 6. ⛔ ADDING THIS EXTENSION WILL NOT MOVE B VISIBLE'S BILL

`TenantBillingSettings.metadata.billingFlatRate` =
`{ enabled: true, appliesTo: "extensions", amountCents: 10500 }`.

`buildExtensionInvoiceLine` (`apps/api/src/billing/billingFlatRate.ts:103`)
returns a **single $105 line, quantity 1**, whenever a flat rate is active — the
count only appears in the description text. So the 11th extension bills exactly
what the 10th did.

Their last two invoices are **$140.00, PAID** (CC-202608-00004, CC-202607-00004),
autopay on, card on file, billing day 5, `billingEmail: ap@bvisible.us`.

⛔ **This inverts the normal rule.** Everywhere else *creating the extension IS
the billing update* (`agent-can-add-billable-things`) — and
`reconcileBillingAfterAddition` **refuses to report success if the monthly total
did not rise**. On a flat-rate tenant it never will. So if this extension is ever
added through the assistant's `action.add_extension` capability, expect that
reconciliation to complain even though nothing is wrong.

Also on this account: `billingQuantityOverrides` pins `phoneNumbers` **manual 2**
and `tollFreeNumbers` **manual 1**. Raised with Izzy; no change made.

---

## 7. ⏳ NOT DONE — the extension itself

Blocked on two facts only Izzy has: **the employee's name** and **his email
address** (the email is the Connect login and where the welcome email with the
app links goes).

Also note: **extensions 105, 106 and 107 have no Connect user at all**
(`ownerUserId: null`). Only four logins exist on this account —
`sales@`, `printing@`, `nechamyaweiss@gmail.com`, `artwork@`. So "add an
extension" here has historically meant a PBX line with no app login. Confirm
which is wanted.

⛔ **Creating the extension is a PBX WRITE** and the PBX is read-only by standing
rule — it needs Izzy's explicit go-ahead, and Apply Changes stays his click.

Two sanctioned paths, both replaying the real routes rather than reimplementing
them (`AGENT_HANDOFF_AGENT_PROVISIONING_2026-08-07.md` §2):
1. **Portal / assistant chat** — Izzy asks for the extension and confirms with
   his own password. Everything (PBX line, SIP device, invite token, welcome
   email with the APK link, audit rows) is byte-identical to clicking the buttons.
2. **`POST /pbx/extensions` then `POST /admin/users`** signed as the confirming
   admin. ⛔ `/pbx/extensions` stamps `ownerUserId` with its creator and
   `/admin/users` then refuses that extension (409 `extension_already_assigned`)
   — ownership must be handed back in between.

Per `connect-panel-automation-contract`, Izzy's standing per-extension rule is
`incoming_rec=yes`, `outgoing_rec=yes`, `vm_enabled=yes`, and every extension
gets **PJSIP + WebRTC** devices (WebRTC is what the app and the computer use —
without it the 443 route has nothing to register).

---

## 8. Acceptance test

1. Employee installs the WireGuard app — QR on the phone
   (`bvisible-ph-phone.png`), `bvisible-ph-pc.conf` on the computer. Confirm
   `wg show wg0` shows a **recent handshake** on `10.88.0.6` / `10.88.0.7`.
2. **Then turn WireGuard OFF and sign into the Connect app.** It should still
   register — that is the proof the 443 route is doing the work and the tunnel is
   only a fallback.
3. `asterisk -rx "pjsip show contacts" | grep T9_111` → `Avail`. ⛔ The PBX
   contact list is the fact; the app's own "registered" is an opinion.
4. Ring extension 111 from the office and answer it in the Philippines.
5. ⛔ Existing B Visible app users must **sign out and back in** to pick up the
   new SIP address. Until they do, they stay on 8089 — which still works, so
   nothing breaks and nothing announces itself.

---

## 9. Housekeeping spotted, not acted on

- **Gesheft ext 101's Brazil peer (`10.88.0.5`) is still installed** and has
  **never handshaken** (no endpoint at all). It was flagged "revoke on return" on
  2026-08-02. Removal is `wg set wg0 peer grxye+j8hU5ZW6ZTwfOV7aprncxcBEqJ5th1bt/YPFA= remove`
  plus deleting its `[Peer]` block from `wg0.conf`. **Needs Izzy's word.**
- **The earlier Philippines employee (`.3`/`.4`) is on a stale tunnel** — 4 and 5
  days since a handshake. If that person still needs to work, their tenant is a
  candidate for the same 443 flip. **Which tenant they belong to was not
  established** — no `10.88.0.x` contact exists on the PBX right now, so nothing
  tied them to an extension during this session.
