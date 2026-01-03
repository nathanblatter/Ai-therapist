/** @type {import('tailwindcss').Config} */
import { join } from 'path';

export default {
  content: [
    "./src/client/main/index.html",
    "./src/client/admin/admin.html",
    "./src/client/**/*.{jsx,tsx,js,ts}"
  ],
  theme: {
    extend: {
      colors: {
        byuNavy: "#002E5D",
        byuRoyal: "#0047BA",
        byuLightBlue :"#BDD6E6",
        byuOrange: "#D14124",
        byuPlum: "#A73A64",
        byuSlateGray: "#7C878E",
        byuSand: "#A39382",
        byuLightSand: "#D1CCBD",
        byuBlueGray: "#6E7CA0",

      },
    },
  },
  plugins: [],
};
