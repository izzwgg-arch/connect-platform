/**
 * Paths that skip JWT verification in apps/api/src/server.ts preHandler.
 * Internal deploy probes and webhooks authenticate in their own handlers.
 *
 * Keep this aligned verbatim with production behavior — tested in publicReadyJwtBypass.test.ts.
 */
export function shouldSkipJwtVerification(path: string): boolean {
  const pathWithoutApiPrefix = path.startsWith("/api/") ? path.slice(4) : path;
  // Reverse proxies often mount the API under a prefix (e.g. /api/...); req.url keeps that prefix.
  // ⛔ `/admin/dev/generate-observe-token` was on this list until 2026-08-18.
  // Being here is what made it run ANONYMOUSLY, and nginx proxies `/api/` with
  // no exclusion for it — so a shared secret alone, from the public internet,
  // minted a SUPER_ADMIN JWT scoped to tenantId "global" for up to 120 minutes.
  // The route is deleted; this entry goes with it. Never re-add either.
  // A shared secret may authenticate a MACHINE on a narrow door; it must never
  // be sufficient to mint an IDENTITY that outlives the request.
  const isInternalCdrIngestPath =
    path === "/internal/cdr-ingest" || path.endsWith("/internal/cdr-ingest");
  const isInternalMobileRingPath =
    path === "/internal/mobile-ring-notify" || path.endsWith("/internal/mobile-ring-notify");
  const isInternalMobilePrewakePath =
    path === "/internal/mobile-prewake" || path.endsWith("/internal/mobile-prewake");
  const isInternalPbxWakePath =
    path === "/internal/pbx/wake-extension"
    || path.endsWith("/internal/pbx/wake-extension")
    || path === "/internal/pbx/publish-wake-config"
    || path.endsWith("/internal/pbx/publish-wake-config");
  const isInternalPbxContactStatusPath =
    path === "/internal/pbx/contact-status"
    || path.endsWith("/internal/pbx/contact-status");
  const isInternalTelephonyPath =
    path === "/internal/telephony/pbx-tenant-map"
    || path.endsWith("/internal/telephony/pbx-tenant-map")
    || path === "/internal/telephony/user-extensions"
    || path.endsWith("/internal/telephony/user-extensions")
    || path === "/internal/telephony/inbound-crm-match"
    || path.endsWith("/internal/telephony/inbound-crm-match");
  // SMS-bridge shared-inbox reply door. In-handler shared-secret auth via
  // guardInternalSecret (fail-closed). ⛔ A missing entry here makes the
  // route answer 401 before its own secret check ever runs - 403 means you
  // reached the handler, 401 means you did not.
  const isInternalChatSystemReplyPath =
    path === "/internal/chat/sms-system-reply" || path.endsWith("/internal/chat/sms-system-reply");
  const isInternalVoicemailNotifyPath =
    path === "/internal/voicemail-notify" || path.endsWith("/internal/voicemail-notify");
  // Voice agent (conversational order-taking IVR): three telephony→api doors,
  // each in-handler internal-secret auth (fail-closed). ⛔ MUST be here or the
  // JWT hook 401s them before the secret check runs — the twice-shipped trap.
  // They answer 403 on a bad secret, so a 401 means the bypass entry is missing.
  const isInternalVoiceAgentPath =
    path === "/internal/voice-agent/session-start" || path.endsWith("/internal/voice-agent/session-start")
    || path === "/internal/voice-agent/tool" || path.endsWith("/internal/voice-agent/tool")
    || path === "/internal/voice-agent/session-end" || path.endsWith("/internal/voice-agent/session-end");
  // M1 (AI agent): agent-service MOH override door. Authenticates in-handler via
  // the AGENT_INTERNAL_SECRET shared-secret header (fail-closed when unset).
  const isInternalAgentMohPath =
    path === "/internal/agent/moh/override" || path.endsWith("/internal/agent/moh/override")
    // Agent chat MP3 upload → hold-music profile door (same shared-secret auth).
    || path === "/internal/agent/moh/upload-asset" || path.endsWith("/internal/agent/moh/upload-asset");
  // M3: agent inbound-route door. In-handler shared-secret auth (fail-closed).
  const isInternalAgentRoutePath =
    path === "/internal/agent/route/action" || path.endsWith("/internal/agent/route/action");
  // M4: agent IVR menu door. In-handler shared-secret auth (fail-closed).
  const isInternalAgentIvrPath =
    path === "/internal/agent/ivr/action" || path.endsWith("/internal/agent/ivr/action");
  // M10: agent queue-config door. In-handler shared-secret auth (fail-closed).
  const isInternalAgentQueuePath =
    path === "/internal/agent/queue/action" || path.endsWith("/internal/agent/queue/action");
  // M11: agent extension-feature (DND/CF) door. In-handler shared-secret auth.
  const isInternalAgentExtFeaturePath =
    path === "/internal/agent/extfeature/action" || path.endsWith("/internal/agent/extfeature/action");
  // Read-only account/pricing door behind the provisioning tools ("how many
  // extensions do I have", "add extension 1102", "turn texting on"). Same
  // in-handler shared-secret auth, fail-closed.
  // ⛔ This was MISSING, so the door 401'd at the JWT hook before its own secret
  // check ever ran — the agent shipped the caller and the api shipped the route,
  // and nothing connected them. Symptom in production: "I couldn't retrieve the
  // account setup details right now", every time, which is what blocked the
  // trainer's extension request. Tell the two apart by the STATUS: this route
  // answers 403 forbidden on a bad secret, so a 401 unauthorized means you never
  // reached it. Any new /internal/agent/* door must be added here too.
  const isInternalAgentAccountSetupPath =
    path === "/internal/agent/account-setup-info" || path.endsWith("/internal/agent/account-setup-info");
  // Read-only contacts door ("who is in my contacts"). Same in-handler
  // shared-secret auth, fail-closed.
  const isInternalAgentContactsPath =
    path === "/internal/agent/contacts-info" || path.endsWith("/internal/agent/contacts-info");
  // Read-only "which numbers could this account add" door. Looks at carrier
  // stock; never buys — the purchase happens only behind the password confirm.
  const isInternalAgentNumberSearchPath =
    path === "/internal/agent/search-phone-numbers" || path.endsWith("/internal/agent/search-phone-numbers");
  // Read-only investigation workspace: the assistant's window onto BOTH servers
  // (Connect's Postgres and the PBX's MySQL) so it can diagnose a fault nobody
  // pre-built a tool for. Same in-handler shared-secret auth, fail-closed.
  // ⛔ It can only ever READ — three enforcement layers in
  // agentInvestigation/readOnlySql.ts, the outermost being that Postgres runs
  // it in a READ ONLY transaction and the PBX credential is SELECT-only.
  const isInternalAgentInvestigatePath =
    path === "/internal/agent/investigate" || path.endsWith("/internal/agent/investigate");
  // The support Workbench door: the agent's read_file / list_files /
  // run_command / browse. Same in-handler shared-secret auth, fail-closed, and
  // it shares the HUMAN workbench's gate closure in supportConsole.ts so the
  // agent can never be held to looser rules than a person at the desk.
  const isInternalAgentWorkbenchPath =
    path === "/internal/agent/workbench" || path.endsWith("/internal/agent/workbench");
  const isIvrPromptSyncPath =
    path === "/voice/ivr/prompts/sync-manifest"
    || path.endsWith("/voice/ivr/prompts/sync-manifest")
    || path === "/voice/ivr/prompts/upload"
    || path.endsWith("/voice/ivr/prompts/upload")
    || path.startsWith("/voice/ivr/prompts/download/")
    || path.includes("/voice/ivr/prompts/download/");
  const isMohSyncPath =
    path === "/voice/moh/sync-manifest"
    || path.endsWith("/voice/moh/sync-manifest")
    || path === "/voice/moh/upload"
    || path.endsWith("/voice/moh/upload")
    // Signed MOH download (HMAC exp+sig in query, verified in-handler) — pulled
    // by the PBX connect-media-sync helper, which has no JWT.
    || path.startsWith("/voice/moh/download/")
    || path.includes("/voice/moh/download/");
  // Loopcom Meetings (2026-08-20): the public /meet/<code> page's two calls —
  // meeting info and guest join. The meeting CODE is the credential
  // (unguessable, per-meeting, validated against the VideoMeeting table
  // in-handler — the pay-link pattern). ⛔ ONLY /meetings/public/* is open:
  // creating, listing, ending and every host control live under /meetings/*
  // and stay JWT-gated. Anchored to the path start, never a substring match.
  const isPublicMeetingPath =
    path.startsWith("/meetings/public/") || path.startsWith("/api/meetings/public/");
  const isOnboardingPublicPath = path.startsWith("/onboarding/");
  const isPublicCrmFormPath = pathWithoutApiPrefix.startsWith("/public/forms/");
  // Public customer delivery-tracking page: token-authenticated inside the handler
  // (the browser has no Bearer token). Only /track/* — dispatcher tracking-link mint/revoke
  // lives under /delivery/* and remains JWT-gated.
  const isPublicTrackingPath = pathWithoutApiPrefix.startsWith("/track/");
  // CRM Email OAuth callback: Google redirects the user's browser here with code+state.
  // The browser cannot carry our Bearer token. Auth is performed inside the handler via
  // HMAC-signed `state` (tenantId, userId, scope, ts) — see emailRoutes.ts.
  const isCrmEmailOauthCallbackPath =
    path === "/crm/email/oauth/callback" || path.endsWith("/crm/email/oauth/callback");
  // Supermarket pay-by-phone door: the PBX dialplan curls it per IVR step.
  // In-handler shared-secret auth via guardInternalSecret (fail-closed) — but
  // without this bypass the JWT hook 401s before that check ever runs (403 =
  // you reached the handler, 401 = you did not).
  const isInternalSupermarketPayIvrPath =
    path === "/internal/supermarket/pay-ivr/step" || path.endsWith("/internal/supermarket/pay-ivr/step");
  // Marketing one-click unsubscribe: opened from an email, no Bearer token.
  // The HMAC-signed token in the path is the whole credential (specials.ts).
  const isMarketingUnsubscribePath =
    path.startsWith("/marketing/unsubscribe/") || path.startsWith("/api/marketing/unsubscribe/");
  if (
    path.includes("/webhooks/pbx")
    || path.startsWith("/billing/invoices/pay/")
    || path.startsWith("/billing/platform/invoices/pay/")
    || path.includes("/billing/platform/invoices/pay/")
    // Combined pay links (/pay/invoices/[token] page): view/config/pay for
    // SEVERAL open invoices under one token. ⛔ Audit §6j: "pay-multi/" does not
    // match "pay/", so all three routes 401'd before their handler ran and
    // every combined pay link a customer was ever sent was dead. Fails closed,
    // so it was an availability bug, not a leak — but a customer who cannot
    // pay is a customer who does not pay.
    || path.startsWith("/billing/platform/invoices/pay-multi/")
    || path.includes("/billing/platform/invoices/pay-multi/")
    // Multi-invoice short pay links (/p/{code} page): public view/config/pay by code.
    || path.startsWith("/billing/platform/pay-links/")
    || path.includes("/billing/platform/pay-links/")
    || isInternalCdrIngestPath
    || isInternalMobileRingPath
    || isInternalMobilePrewakePath
    || isInternalPbxWakePath
    || isInternalPbxContactStatusPath
    || isInternalTelephonyPath
    || isInternalChatSystemReplyPath
    || isInternalVoicemailNotifyPath
    || isInternalVoiceAgentPath
    || isInternalAgentMohPath
    || isInternalAgentRoutePath
    || isInternalAgentIvrPath
    || isInternalAgentQueuePath
    || isInternalAgentExtFeaturePath
    || isInternalAgentAccountSetupPath
    || isInternalAgentContactsPath
    || isInternalAgentNumberSearchPath
    || isInternalAgentInvestigatePath
    || isInternalAgentWorkbenchPath
    || isIvrPromptSyncPath
    || isMohSyncPath
    || isPublicMeetingPath
    || isOnboardingPublicPath
    || isPublicCrmFormPath
    || isPublicTrackingPath
    || isCrmEmailOauthCallbackPath
    || isInternalSupermarketPayIvrPath
    || isMarketingUnsubscribePath
    || [
      "/health",
      // Blue/green deploy + load balancers probe :3001/:3004 without JWT; must not 401.
      "/ready",
      // Same handler when nginx forwards the /api prefix to the backing port.
      "/api/ready",
      "/auth/signup",
      "/auth/login",
      // MFA second step (2026-08-18). Carries a 5-minute PRE-AUTH token — not a
      // session — and verifies it in-handler with a key derived from JWT_SECRET,
      // so the JWT hook could never accept it anyway. ⛔ The ONLY /auth/mfa/*
      // path that may be here: setup / verify / disable / status all need a
      // real session. `mfa.test.ts` pins that.
      "/auth/mfa/challenge",
      // Per-tenant sign-in code (2FA-by-code, 2026-08-19): a pre-auth token is
      // not a session, so these must run without the JWT hook. ONLY these two.
      "/auth/otp/verify",
      "/auth/otp/resend",
      "/auth/mobile-qr-exchange",
      "/auth/invite/validate",
      "/auth/invite/accept",
      "/auth/password/forgot",
      "/auth/password/reset",
      "/auth/password/reset/validate",
      "/webhooks/twilio/sms-status",
      "/webhooks/sola-cardknox",
      "/webhooks/whatsapp/meta",
      "/webhooks/whatsapp/twilio/status",
      "/webhooks/voipms/sms",
      // SignalWire evaluation console (2026-08-18): inbound SMS + delivery
      // status callbacks. Both verify X-SignalWire-Signature in-handler and
      // FAIL CLOSED without a signing key (signalwire/signalWireWebhookAuth.ts).
      "/webhooks/signalwire/sms",
      "/webhooks/signalwire/sms-status",
      // 10DLC registry status callback (2026-08-30): an untrusted TRIGGER
      // only — every state written comes from an authenticated re-read of
      // the registry API (signalwire/signalWireTenDlc.ts), and the handler
      // throttles itself, so no signature is required for safety.
      "/webhooks/signalwire/registry",
    ].includes(path) || path.endsWith("/webhooks/voipms/sms")
    || path.endsWith("/webhooks/signalwire/sms") || path.endsWith("/webhooks/signalwire/sms-status")
    || path.endsWith("/webhooks/signalwire/registry")
    || path === "/metrics"
    || path.endsWith("/metrics")
    || path.includes("/chat/attachments/download")
    // Anchored to the path start (with or without the /api prefix). This was
    // `path.includes("/chat/a/")` — a substring match anywhere in the URL, so
    // any future route whose path merely CONTAINED that fragment would have
    // gone public. Two signature-gated wildcard routes exist today; anchor now.
    || path.startsWith("/chat/a/")
    || path.startsWith("/api/chat/a/")
    || path.startsWith("/downloads/")
    || /\/downloads\/[^/]+$/.test(path)
    || path === "/mobile/android/download"
    || path.endsWith("/mobile/android/download")
    || path === "/mobile/android/latest"
    || path.endsWith("/mobile/android/latest")
  ) {
    return true;
  }
  return false;
}
