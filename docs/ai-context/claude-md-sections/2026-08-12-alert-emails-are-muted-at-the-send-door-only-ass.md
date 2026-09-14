# ⛔⛔ ALERT EMAILS ARE MUTED AT THE SEND DOOR; ONLY ASSISTANT ESCALATIONS REACH THE OWNER (verified live 2026-08-12) — READ FIRST before adding ANY alert, before "why didn't I get warned about X", and before assuming an alert reached a human

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


**Verified by reading the running container and the DB, 2026-08-12 — read-only,
nothing changed.** Izzy's directive (2026-08-12), already implemented by another
session: **every automated alert to the alert inbox stops; Assistant escalations
continue.**

- **The mute is ONE gate at the single send door** —
  `processEmailJobsBatch` in `apps/api/src/server.ts:1162`: any
  `EmailJob` with `type === "ADMIN_ALERT"` is set `status SKIPPED`,
  `lastErrorCode "ALERTS_MUTED"`, and never sent. ⛔ **This design is the point:
  gating the CREATION sites would always leak**, because at least seven files
  (`billingEmailLifecycle`, `receiptReconciliation`, `adminSignupReport`,
  `journeyTracking`, `setupWatchdog`, `portLanding`, `portWatchdog`) create
  `ADMIN_ALERT` rows **without** going through `sendAdminAlert`. Do not "improve"
  this by moving the check upstream.
- ⛔ **It is CODE in the running image, not a shell script with a timer.** Last
  week's `/root/alert-email-killswitch.sh` self-expired and alerts silently
  returned for five days. This survives restarts and deploys. Verify with
  `docker exec app-api-1 grep -c ALERTS_MUTED /app/apps/api/src/server.ts` → `1`.
- **Nothing bypasses it: the api is the ONLY sender of `EmailJob` rows.** The
  worker merely *creates* them (its `status: "SENT"` writes are all
  `SmsMessage`/CRM tables, not `EmailJob`).
- ✅ **PROVEN OFF, not assumed:** last `ADMIN_ALERT` with a real `sentAt` was
  **2026-08-12T01:08Z**; **36 rows SKIPPED `ALERTS_MUTED`** from 02:18Z to
  23:44Z. Rows are still created on purpose — **they are the audit trail**, and
  reading them is now the only way to see what the platform tried to warn about.
- **58 `ADMIN_ALERT` rows sit `FAILED` at `attempts=5`** (Aug 5–6, the mail-quota
  casualties). The processor only takes `attempts < 5`, so ⛔ **they can never
  fire** — do not "retry" them.
- ✅ **Escalations work, both halves, proven live:** `apps/api/src/agentEscalationDispatch.ts`
  turns each `AgentEscalation` row into an SMS **and** an `EmailJob` of type
  **`AGENT_ESCALATION`** — the only mail category the gate lets through. Two real
  dispatches on 2026-08-12 (02:21, 03:05) both carry `smsSentAt` **and**
  `emailQueuedAt` with `lastError: null`; both emails show `SENT`.
  SMS → **(562) 209-6644 + (845) 723-1213**, from **(845) 557-7768**, capped at
  **40/rolling 24h** so a runaway agent cannot text all night. ⛔ **Escalation SMS
  writes NO `SmsMessage` row** — querying that table returns "none" and looks
  like a failure; read `AgentEscalation.smsSentAt` instead.
- ⛔ **Two suppression mechanisms now look alike — tell them apart by
  `lastErrorCode`, never by status.** `ALERTS_MUTED` = this gate (owner
  directive). No code / a `decideAdminAlert` log line = the **40-per-rolling-24h
  ceiling** in `packages/shared/src/adminAlertBudget.ts`, which still exists
  underneath and still works.
- **Agent-side alert channels are muted DELIBERATELY, and belt-and-braces:** the
  daily digest and the `[Watchman CRITICAL]` toll-fraud warnings run through
  `apps/agent/src/notify/notifier.ts:73`, which filters recipients listed in
  **`AGENT_MUTED_ALERT_RECIPIENTS` (default `tod10950@gmail.com`)** and returns
  `{sent:false, reason:"recipient_muted"}`. On top of that `app-agent-1` has
  **zero SMTP env vars**, so today they are `recorded to audit only` anyway.
  ⛔ The real fragility is not SMTP — it is that **the filter matches on the
  literal address**: change `ADMIN_ALERT_EMAIL` (or the owner's address) without
  updating `AGENT_MUTED_ALERT_RECIPIENTS` and the agent's alerts start flowing
  again silently.
- **Customer mail is untouched and must stay that way:** `BILLING_INVOICE_READY`,
  `BILLING_RECEIPT`, `BILLING_PAYMENT_LINK`, `USER_INVITE` all still send, as do
  the PBX's voicemail notifications (a different system entirely — see the
  voicemail-email handoff).
- ⚠️ **The accepted cost:** toll-fraud attempts, unregistered devices and doorway
  failures now warn nobody. That is Izzy's call, made twice. If you need one of
  these back, add it as an **escalation**, not as an `ADMIN_ALERT` — that is the
  channel that reaches him.
