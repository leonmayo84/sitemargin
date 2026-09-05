import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Clear the native splash the moment React has actually mounted, rather than
// waiting out the fixed launchShowDuration in capacitor.config.json. That
// setting keeps launchAutoHide: true as a safety net, so a JS failure can
// never strand anyone on the splash -- this call only ever shortens the
// launch, never extends it. Dynamically imported so the browser build doesn't
// carry the plugin in its startup chunk.
if (Capacitor.isNativePlatform()) {
  import('@capacitor/splash-screen')
    .then(({ SplashScreen }) => SplashScreen.hide())
    .catch(() => {
      // Safety net above still clears it -- never block the app on this.
    });
}

// Register the service worker in production only, so it never interferes
// with Vite's dev-server hot reload.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Installability is a nice-to-have — never block the app on this.
    });
  });
}
