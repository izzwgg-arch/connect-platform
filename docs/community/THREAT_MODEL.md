# Loopcom Community — threat model & security controls

Scope: `apps/community-api`, `apps/community-web`, `apps/community-mobile`, their own Postgres, object storage, the Loopcom SSO seam. Method: STRIDE per trust boundary, mapped to the controls in code, then the OWASP Top 10 checklist with the file that implements each control.

## Trust boundaries

1. **Browser / native app → api** (public internet). Bearer access tokens (15 min, HS256 signed with `COMMUNITY_JWT_SECRET` ≥ 32 chars), opaque refresh tokens (sha256 at rest, rotation with 30 s grace, reuse outside the window revokes the family — `src/auth/tokens.ts`).
2. **api → Postgres** (private network only; `infra/community/docker-compose.yml` binds the api to 127.0.0.1 behind nginx).
3. **api → object storage** (disk or S3 with keys built from ids only — `src/lib/storage.ts` rejects any key that escapes the root).
4. **api → Loopcom api** (outbound only, `src/auth/loopcomSso.ts`; the Loopcom JWT is verified by asking Loopcom `/me`; nothing minted in reverse).
5. **api → Anthropic / Expo push / SMTP / Google / Apple** (outbound, timeouts on every call, failures degrade: mail parks for retry, push prunes dead tokens, AI falls back to rules).
6. **Staff → admin console** (`StaffGrant` row required; a Loopcom SUPER_ADMIN is granted ADMIN at SSO; every mutation writes `AuditLog`).

## STRIDE

| Threat | Where | Control |
|---|---|---|
| Spoofing (identity) | login, SSO, OAuth | argon2id passwords; TOTP; WebAuthn passkeys (challenge stored server-side, RP id/origin pinned); Google id_token verified with the client id; Apple id_token verified against Apple JWKS + audience; Loopcom token verified against Loopcom itself; new-device sign-in alerts |
| Spoofing (session) | refresh tokens | hashed at rest, rotated per use, reuse = theft signal → whole session revoked; sessions listable/revocable; password change/reset revokes others |
| Tampering (data) | every mutation | zod validation on body/params/query; ownership checked before permission before body (`notFound()` for non-owners); Prisma parameterised queries; the two `$queryRaw` call sites (`src/lib/search.ts`, `src/core/schedulers.ts`) use tagged templates, never string concatenation |
| Tampering (files) | media | MIME sniffed from bytes, size caps per kind, images re-encoded (EXIF stripped), private assets served only with HMAC-signed expiring URLs |
| Tampering (actions) | concierge | proposed actions are HMAC-signed, bound to the person, 30-minute expiry, and executed only on an explicit confirm |
| Repudiation | admin, roles, moderation, privacy, verification | `AuditLog` rows with actor, action, target, before/after, source, ip (`src/lib/audit.ts`); moderator notes required |
| Information disclosure | profiles, graph, messaging | `policy.ts` per domain; blocks and absence share one `not_found` shape (no oracle); message requests cap a stranger at one message; read receipts/presence gated by both sides' preferences; intro paths only from discoverable evidence; export never includes hashes/secrets; analytics props screened for password/token/body keys |
| Information disclosure (cross-org) | company admin | org permission checks (`requireOrgPermission`) on every org mutation; last-owner guard; membership affiliation states |
| Denial of service | public endpoints | `@fastify/rate-limit` global 600/min per person-or-ip + tight per-route limits on register/login/reset/verify/uploads/concierge; body limit; upload size caps; link-preview fetch capped at 512 KB / 5 s with private-IP refusal (SSRF) |
| Elevation of privilege | staff, org roles | `requireStaff` from the DB, never a token claim; org roles resolved per request; CUSTOM permissions explicit; `COMMUNITY_TEST_HOOKS` refuses to boot in production |

## OWASP Top 10 (2021) checklist

| # | Class | Status | Evidence |
|---|---|---|---|
| A01 Broken access control | ✓ | ownership→permission→body order; per-user thread isolation; `graph.test.ts`, `messaging.test.ts`, `organizations.test.ts`, `moderation.test.ts` permission cases |
| A02 Cryptographic failures | ✓ | argon2id; sha256 refresh tokens; HMAC media/action signatures; TLS terminated at nginx; secrets only from env |
| A03 Injection | ✓ | Prisma + tagged `$queryRaw`; no `Unsafe` variants (grep clean); React escapes output; the one `dangerouslySetInnerHTML` on notifications was removed 2026-09-18; `Icon.tsx` injects only a constant SVG path table |
| A04 Insecure design | ✓ | message-request cap, discoverable-intro rule, one-accepted-quote DB index, idempotency keys, verification chips instead of a score |
| A05 Security misconfiguration | ✓ | CSP/X-Frame-Options/nosniff/Referrer-Policy/Permissions-Policy in `next.config.mjs` (`unsafe-eval` only in dev); api sets nosniff/referrer/no-store; CORS allowlist; test hooks and rate-limit bypass are env-gated and refused in production |
| A06 Vulnerable components | ⚠ | `@fastify/jwt` bumped to 10.2.2 (fast-jwt 6.3.3) 2026-09-18; **Next 14.2.35 carries open advisories (patched in 15.x)** — upgrade tracked as an open High item; `pnpm audit` in CI |
| A07 Identification & auth failures | ✓ | login throttled (10/5 min), generic failure message, TOTP, passkeys, session revocation, new-device alert |
| A08 Software/data integrity | ✓ | lockfile committed; SBOM step in CI; media sha256; signed action tokens |
| A09 Logging & monitoring | ✓ | pino request logs with request ids; audit log; admin security alerts (`/admin/security/alerts`: failed-login spikes, new-device alerts, resets); notifications health; system health with in-process p95 |
| A10 SSRF | ✓ | link preview refuses private/loopback/link-local ranges and localhost (`src/posts/service.ts`); all other outbound targets are fixed hosts |

## Open items (honest)

- Next.js 14.2.x advisories → plan the 15.x upgrade with the E2E suite as the gate.
- No WAF/bot protection in front of `/auth/register` beyond rate limits — Cloudflare Turnstile (already used on the Loopcom portal) is the intended addition on the separate server.
- Malware scanning: MIME sniffing + re-encoding only; a ClamAV sidecar is the planned `scanResult` provider (`MediaAsset.scanResult` is written as `"not-scanned"` today — never "clean" — so the UI and the admin console can say so; documents are served with `nosniff` and never rendered inline).
- Secrets manager: env files on the box; move to the host's secret store at deploy time.
