/**
 * The one number both halves of "Fix it!" by text must agree on.
 *
 * It lives alone because the two modules that need it import each other:
 * `agentFixByText.ts` mints and spends codes through `agentGrantRoutes.ts`,
 * which in turn needs this TTL to decide how old a draft may be. A shared
 * constant in its own file keeps that honest instead of duplicating the value
 * into two places that would drift.
 *
 * ⛔ The code's lifetime and the draft's approvable lifetime are THE SAME
 * NUMBER on purpose. If the code outlived the draft, replying in the morning
 * would answer "expired" — the feature failing exactly when it is most useful.
 * If the draft outlived the code, an action would sit executable with nothing
 * left able to authorise it.
 */
export const FIX_CODE_TTL_MS = Number(process.env.AGENT_FIX_CODE_TTL_MS || 24 * 3600 * 1000);
