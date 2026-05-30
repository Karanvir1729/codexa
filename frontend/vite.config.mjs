import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";

const certDir = new URL("../.certs/", import.meta.url);
const certPath = new URL("dev-cert.pem", certDir);
const keyPath = new URL("dev-key.pem", certDir);
const https =
  process.env.VITE_DEV_HTTPS === "true" &&
  fs.existsSync(certPath) && fs.existsSync(keyPath)
    ? {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath)
      }
    : undefined;

export default defineConfig({
  plugins: [react()],
  envDir: "..",
  build: {
    reportCompressedSize: false
  },
  server: {
    https,
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/health": "http://localhost:8000",
      "/twilio": "http://localhost:8000",
      "/supervisor-api": {
        target: "http://localhost:4317",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/supervisor-api/, "")
      }
    }
  }
});
