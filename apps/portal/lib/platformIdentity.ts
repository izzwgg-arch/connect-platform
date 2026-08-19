/**
 * The platform's public identity as the portal shows it. One place, so the
 * Loopcom flip is a build env change, not a grep. Keep it tiny and dependency-
 * free — onboarding pages import it and they render for signed-out visitors.
 */
export const SUPPORT_EMAIL: string =
  (process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "").trim() || "support@connectcomunications.com";
