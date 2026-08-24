import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxying in dev means the browser never makes a cross-origin call, so the
    // demo works without touching CORS config.
    proxy: { '/api': { target: process.env.VITE_API_URL ?? 'http://localhost:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
