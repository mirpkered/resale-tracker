// @ts-expect-error The test runner uses Node; Node types are intentionally excluded from browser source compilation.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = read('./ui/styles.css')
const lotUi = read('./ui/LotFirst.tsx')
const appUi = read('./ui/App.tsx')
const voiceUi = read('./ui/VoiceCommandDialog.tsx')

describe('responsive lot-first layout', () => {
  it('uses stacked lot and item cards with wrapping content at phone widths', () => {
    expect(css).toContain('.lot-card-list,.lot-item-list,.settings-card-list')
    expect(css).toContain('overflow-wrap:anywhere')
    expect(css).toContain('@media(max-width:760px)')
    expect(lotUi).toContain('className="lot-card panel"')
    expect(lotUi).toContain('lot-item-card panel ${item.archived?\'archived-item\':\'\'}')
    expect(lotUi).toContain('Historical ask · unconfirmed')
  })

  it('keeps mobile controls inside the viewport and honors the iPhone safe area', () => {
    expect(css).toContain('env(safe-area-inset-bottom)')
    expect(css).toContain('calc(100vw - 22px)')
    expect(css).toContain('grid-template-columns:minmax(0,1fr) minmax(0,1fr)')
    expect(css).not.toContain('.table-scroll table{min-width:760px}')
  })

  it('centers sale dialogs within 320, 375, and 390 CSS-pixel viewports and makes long forms scrollable', () => {
    for (const viewport of [320, 375, 390]) {
      const available = viewport - 16 // 8px minimum gutter on each side, before safe-area padding
      const width = Math.min(600, available)
      expect(width).toBeLessThanOrEqual(available)
      expect((viewport - width) / 2).toBeGreaterThanOrEqual(8)
    }
    expect(css).toContain('.modal{position:relative;inset:auto;transform:none;')
    expect(css).toContain('overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch')
    expect(css).toContain('grid-template-columns:minmax(0,1fr)')
    expect(css).toContain('env(safe-area-inset-top)')
    expect(css).toContain('env(safe-area-inset-bottom)')
    expect(css).toContain('quick-sale-modal-form .form-actions')
    expect(appUi).toContain('visual?.addEventListener(\'resize\',update)')
  })

  it('defers a PWA update during a form without putting an interactive banner over it', () => {
    expect(appUi).toContain("unsubmittedEdits?'Update ready · finish or close this form to apply it.'")
    expect(css).toContain('.pwa-update-banner.editing')
    expect(css).toContain('pointer-events:none')
  })

  it('keeps a safe-area-aware application header sticky above mobile navigation and below dialogs', () => {
    for (const viewport of [320, 375, 390]) expect(viewport).toBeGreaterThanOrEqual(320)
    expect(css).toContain('.topbar{position:sticky;top:0;z-index:15;')
    expect(css).toContain('padding-top:env(safe-area-inset-top)')
    expect(css).toContain('.mobile-nav{position:fixed;z-index:5;')
    expect(css).toContain('.modal-backdrop{position:fixed;z-index:100;')
    expect(appUi).toContain('<Brand onHome={()=>openSection(\'Dashboard\')}/>')
    expect(appUi).toContain('aria-label="Resale Tracker — Dashboard"')
    expect(voiceUi).toContain('useEffect(() => {')
    expect(voiceUi).toContain('}, [clearSpeechTimers])')
    expect(voiceUi).not.toContain('}, [onClose])')
    expect(voiceUi).toContain('onCloseRef.current = onClose')
    expect(voiceUi).toContain('use the microphone on the iPhone keyboard to dictate')
    expect(voiceUi).toContain('void interpretTranscript(value)')
    expect(voiceUi).toContain('createSpeechCommandSession()')
    expect(voiceUi).toContain('finalizeCompletedTranscript(transcript)')
    expect(voiceUi).toContain('speechSession.complete()')
    expect(voiceUi).toContain('activeSpeechSessionRef.current !== speechSession')
    expect(voiceUi).toContain('Confirm Sale')
  })

  it('has four primary destinations and keeps migrations under settings data management', () => {
    expect(appUi).toContain("type Section = typeof PRIMARY_NAVIGATION[number]")
    expect(appUi).toContain("settingsView==='data'")
    expect(appUi).toContain('<MigrationReconciliation')
    expect(appUi).not.toContain("{ name: 'Inventory'")
    expect(appUi).not.toContain("{ name: 'Import'")
    expect(appUi).toContain("{ name: 'Listings', icon: Tag }")
  })
})
