/**
 * Paths that skip JWT verification in apps/api/src/server.ts preHandler.
 * Internal deploy probes and webhooks authenticate in their own handlers.
 *
 * Keep this aligned verbatim with production behavior — tested in publicReadyJwtBypass.test.ts.
 */
export function shouldSkipJwtVerification(path: string): boolean {
  const pathWithoutApiPrefix = path.startsWith("/api/") ? path.slice(4) : path;
  // Reverse proxies often mount the API under a prefix (e.g. /api/...); req.url keeps that prefix.
  const isDevObserveTokenPath =
    path === "/admin/dev/generate-observe-token" || path.endsWith("/admin/dev/generate-observe-token");
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
  const isInternalVoicemailNotifyPath =
    path === "/internal/voicemail-notify" || path.endsWith("/internal/voicemail-notify");
  // M1 (AI agent): agent-service MOH override door. Authenticates in-handler via
  // the AGENT_INTERNAL_SECRET shared-secret header (fail-closed when unset).
  const isInternalAgentMohPath =
    path === "/internal/agent/moh/override" || path.endsWith("/internal/agent/moh/override");
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
    || path.endsWith("/voice/moh/upload");
  const isOnboardingPublicPath = path.startsWith("/onboarding/");
  const isPublicCrmFormPath = pathWithoutApiPrefix.startsWith("/public/forms/");
  // CRM Email OAuth callback: Google redirects the user's browser here with code+state.
  // The browser cannot carry our Bearer token. Auth is performed inside the handler via
  // HMAC-signed `state` (tenantId, userId, scope, ts) — see emailRoutes.ts.
  const isCrmEmailOauthCallbackPath =
    path === "/crm/email/oauth/callback" || path.endsWith("/crm/email/oauth/callback");
  if (
    path.includes("/webhooks/pbx")
    || path.startsWith("/billing/invoices/pay/")
    || path.startsWith("/billing/platform/invoices/pay/")
    || path.includes("/billing/platform/invoices/pay/")
    // Multi-invoice short pay links (/p/{code} page): public view/config/pay by code.
    || path.startsWith("/billing/platform/pay-links/")
    || path.includes("/billing/platform/pay-links/")
    || isDevObserveTokenPath
    || isInternalCdrIngestPath
    || isInternalMobileRingPath
    || isInternalMobilePrewakePath
    || isInternalPbxWakePath
    || isInternalPbxContactStatusPath
    || isInternalTelephonyPath
    || isInternalVoicemailNotifyPath
    || isInternalAgentMohPath
    || isInternalAgentRoutePath
    || isInternalAgentIvrPath
    || isInternalAgentQueuePath
    || isInternalAgentExtFeaturePath
    || isIvrPromptSyncPath
    || isMohSyncPath
    || isOnboardingPublicPath
    || isPublicCrmFormPath
    || isCrmEmailOauthCallbackPath
    || [
      "/health",
      // Blue/green deploy + load balancers probe :3001/:3004 without JWT; must not 401.
      "/ready",
      // Same handler when nginx forwards the /api prefix to the backing port.
      "/api/ready",
      "/auth/signup",
      "/auth/login",
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
    ].includes(path) || path.endsWith("/webhooks/voipms/sms")
    || path === "/metrics"
    || path.endsWith("/metrics")
    || path.includes("/chat/attachments/download")
    || path.includes("/chat/a/")
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
