/**
 * Paths that skip JWT verification in apps/api/src/server.ts preHandler.
 * Internal deploy probes and webhooks authenticate in their own handlers.
 *
 * Keep this aligned verbatim with production behavior — tested in publicReadyJwtBypass.test.ts.
 */
export function shouldSkipJwtVerification(path: string): boolean {
  // Reverse proxies often mount the API under a prefix (e.g. /api/...); req.url keeps that prefix.
  const isDevObserveTokenPath =
    path === "/admin/dev/generate-observe-token" || path.endsWith("/admin/dev/generate-observe-token");
  const isInternalCdrIngestPath =
    path === "/internal/cdr-ingest" || path.endsWith("/internal/cdr-ingest");
  const isInternalMobileRingPath =
    path === "/internal/mobile-ring-notify" || path.endsWith("/internal/mobile-ring-notify");
  const isInternalPbxWakePath =
    path === "/internal/pbx/wake-extension"
    || path.endsWith("/internal/pbx/wake-extension")
    || path === "/internal/pbx/publish-wake-config"
    || path.endsWith("/internal/pbx/publish-wake-config");
  const isInternalTelephonyPath =
    path === "/internal/telephony/pbx-tenant-map"
    || path.endsWith("/internal/telephony/pbx-tenant-map")
    || path === "/internal/telephony/user-extensions"
    || path.endsWith("/internal/telephony/user-extensions");
  const isInternalVoicemailNotifyPath =
    path === "/internal/voicemail-notify" || path.endsWith("/internal/voicemail-notify");
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
    || isDevObserveTokenPath
    || isInternalCdrIngestPath
    || isInternalMobileRingPath
    || isInternalPbxWakePath
    || isInternalTelephonyPath
    || isInternalVoicemailNotifyPath
    || isIvrPromptSyncPath
    || isMohSyncPath
    || isOnboardingPublicPath
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
