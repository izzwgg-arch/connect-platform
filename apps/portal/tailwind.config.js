/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./hooks/**/*.{js,ts,jsx,tsx}",
    "./contexts/**/*.{js,ts,jsx,tsx}",
  ],
  corePlugins: {
    // Portal layout relies on globals.css; avoid Tailwind reset clashes.
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        crm: {
          bg: "var(--crm-bg)",
          surface: "var(--crm-surface)",
          "surface-2": "var(--crm-surface-2)",
          border: "var(--crm-border)",
          text: "var(--crm-text)",
          muted: "var(--crm-text-muted)",
          accent: "var(--crm-accent)",
          danger: "var(--crm-danger)",
          warning: "var(--crm-warning)",
          success: "var(--crm-success)",
        },
      },
      borderRadius: {
        crm: "var(--crm-radius)",
        "crm-lg": "var(--crm-radius-lg)",
      },
      boxShadow: {
        crm: "var(--crm-shadow)",
      },
    },
  },
  plugins: [],
};
