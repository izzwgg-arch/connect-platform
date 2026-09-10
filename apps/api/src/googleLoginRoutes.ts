/**
 * Sign in with Google — the three routes (2026-09-10). Rules live in
 * `googleLogin.ts`; this file only wires them to Fastify, the database and
 * Google. Read that file's header first.
 *
 *   GET  /auth/google/start?next=   302 → Google's account chooser
 *   GET  /auth/google/callback      Google → here → 302 back to /login with a
 *                                   one-shot handoff code (or a google_error)
 *   POST /auth/google/complete      { code } → the ORDINARY login body
 *
 * ⛔ All three are on the JWT bypass list (jwtPublicRouteBypass.ts) — the
 * browser carries no session on any of them. A missing entry answers 401 at the
 * hook before the handler runs, which reads as "Google login is broken" with
 * nothing in the logs (the /internal/agent/* lesson).
 *
 * ⛔ `/complete` hands the user to `deps.completeLogin` — the SAME function
 * `/auth/login` runs after a password matches (DISABLED check → TOTP decision
 * → sign-in-code gate → session). So a person who turned the sign-in code on
 * still gets asked for it after Google, and the session body is byte-identical
 * to a password sign-in. Never mint a session here directly.
 *
 * ⛔ Nothing here writes a User row and nothing here counts as a login failure
 * for the throttle: a Google address that is not on Loopcom is told so in
 * plain words (the person just proved the address is theirs), and no 401 is
 * ever produced — a 401 stream from a login page is how a customer's office
 * gets auto-banned at nginx.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  GOOGLE_LOGIN_CALLBACK_PATH,
  GOOGLE_TOKEN_ENDPOINT,
  HandoffRegistry,
  buildGoogleAuthUrl,
  decideGoogleLogin,
  loginRedirectUrl,
  mintGoogleLoginHandoff,
  mintGoogleLoginState,
  readGoogleIdToken,
  safeNextPath,
  verifyGoogleLoginHandoff,
  verifyGoogleLoginState,
  type GoogleLoginError,
} from "./googleLogin";

export type GoogleLoginUserRow = {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  status?: string | null;
  phone?: string | null;
  loginOtpEnabledAt?: Date | null;
};

export type CompletedLogin = { status: number; body: Record<string, unknown>; outcome: "disabled" | "mfa_enroll_required" | "mfa_challenge" | "otp_challenge" | "session" };

export type GoogleLoginRouteDeps = {
  db: {
    user: {
      findUnique: (args: any) => Promise<GoogleLoginUserRow | null>;
      findFirst: (args: any) => Promise<GoogleLoginUserRow | null>;
    };
  };
  log: { warn: (o: unknown, msg?: string) => void; info: (o: unknown, msg?: string) => void };
  audit: (params: { tenantId: string; action: string; entityType: string; entityId: string; actorUserId?: string; metadata?: Record<string, unknown> | null }) => Promise<unknown>;
  /** The shared post-credential chain from server.ts (`completeLoginAfterPrimaryFactor`). */
  completeLogin: (user: GoogleLoginUserRow, input: { otpChannel?: string; via: "google" }) => Promise<CompletedLogin>;
  /** Which of OUR portal origins the request arrived on (publicOrigins.portalOriginForRequest). */
  portalOriginForRequest: (req: { headers?: Record<string, unknown> }) => string;
  /** Read at call time so a container that gains the variables needs no code change. */
  googleClient: () => { clientId: string; clientSecret: string } | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  registry?: HandoffRegistry;
};

