import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// `base: './'` keeps every asset path relative so the build works on
// GitHub Pages (https://<user>.github.io/<repo>/) or any static host.
export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    // Shown in the activity log, to know which version produced it.
    __APP_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
    // Number of the iPhone build (GitHub run), to compare with the latest release (see update.ts).
    __WEB_BUILD__: JSON.stringify(Number(process.env.WEB_BUILD ?? 0)),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
  },
});
