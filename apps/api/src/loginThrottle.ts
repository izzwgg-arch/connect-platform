/**
 * Login brute-force / credential-stuffing throttle.
 *
 * ⛔ WHY THIS FILE EXISTS (2026-08-16 security audit)
 *
 * `/auth/login` already had a per-account limiter, but it was wrapped in
 *
 *     const loginRateLimitEnabled = process.env.NODE_ENV === "production" || ...
 *
 * and **the api container sets no NODE_ENV** (proven live: `docker exec app-api-1`
 * prints an empty value, while telephony prints "production"). So the limiter was
 * dead code and had never executed in production — the same class of bug as the
 * error-leak handler fixed in `4fb512ed`. See memory `api-container-no-node-env`.
 *
 * ⛔ RULE: never gate a security control on NODE_ENV in apps/api. Nothing in this
 * file reads it. The control is always on; `LOGIN_THROTTLE_DISABLED=1` is the only
 * off switch and it must be set deliberately.
 *
 * ⛔ DESIGN RULE — a forgotten password is not an attack (Phase 36 of the mandate).
 * One person fat-fingering their own password ten times must NOT be banned. So the
 * per-account window is generous and only ever produces a short, self-expiring
 * throttle, a successful login clears it completely, and **no decision here is ever
 * permanent**. The high-confidence attack signal is deliberately a *different*
 * dimension: one source trying MANY DISTINCT ACCOUNTS. That is credential stuffing
 * and it is what earns a source-level block — never raw failure count alone.
 *
 * ⛔ KNOWN LIMITATION, stated honestly rather than papered over: state is per-process
 * and in-memory, so it resets on every api restart and blue/green runs two api
 * processes (each with its own budget). That makes it a speed bump, not a wall —
 * exactly the weakness that made the old ADMIN_ALERT cooldown Map fail. It is still
 * strictly better than the current state (no limiter at all) and it adds NO new
 * runtime dependency to the login path, which is why it ships this way first. The
 * store is pluggable (`setLoginThrottleStore`) so moving it to Redis later is a
 * one-line change and does not touch the decision logic or its tests.
 */

export type LoginThrottleAction = "allow" | "throttle" | "block";

export type LoginThrottleDecision = {
  action: LoginThrottleAction;
  /** Machine-readable reason, safe to log. */
  reason: string;
  /** Human-readable explanation. Phase 41: a decision must always be explainable. */
  detail: string;
  /** Seconds the caller should advertise in Retry-After. */
  retryAfterSeconds: number;
};

const ALLOW: LoginThrottleDecision = {
  action: "allow",
  reason: "ok",
  detail: "No throttle applied.",
  retryAfterSeconds: 0,
};

export type LoginThrottleConfig = {
  /** Failures for ONE account before that account is throttled. */
  accountFailureLimit: number;
  accountWindowMs: number;
  /** Total failures from one source before that source is throttled. */
  sourceFailureLimit: number;
  sourceWindowMs: number;
  /**
   * Distinct accounts a single source may fail against before it is treated as
   * credential stuffing. This — not the raw failure count — is the signal that
   * separates an attacker from a person who forgot their own password.
   */
  sourceDistinctAccountLimit: number;
  /** How long a source-level block lasts. Always short, never permanent. */
  blockMs: number;
};

export const DEFAULT_LOGIN_THROTTLE_CONFIG: LoginThrottleConfig = {
  accountFailureLimit: 10,
  accountWindowMs: 15 * 60 * 1000,
  sourceFailureLimit: 30,
  sourceWindowMs: 10 * 60 * 1000,
  sourceDistinctAccountLimit: 6,
  blockMs: 15 * 60 * 1000,
};

type Attempt = { at: number; account: string };

export type LoginThrottleStore = {
  /** Failure timestamps for one account. */
  account: Map<string, number[]>;
  /** Failures from one source, carrying which account each was against. */
  source: Map<string, Attempt[]>;
};

let store: LoginThrottleStore = { account: new Map(), source: new Map() };

/** Swap the backing store (e.g. for a Redis-backed implementation, or in tests). */
export function setLoginThrottleStore(next: LoginThrottleStore) {
  store = next;
}

export function resetLoginThrottle() {
  store = { account: new Map(), source: new Map() };
}

function prune(times: number[], threshold: number): number[] {
  return times.filter((t) => t >= threshold);
}

function pruneAttempts(attempts: Attempt[], threshold: number): Attempt[] {
  return attempts.filter((a) => a.at >= threshold);
}

/**
 * A source key that does not hand an attacker a free bypass by rotating the last
 * octet, and does not lump an entire IPv6 provider together either. IPv4 is used
 * whole (a /32 is one machine); IPv6 is cut to the /64 that a single subscriber
 * line is normally delegated.
 *
 * ⛔ Deliberately NOT widened to an IPv4 /24: shared-NAT offices and carrier CGNAT
 * put unrelated customers behind one address already, and widening further would
 * punish a whole neighbourhood for one bad actor.
 */
export function normalizeSourceKey(ip: string | undefined | null): string {
  const raw = (ip || "").trim();
  if (!raw) return "unknown";
  if (raw.includes(":")) {
    const parts = raw.split(":");
    return parts.slice(0, 4).join(":") + "::/64";
  }
  return raw;
}

