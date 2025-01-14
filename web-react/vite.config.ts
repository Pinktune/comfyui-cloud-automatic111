import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import watch from "rollup-plugin-watch";

// https://vitejs.dev/config/
export default defineConfig({
  base: "/cloud/",
  plugins: [react(), watch({ dir: "public" })],
});
