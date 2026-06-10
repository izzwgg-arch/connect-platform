// Tracks which tab the user was on before a call screen took over, so that
// hanging up returns them to where the call started (dialer, call history,
// contacts, messages, ...) instead of always snapping to the dialer.
//
// We record only *tab* routes. The full-screen call modals (ActiveCall /
// IncomingCall) are intentionally ignored, so while a call is on screen the
// remembered value stays pinned to the originating tab.

const TAB_ROUTES = new Set<string>([
  'Team',
  'Contact',
  'Recent',
  'Keypad',
  'Chat',
  'Voicemail',
  'Settings',
]);

const DEFAULT_RETURN_TAB = 'Keypad';

let lastTabRoute: string | null = null;

export function isTabRoute(routeName: string | null | undefined): boolean {
  return !!routeName && TAB_ROUTES.has(routeName);
}

/**
 * Record the currently focused route. No-op for anything that isn't a tab
 * (e.g. ActiveCall / IncomingCall / modals), so the originating tab survives
 * the entire call.
 */
export function recordFocusedRoute(routeName: string | null | undefined): void {
  if (routeName && TAB_ROUTES.has(routeName)) {
    lastTabRoute = routeName;
  }
}

/**
 * The tab to return to when a call ends. Falls back to the dialer when we
 * never saw a tab (e.g. a cold-start incoming call answered from the lock
 * screen).
 */
export function getCallReturnTab(): string {
  return lastTabRoute && TAB_ROUTES.has(lastTabRoute) ? lastTabRoute : DEFAULT_RETURN_TAB;
}
