import { describe, expect, it } from 'vitest'
import { formatSpeechDiagnosticReport } from './speechDiagnostics'

describe('copyable speech diagnostics', () => {
  it('reports API exposure, standalone mode, current state, errors, and bounded event history without transcripts', () => {
    const report = formatSpeechDiagnosticReport({
      apiAvailable: true,
      apiName: 'webkitSpeechRecognition',
      standalone: true,
      phase: 'error',
      interpretationAttempts: 0,
      errorCode: 'network',
      events: Array.from({ length: 24 }, (_, index) => ({ at: index * 1000, event: `event-${index}`, ...(index === 23 ? { code: 'network' } : {}) })),
    })
    expect(report).toContain('webkitSpeechRecognition')
    expect(report).toContain('Standalone app display: yes')
    expect(report).toContain('Last recognition error code: network')
    expect(report).toContain('event-23')
    expect(report).not.toContain('event-0')
    expect(report).not.toContain('VI Music')
    expect(report).not.toContain('access_token')
    expect(report).toContain('transcript content omitted')
  })

  it('clearly identifies browsers that do not expose speech recognition', () => {
    expect(formatSpeechDiagnosticReport({ apiAvailable: false, apiName: 'unavailable', standalone: false, phase: 'ready', interpretationAttempts: 0, errorCode: '', events: [] })).toContain('Speech API exposed: no')
  })
})
