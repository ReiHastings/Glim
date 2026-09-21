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
  //
  // `npm run build:ios:dev` passes --mode nativedev for the side-by-side dev
  // app (bundle id com.reihastings.glim.dev). Identical build shape; the only
  // difference is which env file Vite reads, and therefore which Firebase
  // project the bundle points at. Vite resolves .env.nativedev.local ahead of
  // .env.local, so the dev app gets glim-dev and every other path keeps
  // production. Both modes must answer true here or the dev app would ship
  // with base '/Glim/' and a service worker, and would not boot in the
  // WebView.
  const native = mode === 'native' || mode === 'nativedev'

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
