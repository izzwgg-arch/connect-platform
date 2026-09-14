# ⛔ AGENT HANDOFF — the bottom-right "Incoming Call / Unknown caller / Dismiss" card (CRM screen pop) is REMOVED for every tenant; the ringing softphone is the ONLY incoming-call surface (2026-09-08, `04b23b11`) — READ FIRST before adding any incoming-call pop-up, toast or card to the portal or desktop

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(**portal only** — no api, no telephony, no migration, no env, no PBX write. Memory: [[no-second-incoming-call-popup]].)
Izzy, 2026-09-08, screenshot of the white card on the dark portal: *"Just remove those notifications
completely. I don't want to see those incoming call notifications in the main tenant or any other
tenant. The only incoming call notifications I want to see are the actual incoming calls. That's it.
On the phone you don't need the extra notification."*

- ✅ **GONE: `apps/portal/components/CrmScreenPop.tsx` (deleted) and its `<CrmScreenPop />` mount in
  `layout/AppShell.tsx`** — that shell wraps every `(platform)` page, so this is every tenant and the
  Windows app's main window too. It was a second pop for a ring: one 316 px card per ringing inbound
  external call (83 px looking up / 125 px unknown caller / 277 px matched contact, measured against
  the shipped CSS), living until *its* call left the live feed, hard-coded white (`var(--surface,#fff)`
  — `--surface` is defined nowhere) so it glowed in dark mode, and a comment claimed "only keep one
  pop at a time" while the code stacked them. ⛔ **Do not re-add it, resize it, or replace it with a
  toast.** Guard: `apps/portal/lib/noIncomingCallScreenPop.test.ts` (3 tests, registered in the
  package `test` list, green on the dev box via the Node 26 type-strip harness).
- ⛔ **What the "actual incoming call" surfaces are, all untouched:** the floating dialer's own
  incoming card (`FloatingDialer.tsx`, 288 × 345 px, only when YOUR extension rings), the Windows
  mini dialer window (360 × 640 default, user-resized, `showMiniForIncomingCall`), the Android
  CallStyle heads-up / full-screen ring, the in-call `CallWaitingBanner`. Also untouched:
  `GET /crm/contacts/lookup` and the WS `crm*` enrichment fields (dialer + live workspace use them),
  `cdrHook`'s after-the-fact CRM_INBOUND_CALL notification/toast to the contact's owner (60 s poll,
  not a live ring — the next candidate if Izzy names it).
- ✅ **Phone: nothing to change.** The Android wake-placeholder "Incoming call — connecting…" heads-up
  (`postWakePlaceholderNotification`) has **no call site** since 2026-07-07 — only the definition and
  three `cancelWakePlaceholderNotification` calls remain — so the CallStyle ring is already the only
  notification a ring produces there.
- ⛔ **I first built the wrong thing:** a half/quarter resize mock-up plus a "newer call gives the
  older card 1 s, then it fades" rule (`lib/screenPopStack.ts`, 8 tests). Izzy cut the feature
  instead; that code was reverted before commit and is NOT in the tree. Do not resurrect it.
- ✅ **DEPLOYED + container-verified 2026-09-08 ~21:08Z** via `ssh connect … bash scripts/deploy-direct.sh portal --commit 04b23b11` (blue/green, build ~5 min, health /login 293 ms). ⛔ The host checkout finished at **`68e17c90`**, not 04b23b11: deploy-portal.sh re-exec'd after advancing and picked up the branch head, which by then carried another session's commit on top of mine (68e17c90 fix(supermarket): Orders Desk status tabs — themed segmented control, no more grey button face;e0c3594d feat(auth): sign-in code v3 — per user on Account → Security, text or email only; tenant switch and authenticator-app enrolment UI removed). So the portal container = 68e17c90 (mine included). Proof: `docker exec app-portal-1 sh -c 'cd /app/apps/portal/.next && grep -rl crm-pop-slide-in .'` → **empty** (the pre-deploy container matched `static/chunks/app/(platform)/layout-2c7c1cd9….js` and `server/chunks/7380.js`); `curl 127.0.0.1:3000/login` → 200. Nothing else deployed (no api).
- Docs updated: `TELEPHONY.md` § CRM screen pop (now the removal note), `RULES.md` rule 39 (now "there
  is NO CRM screen pop"), `CRM.md` match-order note. The Live-workspace copy still says "answer an
  incoming screen pop" in two subtitles (`LiveCallStatusBanner.tsx`, `LiveWorkspaceSessionRail.tsx`)
  — wording only, left alone.
