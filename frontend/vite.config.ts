import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // 音频编辑重库单独分包，仅进入「音乐编辑」tab 时加载。
          audio: ["tone", "wavesurfer.js"],
        },
      },
    },
  },
});
