import { join, dirname } from "path";
import { fileURLToPath } from "url";
import react from "@vitejs/plugin-react";

const path = fileURLToPath(import.meta.url);

export default {
  root: join(dirname(path), "src/client/redact"),
  base: "/redact/",
  plugins: [react()],
  build: {
    rollupOptions: {
      input: join(dirname(path), "src/client/redact/redact.html")
    }
  },
  server: {
    host: true,
    allowedHosts: ["www.byuisresearch.com", "byuisresearch.com"],
  },
};
