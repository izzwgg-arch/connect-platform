"use client";

import type { ResetIllustration as Kind } from "@connect/shared";

/**
 * The factory-reset illustration library — one drawing per reset SHAPE, keyed by the
 * shared recipe's `illustration` (Izzy, 2026-09-18: "an illustration for each phone,
 * for each brand, on how to factory reset… would pull up on the screen").
 *
 * ⛔ Schematic on purpose: a phone outline with the ONE key the person must press lit
 * up. A photo-real render of the wrong model misleads; a schematic with the right key
 * in the right place does not. Colours are the theme tokens, so it follows light/dark.
 */
export function ResetIllustration({ kind, holdSeconds, label }: { kind: Kind; holdSeconds: number | null; label: string }) {
  const stroke = "var(--dps-border)";
  const body = "var(--dps-panel-2)";
  const screen = "var(--dps-panel)";
  const key = "var(--dps-panel)";
  const lit = "var(--dps-accent)";
  const ink = "var(--dps-dim)";
  const litInk = "#04121d";

  if (kind === "pinhole") {
    return (
      <svg viewBox="0 0 420 300" width="100%" role="img" aria-label={label}>
        <rect x="60" y="70" width="300" height="150" rx="16" fill={body} stroke={stroke} strokeWidth="3" />
        <circle cx="100" cy="110" r="6" fill={lit} />
        <circle cx="122" cy="110" r="6" fill={ink} />
        <circle cx="144" cy="110" r="6" fill={ink} />
        <rect x="250" y="95" width="70" height="30" rx="4" fill={screen} stroke={stroke} strokeWidth="2" />
        <rect x="330" y="95" width="18" height="30" rx="3" fill={screen} stroke={stroke} strokeWidth="2" />
        <circle cx="300" cy="180" r="9" fill={screen} stroke={lit} strokeWidth="3" />
        <circle cx="300" cy="180" r="3" fill={lit} />
        <circle cx="300" cy="180" r="20" fill="none" stroke={lit} strokeWidth="3" strokeDasharray="5 5" />
        <text x="300" y="222" textAnchor="middle" fontSize="12" fontWeight="700" fill={lit}>RESET</text>
        <path d="M300 160 L300 132" stroke={lit} strokeWidth="3" strokeLinecap="round" />
        <path d="M292 140 L300 130 L308 140" fill="none" stroke={lit} strokeWidth="3" strokeLinecap="round" />
        {holdSeconds ? <Badge x={330} y={240} text={`HOLD ${holdSeconds} s`} /> : null}
      </svg>
    );
  }

  const generic = kind === "generic";
  const highlightOk = kind === "hold_ok";
  const highlightMenu = kind === "menu_path" || kind === "menu_password";

  return (
    <svg viewBox="0 0 420 340" width="100%" role="img" aria-label={label}>
      <rect x="70" y="18" width="330" height="304" rx="22" fill={body} stroke={stroke} strokeWidth="3" />
      <rect x="18" y="32" width="44" height="226" rx="18" fill={body} stroke={stroke} strokeWidth="3" />
      <rect x="100" y="40" width="270" height="104" rx="8" fill={screen} />
      {highlightOk && (
        <>
          <text x="235" y="86" textAnchor="middle" fontSize="15" fontWeight="700" fill={ink}>Reset to factory settings?</text>
          <text x="235" y="112" textAnchor="middle" fontSize="12" fill={ink}>after about {holdSeconds ?? 10} seconds</text>
        </>
      )}
      {highlightMenu && (
        <>
          <text x="235" y="76" textAnchor="middle" fontSize="13" fontWeight="700" fill={ink}>System › Operations</text>
          <text x="235" y="100" textAnchor="middle" fontSize="15" fontWeight="700" fill="var(--dps-text)">Factory Reset</text>
          <text x="235" y="124" textAnchor="middle" fontSize="12" fill={ink}>{kind === "menu_password" ? "Password: ····" : "Are you sure?   OK"}</text>
        </>
      )}
      {generic && <text x="235" y="98" textAnchor="middle" fontSize="14" fontWeight="700" fill={ink}>Settings › Reset</text>}
      {/* soft keys under the screen */}
      <rect x="100" y="160" width="60" height="24" rx="6" fill={highlightMenu ? lit : key} stroke={stroke} strokeWidth="1" />
      {highlightMenu && <text x="130" y="177" textAnchor="middle" fontSize="11" fontWeight="700" fill={litInk}>MENU</text>}
      <rect x="170" y="160" width="60" height="24" rx="6" fill={key} stroke={stroke} strokeWidth="1" />
      <rect x="240" y="160" width="60" height="24" rx="6" fill={key} stroke={stroke} strokeWidth="1" />
      <rect x="310" y="160" width="60" height="24" rx="6" fill={key} stroke={stroke} strokeWidth="1" />
      {/* keypad */}
      {[0, 1, 2].map((r) => [0, 1, 2].map((c) => (
        <rect key={`${r}${c}`} x={100 + c * 44} y={204 + r * 32} width="36" height="24" rx="5" fill={key} stroke={stroke} strokeWidth="1" />
      )))}
      {/* nav cluster */}
      <circle cx="312" cy="252" r="46" fill={key} stroke={stroke} strokeWidth="2" />
      <path d="M312 216l-6 8h12zM312 288l-6-8h12zM276 252l8-6v12zM348 252l-8-6v12z" fill={ink} />
      <circle cx="312" cy="252" r="18" fill={highlightOk ? lit : screen} stroke={stroke} strokeWidth="2" />
      <text x="312" y="257" textAnchor="middle" fontSize="12" fontWeight="700" fill={highlightOk ? litInk : ink}>OK</text>
      {highlightOk && <circle cx="312" cy="252" r="30" fill="none" stroke={lit} strokeWidth="3" strokeDasharray="6 6" />}
      {highlightMenu && <circle cx="130" cy="172" r="22" fill="none" stroke={lit} strokeWidth="3" strokeDasharray="5 5" />}
      {highlightOk && holdSeconds ? <Badge x={312} y={318} text={`HOLD ${holdSeconds} s`} /> : null}
    </svg>
  );
}

function Badge({ x, y, text }: { x: number; y: number; text: string }) {
  const w = 16 + text.length * 8;
  return (
    <g>
      <rect x={x - w / 2} y={y - 13} width={w} height="26" rx="13" fill="var(--dps-accent)" />
      <text x={x} y={y + 5} textAnchor="middle" fontSize="12" fontWeight="800" fill="#04121d">{text}</text>
    </g>
  );
}
