/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Body sans — IBM Plex Sans, distinctive but readable
        sans: ['"IBM Plex Sans"', "system-ui", "sans-serif"],
        // Tabular data, IDs, numbers
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
        // Section labels and KPI numerals — all-caps tracked monospace,
        // operator-instrument feel without an extra font load (Plex Mono
        // ships in the same family as the sans).
        display: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      colors: {
        // Dark surface system. Background → raised surfaces → hairlines.
        panel: {
          bg: "#08090b",       // page — near-black with a cool tint
          raise: "#0e1014",    // tables, form panels
          hover: "#13161b",    // row hover
          edge: "#1a1d23",     // hairline borders
          line: "#23272f",     // stronger dividers
        },
        // Text scale on dark backgrounds
        ink: {
          50: "#f5f6f8",       // primary text
          100: "#e2e4e9",      // headings
          300: "#a1a5ad",      // secondary
          500: "#6b6f78",      // labels, captions
          700: "#3d4148",      // disabled, very low-emphasis
          900: "#1a1c20",      // for the rare light-on-light surface
        },
        // Status semantics. Warm amber as accent is deliberate — references
        // the signal lamps of analog telephony equipment. Avoids every
        // AI-slop trap (no purple, no blue gradient, no cyan).
        signal: {
          amber: "#f5a524",    // active dialing, live markers
          green: "#5dd39e",    // healthy / human pickup / completed
          slate: "#8b95a3",    // no-human outcomes (voicemail, no_answer, busy)
          red: "#f06a6a",      // failed
          dim: "#4a4e57",      // unhealthy / inactive markers
        },
      },
      fontFeatureSettings: {
        nums: '"tnum"',
      },
      keyframes: {
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
      },
      animation: {
        "fade-in-up": "fade-in-up 320ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "pulse-soft": "pulse-soft 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
