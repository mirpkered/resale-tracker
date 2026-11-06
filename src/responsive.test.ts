// @ts-expect-error The test runner uses Node; Node types are intentionally excluded from browser source compilation.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = read('./ui/styles.css')
const lotUi = read('./ui/LotFirst.tsx')
const appUi = read('./ui/App.tsx')

describe('responsive lot-first layout', () => {
  it('uses stacked lot and item cards with wrapping content at phone widths', () => {
    expect(css).toContain('.lot-card-list,.lot-item-list,.settings-card-list')
    expect(css).toContain('overflow-wrap:anywhere')
    expect(css).toContain('@media(max-width:760px)')
    expect(lotUi).toContain('className="lot-card panel"')
    expect(lotUi).toContain('className="lot-item-card panel"')
    expect(lotUi).toContain('Historical ask · unconfirmed')
  })

  it('keeps mobile controls inside the viewport and honors the iPhone safe area', () => {
    expect(css).toContain('env(safe-area-inset-bottom)')
    expect(css).toContain('calc(100vw - 22px)')
    expect(css).toContain('grid-template-columns:minmax(0,1fr) minmax(0,1fr)')
    expect(css).not.toContain('.table-scroll table{min-width:760px}')
  })

  it('has three primary destinations and keeps migrations under settings data management', () => {
    expect(appUi).toContain("type Section = typeof PRIMARY_NAVIGATION[number]")
    expect(appUi).toContain("settingsView==='data'")
    expect(appUi).toContain('<MigrationReconciliation')
    expect(appUi).not.toContain("{ name: 'Inventory'")
    expect(appUi).not.toContain("{ name: 'Import'")
  })
})
