/**
 * The ONE place apps/api knows its own public hostnames and platform mail
 * addresses.
 *
 * ⛔ HISTORY (2026-08-19, the Loopcom parallel-run): the platform is served on
 * TWO hostnames — `app.connectcomunications.com` and `app.loopcom.net` — and is
 * migrating to Loopcom, with the old domain to be removed once Loopcom does
 * everything the old one does. An inventory that day found the literal
 * `https://app.connectcomunications.com` in ~30 places across apps/api: pay-link
 * builders, email templates, the PBX webhook default, OAuth, SBC probes, and
 * several `process.env.X || literal` chains that each read a DIFFERENT env name
 * (`PUBLIC_PORTAL_URL`, `PORTAL_PUBLIC_URL`, `CONNECT_APP_URL`, `APP_PUBLIC_URL`,
 * `PUBLIC_API_BASE_URL`, `API_PUBLIC_URL`, `PUBLIC_API_URL`). Eleven pay-link
 * sites had NO env override at all. So "flip the platform to Loopcom" was not
 * one change; it was thirty, and the eleven hardcoded ones would have kept
 * sending customers to a dead hostname after the removal.
 *
 * Every one of those sites now calls into here. `publicOrigins.test.ts` reads
 * `apps/api/src` with comments stripped and fails if the literal reappears
 * anywhere but this file.
 *
 * THE RULES
 *  - `canonicalPortalOrigin()` is what goes into anything DURABLE that leaves the
 *    platform: emails, SMS, pay links, webhook registrations, PDF footers. It is
 *    ONE value (env, else the current canonical default) because a link in an
 *    email cannot know which host the reader prefers.
 *  - `portalOriginForRequest(req)` is for things answered TO A BROWSER THAT IS
 *    ALREADY ON A HOST — OAuth redirect URIs, "open this in the app" links in an
 *    API response. It keeps the person on the host they came from, but ONLY if
 *    that host is one of ours (`PLATFORM_PORTAL_HOSTS`); anything else falls
 *    back to canonical, so a forged `Host:` header can never mint a link to an
 *    attacker's domain.
 *  - Flipping the canonical host to Loopcom is `PUBLIC_PORTAL_URL=https://app.loopcom.net`
 *    (+ `PUBLIC_API_BASE_URL` if the API should differ, which it does not) — a
 *    real `apps/api/` commit must ride with it, per CLAUDE.md's env-only-deploy
 *    trap. Nothing else needs to change.
 */

/** Every hostname the portal is legitimately served on. Add a host HERE when a vhost is added. */
export const PLATFORM_PORTAL_HOSTS: ReadonlySet<string> = new Set([
  "app.connectcomunications.com",
  "app.loopcom.net",
]);

/** The canonical default until the Loopcom cut-over flips it by env. */
export const DEFAULT_CANONICAL_PORTAL_ORIGIN = "https://app.connectcomunications.com";

function firstEnv(...names: string[]): string | null {
  for (const n of names) {
    const v = String(process.env[n] ?? "").trim();
    if (v) return v;
  }
  return null;
}

function stripTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, "");
}

/** `https://<host>` — the ONE canonical portal origin for durable links. */
export function canonicalPortalOrigin(): string {
  const v = firstEnv("PUBLIC_PORTAL_URL", "PORTAL_PUBLIC_URL", "CONNECT_APP_URL", "APP_PUBLIC_URL");
  return stripTrailingSlashes(v ?? DEFAULT_CANONICAL_PORTAL_ORIGIN);
}

/** `https://<host>/api` — the canonical API base for durable references (webhook registrations, PBX config). */
export function canonicalApiBase(): string {
  const v = firstEnv("PUBLIC_API_BASE_URL", "API_PUBLIC_URL", "PUBLIC_API_URL");
  if (v) return stripTrailingSlashes(v);
  return `${canonicalPortalOrigin()}/api`;
}

/** Just the hostname of the canonical origin (for code that compares hosts). */
export function canonicalPortalHost(): string {
  try {
    return new URL(canonicalPortalOrigin()).host;
  } catch {
    return "app.connectcomunications.com";
  }
}

/**
 * The origin the requesting browser is on, IF it is one of ours. Reads
 * `X-Forwarded-Host` (nginx sets it) then `Host`, first value only, port
 * stripped for the membership check. Anything not in `PLATFORM_PORTAL_HOSTS`
 * → null, so a forged header cannot redirect anyone to a foreign domain.
 */
export function requestPortalOrigin(req: { headers?: Record<string, unknown> } | null | undefined): string | null {
  const h = (req?.headers ?? {}) as Record<string, unknown>;
  const raw = String(h["x-forwarded-host"] ?? h["host"] ?? "").split(",")[0].trim().toLowerCase();
  if (!raw) return null;
  const host = raw.replace(/:\d+$/, "");
  if (!PLATFORM_PORTAL_HOSTS.has(host)) return null;
  return `https://${host}`;
}

