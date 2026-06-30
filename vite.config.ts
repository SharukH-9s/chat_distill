/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import { crx, defineManifest } from "@crxjs/vite-plugin";
import { resolve } from "path";

const manifest = defineManifest({
  manifest_version: 3,
  name: "ChatDistill",
  version: "0.1.0",
  description:
    "Distill AI chat conversations into clean, structured Markdown notes.",
  permissions: ["storage", "activeTab", "downloads", "tabs", "offscreen"],
  host_permissions: ["https://generativelanguage.googleapis.com/*"],
  action: {
    default_popup: "src/popup/index.html",
    default_icon: {
      "16": "public/icons/icon16.png",
      "48": "public/icons/icon48.png",
      "128": "public/icons/icon128.png",
    },
  },
  icons: {
    "16": "public/icons/icon16.png",
    "48": "public/icons/icon48.png",
    "128": "public/icons/icon128.png",
  },
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true,
  },
  content_scripts: [
    {
      matches: ["https://chatgpt.com/*", "https://gemini.google.com/*"],
      js: ["src/content/index.ts"],
    },
  ],
});

export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        offscreen: resolve(__dirname, "src/offscreen/offscreen.html"),
      },
    },
  },
  test: {
    environment: "jsdom",
  },
});
