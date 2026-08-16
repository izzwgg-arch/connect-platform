/**
 * The app's brand mark in the topbar.
 *
 * ⛔ ONE file serves BOTH themes, deliberately. The wordmark is a transparent PNG
 * that reads on light and dark alike, so there is no `-light` variant to add and
 * no filter to apply — see docs/brand/loopcom/README.md. The kit does ship a
 * deep-ink light file; Izzy rejected it (2026-08-16, "I never approved any other
 * colors"). Do not reintroduce it here.
 *
 * This replaced `ConnectLogo`, whose stylesheet HID the logo entirely in light
 * mode and printed the word "Connect" as a text fallback, because the old SVG was
 * white-on-transparent. That is why the app appeared to have no logo in light mode.
 *
 * Same asset as the sign-in screen, so the browser reuses one cached file.
 */
export function LoopComLogo({ className }: { className?: string }) {
  return (
    <img
      src="/brand/loopcom/loopcom-wordmark-560.png"
      alt="LoopCom"
      className={className}
      width={560}
      height={99}
      decoding="async"
    />
  );
}
