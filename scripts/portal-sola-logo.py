"""Generate apps/portal/components/billing/SolaLogo.tsx from the SHIPPED vendor SVG.

The vendor file is the source of truth; the two path `d` strings are 4 KB of
coordinates and must never be transcribed by hand. Run from the repo root.
"""
import re

SRC = "apps/portal/public/assets/vendor/sola/sola-logo.svg"
OUT = "apps/portal/components/billing/SolaLogo.tsx"

svg = open(SRC, encoding="utf-8").read()
paths = re.findall(r'<path d="([^"]+)" fill="([^"]+)"/>', svg)
by_fill = {f.lower(): d for d, f in paths}
ring = by_fill["#0047ff"]
ink = by_fill["#020622"]

tsx = '''export type SolaLogoTheme = "light" | "dark";

/**
 * The Sola mark, inline.
 *
 * ⛔ Generated from apps/portal/public/assets/vendor/sola/sola-logo.svg by
 * `scripts/portal-sola-logo.py` — never hand-edit the path data. If the vendor
 * ships a new logo, re-run the generator rather than transcribing coordinates.
 *
 * It is inline rather than an <img> for one reason: the vendor artwork paints
 * its wordmark in near-black (#020622), which disappears on the dark pay
 * surface. Inline, the wordmark takes `currentColor`, so one file serves both
 * themes and the ring keeps Sola's blue on each. (The old component set a
 * `data-logo-theme` attribute that no stylesheet has ever read, so the dark
 * theme has been showing a near-black logo on a near-black card.)
 */
export function SolaLogo({
  theme = "light",
  className,
}: {
  theme?: SolaLogoTheme;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 318 86"
      role="img"
      aria-label="Sola Payments"
      style={{ color: theme === "dark" ? "#ffffff" : "#020622" }}
    >
      <path d="RING" fill="#0047FF" />
      <path d="INK" fill="currentColor" />
    </svg>
  );
}
'''

tsx = tsx.replace("RING", ring).replace("INK", ink)
open(OUT, "w", encoding="utf-8", newline="\n").write(tsx)
print("wrote", OUT, len(tsx), "bytes; ring", len(ring), "ink", len(ink))
