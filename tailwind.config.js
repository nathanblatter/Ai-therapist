/** @type {import('tailwindcss').Config} */
import { join } from 'path';

export default {
  content: ["./client/index.html", "./client/**/*.{jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        byuNavy: "#002E5D",
        byuRoyal: "#0047BA",
        byuLightBlue :"#BDD6E6",
      },
    },
  },
  plugins: [],
};
