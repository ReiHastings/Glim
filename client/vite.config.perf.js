// Build config for the CDP performance and behaviour harness (tests/perf).
// Production React, so measurements match what ships, but unminified so a CPU
// profile carries real component names. See tests/perf/README.md.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: '/',
  plugins: [tailwindcss(), react()],
  build: {
    outDir: 'dist-perf',
    minify: false,
    rollupOptions: { input: 'tests/perf/harness.html' },
  },
})
