import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = 'http://127.0.0.1:8794';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5194,
    strictPort: true,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/webhooks': { target: backend, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
