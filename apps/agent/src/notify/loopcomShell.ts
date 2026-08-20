/**
 * The agent's boundary onto THE Loopcom email look.
 *
 * ⛔ The look itself lives in `@connect/shared` (`loopcomEmailShell`) and is the
 * same one apps/api renders for the invite and voicemail emails. This module
 * exists for ONE reason: to resolve the logo URL from the agent's own
 * environment so that no email BUILDER in this app ever takes it as an input.
 * Mirror of `loopComShell()` in apps/api — read the note on `brandLogoUrl()`
 * there for why passing a brand asset into a builder is a trap this repo has
 * already fallen into once.
 *
 * ⛔ Do NOT copy the shell's markup in here. The whole point of the 2026-08-20
 * move was that the SMS bridge spent weeks on a pre-rebrand template precisely
 * because it could not reach the api's copy. A second copy recreates that.
 */
import { loopcomEmailShell, type LoopcomEmailShellOptions } from "@connect/shared";

/**
 * Absolute https URL of the Loopcom wordmark.
 *
 * ⛔ Must stay absolute and publicly reachable — mail clients cannot read a
 * relative path or a data: URI. `/brand/` is served by BOTH app hostnames, so
 * either origin resolves; nginx caches it immutably for a year.
 */
export function agentBrandLogoUrl(): string {
  const origin = (process.env.AGENT_PORTAL_URL || "https://app.connectcomunications.com").replace(/\/+$/, "");
  return `${origin}/brand/loopcom/loopcom-wordmark-email-336.png`;
}

/** Render a Loopcom email from the agent. The logo is supplied here, once. */
export function loopcomShellForAgent(opts: Omit<LoopcomEmailShellOptions, "logoUrl">): string {
  return loopcomEmailShell({ ...opts, logoUrl: agentBrandLogoUrl() });
}
