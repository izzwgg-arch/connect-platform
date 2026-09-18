import { env } from "../env.js";

/**
 * The ONE integration point with Loopcom (Connect). A person signed into the
 * Loopcom portal/app hands us their Loopcom bearer token; we verify it by
 * asking the Loopcom api who it belongs to. No shared secret, no second
 * password, nothing minted here can reach Loopcom.
 *
 * Injected in tests so nothing leaves the process.
 */
export type LoopcomIdentity = {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  tenantName?: string | null;
  avatarUrl?: string | null;
};

export type LoopcomVerifier = (token: string) => Promise<LoopcomIdentity | null>;

export const verifyLoopcomToken: LoopcomVerifier = async (token) => {
  const base = env().LOOPCOM_API_URL;
  if (!base) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/me`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as any;
    // Connect's /me returns the user with tenant info; the JWT carries tenantId/sub.
    const payload = decodeJwtPayload(token);
    const userId = String(body?.id || payload?.sub || "");
    const tenantId = String(body?.tenantId || payload?.tenantId || "");
    const email = String(body?.email || "");
    if (!userId || !tenantId || !email) return null;
    return {
      userId,
      tenantId,
      email,
      role: String(body?.role || payload?.role || "USER"),
      firstName: body?.firstName ?? null,
      lastName: body?.lastName ?? null,
      displayName: body?.displayName ?? null,
      tenantName: body?.tenant?.name ?? body?.tenantName ?? null,
      avatarUrl: body?.avatarUrl ?? null,
    };
  } catch {
    return null;
  }
};

function decodeJwtPayload(token: string): any {
  try {
    const part = token.split(".")[1];
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
