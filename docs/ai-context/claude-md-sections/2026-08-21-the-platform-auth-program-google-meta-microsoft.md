# ⛔⛔ AGENT HANDOFF — the PLATFORM-AUTH PROGRAM (Google / Meta / Microsoft-Outlook / TikTok): RESEARCHED, NOTHING FILED (2026-08-21) — READ FIRST before creating ANY developer account, before quoting a verification lead time, before designing an Outlook or Instagram connect flow, or before telling anyone TikTok has no DM API

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_PLATFORM_AUTH_PROGRAM_2026-08-21.md`**
(**Research only — no code, no account created, no application filed.**)
Izzy, 2026-08-21: *"I want the CRM people to be able to log in to all their
socials and Outlook … login/sign up with Google … For WhatsApp, people are
setting up their WhatsApp … For anything I need, I want to be verified."*

- ⛔⛔ **THE NAME SPELLING IS A SYSTEMIC RISK, NOT A D-U-N-S DETAIL.** D&B, Meta
  and Microsoft **all** verify the entity name against official records and
  demand an exact match (Microsoft also cross-checks the **domain registrar /
  WHOIS**). Three spellings are live: `LoopCom, LLC` (USAC), `loopcom llc.`
  (FCC FRN), `Loopcom` (brand). ⏳ **Nobody has checked the LLC certificate or
  the loopcom.net WHOIS.** That one fact gates four verifications.
- ⛔ **"Verified" is THREE different Meta things**: Business Verification (gates
  Advanced Access) ≠ **Access Verification** (gates *Tech Provider*, ~5 days,
  the one nobody knows about) ≠ **Meta Verified** (a **$15–$500/mo paid
  subscription per asset conferring NO developer access — do not buy it**).
  ⛔ **Facebook + Instagram + WhatsApp are ONE app and ONE chain, not three.**
- ⛔⛔ **DATED CLIFFS:** **Embedded Signup v2 dies 2026-10-15** (build **v4**);
  **Graph mail: mutating non-draft `subject`/`body`/`recipients` needs
  `Mail-Advanced.*` from 2026-12-31** — ⛔ audit the SMS↔email bridge;
  **Messenger tags `CONFIRMED_EVENT_UPDATE`/`ACCOUNT_UPDATE`/
  `POST_PURCHASE_UPDATE` already return error 100** since 2026-04-27.
- ⛔⛔ **OUTLOOK: READING MAIL NEEDS THE CUSTOMER'S TENANT ADMIN, SENDING DOES
  NOT.** A late-2025 policy change (MC1163922) excludes `Mail.Read`/
  `ReadBasic`/`ReadWrite` from user consent in every tenant, **publisher-verified
  or not**; `Mail.Send` is not on that list. ⛔ **`permissions-reference` still
  says `Mail.Read` needs no admin consent — that describes the PERMISSION, not
  the tenant's CONSENT POLICY, which overrides it. Building off that table gives
  an app that works in your dev tenant and fails at every customer.**
  ⛔ The app **must** be registered under a **work/school account** (Loopcom is
  on Google Workspace → **create a free Entra tenant first**); a personal MSA can
  **never** be publisher-verified and an app cannot move tenants.
- ⛔ **TIKTOK: an earlier pass of this file said "no DM API, US excluded, drop
  it". THAT WAS WRONG.** The Business Messaging API is real and **the US IS
  supported**; the excluded regions are EEA/Switzerland/UK. ⛔ **The false
  negative came from searching only `developers.tiktok.com` — messaging lives on
  the SEPARATE `business-api.tiktok.com` portal.** US access needs a **DSPR +
  US Data Security review + USDS Addendum, 6–10 weeks**, and is a
  security-compliance project, not an integration.
- ⛔ **ONE SECURITY EVIDENCE PACK UNLOCKS THREE PROGRAMMES** — Meta's annual DPA
  (⛔ **60-day clock, starts silently via the app's Alert Inbox, ends in
  deactivation**), TikTok's DSPR, and optionally M365 Certification, with
  Google's CASA the same genre. Shared: **SOC 2 / ISO 27001** (short-circuits
  most of Meta's security section), a **pentest**, MFA on admin tooling, ≥30-day
  logs, TLS 1.2+, encryption at rest, service-provider agreements.
- ✅ **Free and immediate: "Sign in with Google"** — `openid`/`email`/`profile`
  are non-sensitive, so **no verification, no warning, no 100-user cap**.
- ⛔⛔ **THE TWO-MINUTE CHECK NOBODY HAS RUN: is `gmail.send` RESTRICTED or
  SENSITIVE?** Restricted ⇒ **CASA, ~$540–$1,800/yr, REPEATING ANNUALLY**;
  sensitive ⇒ a 3–5 day review and no CASA. The Cloud Console scope picker
  labels it inline. ⏳ Blocked: the live client is
  `1004420523742-…apps.googleusercontent.com` (**project `1004420523742`**) and
  **which Google account owns it is UNKNOWN**. ⛔ The `$50,000 CASA` figure is a
  myth. ⛔ **Scope minimisation (send-only + `drive.file`) may remove the cost
  entirely** — check before budgeting.
- 🔴 **Live bug, no approval needed:** the OAuth client is registered for
  `app.connectcomunications.com` only, so **Gmail/Drive connect is broken on
  `app.loopcom.net`**.
- ⛔ **Repo reality:** Google Gmail/Drive is the ONLY working third-party OAuth;
  **`graph.facebook.com` appears nowhere**; Microsoft/Instagram/TikTok are
  absent; WhatsApp is a front door with **no transport**. There is **no OAuth
  abstraction** — the Google flow is hand-rolled twice. ⛔ The clean extension
  point is **`ProviderCredential` + the `IntegrationProvider` enum** plus ONE
  shared OAuth module; the inbox seam is `ConnectChatThreadType` + per-type
  adapter dispatch behind the existing `/chat/threads` routes.
- ⛔ **Instagram: use the Instagram Login path** (no linked Facebook Page, two
  permissions instead of four+). ⛔ **The #1 cause of "connected but no messages
  arrive" is the customer's own Instagram toggle** — Settings → Messages and
  story replies → Message controls → **Connected Tools → Allow Access to
  Messages**. Put it in the onboarding copy.
- ⛔ **WhatsApp onboarding throughput is capped at 10 new customers per rolling
  7 days** until BV + App Review + Access Verification all clear (then 200).
  Pricing is **per message since 2025-07-01, billed to the customer**, and free
  inside the 24-hour service window — ⛔ **the cost model must track that window
  per conversation; per-conversation amortisation is now wrong.**
- ⛔ **App Review needs a SEPARATE screencast per permission** (1080p+, monitor
  ≤1440px, **no audio**, showing both the grant AND the use), plus **≥1
  successful API call per permission within 30 days** before submitting.
