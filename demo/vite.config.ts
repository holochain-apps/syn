import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  optimizeDeps: {
    disabled: true,
  },
  // vite-plugin-wasm emits a top-level await for the wasm module init,
  // which the default build target rejects
  build: {
    target: 'esnext',
  },
  plugins: [svelte(), wasm()],
});
