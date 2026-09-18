import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { env } from "../env.js";

export type OAuthIdentity = { provider: "google" | "apple"; subject: string; email: string | null; emailVerified: boolean; firstName?: string | null; lastName?: string | null };
export type OAuthVerifier = (provider: "google" | "apple", idToken: string) => Promise<OAuthIdentity | null>;

export const verifyOAuthIdToken: OAuthVerifier = async (provider, idToken) => {
  if (provider === "google") return verifyGoogle(idToken);
  return verifyApple(idToken);
};

async function verifyGoogle(idToken: string): Promise<OAuthIdentity | null> {
  const clientId = env().GOOGLE_CLIENT_ID;
  if (!clientId) return null;
  try {
    const { OAuth2Client } = await import("google-auth-library");
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const p = ticket.getPayload();
    if (!p?.sub) return null;
    return { provider: "google", subject: p.sub, email: p.email ?? null, emailVerified: !!p.email_verified, firstName: p.given_name ?? null, lastName: p.family_name ?? null };
  } catch {
    return null;
  }
}

let appleKeys: { keys: any[]; fetchedAt: number } | null = null;

/** Apple id_token: RS256 signed by Apple's JWKS; audience = our Services ID / bundle id. */
async function verifyApple(idToken: string): Promise<OAuthIdentity | null> {
  const aud = env().APPLE_CLIENT_ID;
  if (!aud) return null;
  try {
    const [h, p, s] = idToken.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    if (!appleKeys || Date.now() - appleKeys.fetchedAt > 3600_000) {
      const res = await fetch("https://appleid.apple.com/auth/keys", { signal: AbortSignal.timeout(8000) });
      appleKeys = { keys: ((await res.json()) as any).keys, fetchedAt: Date.now() };
    }
    const jwk = appleKeys.keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = createPublicKey({ key: jwk, format: "jwk" });
    const ok = cryptoVerify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
    if (!ok) return null;
    if (payload.iss !== "https://appleid.apple.com") return null;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return { provider: "apple", subject: payload.sub, email: payload.email ?? null, emailVerified: payload.email_verified === true || payload.email_verified === "true" };
  } catch {
    return null;
  }
}
