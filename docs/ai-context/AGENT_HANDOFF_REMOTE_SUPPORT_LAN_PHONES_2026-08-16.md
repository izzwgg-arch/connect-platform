# AGENT HANDOFF — remote support (watch + control a customer's Windows machine) and desk-phone discovery on their network (2026-08-16)

**Read this before touching remote support, the desktop app's input/capture
code, the LAN phone inventory, or before adding any capability that can observe
or act on a customer's computer.**

⛔ **STATUS: BUILT, TESTED, COMMITTED. NOT DEPLOYED, NOT MIGRATED, AND NEVER RUN
BY A HUMAN.** No api deploy, no portal deploy, no `prisma migrate deploy`, no
desktop build published. Nobody has watched a screen, moved a mouse, or scanned
a network with this. Every claim below is proven by tests, typechecks and the
generated Prisma DDL — **not** by a real session. The acceptance test is in §9.

Owner's decisions, 2026-08-16, in his words: build it ourselves rather than
RustDesk; v1 sees and controls normal windows (no Windows service, so no UAC);
both remote support and phone discovery shipped together; access is a permission
key others can be granted. Certificate deliberately deferred — see §8.

---

## 1. What this is, in one paragraph

A staff member with the right permission can ask a customer to share their
Windows screen. The customer gets a prompt showing who is asking and why, picks
which screen, and separately decides whether that person may also use their
mouse and keyboard. While it is live an always-on-top red banner says so and can
stop it. Separately, the Windows app can look at the customer's own network and
report which desk phones are on it — their real MAC addresses, which is the one
thing in phone provisioning that nothing currently verifies.

⛔ **The screen never touches Connect's servers.** Video and every input event
ride a direct peer connection between the two browsers. The API carries only
the request, the answer, and the few messages needed to introduce the two peers.
There is no recording, nothing stored, and nothing at rest to secure. **Preserve
this property** — it is the reason this feature is defensible.

---

## 2. The rules the design enforces, and why each exists

These are in `apps/api/src/remoteSupport/policy.ts`, as pure functions with 35
tests, deliberately separate from the Fastify handlers. If you find yourself
writing an `if` about who may do what inside a route, it belongs in the policy.

1. ⛔ **Only the person whose screen it is may consent.** Not their manager, not
   a tenant admin, not Connect. There is no standing consent, no "always allow".
   A tenant admin approving on an employee's behalf is precisely the abuse this
   refuses.
2. ⛔ **Control is consented SEPARATELY from viewing, and a view-only session
   can never be upgraded.** `controlRequested` is what the admin asked for;
   `controlGranted` is what the customer agreed to. Only the consent route ever
   writes the latter, and it requires **both** to be true. Upgrading means a new
   request, which means a new dialog the customer has to read.
3. ⛔ **Permissions are re-read on every single request, never cached onto the
   session.** Revoke someone's key mid-session and their next action fails. This
   is why `actorFacts()` hits `userHasActionPermission` every time.
4. ⛔ **Silence ends the session.** Both sides heartbeat every 10s; either going
   quiet for 35s ends it, plus a hard four-hour ceiling. A session that outlives
   the window showing the banner is a screen being watched with nobody's banner
   up, and that must be impossible rather than unlikely.
5. ⛔ **The customer's stop button never consults a permission.** `decideEnd`
   has no permission check at all. A stop button that can refuse is not a stop
   button.

---

## 3. Permissions

Three new keys in `packages/shared/src/portalPermissions.ts`:

| Key | What it allows |
|---|---|
| `can_remote_support` | Request and watch a session |
| `can_control_remote_support` | Also request and use mouse/keyboard |
| `can_view_lan_phones` | See the desk-phone inventory |

⛔ **All three are absent from BOTH default buckets — including TENANT_ADMIN** —
exactly like `can_use_amazon_polly`. They are granted per person through a
custom role. SUPER_ADMIN gets them automatically via the force-add bucket, so
**no `PlatformRolePermissionSnapshot` migration is needed.**

⛔ **If a future change adds either remote-support key to TENANT_ADMIN "so admins
can help their own staff", every tenant admin on the platform silently gains the
ability to watch their employees' screens.** `portalPermissions.remoteSupport.test.ts`
exists to make that loud.

⛔ Per [[custom-roles-are-authoritative]], a custom role created before these
keys existed simply lacks them (fails closed) and needs them ticked on.

---

## 4. What was built, file by file

**Shared** — `portalPermissions.ts` (+3 keys), `portalPermissions.remoteSupport.test.ts` (7 tests).

**Database** — migration `20260816200000_remote_support_and_lan_phones`:
`RemoteSupportSession` (consent state machine + audit), `RemoteSupportSignal`
(WebRTC relay), `LanDiscoveryRun`, `LanDiscoveredPhone`. Two enums.
✅ **Verified column-identical to Prisma's own generated DDL** — all four tables,
every index and FK (recipe in §7).

