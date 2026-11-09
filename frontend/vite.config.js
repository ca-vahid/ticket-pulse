import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // QA 11-06 #3: Outlook .msg previews. msgreader's iconv-lite needs Node's
      // Buffer (crashes in the browser); the shim decodes with TextDecoder.
      'iconv-lite': fileURLToPath(new URL('./src/components/tickets/attachmentPreview/iconvLiteShim.js', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
