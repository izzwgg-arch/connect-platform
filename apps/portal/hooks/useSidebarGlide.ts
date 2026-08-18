"use client";

import { useLayoutEffect, useRef } from "react";

/** Expanded sidebar width, and the width of the collapsed rail. */
const FULL = 280;
const RAIL = 68;
const SHIFT = FULL - RAIL;
const DURATION_MS = 200;

/**
 * Slides the sidebar open and shut without laying the page out on every frame.
 *
 * ⛔ THE WHOLE POINT, and it is not obvious from reading the code:
 * animating the sidebar's `width` forces a full layout every frame. Measured on
 * the owner's machine (Intel HD 4000 driving a 3440px ultrawide) that dropped
 * 5-6 frames per toggle — and it dropped the same 5-6 with the animation
 * REMOVED ENTIRELY, because the cost is re-rendering the shell at a new width,
 * not the animation itself. So the width changes exactly ONCE per toggle here,
 * and the motion is carried by two things the GPU does without laying anything
 * out:
 *   - the sheet's clip-path closes over a panel that never changes size
 *   - the workspace is translated from where it looked a moment ago back to 0
 * Measured after: 0-2 dropped frames per toggle, layout time down ~12x.
 *
 * ⛔ The forced read of `offsetWidth` is load-bearing. It commits the starting
 * position before the transition is armed. Deferring that to a rAF instead was
 * measured and came out FIVE TIMES WORSE (5.75 dropped frames vs 0.9).
 */
export function useSidebarGlide(railMode: boolean, enabled: boolean) {
  const navRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const previous = useRef<boolean | null>(null);
  const timer = useRef<number | null>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const workspace = workspaceRef.current;
    const first = previous.current === null;
    const unchanged = previous.current === railMode;
    previous.current = railMode;
    // Nothing to animate on the first paint, on mobile (that drawer slides on
    // its own transform), or when the flag did not actually move.
    if (!nav || !workspace || first || unchanged || !enabled) return;

    if (timer.current) window.clearTimeout(timer.current);
    nav.classList.remove("nav-gliding");
    workspace.classList.remove("ws-gliding");

    // Start state: the panel and the content are drawn where they were a
    // moment ago, even though the layout has already moved on.
    nav.classList.add("nav-gliding");
    workspace.style.transform = `translateX(${railMode ? SHIFT : -SHIFT}px)`;
    void workspace.offsetWidth;

    // From here on nothing lays out: a clip closes and a layer slides.
    workspace.classList.add("ws-gliding");
    workspace.style.transform = "translateX(0px)";

    timer.current = window.setTimeout(() => {
      nav.classList.remove("nav-gliding");
      workspace.classList.remove("ws-gliding");
      workspace.style.transform = "";
      timer.current = null;
    }, DURATION_MS + 30);
  }, [railMode, enabled]);

  useLayoutEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  return { navRef, workspaceRef };
}
