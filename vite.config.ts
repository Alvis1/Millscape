import { defineConfig } from 'vite';

// MillScape is a fully static SPA. A relative base ('./') makes the built
// bundle work when served from any sub-path, which is what GitHub Pages does
// (https://<user>.github.io/<repo>/). If you deploy to a custom domain root,
// you may set base to '/'.
export default defineConfig({
  base: './',
  build: {
    target: 'es2021',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
