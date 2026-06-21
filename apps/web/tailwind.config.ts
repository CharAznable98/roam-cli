import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f8fafc",
          100: "#eef2f6",
          200: "#d9e1ea",
          300: "#b8c6d6",
          400: "#8fa2b7",
          500: "#71869d",
          600: "#586a80",
          700: "#465568",
          800: "#2e3a49",
          900: "#1f2937",
        },
        signal: {
          green: "#087451",
          amber: "#8a5200",
          red: "#b42318",
          cyan: "#0b6f98",
        },
      },
      boxShadow: {
        panel: "0 1px 2px rgba(15, 23, 42, 0.08)",
      },
    },
  },
  plugins: [],
} satisfies Config;
