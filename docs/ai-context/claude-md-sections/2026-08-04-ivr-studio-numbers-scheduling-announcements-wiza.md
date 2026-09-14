# ⛔ AGENT HANDOFF — IVR Studio: numbers/scheduling/announcements, wizard checkout, ElevenLabs, teams, permissions (2026-08-04) — READ FIRST for IVR Studio, DID switching, onboarding payment, voice generation, or custom-role permission work

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_IVR_YIDDISH_2026-08-04.md`** (3 sessions appended).

- **The wizard has NO payment screen.** Reaching checkout calls
  `POST /onboarding/:token/checkout` (creates tenant + first invoice in the
  background, idempotent, re-lines an UNPAID invoice if the quote changed) and
  hands to `/pay/invoice/[token]` — the real customer checkout. The public pay
  route detects `metadata.source=onboarding_signup`, FORCES card-vault +
  autopay (upsert, not update — a new tenant has no settings row), marks the
  submission paid, and kicks number purchase + PBX build + welcome emails.
  Never rebuild a second card form; that mistake was made and deleted twice in
  one night (wizard inline form, then a bespoke /admin/card-test form).
  `/admin/card-test` = $1 invoice on the same checkout (super-admin, amount is
  a server constant).
- **Number↔menu scheduling** (`didSwitchSchedule.ts` + `DidSwitchSchedule` /
  `IvrAnnouncementSchedule` tables): the Studio's top step picks which DID
  rings a menu and WHEN — exactly two timing options (now / date+time), end
  never / on-a-date. ⛔ **The scheduler never reimplements the flip** — it
  mints a 2-min SUPER_ADMIN service JWT and drives the EXISTING
  `/voice/did/:id/switch-to-connect|switch-to-pbx` via `app.inject`. "Now"
  executes inside the Studio's publish(); dated switches run on a 60s tick,
  retry 30 min, then mark failed + email ADMIN_ALERT_EMAIL. A failed HAND-BACK
  deliberately stays on Connect (the direction that keeps answering).
- **Pre-menu announcements are END-TO-END LIVE**: one AstDB key
  (`connect/t_<slug>/pre_announce`) set/cleared by the same tick; the dialplan
  patch was applied 2026-08-04 under Izzy's one-time PBX mandate (backup
  `/etc/asterisk/extensions__60_custom.conf.bak.pre-announce.20260804T150419Z`).
  Plays ONCE per call (retries jump to `(prompt)`), skips if the file is
  missing.
- ⛔ **`requirePermission(canManageIvr)` is a ROLE-ONLY check** — custom-role
  portal permissions are invisible to it. Every Studio/DID write must use
  `requireRoleOrPortalPermission(..., "can_manage_ivr_routing" | "can_publish_ivr_routing" | "can_manage_ivr_prompts")`.
  Half the Studio's writes had the bare form: a custom role could open the
  Studio and fail every save. **IVR Migration is super-admin only, with NO
  grantable permission** — nav-hidden AND page-gated (`backendJwtRole`).
- **ElevenLabs greeting generation** (`apps/api/src/voice/elevenLabs*.ts`):
  key lives in AgentSecret (same CREDENTIALS_MASTER_KEY as the agent), asks
  for phone-native `pcm_8000` (no conversion at all; 16 kHz fallback → one
  ffmpeg downsample), IVR-tuned defaults, preview saves nothing, generated
  rows are `source:"generated"` = play-only (no download, `no-store`).
  ⛔ ElevenLabs returns **401 for an UNPAID account** — same code as a bad
  key; `classify()` reads `detail.status` first. `usable:false` ≠
  `keyWorks:false`. Never blame the key on status code alone. **A retired-format
  key answers 400, not 401** — and `usable` is decided by `past_due` ALONE now,
  never `has_open_invoices`; see the ElevenLabs key/billing handoff at the top
  of this file before touching any of that.
- **Ring groups / waiting lines** ship from the Studio (`MakeTeam.tsx` →
  `POST /voice/teams`): members arrive as extension NUMBERS, resolved against
  ONE live PBX read that also yields free numbers + tenant path; unknown
  extension = refuse whole request; Apply Changes is NEVER fired.
  ⛔ apps/api must not import undeclared packages (`undici` killed the
  container on boot — blue/green refused cutover; guarded by
  `dependencyHygiene.test.ts`; local `require.resolve` LIES, pnpm hoists).
- **Deploys do not queue**: `deploy-direct.sh` fails fast when the queue has a
  running job (a parallel server session deploys the same branch). Wait on
  `curl 127.0.0.1:3910/ops/deploy/status` until `runningCount:0` — never
  `--skip-queue-check`, never `pgrep`-based waiters (they self-match the
  compound command line; cost three dead SSH sessions).
- Yiddish: every new customer-facing screen registers a PHRASES list +
  `useUiLanguage`; phrases are warmed through Yiddish Labs via the agent's
  `/agent/ui/translate` (warm:true). ~240 phrases warmed this engagement,
  0 failures. Never let a `teams.map((t) => …)` shadow the translator `t`.
