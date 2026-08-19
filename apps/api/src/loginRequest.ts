/**
 * Shape-check the body of `POST /auth/login` WITHOUT throwing.
 *
 * ⛔ WHY THIS FILE EXISTS (2026-08-18)
 *
 * The login handler used to do
 *
 *     z.object({ email: z.string().email(), password: z.string().min(8) }).parse(req.body)
 *
 * and `.parse` THROWS on a bad body. The throw went into the global error handler,
 * which (correctly, since `4fb512ed`) turns every unexpected exception into
 * `500 { error: "internal_error" }`. Proven live 2026-08-18: `curl --data @file`
 * with `{"email":"x@y.com","password":"x"}` against
 * https://app.connectcomunications.com/api/auth/login answered 500, while a
 * well-formed wrong password answered `401 invalid_credentials`. A person typing a
 * short password saw "Server error" and every such request lit up the 5xx
 * counters. Nothing was actually broken on the server — the body was just short.
 *
 * ⛔ THE CONTRACT: anything that is not a proper `{ email, password }` pair is
 * answered exactly like a wrong password — `401 { error: "invalid_credentials" }`.
 * Not 400, deliberately:
 *   - the portal renders 401 as "Invalid email or password." and renders any other
 *     4xx as the raw error code — a person who typed 6 characters should read the
 *     former, not `invalid_request`;
 *   - a password shorter than 8 characters can NEVER be right (signup enforces ≥ 8,
 *     invite-accept / reset enforce ≥ 10, every temp password is 32 chars), so
 *     "invalid credentials" is the truthful answer, and answering it before the
 *     bcrypt compare and the DB lookup costs nothing and leaks nothing;
 *   - one status for "wrong" and "malformed" means the response can never be used
 *     to tell a real account from a missing one.
 *
 * ⛔ THE THROTTLE DECISION (see loginThrottle.ts): a malformed body is NOT recorded
 * as a login failure and is answered BEFORE the throttle is consulted. Nothing was
 * compared against a credential, so it is not a guess; the answer is identical for
 * an existing and an unknown account, so it is not an oracle; and it is served
 * without bcrypt or a DB round-trip, so it is the cheapest request on the route.
 * Counting it would only hand an attacker a zero-cost way to fill a victim's
 * account counter with garbage. A wrong password of ≥ 8 characters keeps counting
 * exactly as before.
 *
 * Nothing in this file throws on user input, and nothing in it reads NODE_ENV.
 */

import { z } from "zod";

export const LOGIN_PASSWORD_MIN_LENGTH = 8;

const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(LOGIN_PASSWORD_MIN_LENGTH),
  /** "Remember this device" token from a previous sign-in-code verification (per-tenant 2FA). Optional, opaque. */
  trustedDeviceToken: z.string().max(200).optional(),
  /** Cloudflare Turnstile response from the portal's sign-in form. Optional; the api decides whether it is required. */
  turnstileToken: z.string().max(4096).optional(),
  /** Which channel the sign-in code should go out on, when the tenant allows a choice. */
  otpChannel: z.string().max(10).optional(),
});

export type LoginRequest = { email: string; password: string; trustedDeviceToken?: string; turnstileToken?: string; otpChannel?: string };

export type LoginRequestParse =
  | { ok: true; value: LoginRequest }
  | { ok: false; reason: "no_body" | "bad_email" | "bad_password" | "malformed" };

/**
 * Returns the parsed credentials, or `{ ok: false }` with a machine-readable
 * reason that is safe to LOG (never to send — the client always gets the same
 * `invalid_credentials` body regardless of which field was wrong).
 */
export function parseLoginRequest(body: unknown): LoginRequestParse {
  if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "no_body" };
  }
  const result = loginRequestSchema.safeParse(body);
  if (result.success) {
    return {
      ok: true,
      value: {
        email: result.data.email,
        password: result.data.password,
        ...(result.data.trustedDeviceToken ? { trustedDeviceToken: result.data.trustedDeviceToken } : {}),
        ...(result.data.turnstileToken ? { turnstileToken: result.data.turnstileToken } : {}),
        ...(result.data.otpChannel ? { otpChannel: result.data.otpChannel } : {}),
      },
    };
  }
  const paths = new Set(result.error.issues.map((i) => String(i.path[0] ?? "")));
  if (paths.has("email") && !paths.has("password")) return { ok: false, reason: "bad_email" };
  if (paths.has("password") && !paths.has("email")) return { ok: false, reason: "bad_password" };
  return { ok: false, reason: "malformed" };
}
