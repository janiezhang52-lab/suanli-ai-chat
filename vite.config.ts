import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 47632,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:47631',
      '/auth': 'http://127.0.0.1:47631',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
