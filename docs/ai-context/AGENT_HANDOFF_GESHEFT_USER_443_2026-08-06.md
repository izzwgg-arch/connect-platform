# AGENT HANDOFF — Gesheft ext 114: the missing user, then the machine that couldn't register (2026-08-06)

Session scope: "gesheft 114 still doesn't have a user in connect" → root-caused and
fixed → "114 is in but not registered" → root-caused to ONE computer → Gesheft
flipped to SIP-over-443 on Izzy's word.

Identities used throughout:

| Thing | Value |
|---|---|
| Tenant Gesheft | `cmnlgnumu0001p9g6xyl1pbdd` (PBX tenant **T8**, `pbxTenantId "8"`) |
| Extension 114 "Accounts Receivable" | `cmnmd7qo7008tp9b0lohm6ejn` |
| Its PbxExtensionLink | `cmnmd7qoc008vp9b0wsaim19o` (`pbxExtensionId "61"`, device `T8_114_1`) |
| New user created | `ap@gesheftkosher.com` = `cmsgdiyg30001tdr78aafptr0` |
| Office egress IP | `66.250.98.9` (Cogent → **Xchange Telecom, Brooklyn**) |

⛔ **Clock note:** the environment reported the session date as 2026-08-06 while the
server and PBX clocks were on **2026-08-05** (curl: `Wed, 05 Aug 2026 18:28 GMT`).
Every raw timestamp quoted below is exactly as the logs wrote it — PBX log lines are
ET, Postgres values are UTC (ET + 4h). Don't "correct" them.

---

## 1. ⛔ THE ROOT CAUSE — the PBX sync will NEVER create a user for an extension that already has an owner

This is the reusable finding. Extension 114 carried `pbxUserEmail = ap@gesheftkosher.com`
on the PBX, yet no Connect account with that email had ever been created — and **no
number of syncs would ever have created one.**

The auto-provision block in `apps/api/src/pbxExtensionSync.ts:537` is gated:

```ts
// 4c. Auto-provision a Connect user from the PBX email (if not already assigned)
if (pbxUserEmail && !connectExt.ownerUserId) {
```

Extension 114 was already owned by the **shared** `contact@gesheftkosher.com` account
(`cmnmjhqzy00ahp96hipt2vy1j`), so `ownerUserId` was non-null and the whole block was
skipped on every single sync, forever. The extension's `pbxUserEmail` column was
faithfully updated to `ap@gesheftkosher.com` each time — so the DB *looked* correct
while the user genuinely did not exist.

**Why this is easy to misread:** nothing errors, nothing logs, and the admin UI shows
an extension with an email on it. The only way to see the problem is to compare
`Extension.pbxUserEmail` against the email of the user in `Extension.ownerUserId`.

**Detection query — run this for any "X doesn't have a user" report:**

```js
// mismatched owners: PBX says one person, Connect assigned another
const exts = await p.extension.findMany({
  where: { tenantId, status: "ACTIVE", pbxUserEmail: { not: null } },
  select: { extNumber: true, pbxUserEmail: true, ownerUserId: true },
});
for (const e of exts) {
  const owner = e.ownerUserId
    ? await p.user.findUnique({ where: { id: e.ownerUserId }, select: { email: true } })
    : null;
  if ((owner?.email ?? null) !== e.pbxUserEmail) console.log(e.extNumber, e.pbxUserEmail, "→ owned by", owner?.email ?? "(nobody)");
}
```

### What was done (both writes DB-confirmed)

1. Created `ap@gesheftkosher.com` in the Gesheft tenant the same way the sync would —
   `role: "USER"`, `displayName: "Accounts Receivable"`, `randomBytes(24).toString("base64url")`
   password bcrypt-hashed at cost 10, i.e. unguessable and unusable until invite/reset.
2. Repointed extension 114's `ownerUserId` from the shared `contact@` account to the
   new user.

Izzy then sent the invite from the admin UI; the user accepted at
`2026-08-05T17:46:03Z` (`USER_INVITE_ACCEPTED` in `auditLog`) and signed in.

### ⛔ OPEN ITEM — two more Gesheft extensions are still mismatched

Same skip rule, same silence. **The sync will never fix these; they need the same
manual treatment (decide the intended owner first — do not assume):**

| Ext | `pbxUserEmail` (PBX truth) | Actually owned by |
|---|---|---|
| 107 "Customer Phone 2" | `tod10950@gmail.com` | `contact@gesheftkosher.com` |
| 109 "Hiring" | `contact@gesheftkosher.com` | `connect@gesheftkosher.com` |

