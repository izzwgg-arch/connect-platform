import crypto from "node:crypto";

function timingSafeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function verifyMetaSignature(rawBody: string | Buffer, appSecret: string, signatureHeader?: string): boolean {
  if (!appSecret) return false;
  const sig = String(signatureHeader || "").trim();
  if (!sig) return false;
  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const expected = crypto.createHmac("sha256", appSecret).update(bodyBuf).digest("hex");
  const candidate = sig.replace(/^sha256=/i, "");
  return timingSafeEquals(expected, candidate);
}

// Twilio signature: Base64(HMAC-SHA1(authToken, fullUrl + sortedParams)) per Twilio docs.
export function verifyTwilioSignature(
  fullUrl: string,
  params: Record<string, string>,
  authToken: string,
  signatureHeader?: string,
): boolean {
  if (!authToken) return false;
  const sig = String(signatureHeader || "").trim();
  if (!sig) return false;
  // Sort params by key, then concatenate key+value
  const sorted = Object.keys(params)
    .sort()
    .map((k) => k + String(params[k] ?? ""))
    .join("");
  const data = fullUrl + sorted;
  const hmac = crypto.createHmac("sha1", authToken).update(data).digest("base64");
  return timingSafeEquals(hmac, sig);
}
