import type { Config } from "tailwindcss"
import defaultColors from "tailwindcss/colors"
import plugin from "tailwindcss/plugin"
import { LOOPCOM_PALETTE, paletteCssVars } from "./lib/branding/loopcom-palette"

/**
 * LoopCom Works theme (2026-09-18).
 *
 * The app was written with plain Tailwind colour utilities (`bg-white`,
 * `text-gray-900`, `border-gray-200`, `bg-blue-600` …) in ~150 files. Rather
 * than rewriting every page — the owner's rule for this pass is "no change on
 * the code, just looks" — every palette hue the app uses is re-pointed at a CSS
 * variable. The variables carry Loopcom's light values on `:root` and the dark
 * values on `.dark`, so the same class renders correctly in both themes and no
 * JSX, handler or route changes.
 *
 * `white` is deliberately NOT remapped here: `text-white` sits on accent
 * buttons and badges and must stay white in the dark theme. `bg-white` (a card
 * surface) is flipped in `app/globals.css` with a `.dark .bg-white` rule.
 */
const HUES = Object.keys(LOOPCOM_PALETTE.light) as Array<keyof typeof LOOPCOM_PALETTE.light>

function varPalette(hue: string) {
  const shades = Object.keys((defaultColors as any)[hue] || LOOPCOM_PALETTE.light.gray)
  const out: Record<string, string> = {}
  for (const s of shades) out[s] = `rgb(var(--lw-c-${hue}-${s}) / <alpha-value>)`
  return out
}

const varColors: Record<string, Record<string, string>> = {}
for (const hue of HUES) varColors[hue] = varPalette(hue)

const config = {
  darkMode: ["class"],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
	],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        ...varColors,
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Loopcom semantic tokens (portal names), usable directly as
        // `bg-panel`, `text-dim`, `border-line`, `text-accent-2`, `bg-accent-soft`.
        panel: "var(--lw-panel)",
        "panel-2": "var(--lw-panel-2)",
        "panel-3": "var(--lw-panel-3)",
        page: "var(--lw-bg)",
        ink: "var(--lw-text)",
        dim: "var(--lw-text-dim)",
        faint: "var(--lw-text-muted)",
        line: "var(--lw-border)",
        "line-strong": "var(--lw-border-strong)",
        "accent-2": "var(--lw-accent-2)",
        "accent-soft": "var(--lw-accent-soft)",
        success: "var(--lw-success)",
        warning: "var(--lw-warning)",
        danger: "var(--lw-danger)",
        info: "var(--lw-info)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        panel: "var(--lw-shadow-sm)",
        float: "var(--lw-shadow-lg)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    // Emits the `--lw-c-<hue>-<shade>` RGB triplets for both themes.
    plugin(({ addBase }) => {
      addBase({
        ":root": paletteCssVars("light"),
        ".dark": paletteCssVars("dark"),
      })
    }),
  ],
} satisfies Config

export default config
