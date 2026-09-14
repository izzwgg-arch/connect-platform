# ⛔⛔ AGENT HANDOFF — remote support: we can now watch and drive a customer's Windows machine (2026-08-16) — READ FIRST before touching remote support, the desktop app's capture/input code, the LAN phone inventory, or before adding ANY capability that observes or acts on a customer's computer

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_REMOTE_SUPPORT_LAN_PHONES_2026-08-16.md`**
(⛔ **BUILT, TESTED, COMMITTED — NOT DEPLOYED, NOT MIGRATED, NEVER RUN BY A
HUMAN.** No api/portal deploy, no `prisma migrate deploy`, no desktop build
published. Acceptance test in §9 of the handoff.)
Owner's decisions 2026-08-16: build it ourselves (not RustDesk); v1 controls
normal windows only; remote support + phone discovery together; access is a
grantable permission key.

- ⛔⛔ **THE SCREEN NEVER TOUCHES CONNECT'S SERVERS.** Video and every input
  event ride a direct peer connection between the two browsers; the API carries
  only the request, the answer and the few messages that introduce the peers.
  Nothing is recorded and nothing is stored. **Preserve this** — it is what
  makes the feature defensible.
- ⛔⛔ **CONSENT RULES, enforced in `apps/api/src/remoteSupport/policy.ts` (pure,
  35 tests).** (1) **Only the person whose screen it is may consent** — not a
  manager, not a tenant admin. (2) **Control is consented SEPARATELY from
  viewing and a view-only session can NEVER be upgraded** — `controlRequested`
  is what the admin asked, `controlGranted` is what the customer agreed, only
  the consent route writes the latter, and it needs both. (3) **Permissions are
  re-read on EVERY request, never cached onto the session**, so revoking a key
  mid-session kills it at the next action. (4) **Silence ends it** — 10s
  heartbeats, 35s window, 4h ceiling. (5) **The customer's stop button consults
  no permission at all**; a stop button that can refuse is not a stop button.
- ⛔ **Three new keys, ALL absent from BOTH default buckets including
  TENANT_ADMIN** (the Polly pattern): `can_remote_support`,
  `can_control_remote_support`, `can_view_lan_phones`. SUPER_ADMIN gets them via
  the force-add bucket, so **no snapshot migration**. ⛔ **Adding either
  remote-support key to TENANT_ADMIN would silently let every tenant admin watch
  their employees' screens** — `portalPermissions.remoteSupport.test.ts` exists
  to make that loud.
- ⛔⛔ **THREE TEST-REGISTRATION TRAPS FOUND, ALL THE SAME SHAPE — a new test
  does NOTHING until the runner names it.** `packages/shared` listed neither
  `portalPermissions.queues.test.ts` **nor** `portalPermissions.tenantComm.test.ts`,
  so **both had never run once**; apps/api globbed `src/agentProvisioning/` but
  not `src/remoteSupport/`; **apps/desktop had no `test` script at all.** All
  registered. **Check the runner's file list before believing a test protects
  anything.**
- ⛔ **`getDisplayMedia` DOES NOTHING in Electron without
  `session.setDisplayMediaRequestHandler`** — it hangs or rejects with nothing
  useful in the console. Easiest piece to omit, then debug for an afternoon in
  the portal where the bug is not. It is in `main.ts`.
- ⛔ **The letterbox maths is the subtle one** (`lib/remoteSupportInput.ts`, 24
  tests). The screen shows in a `<video>` with `object-fit: contain`, so there
  are black bars; treating the element's corner as the screen's corner doesn't
  throw and doesn't look broken — every click just lands off, worse toward the
  edges. **A click in a bar produces NO click**, never a clamped one.
- ⛔ **Two real bugs the tests caught:** a malformed coordinate was being clamped
  to `0,0` (turning NaN into "click the top-left corner" — now the command is
  refused), and a sub-threshold scroll was rounded **up** to a full notch (a
  0.1px trackpad twitch became the biggest possible jump — now proportional).
  Also: **`ctrl+c` must be a KEY press, not the text "c"**, and bare modifier
  presses are never sent or they stick down on the customer's keyboard.
- ⛔ **TWO HARD LIMITS THAT ARE NOT BUGS.** (1) **Windows refuses input to
  ELEVATED windows** — UAC prompts and the login screen look frozen; fixing it
  needs a service running as SYSTEM, deliberately deferred. **A code-signing
  certificate does NOT fix this** (the two were confused once already).
  (2) Injection is **Windows-only**, via a PowerShell helper that P/Invokes
  `SendInput` — chosen to avoid native compilation entirely, at the cost that
  **antivirus dislikes PowerShell calling SendInput.** `InputInjector` is an
  interface so a signed native addon is a one-file swap.
- ⛔ **The certificate is deliberately deferred and that is FINE:** existing
  installs get this through the **auto-updater, which does not re-trigger the
  install warning**. Only new installs keep the warning they already have. If
  bought later: Azure Trusted Signing ~$10/mo (⛔ needs the business to be 3+
  years old) or an **EV** cert ~$300–700/yr — ⛔ **a standard OV cert does not
  solve it**, trust is earned by download volume over weeks.
- **The LAN half exists because the MAC on the PBX record is the one thing
  nothing verifies** — the Create A Box ext 102 failure, seven weeks of a stale
  config with a clean 200 in the log. The Windows app sweeps its own /24, reads
  `arp -a`, and reports real MACs. ⛔ **Only private ranges, only /24, explicit
  action only — never on a timer.** ⛔ An empty list is **never** rendered as
  "no phones here": `everScanned`/`scanCount`/`lastRun` are always returned.
- ⏳ **NOT PROVEN, and the list is long:** no screen shared, no mouse moved, **the
  PowerShell helper has never executed**, the banner has never been shown, no LAN
  scanned, neither portal screen opened, **migration not applied**, nothing
  deployed. Proven only as 97 new tests, clean typechecks (portal 0 errors; api
  adds 0 to its 75-error baseline), and the migration verified **column-identical
  to Prisma's own generated DDL**. ⛔ **The negative in the acceptance test
  matters most: a session opened WITHOUT control must do nothing at all when
  clicked.**
- ⛔ **Next step is the actual payoff and is NOT built:** joining discovered MACs
  against the PBX's records. The inventory is collected; the comparison is not
  written.