/** Keep a browser on the host it came from; canonical for anything else. */
export function portalOriginForRequest(req: { headers?: Record<string, unknown> } | null | undefined): string {
  return requestPortalOrigin(req) ?? canonicalPortalOrigin();
}

/** `${origin}/api` for the requesting host — pairs with `portalOriginForRequest`. */
export function apiBaseForRequest(req: { headers?: Record<string, unknown> } | null | undefined): string {
  const o = requestPortalOrigin(req);
  return o ? `${o}/api` : canonicalApiBase();
}

/**
 * OAuth redirect URIs MUST match what is registered with the provider, and the
 * value used at token exchange must equal the one used at authorisation.
 *
 * `registered` is the env value (e.g. GOOGLE_OAUTH_REDIRECT_URI =
 * `https://app.connectcomunications.com/api/crm/email/oauth/callback`). When the
 * requesting browser is on one of OUR hosts, only the ORIGIN is swapped — the
 * registered PATH is kept byte-for-byte — so the provider-side registration for
 * the second host is the same path on the other hostname, nothing more. Both
 * calls (start + exchange) derive from the same request host, and the
 * provider's redirect brings the browser back to that host, so the pair agrees.
 * ⛔ Register `https://app.loopcom.net/api/<same path>` with the provider too, or
 * a Loopcom user's sign-in answers `redirect_uri_mismatch`.
 */
export function oauthRedirectUriForRequest(
  req: { headers?: Record<string, unknown> } | null | undefined,
  registered: string,
): string {
  const reg = String(registered ?? "").trim();
  if (!reg) throw new Error("oauth_redirect_uri_not_configured");
  const o = requestPortalOrigin(req);
  if (!o) return reg;
  try {
    const u = new URL(reg);
    return `${o}${u.pathname}${u.search}`;
  } catch {
    return reg;
  }
}

// ── Platform mail identity ────────────────────────────────────────────────────
//
// The mailbox that sends everything is Google Workspace `support@…` (see the
// EmailProviderConfig row for the INTERNAL tenant); these are the DEFAULT
// addresses code falls back to when a provider row carries no fromEmail, and
// the address printed on invoices and sign-up pages. One env each; the domain
// half flips with `PLATFORM_MAIL_DOMAIN`.

export const DEFAULT_PLATFORM_MAIL_DOMAIN = "connectcomunications.com";

export function platformMailDomain(): string {
  return firstEnv("PLATFORM_MAIL_DOMAIN") ?? DEFAULT_PLATFORM_MAIL_DOMAIN;
}

export function platformSupportEmail(): string {
  return firstEnv("PLATFORM_SUPPORT_EMAIL") ?? `support@${platformMailDomain()}`;
}

/**
 * The billing address PRINTED on invoices and receipts — the one a customer
 * replies to when they have a question about a bill.
 *
 * Deliberately already on loopcom.net while `platformMailDomain()` (support@,
 * noreply@) still answers connectcomunications.com: the rebrand is landing
 * surface by surface, and the billing emails have carried this address since
 * the 2026-08-16 rebrand. Keeping it here means the invoice PDF and the invoice
 * EMAIL can never disagree about where a reply should go.
 *
 * ⛔ The loopcom.net DOMAIN is verified in Google Workspace; that does NOT prove
 * the billing@ MAILBOX exists, and Google bounces mail addressed to a user that
 * does not. Confirm the mailbox before relying on replies reaching anyone.
 */
export const DEFAULT_PLATFORM_BILLING_CONTACT_EMAIL = "billing@loopcom.net";

export function platformBillingContactEmail(): string {
  return firstEnv("PLATFORM_BILLING_CONTACT_EMAIL") ?? DEFAULT_PLATFORM_BILLING_CONTACT_EMAIL;
}

export function platformBillingFromEmail(): string {
  return firstEnv("PLATFORM_BILLING_FROM_EMAIL") ?? `billing@${platformMailDomain()}`;
}

export function platformNoreplyEmail(): string {
  return firstEnv("PLATFORM_NOREPLY_EMAIL") ?? `noreply@${platformMailDomain()}`;
}

/**
 * The website printed on invoice PDFs — the apex marketing site, not the app.
 *
 * Izzy’s call, 2026-08-23: the invoice shows loopcom.net. It used to borrow
 * DEFAULT_PLATFORM_MAIL_DOMAIN, which is why it printed the old domain — it has
 * its own constant now, because the marketing site and the mail domain are
 * separate questions that move at different times.
 *
 * ⛔ loopcom.net’s apex serves a LIVE Squarespace site, so this points somewhere
 * real. ⛔ The ONLY caller is the invoice/receipt PDF — keep it that way, or this
 * default quietly becomes a platform-wide answer.
 */
export const DEFAULT_PLATFORM_WEBSITE = "loopcom.net";

export function platformWebsite(): string {
  return firstEnv("PLATFORM_WEBSITE") ?? DEFAULT_PLATFORM_WEBSITE;
}
