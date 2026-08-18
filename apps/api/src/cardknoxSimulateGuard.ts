import { isEnvFlagEnabled } from "./envFlag";

/**
 * ⛔⛔ THE PAYMENT-SAFETY GUARD THAT HAD NEVER RUN.
 *
 * `SOLA_CARDKNOX_SIMULATE` makes the Cardknox/Sola gateway *pretend* to charge
 * a card: it returns an approval without any money moving. In production that
 * means invoices marked PAID, receipts emailed, autopay "succeeding", and a
 * customer's card never touched. The api is supposed to refuse to boot rather
 * than run in that state.
 *
 * It never refused, because the guard read:
 *
 *     if (process.env.NODE_ENV === "production" && simulate) throw ...
 *
 * and **the api container sets no `NODE_ENV`** (proven live 2026-08-18:
 * `docker exec app-api-1 printenv NODE_ENV` → empty, exit 1, while
 * `app-telephony-1` prints `production`). So the guard was permanently
 * false — same class as the login throttle (`loginThrottle.ts`), the
 * error-leak handler (`4fb512ed`) and the anonymous tenant factory
 * (`onboarding/publicRoutes.ts`). See CLAUDE.md → "THE NODE_ENV SWEEP NOBODY
 * DID".
 *
 * ⛔ A SECOND HOLE, found while fixing the first: the guard only recognised
 * the spelling `"true"`, but `billing/solaGateway.ts:66`/`:195` and
 * `billing/solaExternalSchedules.ts:199` turn simulate on for the literal
 * `"1"`. `SOLA_CARDKNOX_SIMULATE=1` therefore put the real gateway into
 * simulate mode with the guard staying silent — even if `NODE_ENV` had been
 * set. Both spellings (and `yes`/`on`) now refuse boot, via the one shared
 * `isEnvFlagEnabled` rule.
 *
 * ⛔ Do NOT "fix" the dead-gate class by setting `NODE_ENV=production` on the
 * container — that flips several unrelated dead gates at once with unknown
 * blast radius, and CLAUDE.md forbids it. The dependency is removed instead.
 *
 * ✅ Safe to make this fail closed: verified live 2026-08-18 that
 * `SOLA_CARDKNOX_SIMULATE=false` inside `app-api-1` AND `app-worker-1`; it is
 * set in NO env file under `/opt/connectcomms/env/`, and comes from the
 * compose default `${SOLA_CARDKNOX_SIMULATE:-false}` present in all three
 * blocks (`api`, `api_candidate`, `worker`). Nothing in production is
 * simulating, so this guard cannot stop the api booting today.
 *
 * Local development that genuinely wants the fake gateway sets BOTH
 * `SOLA_CARDKNOX_SIMULATE=1` and `SOLA_CARDKNOX_ALLOW_SIMULATE=1`. Two
 * variables on purpose: a single one is exactly what an operator copies into a
 * production env file by accident.
 */
export const CARDKNOX_SIMULATE_VAR = "SOLA_CARDKNOX_SIMULATE";
export const CARDKNOX_ALLOW_SIMULATE_VAR = "SOLA_CARDKNOX_ALLOW_SIMULATE";

export type CardknoxSimulateDecision = {
  /** Would any Sola/Cardknox reader in this repo treat the value as "simulate"? */
  simulateRequested: boolean;
  /** `boot` = carry on; `refuse_boot` = throw before the server listens. */
  action: "boot" | "refuse_boot";
  reason: "not_simulating" | "explicit_dev_override" | "simulate_not_allowed";
};

export function decideCardknoxSimulate(
  env: Record<string, string | undefined>,
): CardknoxSimulateDecision {
  const simulateRequested = isEnvFlagEnabled(env[CARDKNOX_SIMULATE_VAR]);
  if (!simulateRequested) {
    return { simulateRequested: false, action: "boot", reason: "not_simulating" };
  }
  if (isEnvFlagEnabled(env[CARDKNOX_ALLOW_SIMULATE_VAR])) {
    return { simulateRequested: true, action: "boot", reason: "explicit_dev_override" };
  }
  return { simulateRequested: true, action: "refuse_boot", reason: "simulate_not_allowed" };
}

/**
 * Called once at api boot. Throws — deliberately preventing the process from
 * listening — when the card gateway would fake approvals without an operator
 * having explicitly said that is what they want.
 */
export function assertCardknoxNotSimulating(
  env: Record<string, string | undefined> = process.env,
): CardknoxSimulateDecision {
  const decision = decideCardknoxSimulate(env);
  if (decision.action === "refuse_boot") {
    throw new Error(
      `${CARDKNOX_SIMULATE_VAR} is on: card charges would be FAKED (approved without money moving). ` +
        `Refusing to start. If this really is a development machine, also set ` +
        `${CARDKNOX_ALLOW_SIMULATE_VAR}=1.`,
    );
  }
  return decision;
}
