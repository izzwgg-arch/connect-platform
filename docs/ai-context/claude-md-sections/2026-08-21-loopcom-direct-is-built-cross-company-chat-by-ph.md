# ⛔⛔ AGENT HANDOFF — Loopcom Direct is BUILT: cross-company chat by phone number + the video call that starts from it (2026-08-21) — READ FIRST before touching `apps/api/src/loopcomDirect/*`, `/direct` routes, the `LoopcomDirect*` models, or before adding ANY tenant filter to a Direct query

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_LOOPCOM_DIRECT_BUILD_2026-08-21.md`**
(`d0e98b96` + `c1f8caa5` + `59f5671e` on `feat/ivr-migration-takeover`.
✅✅ **api + portal DEPLOYED and PROVEN LIVE 2026-08-21** — both containers at
`8d033759` (all three commits confirmed ancestors), migration applied **15:35:35Z**
with all 6 `LoopcomDirect*` tables present, **0 identity rows so the feature is
inert**, health 200 on both hostnames, and all four read routes probed live with a
self-signed SUPER_ADMIN token: `/direct/me` → `200 identity:null`,
`/direct/threads` → `200` empty, a junk number → the plain-English refusal, an
unknown number → `not_on_loopcom`. The SUPER_ADMIN nav gate is grepped in the
shipped bundle, so customers cannot see it. No PBX write, no env change, no
tenant row touched.
✅ **RE-VERIFIED LIVE 2026-08-23**, two days and many other deploys later: the
routes are still in `app-api-1` (2 refs + 5 files), the 6 tables are still there
with **0 identities and 0 threads — still inert, nobody has opted in**, the
SUPER_ADMIN nav gate is still in the shipped bundle
(`workspace.direct"!==e.id||"SUPER_ADMIN"===t`), and `/api/health` + `/direct`
answer **200 on both hostnames**.)
⛔⛔ **AND IT COST A REAL 40-MINUTE EXPOSURE WINDOW, which is the lesson: the
first portal build was pinned to `d0e98b96` — the commit BEFORE the nav gate —
because another session's pipeline deploys the BRANCH TIP whenever it likes. A
new customer-facing nav item and its visibility gate must land in the SAME
commit, never as a follow-up.** Built screens rendered with the SHIPPED stylesheet, light
and dark: <https://claude.ai/code/artifact/ee5e08d9-0bab-40fb-89b1-2ddedb2a537a>.
Izzy: *"Build it like this … make everything exactly like the mock-ups. 100%
light mode and dark mode"*, and *"build it on that server first"* (the US media
box is DEFERRED, not cancelled).

- ⛔⛔ **IT IS INERT ON DEPLOY, AND THAT IS THE DESIGN.** No
  `LoopcomDirectIdentity` row = a person cannot be found, cannot be messaged, and
  sees only a "verify your number" card. **Nothing changes for any existing
  customer until somebody verifies their own mobile number.**
- ⛔⛔ **THERE IS NO `tenantId` FILTER IN `directRoutes.ts` AND A GUARD TEST
  ENFORCES THAT.** A Direct thread spans two tenants, so a tenant filter returns
  nothing for every real conversation. Isolation is **per USER** — every route
  resolves the caller's own participant row first; a non-participant gets **404**,
  never 403. ⛔ Every `ConnectChat*` model still carries its required `tenantId`
  and none of that machinery was touched.
- ⛔⛔ **NO ORACLE: `decideLookup` returns a DEEP-EQUAL `{kind:"not_found"}` for
  five different truths** — not on Loopcom, findable off, they blocked you, you
  blocked them, their company switched off. The test asserts **deep equality**,
  not "all not_found": an extra field on any one of them IS the leak and would
  pass a kind-only assertion.
- ⛔ **The anti-spam property is one branch**: while the other side has not
  accepted, the sender is capped at the ONE message they already sent. Without it
  "requests" delays spam by a single tap. ⛔ A pending request also leaks **no read
  receipt**, and **cannot start a call** (`decideCanCall` needs BOTH sides ACTIVE).
  ⛔ Declining tells the sender **nothing** — asserted.
- ⛔ **Every privacy rule is a pure function in `directPolicy.ts`; routes call
  them and never re-derive one inline** (the two-IVR-publish-paths defect shape).
- ⛔⛔ **THE VIDEO CALL DOES NOT RING A PHONE, ON PURPOSE.** It creates a
  `VideoMeeting` row (the SAME table `/meetings` uses — one video system, not two)
  and posts the join link into the thread. `INCOMING_CALL` is the only type the
  native service rings on and borrowing it would make the phone try to answer a
  SIP call that does not exist. A real `INCOMING_VIDEO_CALL` needs an **app
  build** — Phase 3, not done. ⛔ The row is created directly rather than through
  the SUPER_ADMIN-only `POST /meetings`; that gate is about who may HOST a room,
  not about two people already talking. Do not "fix" it.
- ⛔⛔ **`{ prefix: "/direct", permission: "can_view_workspace_chat" }` in
  `PORTAL_API_PERMISSION_RULES` is the ONLY thing gating the surface — without it
  a new prefix has NO permission check at all** (the `/admin/wake-health` bug).
  Guard-tested. It reuses the CHAT key deliberately: a new grantable key would not
  reach TENANT_ADMIN without a live snapshot refresh, so it would ship denying
  everybody (the Meetings precedent).
- ⛔ **Light/dark: bare `:root` is DARK, light is the opt-in override, and the
  screen must never theme off `prefers-color-scheme`** (the OS setting, which
  disagrees with the app's own toggle). ⛔⛔ **INK vs FILL** — display colours as
  TEXT measure **2.15–3.76:1** on the light panel (unreadable); the `--lcd-ink-*`
  tokens measure **5.38–5.93:1**. Fills keep the display colour. Verified live:
  the pill computes `#0f7a4a` light / `#34c27b` dark. ⛔ The prefers-color-scheme
  guard **must strip comments** or it matches the doc block explaining the rule —
  fifth time in this repo.
- ⛔ **Decisions as built** (he said "build it like this" over a page carrying
  recommendations): **requests-mode ON**, **verified personal mobile** as
  identity, **opt-in by verification**. ⛔ `Tenant.loopcomDirectEnabled` defaults
  **true** on purpose — verification is the real lock, and defaulting it off would
  mean Izzy cannot try the feature without a DB write.
- ✅ **VERIFICATION TEXTS REALLY SEND — checked live, not assumed.**
  `resolveBillingSmsSender` returns `testMode: true` unless
  `SMS_PROVIDER_TEST_MODE` is explicitly `"false"`, and in `app-api-1` it **is**
  `false`, with `BILLING_SMS_FROM_NUMBER=8457231213`. So the first verification
  costs a real SMS from **(845) 723-1213**, Connect's own number — the same
  sender as billing pay-links. The verify screen still reports test mode honestly
  if that ever changes, rather than claiming a text was sent.
- ✅ **Proven:** 42 api tests (23 policy + 19 routes through a real Fastify) + 14
  portal, all registered; **both positive source guards fail replayed against
  `HEAD`**; api typecheck **0 errors in any new file**; portal typecheck 0, suite
  279/281 (the two documented pre-existing); adjacent api suites 35/35.
- ⏳ **NOT PROVEN: nobody has opened the screen, no message has been sent between
  two real people, no code has been texted.** Mobile is untouched (Phases 2 and 3
  both need an app build). Acceptance in §10 of the handoff — and **the negatives
  matter most**: a number that is not on Loopcom must read EXACTLY like one whose
  owner blocked you.
