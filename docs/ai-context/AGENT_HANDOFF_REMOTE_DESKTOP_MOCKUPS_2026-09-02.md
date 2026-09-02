# AGENT HANDOFF — Remote Desktop as a CUSTOMER feature: mockups only, six decisions open (2026-09-02)

**Status: MOCKUPS ONLY. No code, no migration, no deploy, no PBX write, no desktop build.**
Izzy, 2026-09-02: *"I want to elevate the remote desktop feature to a new feature to offer
my clients that they can set up. They have multiple desktops, so they can remote log in to
their own desktops. If they want to log in to somebody else's computer that already has a
Loopcom app, you can make an ID and password for them to be able to connect. Also, an option
to move the microphone and speaker to the remote computer as well. Make it a separate page.
Then the remote support. Show me mockups before you build anything."*

**Mockups:** <https://claude.ai/code/artifact/8796c75d-4089-431a-874a-b93265a647e8>
(eight sections, light + dark, portal tokens verbatim, Inter / JetBrains Mono).

Read with `AGENT_HANDOFF_REMOTE_SUPPORT_LAN_PHONES_2026-08-16.md` (the engine),
`AGENT_HANDOFF_REMOTE_SUPPORT_HARDENING_2026-08-31.md` (kill switch, tiers, transcript,
the two real bugs) and `AGENT_HANDOFF_DESKTOP_REMOTE_SUPPORT_TEST_BUILD_2026-09-01.md`
(the argv gate). Nothing in those three has changed.

---

## 1. What was drawn

| # | Screen | What it settles |
|---|---|---|
| 1 | **Remote Desktop home** (`/remote-desktop`, Workspace, after Meetings) | My computers as cards (online / offline / unattended-or-not / this computer), connect-by-ID form, "let someone connect to this computer" card with the permanent 9-digit Connect ID, recent connections incl. Loopcom support sessions |
| 2 | **Connecting to my own computer** | The machine's own access password (set AT the machine, hash kept there), monitor pick, sharp/smooth, sound → here, my mic → there, clipboard — all before connect |
| 3 | **Live session** | Toolbar as the whole control surface; Sound/Mic as two switches stating where each is; Ctrl+Alt+Del and Send-a-file drawn greyed; Good/Poor/Measuring readout; the remote Loopcom ringing a call answerable from the controller's seat |
| 4 | **Share this computer** | Generate a password (shown once), expiry Once / 24 h (default) / Until removed, scope Only my company (default) / Anyone on Loopcom, per-capability ticks (control on, sound on, mic OFF, clipboard off, admin windows unavailable) |
| 5 | **Tray toggle at the computer** | "Allow Remote Desktop to this computer" beside the existing "Allow Remote Support", the access-password dialog, next-launch semantics, Windows lock screen passed through never bypassed |
| 6 | **Remote machine banner** | Always-on-top banner names the connected person + audio routing + Stop; mid-session ask (e.g. mic) inside the banner with an equal No |
| 7 | **Remote Support vs Remote Desktop** | Comparison table + the toggles that must ship with the page |
| 8 | **Decisions** | Six, each with a recommendation |

## 2. Why this is not a re-skin of Remote Support

Grounded in the deployed engine (`apps/api/src/remoteSupport/policy.ts`, `controls.ts`,
schema `RemoteSupportSession`):

- ⛔ **The engine refuses standing consent BY DESIGN** ("no auto-accept, no remember, no
  standing permission" — `RemoteSupportConsent.tsx` rule 1). Own-computer unattended access
  IS standing consent. It needs a new grant type created at the machine, protected by a
  password the machine itself verifies. This must not be done by loosening `decideConsent`.
- ⛔ **Sessions are bound to a USER (`targetUserId`), not a machine.** `deviceId` is
  self-reported (hardening handoff §7: "an identifier, not an attestation"). A Connect ID
  that means one specific installation needs machine identity — a key minted on first run
  and proven per connection (Phases 3/4, still unbuilt).
- ⛔ **Audio is never captured on any path today** (test build handoff §4). Sound OUT of
  the remote computer is Chromium loopback capture (`getDisplayMedia` audio on Windows) —
  ordinary. Mic INTO the remote computer, so its Loopcom and every program hear it as a
  microphone, needs a **virtual audio device driver installed with the app**. That is the
  largest single piece of work in the feature. Decision A proposes shipping in two steps.
- ⛔ **Permission rule stays `{ prefix: "/remote-support", permission: null }`** for the
  existing routes (hardening handoff §5). New Remote Desktop routes get their own prefix
  and their own rules; do not fold them under the support prefix.
- ✅ Carries over unchanged: WebRTC over our coturn (`/voice/ice-servers`), the Electron
  banner, `RemoteSupportEvent` transcript (closed vocabulary, never a secret), heartbeat
  staleness, the global kill switch (must end Remote Desktop sessions too), the argv gate
  (a SECOND tray switch, OFF by default, key absent when off).

## 2b. ✅ Izzy's clarifications, 2026-09-02 (mockups updated to match, same URL)

Verbatim: *"for somebody that wants to have unattended online access to his computer it
has to set a username and password. The ID and password are only from Loopcom to Loopcom
app."*

- **Own computers: a USERNAME and password**, set at the machine from the tray dialog,
  asked on every connect, separate from the Loopcom login, hash kept only on that machine.
  Not a bare PIN/password. Decision C is therefore settled for own computers (standing by
  nature) and open only for the shared-password expiry on someone else's computer.
- **Connect ID + password is Loopcom app → Loopcom app ONLY.** The connect-by-ID card is
  live in the Windows app and reads as a note ("Open the Loopcom app on this computer to
  connect by ID") in a browser tab. Decision E is settled for the ID path; the one residual
  question is whether OWN computers may be reached from a browser (recommendation: app-only
  for now, one rule everywhere).

## 3. The six decisions (verbatim from the mockup)

- **A · Mic into the remote computer.** Recommend two steps: (1) sound follows you + the
  remote Loopcom's calls answered by the controller's Loopcom (no driver); (2) virtual
  microphone driver so any program works.
- **B · Cross-company by ID.** Recommend both, owner's choice per password, default
  "Only people in my company". Crossing companies is what lets Loopcom support connect on a
  customer-issued password without a consent dialog.
- **C · Standing passwords.** Recommend allowed, default 24 h, every standing password
  listed on the computer's card.
- **D · Windows lock screen.** Pass-through only; never store or type a Windows credential.
  Lock screen accepts injected input; UAC/admin prompts still do not (no SYSTEM service).
- **E · Browser as controller.** Allow. The reached computer must run the app; the
  controlling side may be a browser tab.
- **F · Machine identity.** Build it — invisible to customers, and it is what makes a
  Connect ID mean one machine.

## 4. What ships with the page when built (the fourth standing rule)

- `workspace.remote_desktop` → `/remote-desktop` in `navConfig.ts`, Workspace, after Meetings.
- In-sidebar switch on `/admin/permissions`; permission toggles in `/admin/roles/[id]`.
- Keys: `can_use_remote_desktop`, `can_connect_by_id`, `can_share_own_computer`.
  Proposed buckets: TENANT_ADMIN all three, END_USER the first. Existing
  `can_remote_support` / `can_control_remote_support` untouched.

## 5. ⏳ Not done

Everything. No decision answered, no code, and — still — no remote support session has
ever run between two machines (test build handoff §7). The acceptance test for THAT is a
prerequisite worth running before building on the same engine.
