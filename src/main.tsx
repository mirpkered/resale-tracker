import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App'
import './ui/styles.css'

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let reloadingForWorker = false
  const announceWaiting = (registration: ServiceWorkerRegistration) => {
    if (registration.waiting && navigator.serviceWorker.controller) window.dispatchEvent(new CustomEvent('resale:pwa-update', { detail: registration }))
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForWorker) return
    reloadingForWorker = true
    window.location.reload()
  })
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' })
      .then((registration) => {
        announceWaiting(registration)
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          installing?.addEventListener('statechange', () => announceWaiting(registration))
        })
        const update = () => { if (document.visibilityState === 'visible') void registration.update().then(() => announceWaiting(registration)).catch(() => undefined) }
        window.addEventListener('pageshow', update)
        document.addEventListener('visibilitychange', update)
        update()
      })
      .catch(() => undefined)
  })
}
