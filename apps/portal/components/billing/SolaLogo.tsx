export type SolaLogoTheme = "light" | "dark";

const SOLA_LIGHT = "/assets/vendor/sola/sola-logo-positive-rgb.png";
const SOLA_DARK = "/assets/vendor/sola/sola-logo-reverse-rgb.png";

/**
 * The Sola mark — a DIFFERENT vendor file per theme (Izzy, 2026-09-01: "dark
 * mode and light mode should have different sola logos").
 *
 * Sola ships exactly this pair in apps/portal/public/assets/vendor/sola/:
 * `sola-logo-positive-rgb.png` (near-black wordmark + #0047FF ring, for light
 * surfaces) and `sola-logo-reverse-rgb.png` (white wordmark + the same blue
 * ring, for dark surfaces). Their README's rule is "use these files as-is; do
 * not stretch, recolor, invert, or distort" — which is why this is two images,
 * ⛔ never one image recolored with CSS filters and never an inline SVG whose
 * ink is re-tinted per theme (an earlier version did exactly that; it was
 * replaced on Izzy's instruction). Both files are 1100×300.
 */
export function SolaLogo({
  theme = "light",
  className,
}: {
  theme?: SolaLogoTheme;
  className?: string;
}) {
  return (
    <img
      src={theme === "dark" ? SOLA_DARK : SOLA_LIGHT}
      alt="Sola Payments"
      width={1100}
      height={300}
      className={className}
      decoding="async"
      loading="lazy"
    />
  );
}