export function googleClientFromEnv(): { clientId: string; clientSecret: string } | null {
  const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export async function registerGoogleLoginRoutes(app: FastifyInstance, deps: GoogleLoginRouteDeps): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const registry = deps.registry ?? new HandoffRegistry();

  const bounce = (reply: FastifyReply, origin: string, error: GoogleLoginError, next?: string) =>
    reply.redirect(loginRedirectUrl(origin, { google_error: error, next }), 302);

  // ── start ──────────────────────────────────────────────────────────────────
  app.get("/auth/google/start", async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = deps.portalOriginForRequest(req as any);
    const next = safeNextPath((req.query as any)?.next);
    const client = deps.googleClient();
    if (!client) {
      deps.log.warn({ endpoint: "/auth/google/start" }, "google_login_not_configured");
      return bounce(reply, origin, "not_configured", next);
    }
    const state = mintGoogleLoginState({ origin, next }, now());
    const url = buildGoogleAuthUrl({ clientId: client.clientId, redirectUri: `${origin}${GOOGLE_LOGIN_CALLBACK_PATH}`, state });
    return reply.redirect(url, 302);
  });

  // ── callback ───────────────────────────────────────────────────────────────
  app.get("/auth/google/callback", async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = deps.portalOriginForRequest(req as any);
    const q = (req.query as any) || {};
    const stateCheck = verifyGoogleLoginState(q.state, now());
    if (!stateCheck.ok) {
      deps.log.warn({ endpoint: "/auth/google/callback", reason: stateCheck.reason }, "google_login_bad_state");
      return bounce(reply, origin, "expired");
    }
    const { next } = stateCheck.claims;
    if (q.error) {
      // The person pressed Cancel on Google's chooser (access_denied) or Google refused.
      deps.log.info({ endpoint: "/auth/google/callback", googleError: String(q.error).slice(0, 80) }, "google_login_cancelled");
      return bounce(reply, origin, "cancelled", next);
    }
    const code = String(q.code ?? "").trim();
    if (!code) return bounce(reply, origin, "expired", next);
    const client = deps.googleClient();
    if (!client) return bounce(reply, origin, "not_configured", next);

    let tokenJson: any;
    try {
      const tokenRes = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: `${origin}${GOOGLE_LOGIN_CALLBACK_PATH}`,
          grant_type: "authorization_code",
        }),
      });
      tokenJson = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok) {
        deps.log.warn({ endpoint: "/auth/google/callback", status: tokenRes.status, googleError: String(tokenJson?.error ?? "").slice(0, 80) }, "google_login_token_exchange_failed");
        return bounce(reply, origin, "google_failed", next);
      }
    } catch (e) {
      deps.log.warn({ endpoint: "/auth/google/callback", err: String((e as Error)?.message ?? e).slice(0, 200) }, "google_login_token_exchange_unreachable");
      return bounce(reply, origin, "google_failed", next);
    }

    const identity = readGoogleIdToken(tokenJson?.id_token, { clientId: client.clientId, nowMs: now() });
    if (!identity.ok) {
      deps.log.warn({ endpoint: "/auth/google/callback", reason: identity.reason }, "google_login_id_token_refused");
      return bounce(reply, origin, identity.reason === "email_unverified" ? "email_unverified" : "google_failed", next);
    }
    const emailKey = identity.identity.email;

    // Same lookup shape as /auth/login: canonical lowercase first, then a
    // case-insensitive fallback for rows imported with mixed case.
    let user = await deps.db.user.findUnique({ where: { email: emailKey } });
    if (!user) user = await deps.db.user.findFirst({ where: { email: { equals: emailKey, mode: "insensitive" } } });

    const decision = decideGoogleLogin(user);
    if (decision.kind === "not_registered") {
      // ⛔ Nothing is created. The address is not on Loopcom; say so and stop.
      deps.log.info({ endpoint: "/auth/google/callback", emailDomain: emailKey.split("@")[1] ?? "" }, "google_login_not_registered");
      return bounce(reply, origin, "not_registered", next);
    }
    if (decision.kind === "disabled" || !user) {
      return bounce(reply, origin, "disabled", next);
    }
    const handoff = mintGoogleLoginHandoff(user.id, now());
    void deps.audit({ tenantId: user.tenantId, actorUserId: user.id, action: "USER_GOOGLE_LOGIN_VERIFIED", entityType: "User", entityId: user.id, metadata: { googleSub: identity.identity.googleSub } }).catch(() => undefined);
    return reply.redirect(loginRedirectUrl(origin, { g: handoff.code, next: next !== "/dashboard" ? next : undefined }), 302);
  });

  // ── complete ───────────────────────────────────────────────────────────────
  app.post("/auth/google/complete", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    const check = verifyGoogleLoginHandoff(body.code, now());
    if (!check.ok) {
      // 400, never 401: a stale link or a replay is not a bad credential, and
      // it must not feed nginx's 401 ban counter.
      return reply.status(400).send({ error: "google_login_expired", message: "That Google sign-in has expired. Please choose Sign in with Google again." });
    }
    if (!registry.claim(check.claims.jti, check.claims.exp * 1000, now())) {
      return reply.status(400).send({ error: "google_login_used", message: "That Google sign-in was already used. Please choose Sign in with Google again." });
    }
    const user = await deps.db.user.findUnique({ where: { id: check.claims.sub } });
    const decision = decideGoogleLogin(user);
    if (decision.kind !== "ok" || !user) {
      return reply.status(400).send({ error: "google_login_expired", message: "That Google sign-in has expired. Please choose Sign in with Google again." });
    }
    const otpChannel = typeof body.otpChannel === "string" ? body.otpChannel : undefined;
    const done = await deps.completeLogin(user, { otpChannel, via: "google" });
    if (done.outcome === "session") {
      void deps.audit({ tenantId: user.tenantId, actorUserId: user.id, action: "USER_GOOGLE_LOGIN", entityType: "User", entityId: user.id, metadata: null }).catch(() => undefined);
    }
    return reply.status(done.status).send(done.body);
  });
}
