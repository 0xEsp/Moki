import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.MOKI_PORT ?? 7410);

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${serverPort}`,
      '/file-assets': `http://127.0.0.1:${serverPort}`,
      '/sync': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
    },
  },
});
