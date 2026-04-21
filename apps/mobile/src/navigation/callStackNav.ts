/**
 * Walks parent navigators until we find a stack that owns `routeName`.
 * `navigation.getParent()` alone is unsafe: it often points at the root stack,
 * which cannot navigate to ActiveCall / IncomingCall on the inner app stack.
 */
export function findNavigatorWithRoute(nav: any, routeName: string): any | null {
  let cur: any = nav;
  for (let i = 0; i < 10; i++) {
    const state = cur?.getState?.();
    if (state?.routeNames?.includes?.(routeName)) return cur;
    const parent = cur?.getParent?.();
    if (!parent) break;
    cur = parent;
  }
  return null;
}

/** Stack that hosts incoming / active call modals (same layer as TabNavigator's parent). */
export function findCallModalNavigator(nav: any): any | null {
  return (
    findNavigatorWithRoute(nav, "ActiveCall") ??
    findNavigatorWithRoute(nav, "IncomingCall")
  );
}
