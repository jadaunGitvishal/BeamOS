import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Lives here in server/ (next to node_modules), NOT next to the source it
// builds (frontend/dashboard-src) - Vite's config-file loader resolves
// `require`/`import` of `vite`/`@vitejs/plugin-react` relative to this
// file's own directory, and frontend/ has no node_modules of its own. This
// is the one place BeamOS gains build tooling; not worth a second
// node_modules tree just to keep the config colocated with its source.
//
// Builds the merged-in BeamOS Dashboard views (Overview / Devices / Content
// delivery / Issues) as a standalone bundle served by BeamOS's own Express
// server at /dashboard - see server.js's static mount of frontendDir/dashboard
// and its dedicated /dashboard, /dashboard.html route.
export default defineConfig(({ mode }) => {
  const dashboardSrcDir = fileURLToPath(new URL("../frontend/dashboard-src", import.meta.url));

  // vite dev (npm run dev:dashboard) proxies API calls to the real BeamOS
  // server so `vite`'s dev server can hot-reload the dashboard while still
  // hitting live data. Reads server/.env's PORT the same way the server
  // process does, since Vite doesn't pick up --env-file-if-exists for free.
  const env = loadEnv(mode, process.cwd(), "");
  const backendPort = env.PORT || 5001;

  return {
    root: dashboardSrcDir,
    // frontend/dashboard/ is served at /dashboard/ (server.js's static mount
    // of frontendDir keeps each subfolder's path), not site-root - without
    // this, the built HTML's asset URLs default to root-relative (/assets/...)
    // and 404 once actually served from /dashboard/assets/....
    base: "/dashboard/",
    plugins: [react()],
    publicDir: false,
    build: {
      outDir: fileURLToPath(new URL("../frontend/dashboard", import.meta.url)),
      emptyOutDir: true,
      rollupOptions: {
        input: fileURLToPath(new URL("../frontend/dashboard-src/dashboard.html", import.meta.url)),
      },
    },
    server: {
      proxy: {
        "/api": `http://localhost:${backendPort}`,
      },
    },
  };
});
