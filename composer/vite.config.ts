import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // harper.js resolves its WASM with `new URL(..., import.meta.url)`.
    // Pre-bundling moves the module into .vite/deps, where that URL serves
    // the HTML fallback instead of the binary ("expected magic word 00 61
    // 73 6d, found 3c 21 64 6f") and grammar silently dies. Excluding it
    // keeps the module at its real path, where Vite serves the wasm file.
    exclude: ['harper.js'],
  },
});
