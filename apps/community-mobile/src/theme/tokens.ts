// Mirrors apps/community-web/app/globals.css exactly — same brand, two apps.
export type ThemeName = "dark" | "light";

export type ThemeTokens = {
  name: ThemeName;
  bg: string;
  panel: string;
  panel2: string;
  text: string;
  dim: string;
  accent: string;
  accent2: string;
  border: string;
  success: string;
  warning: string;
  danger: string;
};

export const darkTheme: ThemeTokens = {
  name: "dark",
  bg: "#0c1218",
  panel: "#141f2b",
  panel2: "#1a2635",
  text: "#e1e9f1",
  dim: "#8ea0b2",
  accent: "#22a8ff",
  accent2: "#4f7bff",
  border: "#26374a",
  success: "#34c27b",
  warning: "#f0b655",
  danger: "#ea6068",
};

export const lightTheme: ThemeTokens = {
  name: "light",
  bg: "#f6f8fb",
  panel: "#ffffff",
  panel2: "#f8fafc",
  text: "#0f172a",
  dim: "#475569",
  accent: "#3b82f6",
  accent2: "#2563eb",
  border: "rgba(15,23,42,0.14)",
  success: "#0f7a4a",
  warning: "#b4740c",
  danger: "#c1272d",
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };
export const fontSize = { xs: 12, sm: 13, base: 15, md: 16, lg: 18, xl: 22, xxl: 28 };
