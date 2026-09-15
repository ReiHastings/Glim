import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// No-op under `npm run build:ios` (--mode native): vite-plugin-pwa's `disable`
// option resolves virtual:pwa-register to an empty stub, so nothing registers
// inside the iOS app. See vite.config.js.
registerSW({
  onRegisteredSW(swUrl, r) {
    if (!r) return
    // Check for SW updates when app returns to foreground.
    // iOS PWA standalone mode doesn't reliably trigger the browser's
    // built-in SW update check on resume, and GitHub Pages serves sw.js
    // with max-age=600. This fetch bypasses that cache.
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible') return
      if (r.installing || !navigator) return
      if (('connection' in navigator) && !navigator.onLine) return
      const resp = await fetch(swUrl, {
        cache: 'no-store',
        headers: {
          'cache': 'no-store',
          'cache-control': 'no-cache',
        },
      })
      if (resp?.status === 200)
        await r.update()
    })
  },
})
