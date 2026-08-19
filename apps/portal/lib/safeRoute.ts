/**
 * Navigate to an INTERNAL app route only.
 *
 * ⛔ Notification `route` strings are written by our own API today, but they are
 * assigned to `window.location.href`, so a `javascript:` value (or an off-origin
 * `//evil.com` / `/\evil.com`) would execute in-origin or redirect off-site if a
 * route ever became attacker-influenced. This closes that class: only a real
 * same-origin path (starts with a single "/") is allowed.
 */
export function isSafeInternalRoute(route: string | null | undefined): route is string {
  return (
    typeof route === "string" &&
    route.startsWith("/") &&
    !route.startsWith("//") &&
    !route.startsWith("/\\")
  );
}

export function navigateToInternalRoute(route: string | null | undefined): void {
  if (isSafeInternalRoute(route)) window.location.href = route;
}