Note 107's PBX email is **Izzy's own alert address** — that one is probably a
leftover, not a real user request. Confirm before creating anything.

---

## 2. "114 is in but not registered" — it was ONE COMPUTER, not the account and not the office

After the user signed in, ext 114's app still would not register. Everything on our
side was provably correct:

- `PbxExtensionLink`: `webrtcEnabled true`, `sipPasswordEncrypted` present,
  `provisionStatus PROVISIONED`, `pbxDeviceName T8_114_1`, `isSuspended false` —
  **byte-for-byte the same shape as ext 101, which works.**
- PBX has the endpoint: `pjsip show endpoint T8_114_1` → exists, `Unavailable`,
  transport `transport-wss-…` (wss). `authT8_114_1` password matches what Connect hands out.
- The user's app fetched credentials successfully **ten times**
  (`VOICE_ME_SIP_PASSWORD_RESET` audit rows, 17:46→17:53Z).
- Desk phone `T8_114` was `REGISTERED` the whole time (two live contacts).

**The evidence that settled it** — `/var/log/asterisk/fail2ban` on the PBX:

```
[2026-08-05 13:54:58] ERROR tcptls.c: Unable to set up ssl connection with peer '66.250.98.9:28295'
[2026-08-05 13:55:18] ERROR tcptls.c: Unable to set up ssl connection with peer '66.250.98.9:35272'
[2026-08-05 13:55:49] ERROR tcptls.c: Unable to set up ssl connection with peer '66.250.98.9:14955'
```

Counted by minute: **zero** such failures before 13:46 ET, then 6 in 13:4x and 19 in
13:5x — starting the exact minute this user first opened the app, retrying every ~30 s.
The TCP connection *reaches* the PBX and then dies **during the TLS handshake**, so the
client never gets far enough to send a REGISTER. That is why there is no auth failure
and no `T8_114_1` REGISTER anywhere in the logs.

⛔ **The control that makes this conclusive:** in the SAME log window, from the SAME
office IP `66.250.98.9`, ext 101's softphone authenticated cleanly:

```
[2026-08-05 13:55:13] SECURITY SuccessfulAuth ... AccountID="T8_101_1" RemoteAddress="IPV4/WSS/66.250.98.9/52898" UsingPassword="1"
```

Same building, same internet line, same port 8089, same second — one machine succeeds,
the other cannot complete TLS. **That rules out the account, the credentials, the PBX,
the tenant config, and the office internet as a whole.** What is left is that specific
computer: filtering/AV software that intercepts TLS and breaks this connection.

**How to apply — the lesson worth keeping:** before blaming a customer's internet or a
tenant's config, find a second device on the same line and compare them in the same
time window. The existing whois-the-contact-IP rule tells you *what kind* of network is
in the path; this tells you whether the network is in the path **at all**. A per-machine
fault and a per-site fault look identical from Connect's side.

### Harmless red herring seen while digging

`grep T8_114_1 /var/log/asterisk/full` is full of:

```
ERROR res_pjsip.c: Endpoint 'T8_114_1': Could not create dialog to invalid URI 'T8_114_1'. Is endpoint registered and reachable?
ERROR chan_pjsip.c: Failed to create outgoing session to endpoint 'T8_114_1'
```

This is **not** a bug. The dial string already fans out to both legs
(`PJSIP/T8_114/sip:…&PJSIP/T8_114/sip:…&PJSIP/T8_114_1`); the desk phone rings fine and
the app leg errors simply because the app is not registered. It will stop on its own the
moment 114's app comes up. Do not "fix" the dialplan for this.

---

## 3. Gesheft is now on SIP-over-443 (done this session, Izzy said "Flip it")

Second tenant on the route after Displaydex. **Copy-the-recipe, not design** — the nginx
side was already built and is shared by all tenants.

**What changed — exactly one row, no PBX write, no deploy:**

```
Tenant cmnlgnumu0001p9g6xyl1pbdd:
  webrtcRouteViaSbc: false → true
  sipWsUrl: "wss://m.connectcomunications.com:8089/ws" → null
```

⛔ **`sipWsUrl` MUST be nulled, not just the flag set.** `resolveWebrtcConfig`
(`apps/api/src/server.ts:711`) prefers an explicit `tenant.sipWsUrl` and only falls back
to `wss://app.connectcomunications.com/sip` when the flag is on. Leaving the old URL in
place makes the flag a silent no-op. Gesheft now matches Displaydex exactly
(`webrtcRouteViaSbc: true`, `sipWsUrl: null`, `sipDomain: m.connectcomunications.com`).

**Verified live** — the 443 doorway completes a real WebSocket upgrade end to end:

```bash
curl -s -i --max-time 10 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Sec-WebSocket-Protocol: sip' https://app.connectcomunications.com/sip
# → HTTP/1.1 101 Switching Protocols
```

(A plain GET to the same URL answers **426 Upgrade Required** — that is healthy, not an
error.)

### What this does and does not touch

- ⛔ **Desk phones are NOT affected, at all.** They register directly to the PBX on 5060
  with settings stored in the handset. `webrtcRouteViaSbc` only changes what the Connect
  **app** is told at sign-in. Gesheft's desk phones — including the physical 114 phone —
  never see this.
- **Nobody is kicked off.** Port 8089 stays open; each app user migrates lazily the next
  time they sign out and back in. Ext 101 kept working untouched.
- **Media path is unchanged** — 443 carries signaling only.
- ⛔ **PBX-side contact-IP whois is now meaningless for Gesheft** (as it already is for
  Displaydex): every app `contactUri` will read loopcom `45.14.194.179`. Use loopcom
  nginx logs for this tenant from now on.

### ⛔ Still pending / not proven

1. **The 114 user must sign out and back in.** The app caches `sipWsUrl` at provisioning
   and never refreshes it, so until they re-login it keeps hitting 8089 and failing
   identically. Nothing else will happen on its own.
2. **The flip is not proven to fix this machine.** 443 is the port every filter passes,
   so it is likely — but if that computer's software breaks *all* intercepted TLS, 443
   can fail too. Success signal to check afterwards:
   `PbxEndpointRegistration` for endpoint `T8_114_1` goes `REGISTERED` with a
   `contactUri` on `45.14.194.179`.
3. **The cheap control test was never run** (the flip was chosen instead): signing into
   the 114 account on the computer that already runs ext 101. If 443 does not fix it,
   run that first — it separates "this machine" from "this account" in two minutes.
4. If it is the machine and the filter can be adjusted, the customer-side fix is
   whitelisting `m.connectcomunications.com:8089` (or now `app.connectcomunications.com:443`).

---

## 4. Environment traps hit this session (each cost a round-trip)

**Prisma model/field names — the schema does not match the obvious guesses:**

- There is **no** `tenantMembership` model and **no** `pbxExtension` model. Users carry
  `tenantId` directly (`p.user.findMany({ where: { tenantId } })`), and extensions are
  `p.extension` (fields `extNumber`, `displayName`, `ownerUserId`, `pbxUserEmail`).
- `User` has **no `name`** field — it is `displayName` / `firstName` / `lastName`.
- `PbxEndpointRegistrationEvent` has **no `createdAt`** and no `eventType` — order by
  **`occurredAt`**, and the fields are `status` / `rawStatus` / `contactUri` / `userAgent`.
- Fastest way to recover from any of these: the error message lists every valid field,
  and `Object.keys(p).filter(k => !k.startsWith('_') && !k.startsWith('$'))` dumps all
  model names.

**PBX read-only access that works from this environment:**

```bash
ssh -i ~/.ssh/connect2_server2_ed25519 -o IdentitiesOnly=yes root@209.145.60.79 '<cmd>'
```

Port 22 with the repo key. (The `pbx` ssh alias pins port 2222 and times out.)

**Where PBX evidence actually lives:**

- `/var/log/asterisk/fail2ban` holds the `SECURITY` events (`ChallengeSent`,
  `SuccessfulAuth`) **and** the `tcptls.c` handshake failures — this is the file that
  proves whether a client is even reaching TLS. `/var/log/asterisk/full` has the
  dialplan/channel narrative but not those.
- ⛔ Both are enormous — `full` and `fail2ban` are ~106 MB each and `fail2ban.1` is
  **5.4 GB**. Always `grep | tail`, never open them whole.

**Connect DB one-liners** run as documented elsewhere:
`ssh connect "docker exec -i -w /app/packages/db app-api-1 node -e '<js>'"`.

---

## 5. State at handoff

- ✅ `ap@gesheftkosher.com` exists, is ACTIVE, owns ext 114, invite accepted, signed in.
- ✅ Gesheft on the 443 route, doorway verified with a real WS handshake.
- ⏳ 114's app: **not yet registered** — waiting on that user's sign-out/sign-in.
- ⏳ Exts 107 and 109 owner mismatches: untouched, need a decision.
- 📄 This doc is new under `docs/`, which is **gitignored** — it needs `git add -f`.
  Nothing was committed this session: CLAUDE.md in this shared working tree also carried
  another session's in-flight edits (build-52 approval, VoIP.ms porting facts), and
  staging it would have swept those into an unrelated commit.
