# AGENT HANDOFF — cross-tenant call-record leak, contacts cap, iOS modal keyboard trap (2026-08-02)

Read this before touching CDR tenant attribution, the contacts list, or ANY iOS
`<Modal>` that contains a text input.

---

## 1. ⛔ CROSS-TENANT LEAK — calls were written into other companies' history

**The most serious thing found this session.** Not a display bug — real customer
call records, with their recording pointers, filed under the wrong company.

### Proof (PBX is the source of truth — always)

```
PBX:      13:54:00  3479780090 -> 8455577768  dcontext T102_cos-all  ANSWERED
Connect:  13:54:00  filed under Landau Home (T21)
```
PBX said tenant **102** (Loopcom Demo). Connect wrote **21** (Landau Home).

**PBX-verified sweep, 7 days:** 16,047 PBX records → 3,517 matched to Connect →
**116 filed under the WRONG company (3.3%)**, 11 real customers, both directions.
100% of them via `tenantResolutionSource = telephony_connect_tenant_id`, 0% via
any other path.

### Root cause

`resolveCdrTenant()` (`apps/api/src/pbxTenantResolve.ts`) took the
telephony-supplied tenant id and **trusted it outright** — it verified only that
the claimed tenant had *some* linked PBX record, never that the link matched THIS
call. The call's own markers (`dcontext`, `channels`) were passed in and
discarded on that path.

And the telephony service that produced those labels had two defects of its own
(`CallStateStore.ts`): attribution was gated on `!call.tenantId` so **the first
leg to arrive won permanently** (~3% = how often a weak leg arrives first), and
`resolveTenantFromCdrFields` **could not read the `T<n>_` marker at all** — only
slug contexts like `ext-local-a_plus_center`.

### The rule this establishes

**Asterisk stamps the owner into the call itself** — `dcontext T102_cos-all`,
channel `PJSIP/T102_101_1-…`, `Local/111@T8_queue-…`. That marker comes from the
PBX, cannot be forged upstream, and is authoritative. Attribution order is now:

1. **PBX tenant marker on the call** (unforgeable)
2. **the DID the PBX actually routed on** (unforgeable, synced from the PBX)
3. the caller's claim — **only when there is no evidence at all**

⛔ **Fail closed.** A claim that disagrees with the marker is REJECTED, not
preferred. Conflicting markers across legs resolve to NOTHING rather than picking
a side — choosing one is exactly how records landed in the wrong company. An
unattributed record is recoverable; a record in another company's history is not.

### Shipped

| Commit | What |
|---|---|
| `05952fb5` | API: PBX marker authoritative, claim rejected on disagreement, `cdr_tenant_claim_rejected_cross_tenant` alarm, 9 tests |
| `d6c657ff` | API: DID resolution moved AHEAD of the claim (fixes calls with no `T<n>_` marker, e.g. trunk-only `PJSIP/344022_Comfortcont`) |
| `bfaed99e` | Telephony: reads the marker, and a strong signal now CORRECTS a weak earlier guess. Logs `[TENANT_CORRECTED]` — every line is a call that would have been mislabelled |
| `c279247c` | Hourly inbound-DID sync + alarm when any call lands with no owner |

**116 historical records corrected**, re-verified 116 → 2 (the 2 are calls
between two tenants where both legitimately hold a record). Reversal data:
`loopcom:/root/cdr_refile_backup_2026-08-02.json`.

**Voicemail was tested and is CLEAN** — 0 of 34,094 filed under a tenant that
does not own the mailbox. ⚠️ The first voicemail query was WRONG: joining on
extension NUMBER fans out (ext "101" exists in many tenants) and reported 30,000+
phantom leaks — more rows than the table holds. Join on tenant-scoped identity,
and sanity-check any count against the table total.

### Still open

- **DID source gap.** The hourly sync runs, but numbers the PBX actively routes
  are missing from its source (`8452870706` / `8455577096` → Comfort control).
  ~15 calls/month land unattributed because of it. 70 DIDs synced, 47 active.

---

## 2. ⛔ iOS `<Modal>` IS A SEPARATE VIEW HIERARCHY — the recurring trap

**This bit three separate times in one session.** Nothing outside a React Native
`<Modal>` can affect what is inside it.

- **Keyboard covers the sheet.** A screen-level `KeyboardAvoidingView` does NOT
  reach inside a Modal. Every bottom-anchored sheet (`justifyContent:'flex-end'`)
  with a text input needs its OWN `KeyboardAvoidingView` **inside** the Modal.
  iOS only — Android's window soft-input mode already resizes, and stacking both
  double-shifts the sheet.
