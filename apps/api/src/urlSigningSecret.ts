/**
 * ⛔ ONE resolver for every signed-download-URL HMAC key in apps/api.
 *
 * Fix for §3b of `docs/ai-context/AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md`.
 * `packages/shared/src/chatSignedUrl.ts` got this treatment on 2026-08-18; these
 * four helpers (prompt / MOH / CRM doc / CRM voicemail-drop) were left behind and
 * still ended their chain on the literal `"dev-signing-secret"`, which is
 * published in this repo.
 *
 * ⛔⛔ THE DEFECT THIS REPLACES, and why it was invisible.
 *
 * Every helper wrote the same shape:
 *
 *     process.env.X_URL_SIGNING_SECRET ||
 *     process.env.MOH_URL_SIGNING_SECRET ||
 *     process.env.CDR_INGEST_SECRET ||
 *     "dev-signing-secret"
 *
 * `""` IS FALSY IN JS, so a variable "set" to blank slid straight down the chain
 * with no error and no log line. All of these are empty or undefined in
 * `app-api-1`, so the literal WAS the production key: the signature authorized
 * nothing and any expired URL could simply be re-signed by anyone with the repo.
 *
 * ⛔ AND THE KEY HAD ALREADY MOVED ONCE, SILENTLY. When `CDR_INGEST_SECRET` was
 * populated on 2026-08-18 to close §1, the third rung of that chain became a real
 * 64-char value — so all four schemes rotated off the literal that night without
 * anybody choosing to. Anything minted before then was already unverifiable.
 * That is precisely why a chain of unrelated fallbacks is the wrong shape: a
 * change made for one reason rotates keys for four other reasons.
 *
 * ⛔ `CDR_INGEST_SECRET` IS DELIBERATELY GONE FROM THE CHAIN. It is an
 * *authentication* credential for the `/internal/*` doors, and CLAUDE.md now
 * records rotating it as a four-step, multi-service operation. Borrowing an auth
 * secret as a signing key means every such rotation silently invalidates every
 * outstanding signed URL as a side effect.
 *
 * ── The rule ──────────────────────────────────────────────────────────────────
 *
 *   1. the scheme's own dedicated variable, when non-blank after trimming;
 *   2. else a key DERIVED from `JWT_SECRET` under a per-scheme label;
 *   3. else THROW. Never a literal, never a shared auth secret.
 *
 * `JWT_SECRET` is 64 chars, verified byte-identical across api, telephony and
 * worker, and is not in git — so the derivation makes every process agree with no
 * new configuration. It is a derivation, never the raw secret, so a leaked signed
 * URL can never expose the JWT signing key.
 *
 * ⛔ Per-scheme labels are not decoration. `promptStorage` and `mohStorage` sign
 * the byte-identical payload `${storageKey}:${exp}` — so while they shared one
 * key, a valid MOH signature was also a valid PROMPT signature for the same
 * storage key. Domain separation ends that cross-scheme confusion for free.
 *
 * ⛔ Never gate any of this on `NODE_ENV` — the api container sets none
 * (CLAUDE.md), so such a gate is permanently false.
 *
 * ⛔ Read at CALL time, never memoised at module load, so it stays testable and
 * so a container that gains the variable does not need a code change.
 */

import * as crypto from "node:crypto";

export type UrlSigningScheme =
  | "prompt"
  | "moh"
  | "crm-doc"
  | "crm-voicemail-drop"
  | "marketing-unsubscribe";

/** The dedicated env var each scheme may be pinned with. */
const EXPLICIT_ENV_VAR: Record<UrlSigningScheme, string> = {
  prompt: "PROMPT_URL_SIGNING_SECRET",
  moh: "MOH_URL_SIGNING_SECRET",
  "crm-doc": "CRM_DOC_URL_SIGNING_SECRET",
  "crm-voicemail-drop": "CRM_VOICEMAIL_DROP_URL_SIGNING_SECRET",
  "marketing-unsubscribe": "MARKETING_UNSUBSCRIBE_URL_SIGNING_SECRET",
};

/**
 * Domain-separation labels. ⛔ Changing one of these strings rotates every
 * outstanding URL of that scheme — treat them as frozen.
 */
const DERIVATION_LABEL: Record<UrlSigningScheme, string> = {
  prompt: "connect:prompt-url-signing:v1",
  moh: "connect:moh-url-signing:v1",
  "crm-doc": "connect:crm-doc-url-signing:v1",
  "crm-voicemail-drop": "connect:crm-voicemail-drop-url-signing:v1",
  "marketing-unsubscribe": "connect:marketing-unsubscribe-url-signing:v1",
};

/** The literal that must never come back. Exported so tests can assert its absence. */
export const FORBIDDEN_SIGNING_LITERAL = "dev-signing-secret";

export function urlSigningEnvVar(scheme: UrlSigningScheme): string {
  return EXPLICIT_ENV_VAR[scheme];
}

/**
 * Resolve the HMAC key for one signed-URL scheme.
 * @throws when neither the scheme's variable nor `JWT_SECRET` is available —
 *         refusing is correct, because signing with a guessable constant is
 *         indistinguishable from not signing at all.
 */
export function resolveUrlSigningKey(scheme: UrlSigningScheme): string {
  const explicit = String(process.env[EXPLICIT_ENV_VAR[scheme]] ?? "").trim();
  if (explicit) return explicit;

  const jwtSecret = String(process.env.JWT_SECRET ?? "").trim();
  if (jwtSecret) {
    return crypto
      .createHmac("sha256", jwtSecret)
      .update(DERIVATION_LABEL[scheme])
      .digest("hex");
  }

  throw new Error(
    `${scheme}_url_signing_secret_unavailable: set ${EXPLICIT_ENV_VAR[scheme]} (or JWT_SECRET) — refusing to sign with a known constant`,
  );
}