export function isLoginThrottleDisabled(): boolean {
  return (process.env.LOGIN_THROTTLE_DISABLED || "").trim() === "1";
}

/**
 * Resolve the real client address.
 *
 * ⛔ `req.ip` IS USELESS HERE AND USING IT WOULD HAVE CAUSED AN OUTAGE. Fastify is
 * constructed without `trustProxy`, so `req.ip` is the nginx/docker hop — the SAME
 * value for every request on the platform. Feeding that into the source counter would
 * have put all customers in one bucket, and six unrelated people mistyping a password
 * within ten minutes would have blocked login for EVERYONE. Verified before shipping,
 * not after.
 *
 * ⛔ TAKE THE LAST ENTRY OF X-Forwarded-For, NEVER THE FIRST. nginx sets
 * `X-Forwarded-For $proxy_add_x_forwarded_for`, which APPENDS the real peer address to
 * whatever the client already sent. So earlier entries are attacker-controlled — a
 * client can send `X-Forwarded-For: 1.2.3.4` and it is preserved verbatim. Reading the
 * first entry (the usual mistake) would let an attacker forge a fresh source on every
 * request and walk straight through the throttle, and let them poison a chosen victim
 * IP into a block.
 *
 * Returns "unknown" when there is no header — which is a real bucket, not a bypass.
 */
export function clientIpFromForwardedFor(
  forwardedFor: string | string[] | undefined,
): string {
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  if (!raw) return "unknown";
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return "unknown";
  return parts[parts.length - 1];
}

/**
 * Decide whether a login attempt may proceed. Call BEFORE checking the password.
 * Never throws — a throttle that can crash the login route is worse than no throttle.
 */
export function evaluateLoginAttempt(
  account: string,
  sourceIp: string | undefined | null,
  now: number = Date.now(),
  config: LoginThrottleConfig = DEFAULT_LOGIN_THROTTLE_CONFIG,
): LoginThrottleDecision {
  try {
    if (isLoginThrottleDisabled()) return ALLOW;
    const accountKey = (account || "").toLowerCase();
    const sourceKey = normalizeSourceKey(sourceIp);

    const sourceAttempts = pruneAttempts(
      store.source.get(sourceKey) || [],
      now - config.sourceWindowMs,
    );
    store.source.set(sourceKey, sourceAttempts);

    // Credential stuffing: one source, many DIFFERENT accounts. Highest confidence
    // signal available without any external reputation feed, so it is checked first.
    const distinctAccounts = new Set(sourceAttempts.map((a) => a.account)).size;
    if (distinctAccounts >= config.sourceDistinctAccountLimit) {
      return {
        action: "block",
        reason: "credential_stuffing",
        detail:
          `Source attempted ${distinctAccounts} distinct accounts within ` +
          `${Math.round(config.sourceWindowMs / 60000)} minutes.`,
        retryAfterSeconds: Math.round(config.blockMs / 1000),
      };
    }

    if (sourceAttempts.length >= config.sourceFailureLimit) {
      return {
        action: "throttle",
        reason: "source_failure_volume",
        detail:
          `Source produced ${sourceAttempts.length} failed logins within ` +
          `${Math.round(config.sourceWindowMs / 60000)} minutes.`,
        retryAfterSeconds: Math.round(config.sourceWindowMs / 1000),
      };
    }

    const accountFailures = prune(
      store.account.get(accountKey) || [],
      now - config.accountWindowMs,
    );
    store.account.set(accountKey, accountFailures);
    if (accountFailures.length >= config.accountFailureLimit) {
      return {
        action: "throttle",
        reason: "account_failure_volume",
        detail:
          `Account had ${accountFailures.length} failed logins within ` +
          `${Math.round(config.accountWindowMs / 60000)} minutes.`,
        retryAfterSeconds: Math.round(config.accountWindowMs / 1000),
      };
    }

    return ALLOW;
  } catch {
    // Fail OPEN on an internal error: locking every customer out of their phone
    // system because a counter misbehaved is a worse outcome than a missed throttle.
    return ALLOW;
  }
}

/** Record a failed password check. Never throws. */
export function recordLoginFailure(
  account: string,
  sourceIp: string | undefined | null,
  now: number = Date.now(),
  config: LoginThrottleConfig = DEFAULT_LOGIN_THROTTLE_CONFIG,
): void {
  try {
    const accountKey = (account || "").toLowerCase();
    const sourceKey = normalizeSourceKey(sourceIp);

    const accountFailures = prune(
      store.account.get(accountKey) || [],
      now - config.accountWindowMs,
    );
    accountFailures.push(now);
    store.account.set(accountKey, accountFailures);

    const sourceAttempts = pruneAttempts(
      store.source.get(sourceKey) || [],
      now - config.sourceWindowMs,
    );
    sourceAttempts.push({ at: now, account: accountKey });
    store.source.set(sourceKey, sourceAttempts);
  } catch {
    /* never break the login route */
  }
}

/**
 * Clear an account's failure history after a successful sign-in.
 *
 * ⛔ Deliberately does NOT clear the source history: the whole point of the
 * credential-stuffing counter is that an attacker who finally guesses one account
 * out of hundreds must not thereby erase the evidence of the other attempts.
 */
export function recordLoginSuccess(account: string): void {
  try {
    store.account.delete((account || "").toLowerCase());
  } catch {
    /* never break the login route */
  }
}
