import { defineConfig, loadEnv } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

// `/api/*` goes to the billing Gateway, so the browser sees one origin and needs no CORS.
export default defineConfig(({ mode }) => ({
  plugins: [solid(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: loadEnv(mode, process.cwd(), "API_URL").API_URL ?? "http://127.0.0.1:3300",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
}));