**API** —
- `remoteSupport/policy.ts` + `policy.test.ts` (35 tests) — every decision.
- `remoteSupportRoutes.ts` — request / pending / status / consent / heartbeat /
  signal (post + drain) / input / end / history.
- `lanPhoneVendors.ts` + test (12 tests) — MAC normalisation, OUI vendor lookup.
- `lanPhoneRoutes.ts` — start run, report findings, inventory, run history.
- Registered in `server.ts` beside the onboarding routes.

**Desktop** —
- `remoteSupport/inputInjector.ts` + test (19 tests) — the PowerShell/SendInput
  helper and the command sanitiser.
- `remoteSupport/lanScan.ts` + test (12 tests) — subnet selection, TCP sweep,
  ARP parsing.
- `remoteSupport/mainWiring.ts` — IPC, screen enumeration, the banner.
- `remoteSupport/bannerPreload.ts` — the banner's own tiny bridge.
- `main.ts` — `setDisplayMediaRequestHandler` (see §6), IPC registration,
  teardown on quit. `preload.ts` / `types.ts` — the bridge surface.

**Portal** —
- `lib/remoteSupportInput.ts` + test (24 tests) — the letterbox coordinate maths
  and browser-event translation.
- `lib/remoteSupportGuards.ts` — receive-side validation.
- `services/remoteSupport.ts` — API calls + `RemoteSupportPeer`.
- `components/RemoteSupportConsent.tsx` — the customer's prompt, mounted
  globally in `app/providers.tsx`.
- `app/(platform)/admin/remote-support/page.tsx` — the support console.
- `app/(platform)/admin/lan-phones/page.tsx` — the inventory.
- `globals.css` — a `.rs-*` / `.lp-*` block.

---

## 5. ⛔ Traps that cost real time here, so they do not cost it again

- ⛔ **THREE separate test-registration traps, all the same shape.** The shared
  package, apps/api and apps/portal each name test files or globs explicitly.
  A new test does **nothing** until it is registered. Found and fixed:
  `packages/shared` did not list `portalPermissions.queues.test.ts` **or**
  `portalPermissions.tenantComm.test.ts` — **both had never run** (they were
  green; they simply never executed). apps/api globbed `src/agentProvisioning/`
  but not `src/remoteSupport/`. apps/desktop had **no test script at all**.
  All now registered. **Check the runner's file list before believing a new
  test protects anything.**
- ⛔ **`getDisplayMedia` does nothing in Electron without
  `session.setDisplayMediaRequestHandler`.** The call hangs or rejects in the
  renderer with nothing useful in the console. This is the single easiest piece
  to leave out and then spend an afternoon debugging in the portal, where the
  bug is not.
- ⛔ **The letterbox maths.** The support person sees the screen in a `<video>`
  with `object-fit: contain`, so there are black bars. Treating the element's
  corner as the screen's corner does not throw and does not look broken — every
  click just lands slightly off, worse toward the edges, which is miserable to
  debug live. A click **in a bar produces no click at all** rather than a
  clamped one, because clamping puts a click where nobody aimed.
- ⛔ **Two bugs the tests caught that review would not have.** (1) A malformed
  coordinate was being clamped to `0,0` — turning NaN into "click the top-left
  corner". Now the whole command is refused. (2) A sub-threshold scroll was
  being rounded **up** to a full 120 notch, so a 0.1px trackpad twitch became
  the largest possible jump. Now proportional, and zero is dropped.
- ⛔ **`ctrl+c` must be a KEY press, not the text "c".** Otherwise "copy" types
  a letter over whatever the customer had selected.
- ⛔ **Bare modifier presses are never sent** — they leave modifiers stuck down
  on the customer's keyboard.
- ⛔ **ICE candidates routinely arrive before the description they belong to.**
  Adding one early throws, and if that escapes, the connection silently never
  completes. They are queued and flushed.
- ⛔ **`assert.strictEqual` uses `Object.is`, so `-0 !== 0`.** Normalised in the
  function rather than papered over in the test.
- ⛔ **A Next.js App Router `page.tsx` may only default-export a component**, and
  `tsc --noEmit` does not catch a named export — it dies in the deploy build.
- ⛔ **`apps/portal/tsconfig.tsbuildinfo` is tracked and dirtied by `tsc`.**
  Restore it before committing (done here).

---

## 6. The two hard limits, which are NOT bugs

1. ⛔ **Windows refuses input from a normal app to an ELEVATED window.** UAC
   prompts, the login screen and parts of Settings will look frozen to the
   support person. Fixing that needs a background service running as SYSTEM —
   a deliberate, separate decision that was explicitly deferred. **A code-signing
   certificate does NOT fix this**; the two are unrelated and were confused once
   already.