- **A ScrollView does not save you.** The add-contact sheet already scrolled; the
  scrollable area itself was under the keyboard, so there was nowhere to scroll
  to. Lift AND scroll.
- **`showToast` is invisible from inside a Modal.** It renders in the parent
  screen's tree and is drawn BEHIND the Modal. This made "Open SMS thread does
  nothing" unexplainable for two builds — the button worked and the server
  answered 400, but the reason never appeared. **Use `showAppAlert` inside
  modals** (it presents in its own modal and stacks above).
  ⚠️ Any other `showToast` call made while a modal is open has the same defect.

Fixed: `534b298e` (new-message sheet), `628321ca` (visible SMS errors),
`2ddbd7ca` (BOTH add-contact sheets — `ContactTab.tsx` AND
`components/AddContactModal.tsx` are separate implementations; fixing one leaves
the other broken).

---

## 3. "Can't save contacts" was the 1,000-row cap + a duplicate that named nobody

Eli (Displaydex, iPhone) could not save a contact for a month. **16 save attempts
from iOS, 16 rejections, 0 contacts created since the 31 Jul import.**

`GET /contacts` cut at `take: 1000` ordered by displayName. Displaydex holds
1,247, so 247 contacts — everything after "Sruly Goldberger" — never reached the
phone, and the tab searches only what it downloaded, so they were invisible AND
unsearchable. He kept re-adding people from that invisible tail; the server
correctly said duplicate, and the app named nobody.

Fixed `6e07adfe` (opt-in `limit`+`cursor` paging; no `limit` = the exact legacy
1,000-row response so the unvirtualized portal is untouched; mobile
`getContacts()` walks all pages behind the same signature so every screen is
fixed at once) and `bab31854` (409 carries `existingContact` so the sheet says
WHO holds the number). Over cap: Relax Tires 4,010, Create A Box 2,002,
Displaydex 1,247. Contact delete also added.

---

## 4. SMS "does nothing" = no number linked to the tenant

Loopcom Demo had **zero** rows in `TenantSmsNumber`, so
`resolveOutboundSmsNumber` returned `NO_SMS_NUMBER` → 400 on every attempt
(8 taps, 8 rejections). The tenant's own DID `3479780090` was already in the
table, SMS-capable and active, but with `tenantId = null`.

Fixed by linking it: `tenantId` + `isTenantDefault=true` + `active=true` — which
is exactly what the resolver's 4th lookup matches.

⛔ **Check whether the account can do the thing at all before debugging the app.**
Two builds were spent on real-but-unrelated UI bugs before one query found this.

---

## 5. iOS: the pre-wake was reporting a SECOND CallKit call per call

Every incoming call sent **two** VoIP pushes with different ids — the pre-wake
used the PBX `linkedId`, the real push used the `inviteId` — and CallKit derives
its call identity from that id. Two ids → **two ringing system calls for one
phone call**. Hang up the one Connect is attached to and the other survives:
green pill, a second call screen, hang-up-twice.

```
real call  cmsbtysij07nzqe128y77e7ne -> d0b81c61-5c7c-5ff9-8c96-8ed53c76243d
pre-wake   1785676975.150051         -> a0caa00d-494e-550b-94e6-232d6afa1fef
```

Disabled in `18fedd9d` (one constant, send block kept behind it). It cannot be
re-keyed — at ring time the invite does not exist. Measured head start it bought:
1ms, 1ms, 49ms, 90ms, 1000ms. Introduced by `4291fa3b`.

---

## 6. Working notes

- **iOS builds:** run EAS from `/tmp/connect-ios-build/apps/mobile`, NOT the repo
  root — a stray root `eas.json` shadows the real profiles and fails with
  "Missing build profile". `ios-clean` = installable directly; `ios-prod` = store
  distribution, TestFlight only. Bump `ios.buildNumber` every build.
  This session: 46 → 51.
- **Native iOS call diagnostics** land in `CallFlightSession` with
  `uiMode = 'ios-ring-recorder'` — **not** `VoiceDiagEvent`. Looking in the wrong
  table produced a false "the phone never uploads logs" claim. The log drains on
  every app foreground (was: only on token change).
- Deploys: api via `bash scripts/deploy-direct.sh api --branch feat/ai-agent`;
  telephony via the deploy queue (`POST 127.0.0.1:3910/ops/deploy/enqueue`).
