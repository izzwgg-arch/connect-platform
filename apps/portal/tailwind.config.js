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
    extend: {},
  },
  plugins: [],
};
