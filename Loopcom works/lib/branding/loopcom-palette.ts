/**
 * LoopCom Works palette (2026-09-18).
 *
 * Source of truth: the Loopcom portal's live tokens in
 * `apps/portal/app/globals.css` (light block at :12223, dark block at :3410,
 * console/dashboard tokens at :13749). Nothing here is invented — the neutral
 * scale is the portal's slate-based light theme and its navy dark theme, and
 * `blue-500/600` are exactly the portal's `--accent` / `--accent-2`.
 *
 * Every Tailwind hue the app uses is defined for BOTH themes so that the
 * existing classes (`bg-gray-100`, `text-green-800`, `bg-blue-600` …) keep
 * their meaning in dark mode: neutrals invert as a surface hierarchy, and
 * chromatic hues invert shade-for-shade (a `bg-green-50` badge tint becomes a
 * deep green plate, its `text-green-800` becomes a light green — the same
 * contrast, on the other ground).
 */
import defaultColors from "tailwindcss/colors"

type Shade = "50" | "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900" | "950"
type Scale = Record<Shade, string>

const SHADES: Shade[] = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"]

// ── Neutrals ────────────────────────────────────────────────────────────────
// Light: the portal's light surfaces/text (bg #f6f8fb, text #0f172a, dim #475569,
// muted #94a3b8, border ≈ #e5e9ef). 100 is the page, 50 a subtle inset, white
// stays the card (handled in globals.css).
const NEUTRAL_LIGHT: Scale = {
  "50": "#f8fafc",
  "100": "#f6f8fb",
  "200": "#e5e9ef",
  "300": "#cfd6e0",
  "400": "#94a3b8",
  "500": "#64748b",
  "600": "#475569",
  "700": "#334155",
  "800": "#1e293b",
  "900": "#0f172a",
  "950": "#0b1220",
}
// Dark: page #0c1218, subtle inset #101923, borders #26374a / #34495f, text
// #e1e9f1, dim #8ea0b2. Ordering is monotonic so "darker than the card" stays
// darker than the card (#141f2b) exactly as in light mode.
const NEUTRAL_DARK: Scale = {
  "50": "#101923",
  "100": "#0c1218",
  "200": "#26374a",
  "300": "#34495f",
  "400": "#6b7f93",
  "500": "#8ea0b2",
  "600": "#a3b3c3",
  "700": "#c0ccd8",
  "800": "#d3dde8",
  "900": "#e1e9f1",
  "950": "#f3f7fb",
}

// ── Accent (Loopcom blue) ───────────────────────────────────────────────────
const BLUE_LIGHT: Scale = {
  ...(defaultColors.blue as Scale),
  "500": "#3b82f6", // --accent (light)
  "600": "#2563eb", // --accent-2 (light)
}
const BLUE_DARK: Scale = {
  "50": "#0f2340",
  "100": "#123058",
  "200": "#174173",
  "300": "#1e5a9e",
  "400": "#2f8fe0",
  "500": "#22a8ff", // --accent (dark)
  "600": "#4f7bff", // --accent-2 (dark)
  "700": "#7ab6ff",
  "800": "#a9d1ff",
  "900": "#d2e7ff",
  "950": "#eaf4ff",
}

function invert(hue: string): Scale {
  const src = (defaultColors as any)[hue] as Scale
  const out = {} as Scale
  SHADES.forEach((s, i) => {
    out[s] = src[SHADES[SHADES.length - 1 - i]]
  })
  return out
}

const CHROMATIC = [
  "green", "emerald", "teal", "cyan", "sky", "indigo", "violet", "purple",
  "fuchsia", "pink", "rose", "red", "orange", "amber", "yellow", "lime",
] as const

type HueName = "gray" | "slate" | "zinc" | "neutral" | "stone" | "blue" | (typeof CHROMATIC)[number]

function build(theme: "light" | "dark"): Record<HueName, Scale> {
  const neutral = theme === "light" ? NEUTRAL_LIGHT : NEUTRAL_DARK
  const out: Partial<Record<HueName, Scale>> = {
    gray: neutral,
    slate: neutral,
    zinc: neutral,
    neutral: neutral,
    stone: neutral,
    blue: theme === "light" ? BLUE_LIGHT : BLUE_DARK,
  }
  for (const hue of CHROMATIC) {
    out[hue] = theme === "light" ? ((defaultColors as any)[hue] as Scale) : invert(hue)
  }
  return out as Record<HueName, Scale>
}

export const LOOPCOM_PALETTE = {
  light: build("light"),
  dark: build("dark"),
}

function hexToRgbTriplet(hex: string): string {
  const n = hex.replace("#", "")
  const full = n.length === 3 ? n.split("").map((c) => c + c).join("") : n
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `${r} ${g} ${b}`
}

/** `{ "--lw-c-gray-50": "248 250 252", … }` for one theme. */
export function paletteCssVars(theme: "light" | "dark"): Record<string, string> {
  const vars: Record<string, string> = {}
  const scales = LOOPCOM_PALETTE[theme]
  for (const hue of Object.keys(scales) as HueName[]) {
    for (const shade of SHADES) {
      vars[`--lw-c-${hue}-${shade}`] = hexToRgbTriplet(scales[hue][shade])
    }
  }
  return vars
}
