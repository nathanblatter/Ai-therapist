import { join, dirname } from "path";
import { fileURLToPath } from "url";
import react from "@vitejs/plugin-react";

const path = fileURLToPath(import.meta.url);

export default {
  root: join(dirname(path), "client/admin"),
  plugins: [react()],
  build: {
    rollupOptions: {
      input: join(dirname(path), "client/admin/admin.html")
    }
  },
  server: {
    host: true,
    allowedHosts: ["www.byuisresearch.com", "byuisresearch.com"],
  },
};
