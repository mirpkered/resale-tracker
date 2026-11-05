import { describe, expect, it } from 'vitest'
import manifestText from '../public/manifest.webmanifest?raw'

describe('installed app manifest', () => {
  const manifest = JSON.parse(manifestText) as { id: string; start_url: string; scope: string; icons: Array<{ src: string; sizes: string }> }

  it('uses a same-origin root scope when installed from the secure Worker origin', () => {
    const origin = 'https://resale-tracker-private-sync.mirpkered.workers.dev/'
    expect(new URL(manifest.id, origin).origin).toBe(new URL(origin).origin)
    expect(new URL(manifest.start_url, origin).href).toBe(origin)
    expect(new URL(manifest.scope, origin).pathname).toBe('/')
  })

  it('uses the correct relative base when served from the GitHub Pages recovery path', () => {
    const appPath = 'https://mirpkered.github.io/resale-tracker/'
    expect(new URL(manifest.start_url, appPath).pathname).toBe('/resale-tracker/')
    expect(new URL(manifest.scope, appPath).pathname).toBe('/resale-tracker/')
  })

  it('declares installable Android icon sizes', () => {
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(['192x192', '512x512'])
  })
})
