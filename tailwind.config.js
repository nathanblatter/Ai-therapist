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
        navy: "#002E5D",
        royal: "#0047BA",
        lightBlue: "#BDD6E6",
      },
    },
  },
  plugins: [],
};
