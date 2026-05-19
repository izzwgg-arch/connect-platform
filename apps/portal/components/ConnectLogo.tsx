/**
 * Connect Communications logo — inline SVG.
 *
 * Icon anatomy (the "O"):
 *   • A circle with a notch cut at the TOP and BOTTOM → two opposing C-shapes.
 *   • The circle IS the outermost (bottom) ring of the WiFi signal icon.
 *   • Two smaller WiFi arcs sit above the centre, visible through the top notch.
 *   • A short vertical stem descends through the bottom notch.
 */
export function ConnectLogo({ className }: { className?: string }) {
  const blue = "#1a6fff";
  const sw = 3; // stroke-width

  // ── O ring ────────────────────────────────────────────────────────────────
  // Centre: (43, 25), radius: 12
  // Top notch:    ±30° from 12-o'clock  → gap points at (37, 14.61) and (49, 14.61)
  // Bottom notch: ±30° from 6-o'clock   → gap points at (49, 35.39) and (37, 35.39)
  //
  // Left arc  : from bottom-left  (37, 35.39) → top-left  (37, 14.61)  counter-clockwise
  // Right arc : from top-right    (49, 14.61) → bottom-right (49, 35.39) clockwise

  return (
    <svg
      viewBox="0 0 205 52"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Connect Communications"
      role="img"
    >
      {/* ── WiFi arcs (upper semicircles, centred at O centre 43 25) ── */}
      {/* Medium ring  r=8 */}
      <path
        d="M 35 25 A 8 8 0 0 0 51 25"
        stroke={blue}
        strokeWidth={sw}
        strokeLinecap="round"
        fill="none"
      />
      {/* Small inner ring  r=4.5 */}
      <path
        d="M 38.5 25 A 4.5 4.5 0 0 0 47.5 25"
        stroke={blue}
        strokeWidth={sw}
        strokeLinecap="round"
        fill="none"
      />

      {/* ── O ring — left C-shape ── */}
      <path
        d="M 37 35.39 A 12 12 0 1 0 37 14.61"
        stroke={blue}
        strokeWidth={sw}
        strokeLinecap="round"
        fill="none"
      />
      {/* ── O ring — right C-shape ── */}
      <path
        d="M 49 14.61 A 12 12 0 1 1 49 35.39"
        stroke={blue}
        strokeWidth={sw}
        strokeLinecap="round"
        fill="none"
      />

      {/* ── Stem through bottom notch ── */}
      <line
        x1="43" y1="35.39"
        x2="43" y2="43"
        stroke={blue}
        strokeWidth={sw}
        strokeLinecap="round"
      />

      {/* ── "C" ── */}
      <text
        x="0" y="40"
        fontFamily="'Inter var', Inter, 'Helvetica Neue', Arial, sans-serif"
        fontSize="44"
        fontWeight="900"
        fill="white"
        letterSpacing="-1"
      >C</text>

      {/* ── "NNECT" ── */}
      <text
        x="59" y="40"
        fontFamily="'Inter var', Inter, 'Helvetica Neue', Arial, sans-serif"
        fontSize="44"
        fontWeight="900"
        fill="white"
        letterSpacing="-1"
      >NNECT</text>

      {/* ── "COMMUNICATIONS" ── */}
      <text
        x="5" y="51"
        fontFamily="'Inter var', Inter, 'Helvetica Neue', Arial, sans-serif"
        fontSize="9"
        fontWeight="600"
        fill={blue}
        letterSpacing="3.2"
      >COMMUNICATIONS</text>
    </svg>
  );
}
