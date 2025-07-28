import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import react from "@vitejs/plugin-react";

const path = fileURLToPath(import.meta.url);

export default {
  root: join(dirname(path), "client"),
  plugins: [react()],
  // Add this 'server' section
  server: {
    host: true, // This will expose the server to the network
    allowedHosts: ["www.byuisresearch.com"],
  },
};