2. ⛔ **Input injection is Windows-only** and rides a PowerShell helper that
   P/Invokes `SendInput`. Chosen over a native addon so there is no native
   compilation, no `electron-rebuild`, no ABI pinning and no build-pipeline
   change. **The cost: antivirus dislikes PowerShell calling SendInput — it is
   genuinely what malware looks like.** Expect false positives until the app is
   signed. `InputInjector` is an interface precisely so this can be swapped for
   a small signed native addon later as a one-file change.

---

## 7. How to verify what is claimed here

```bash
# Every test this work added or rescued
cd packages/shared && npx tsx --test src/portalPermissions.remoteSupport.test.ts
cd apps/api      && node --experimental-test-module-mocks --import tsx --test "src/remoteSupport/*.test.ts" src/lanPhoneVendors.test.ts
cd apps/desktop  && npx tsx --test src/remoteSupport/*.test.ts
cd apps/portal   && npx tsx --test lib/remoteSupportInput.test.ts
```

Proving the hand-written migration matches the schema, with **no database**:

```bash
cd packages/db
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > /tmp/full_ddl.sql
# then diff the CREATE TABLE bodies against the migration — all four were identical
```

---

## 8. Certificate, deliberately deferred (owner's call)

The installer is **unsigned today**, so new installs already show the blue
"Windows protected your PC" screen. This feature does not make that worse:
⛔ **existing installs receive it through the auto-updater, which does not
re-trigger the warning.** What is given up by not signing: new installs keep
that warning, and antivirus false positives are more likely.

If/when it is bought: Microsoft's Azure Trusted Signing (~$10/mo) is cheapest but
**requires the business to be 3+ years old**; otherwise an **EV** certificate
(~$300–700/yr). ⛔ **A standard OV certificate does not solve it** — trust is
earned by download volume over weeks, so you would pay and still be flagged.

---

## 9. ⏳ NOT PROVEN — the honest list, and the acceptance test

**Nothing here has been run by a human.** Specifically:

- ⏳ No screen has ever been shared, no mouse moved, no key typed.
- ⏳ The PowerShell input helper **has never been executed** — its command
  vocabulary is unit-tested, the C# has never run.
- ⏳ The banner has never been displayed.
- ⏳ No LAN has been scanned; `parseArpTable` is tested against captured output,
  not a live `arp -a`.
- ⏳ Neither portal screen has been opened in a browser.
- ⏳ **The migration has NOT been applied** and the four tables do not exist in
  production.
- ⏳ The api, portal and desktop app are **not deployed/published**.

**Acceptance test, in order:**
1. Apply the migration; confirm the four tables exist.
2. Deploy api + portal. Grant yourself the three keys (SUPER_ADMIN has them).
3. Build and publish the desktop app; restart it on a second machine.
4. From `/admin/remote-support`, request a session **with control** against that
   machine's user. Confirm the prompt names you and shows your reason verbatim.
5. Tick control, allow, pick a screen. Confirm: video appears; the red banner is
   on top of everything; the mouse moves where you click, **including near the
   edges** (this is the letterbox maths); typing works; `ctrl+c` copies.
6. Press Stop on the banner. Confirm the session ends on both sides immediately.
7. Check `/admin/remote-support` history shows the session with a non-zero
   "Typed" count.
8. **The negative that matters most:** open a session **without** control and
   confirm clicking does nothing at all.
9. From the desktop app, run a network scan and confirm a phone's MAC matches
   what the PBX panel holds for it.

---

## 10. Deliberately not built

- The Windows service for UAC-level control (§6).
- Any comparison of discovered MACs against the PBX's records — the inventory is
  collected, the join is not written. **This is the obvious next step and the
  actual payoff.**
- Reading a phone's model/firmware from its web page (the columns exist and are
  accepted by the report endpoint; nothing populates them yet).
- Agent automation. ⛔ When it comes: have the agent drive **structured**
  actions (the phone's own settings, the PBX, Connect) and use the screen to
  *see*. An agent clicking by pixel is fragile and hard to audit — the same
  principle as "a text may only say YES to a prepared draft".
- Any scheduled/background scanning. ⛔ **Scanning is an explicit action only.**
  A support tool that inventories a customer's network on a timer is a different
  product, and the difference is consent.

---

## 11. Pre-existing failures noticed in passing (NOT from this work)

- `apps/api` — `androidApkInviteUrl.test.ts`: *"the invite template renders the
  link in both HTML and plain text"* fails on `HTML body must carry the button
  label`. Almost certainly drift from the Loopcom rebrand rewriting the invite
  email's button. Plus the 7 known `pbxTenantDirectorySync` failures.
- `apps/portal` — `campaignsIndexLayout.test.ts` (asserts the campaigns page
  does **not** reference `CRMWorkspaceShell`; it now does) and
  `webrtcSdpDiagnostics.test.ts` (*"flags an offer with no acceptable codec"*).

**None of these are in files this work touched**, and all four were confirmed
failing in committed code.
