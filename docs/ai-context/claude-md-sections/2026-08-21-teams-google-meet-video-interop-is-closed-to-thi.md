# ⛔⛔ AGENT HANDOFF — Teams / Google Meet VIDEO interop is CLOSED to third parties (2026-08-21) — READ FIRST before promising any Teams or Meet video integration, and before anyone proposes a headless-browser meeting bot

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_TEAMS_GOOGLE_MEET_VIDEO_2026-08-21.md`**
(**Research only — no code, no account, nothing filed.**) Izzy, 2026-08-21,
asked about integrating Teams and Google; asked what he pictured, he answered
**"Video calling and meetings"** and **"Google Meet"**.

- ⛔⛔ **THE ANSWER IS NO, AND IT IS STRUCTURAL, NOT PAPERWORK.** **Google Meet's
  Media API is RECEIVE-ONLY** — *"does not support sending of media… into a
  conference"*, enforced in SDP negotiation, still Developer Preview after 18
  months, every participant must be preview-enrolled, and the DPP terms
  **prohibit productising it**. **Meet SIP interop is Pexip-only** (fixed vendor
  dropdown, no "Other"). **A Teams deep link cannot start a meeting** at all.
- ⛔⛔ **NEVER BUILD A HEADLESS-BROWSER MEETING BOT.** Google's Meet AUP:
  *"Do not automate Google's system to place phone calls or send messages
  automatically."* ⛔ A general SaaS might argue the edges — **a company whose
  product IS automated calling cannot.** This is the tempting shortcut and the
  one that risks the Google account.
- ✅ **Loopcom ALREADY OWNS VIDEO** (LiveKit, live end to end) — so this is an
  *interop* question, not a capability gap. Nothing here replaces what works.
- ✅ **THE ONE CLEAN WIN: dial INTO a Google Meet by phone.** `phoneAccess[]`
  went **GA 2026-04-16** and exposes the meeting's **dial-in number + PIN**, so
  Asterisk can originate and send the PIN as DTMF — no bot, no preview, no ToS
  grey area. ⛔ It is **EMPTY on Business Starter and when dial-in is disabled**;
  branch on that or it becomes the top support ticket.
- ⛔ **Create Meet links via the Calendar API with `conferenceDataVersion=1`**,
  never the Meet REST API (`spaces.create` is capped 100/min **platform-wide**).
  ⛔⛔ **Omit `conferenceDataVersion=1` and the conference is SILENTLY DISCARDED
  with a 200 OK.**
- **Also possible, media-free:** a Meet **Add-ons SDK** side panel / Teams
  meeting extension showing CRM context (⛔ `getMeetingInfo()` gives only the
  meeting id — no roster, no audio; Teams apps are unsupported in E2E-encrypted
  calls). ⛔ Teams **AI insights** APIs need a **Copilot** licence.
- ⚠️ **NOT verified: Teams Cloud Video Interop (CVI)** — the direct analogue of
  Pexip-for-Meet. Check it only if Teams video interop becomes a real commercial
  requirement.
- ⛔ **Adjacent research from the same pass answers a DIFFERENT question (voice
  and messaging, not video) and is kept because it is expensive to re-derive:**
  **Asterisk/VitalPBX can NEVER be a certified Teams SBC** (*"We're not
  accepting new nominations for certification until further notice"*) — Direct
  Routing needs a certified SBC in front (anynode is the only **published**
  price, **$53.90/mo for 10 sessions**, multi-tenancy included); ⛔ **there is NO
  free Ribbon production tier** (demo licence, *"not for production… with live
  customer traffic"*); ⛔ **Operator Connect is out of reach** (public ASN + own
  IPv4 + redundant **10 Gbps** PNIs) and **Azure Communications Gateway RETIRED
  2025-10-30**, so any pre-2025 advice citing it is stale; ✅ **Teams message
  APIs stopped being metered 2025-08-25**; ✅ publishing **"Busy — In a call"
  into Teams presence** works (`setPresence` + `Presence.ReadWrite.All`) but
  ⛔ **the Teams client POLLS — "a few minutes" lag, never sell it as real-time**;
  ✅ **Google Voice SIP Link is open to any carrier** but ⛔ **defensive only** —
  every seat moved there stops paying Loopcom ~$30 and starts paying Google, and
  ⛔ **its E911 behaviour is undocumented — get it in writing.**
