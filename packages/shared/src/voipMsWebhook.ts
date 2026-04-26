/**
 * VoIP.ms SMS/MMS DID callback URL (placeholders per VoIP.ms SMS-MMS wiki).
 * Safe in browser bundles (no Node APIs).
 */
export function buildVoipMsSmsWebhookCallbackUrl(publicBaseUrl: string): string {
  const base = String(publicBaseUrl || "").replace(/\/+$/, "");
  if (!base) return "";
  const q = "from={FROM}&to={TO}&message={MESSAGE}&id={ID}&date={TIMESTAMP}&media={MEDIA}";
  return `${base}/webhooks/voipms/sms?${q}`;
}
