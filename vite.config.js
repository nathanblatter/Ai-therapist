import { join, dirname } from "path";
import { fileURLToPath } from "url";
import react from "@vitejs/plugin-react";

const repoRoot = dirname(fileURLToPath(import.meta.url));

// One config for both sub-apps: "main" (SSR) and "admin" (plain SPA).
// Select with the APP env var (see the build:* scripts in package.json);
// defaults to "main".
const APPS = {
  main: { dir: "src/client/main", html: "index.html", base: "/" },
  admin: { dir: "src/client/admin", html: "admin.html", base: "/" },
};

const app = APPS[process.env.APP || "main"];

export default {
  root: join(repoRoot, app.dir),
  base: app.base,
  plugins: [react()],
  build: {
    rollupOptions: {
      input: join(repoRoot, app.dir, app.html),
    },
  },
};
