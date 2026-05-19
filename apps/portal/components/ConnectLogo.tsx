export function ConnectLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 228 52"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Connect Communications"
      role="img"
    >
      {/* ── "C" ── */}
      <text
        x="0"
        y="40"
        fontFamily="'Inter var', Inter, 'Helvetica Neue', Arial, sans-serif"
        fontSize="44"
        fontWeight="900"
        fill="white"
        letterSpacing="-1"
      >
        C
      </text>

      {/* ── Icon replacing "O" — center at (57, 27) ── */}

      {/* Wifi arcs — two bars above the O, which acts as the bottom ring. */}
      <path
        d="M 42 20 A 15 15 0 0 1 72 20"
        stroke="#1a6fff"
        strokeWidth="3.5"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M 47 25 A 10 10 0 0 1 67 25"
        stroke="#1a6fff"
        strokeWidth="3.5"
        strokeLinecap="round"
        fill="none"
      />

      {/* O letterform: two opposing C-shapes with top and bottom cuts. */}
      <path
        d="M 54 20.5 A 10.5 10.5 0 0 0 54 41.5"
        stroke="#1a6fff"
        strokeWidth="5"
        strokeLinecap="butt"
        fill="none"
      />
      <path
        d="M 60 20.5 A 10.5 10.5 0 0 1 60 41.5"
        stroke="#1a6fff"
        strokeWidth="5"
        strokeLinecap="butt"
        fill="none"
      />

      {/* Short center post from the Wi-Fi ring into the lower mark. */}
      <line
        x1="57"
        y1="20.5"
        x2="57"
        y2="41.5"
        stroke="#1a6fff"
        strokeWidth="3.5"
        strokeLinecap="round"
      />

      {/* ── "NNECT" ── */}
      <text
        x="73"
        y="40"
        fontFamily="'Inter var', Inter, 'Helvetica Neue', Arial, sans-serif"
        fontSize="44"
        fontWeight="900"
        fill="white"
        letterSpacing="-1"
      >
        NNECT
      </text>

      {/* ── "COMMUNICATIONS" ── */}
      <text
        x="4"
        y="51"
        fontFamily="'Inter var', Inter, 'Helvetica Neue', Arial, sans-serif"
        fontSize="9.5"
        fontWeight="600"
        fill="#1a6fff"
        letterSpacing="3.2"
      >
        COMMUNICATIONS
      </text>
    </svg>
  );
}
