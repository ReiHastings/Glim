import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // `npm run build:ios` passes --mode native for the Capacitor iOS shell.
  // It serves from capacitor://localhost/ root, so base is '/', and the
  // service worker is disabled: assets ship inside the app bundle, so a SW
  // would cache a second copy and shadow the bundle after a reinstall.
  const native = mode === 'native'

  return {
    base: native ? '/' : '/Glim/',
    plugins: [
      tailwindcss(),
      react(),
      VitePWA({
        disable: native,
        registerType: 'autoUpdate',
        injectRegister: false,
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
          navigateFallback: '/Glim/index.html',
          navigateFallbackDenylist: [/^\/Glim\/api/],
        },
        manifest: {
          name: 'Glim',
          short_name: 'Glim',
          description: 'Your personal desktop companion',
          theme_color: '#0d0820',
          background_color: '#0d0820',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/Glim/',
          scope: '/Glim/',
          icons: [
            {
              src: '/Glim/glim-icon-192.png',
              sizes: '192x192',
              type: 'image/png',
            },
            {
              src: '/Glim/glim-icon-512.png',
              sizes: '512x512',
              type: 'image/png',
            },
            {
              src: '/Glim/glim-icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
      }),
    ],
  }
})
