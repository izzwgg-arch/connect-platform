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

      {/* Wifi arcs — three concentric arcs fanning upward */}
      <path
        d="M 43.5 21 A 13.5 13.5 0 0 1 70.5 21"
        stroke="#1a6fff"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M 47.5 25 A 9.5 9.5 0 0 1 66.5 25"
        stroke="#1a6fff"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M 51.5 29 A 5.5 5.5 0 0 1 62.5 29"
        stroke="#1a6fff"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />

      {/* Circle (the O letterform) */}
      <circle cx="57" cy="30" r="10" stroke="#1a6fff" strokeWidth="3" fill="none" />

      {/* Centre vertical stem inside the circle */}
      <line
        x1="57"
        y1="30"
        x2="57"
        y2="38"
        stroke="#1a6fff"
        strokeWidth="2.5"
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
