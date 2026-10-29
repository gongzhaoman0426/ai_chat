import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          bootstrap: resolve('apps/desktop/src/main/bootstrap.ts'),
          service: resolve('apps/desktop/src/service/index.ts'),
          'database-prepare': resolve('apps/desktop/src/main/database-prepare.ts'),
        },
        output: { chunkFileNames: '[name]-[hash].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('apps/desktop/src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('apps/desktop'),
    plugins: [react(), tailwindcss()],
    build: { rollupOptions: { input: resolve('apps/desktop/index.html') } },
  },
});
