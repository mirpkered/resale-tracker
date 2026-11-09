import { describe, expect, it } from 'vitest'
// @ts-expect-error Vitest executes in Node; Node types are intentionally not included in the browser app.
import { readFileSync } from 'node:fs'

const stylesheet = readFileSync(new URL('./ui/styles.css', import.meta.url), 'utf8')

describe('speech command mobile layout rules', () => {
  it.each([320, 375, 390])('keeps the diagnostics panel single-column at %i CSS pixels', (width) => {
    expect(width).toBeLessThanOrEqual(600)
    expect(stylesheet).toContain('@media(max-width:600px){.speech-diagnostic-grid{grid-template-columns:minmax(0,1fr)}')
    expect(stylesheet).toContain('.speech-diagnostics{min-width:0')
    expect(stylesheet).toContain('.speech-diagnostic-actions{align-items:flex-start;flex-direction:column}')
  })
})
