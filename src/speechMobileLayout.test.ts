import { describe, expect, it } from 'vitest'
import stylesheet from './ui/styles.css?raw'

describe('speech command mobile layout rules', () => {
  it.each([320, 375, 390])('keeps the diagnostics panel single-column at %i CSS pixels', (width) => {
    expect(width).toBeLessThanOrEqual(600)
    expect(stylesheet).toContain('@media(max-width:600px){.speech-diagnostic-grid{grid-template-columns:minmax(0,1fr)}')
    expect(stylesheet).toContain('.speech-diagnostics{min-width:0')
    expect(stylesheet).toContain('.speech-diagnostic-actions{align-items:flex-start;flex-direction:column}')
  })
})
