/**
 * Cloudflare Turnstile verification — the robot check on the two public forms.
 *
 * ⛔ THE TWO RULES THAT MATTER, AND THEY POINT IN OPPOSITE DIRECTIONS:
 *
 * 1. NO SECRET  ->  THE CHECK IS OFF ENTIRELY, and the site behaves exactly as
 *    it did before this file existed. That is what makes deploying safe: the
 *    check arms itself only when a secret is actually present. A half-configured
 *    Turnstile that refuses every visitor is worse than no Turnstile at all.
 *
 * 2. SECRET SET, TOKEN MISSING OR FORGED  ->  REFUSE.
 *    SECRET SET, CLOUDFLARE UNREACHABLE   ->  ACCEPT, and say so in the record.
 *
 *    That asymmetry is deliberate. A bot that sends no token is refused. But if
 *    Cloudflare itself is down, the failure we must never choose is turning a
 *    real customer away from a quote form. A bot getting through costs us one
 *    junk email; a lost lead costs a sale and we never even learn it happened.
 *    The email is stamped so the operator can see the check did not run.
 *
 * ⛔ A TOKEN IS SINGLE-USE. Verifying the same token twice fails the second
 *    time. So verify ONCE per submission, and the browser must call
 *    turnstile.reset() after any refusal or the visitor's second attempt is
 *    rejected for a reason that has nothing to do with what they typed.
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 6000;

/** The secret lives ONLY in the process environment, never in the repo. */
function secret() {
  return String(process.env.TURNSTILE_SECRET_KEY || '').trim();
}

export function turnstileConfigured() {
  return secret().length > 0;
}

export function turnstileStatus() {
  const s = secret();
  return { configured: s.length > 0, secretLength: s.length };
}

/**
 * @returns {Promise<{allow:boolean, outcome:string, detail?:string}>}
 *   outcome is one of:
 *     'off'          - no secret configured; the check did not run
 *     'verified'     - Cloudflare confirmed a real browser
 *     'missing'      - no token was sent  (REFUSE)
 *     'invalid'      - Cloudflare rejected the token (REFUSE)
 *     'unavailable'  - we could not reach Cloudflare (ACCEPT, flagged)
 */
export async function verifyTurnstile(token, ip) {
  const key = secret();
  if (!key) return { allow: true, outcome: 'off' };

  const t = String(token || '').trim();
  if (!t) return { allow: false, outcome: 'missing' };
  // Cloudflare caps the token at 2048 characters. Anything longer is not one.
  if (t.length > 2048) return { allow: false, outcome: 'invalid', detail: 'oversize' };

  const body = new URLSearchParams();
  body.set('secret', key);
  body.set('response', t);
  if (ip && ip !== 'unknown') body.set('remoteip', ip);

  let res;
  try {
    res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // Network failure or timeout. Fail OPEN. See rule 2.
    return { allow: true, outcome: 'unavailable', detail: String((e && e.message) || e).slice(0, 120) };
  }

  // A 5xx is Cloudflare's problem, not the visitor's. Fail OPEN.
  if (res.status >= 500) {
    return { allow: true, outcome: 'unavailable', detail: 'http_' + res.status };
  }

  let j;
  try {
    j = await res.json();
  } catch {
    return { allow: true, outcome: 'unavailable', detail: 'unparsable_response' };
  }

  if (j && j.success === true) return { allow: true, outcome: 'verified' };

  const codes = Array.isArray(j && j['error-codes']) ? j['error-codes'] : [];

  // ⛔ These two mean WE are misconfigured, not that the visitor is a bot.
  // Refusing a real customer because our own secret is wrong is the worst
  // outcome available, so treat it as an outage: accept, and flag it loudly.
  if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
    return { allow: true, outcome: 'unavailable', detail: codes.join(',').slice(0, 120) };
  }

  return { allow: false, outcome: 'invalid', detail: codes.join(',').slice(0, 120) || 'rejected' };
}
