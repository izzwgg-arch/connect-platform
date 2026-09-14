# ⛔ AGENT HANDOFF — REMOTE DESKTOP as a CUSTOMER feature is MOCKUPS ONLY, six decisions open (2026-09-02) — READ FIRST before building any customer-facing remote access, before loosening `decideConsent`, or before adding audio to a remote session

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_REMOTE_DESKTOP_MOCKUPS_2026-09-02.md`**
(**Mockups only — no code, no migration, no deploy, no PBX write, no desktop build.**)
Mockups: <https://claude.ai/code/artifact/8796c75d-4089-431a-874a-b93265a647e8>.
Memory: [[remote-desktop-mockups-only]]. Izzy, 2026-09-02: *"elevate the remote desktop
feature to a new feature to offer my clients … remote log in to their own desktops … an ID
and password … move the microphone and speaker to the remote computer … a separate page.
Show me mockups before you build anything."*

- **The shape drawn:** a Workspace page `/remote-desktop` (after Meetings) with My
  computers cards, connect-by-ID (permanent 9-digit Connect ID per machine + a password the
  owner issues with expiry Once / 24 h / Until removed and scope Only-my-company /
  Anyone-on-Loopcom), a share-this-computer dialog, a live-session toolbar where Sound and
  Mic are two switches saying where each is, a SECOND tray toggle "Allow Remote Desktop to
  this computer" with a **USERNAME AND PASSWORD set AT the machine** (Izzy, 2026-09-02 —
  not a bare PIN; separate from the Loopcom login), and the same always-on-top banner +
  Stop. ⛔ **Connect ID + password is Loopcom app → Loopcom app ONLY** (Izzy, same day) —
  the ID card is inert in a browser tab. Remote Support stays under Admin; one engine, one
  kill switch.
- ⛔⛔ **THIS IS NOT A RE-SKIN OF REMOTE SUPPORT — three engine rules stand in its way and
  must be EXTENDED, not loosened:** the engine refuses standing consent by design (own-PC
  unattended access IS standing consent → a new grant type verified at the machine);
  sessions bind to a USER, `deviceId` is self-reported (a Connect ID needs minted machine
  identity — Phases 3/4, unbuilt); audio is never captured on any path (sound OUT = Chromium
  loopback capture, ordinary; **mic INTO the remote computer needs a virtual audio driver in
  the installer — the biggest single piece**). New routes get their own prefix; the
  `{ prefix: "/remote-support", permission: null }` rule is untouched.
- ⏳ **Decisions waiting on Izzy (§3 of the handoff):** A mic driver in two steps, B
  cross-company by ID, C standing passwords, D lock screen pass-through only, E browser as
  controller, F machine identity. **Do not start building before he answers.** ⛔ And no
  remote support session has EVER run between two machines — run that acceptance test
  before building more on the same engine.
- **Toggles that ship with it when built:** `workspace.remote_desktop`, In-sidebar switch,
  custom-role toggles for `can_use_remote_desktop` / `can_connect_by_id` /
  `can_share_own_computer`.
