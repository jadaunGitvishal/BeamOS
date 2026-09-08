import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Lives here in server/ (next to node_modules), NOT next to the source it
// builds (frontend/field-tech-src) - Vite's config-file loader resolves
// `require`/`import` of `vite`/`@vitejs/plugin-react` relative to this
// file's own directory, and frontend/ has no node_modules of its own. Exact
// same reasoning as vite.dashboard.config.js; the two configs are siblings.
//
// Builds the Ref 43 Field Technician app (phone + OTP login, then the on-site
// visit workflow) as a standalone bundle served by BeamOS's own Express server
// at /field-tech - see server.js's static mount of frontendDir/field-tech and
// its dedicated /field-tech, /field-tech.html route.
export default defineConfig(({ mode }) => {
  const fieldTechSrcDir = fileURLToPath(new URL("../frontend/field-tech-src", import.meta.url));

  // vite dev (npm run dev:field-tech) proxies API calls to the real BeamOS
  // server so Vite's dev server can hot-reload the app while still hitting
  // live data. Reads server/.env's PORT the same way the server process does.
  const env = loadEnv(mode, process.cwd(), "");
  const backendPort = env.PORT || 5001;

  return {
    root: fieldTechSrcDir,
    // frontend/field-tech/ is served at /field-tech/ (server.js's static mount
    // of frontendDir keeps each subfolder's path), not site-root - without this
    // the built HTML's asset URLs default to root-relative (/assets/...) and
    // 404 once actually served from /field-tech/assets/....
    base: "/field-tech/",
    plugins: [react()],
    publicDir: false,
    build: {
      outDir: fileURLToPath(new URL("../frontend/field-tech", import.meta.url)),
      emptyOutDir: true,
      rollupOptions: {
        input: fileURLToPath(new URL("../frontend/field-tech-src/field-tech.html", import.meta.url)),
      },
    },
    server: {
      proxy: {
        "/api": `http://localhost:${backendPort}`,
      },
    },
  };
});
