# AGENT HANDOFF — onboarding add-on pricing (cold calling / CRM) + phone-wizard step-1 dead end — 2026-09-16

Commit `014c0399` on `feat/ivr-migration-takeover` (committed with a private index onto the origin tip; the shared index was not touched). Deployed api then portal via `/root/coldcall-crm-deploy.sh` (log `/root/coldcall-crm-deploy.log`); both `success`, both containers `.build-commit` = `014c0399`.

## 1. The ask
Swift Mechanics (a cold-calling company) was mid sign-up. Izzy: $65 per cold-calling extension ("cold calling is always double"), CRM $20/ext, both chosen by the admin on the link BEFORE sending, with "how many extensions" (e.g. 3 extensions: 2 cold calling, 1 regular).

## 2. Design (and why)
- Stored at `OnboardingSubmission.answers.pricing` — no migration. `answers` is REPLACED wholesale by the wizard autosave, so the key is carried in `carryServerOwnedAnswers` (the stored value always wins; a client-sent one is dropped even when nothing is stored). The lazy-create save path now also runs the carry.
- Rejected `internalNotes` (Json column): `PUT /admin/onboarding/submissions/:id/notes` overwrites it with a plain string.
- `quoteInputForSubmission` → `coldCallingExtensions` / `crmExtensions` ("all" = extensions, N = min(N, extensions)). `quoteOnboarding` emits `cold_calling_extensions` (line type EXTENSION) + `crm` (line type CUSTOM). Nothing branches on quote line keys (grepped portal + api).
- `/onboarding/:token/quote` builds its own input from query params; it now re-resolves both add-ons against `liveExtensions`. Source guard in `onboardingAddOnPricing.test.ts`.
- Month 2: `applyOnboardingAddOnBilling(db, tenantId, {coldCallingAll, coldCallingExtensions, crmExtensions})` in `onboardingBillingDefaults.ts`, called after `ensureOnboardingBillingDefaults` on both checkout tenant paths (`onboardingPayment.ts`) and after the orchestrator's stamp (`setupOrchestrator.ts`, logs a timeline event). All cold calling → `extensionPriceCents = 6500` (recounts live). Partial → `$35×N` recurring custom line (taxable false = final amount). CRM → `$20×N` line. Lines tagged `source:"onboarding_addon"`; re-runs replace only those.
- Admin: `createInvitationSchema` + `createPublicLinkSchema` accept `coldCalling`/`crm` `{enabled, extensions: "all"|int|null}` (full links only). New `PUT /admin/onboarding/submissions/:id/pricing` (requireOwner; 409 after `paidAt`). Portal `/admin/onboarding` form: two checkboxes + count ("blank = all").
- `inviteEmail.test.ts` gate guard counted only get/post/delete handlers; widened to put/patch (stricter).
- ⚠️ Race: the pricing PUT is read-modify-write on `answers`; an autosave that read the row before the PUT and wrote after would drop it. Low risk; re-check the row after setting.

## 3. Phone-wizard dead end (live customer)
`mobileWizard.tsx`: phone step 0 = company + "you" (email + cell); desktop step 0 = company + names, with email/cell on desktop step 1. Swift Mechanics' journey: "Reached Contact after 17s on Company" = the DESKTOP `goNext` event, then the ≤640px layout rendered step 1 = address only, and `validateStep(1)` demanded `mainPhone` → "A valid phone number is required." with no field. The autosaved answers confirmed email + cell empty. Fix: in `continueFrom`, step 1 with invalid email/cell → `back()` to "you" + message. Before the fix the customer's only escape was the ‹ back arrow.

## 4. Live state
- Swift Mechanics `cmu4kauj00hufli1ktnu7zt17`: `answers.pricing = {coldCalling:{extensions:"all"}, crm:{extensions:"all"}}` stamped by DB after the api deploy (timeline event written). Live `/quote?extensions=1|2|3` → $90 / $175 / $260.
- ⛔ Stamp ONLY after an api that carries `pricing` is live — the old carry would wipe it on the next autosave.

- Later 09-16: customer restarted on a second link `cmu4no5ms0epepb12sk6bvztk` (office@swiftmechanics.net) — reached step 5 with NO pricing; stamped by DB (jsonb_set, atomic). Izzy then dropped CRM: both rows now `{coldCalling:{extensions:"all"}}`, live `/quote` = $70 for 1 ext. No invoice existed at either change.

## 5. Tests
- api `src/onboarding/*.test.ts`: 475/500; the 25 failures = 24 setupOrchestrator + 1 pbxTenantBuild, **identical on HEAD** (all 11 touched files swapped to HEAD and re-run: setupOrchestrator 7 pass / 24 fail).
- New `onboardingAddOnPricing.test.ts` 8/8; `quoteInput.test.ts` expectations extended; shared `onboardingPricing.test.ts` 16/16; portal `onboardingSignalWireWizard.test.ts` 9/9 (the new guard cannot pass on HEAD — its anchor does not exist there). tsc: 0 errors in touched api/portal files.

## 6. Not proven / open
- An autosave after the stamp on the live row; the real checkout invoice total; month-2 lines on a real tenant; the admin checkboxes clicked in a browser; the phone fix on a real phone.
- No UI to edit pricing on an existing link (route only). The invitation list does not show the add-ons.
- CRM billing does not enable CRM access. Partial/CRM counts freeze at build.
- ⚠️ File-swap replays: a Windows file lock failed the restore once (`OSError 22`); the scratchpad backups saved it. Never swap without a backup.
