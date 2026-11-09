export interface SpeechDiagnosticEvent { at: number; event: string; code?: string }

export interface SpeechDiagnosticSnapshot {
  apiAvailable: boolean
  apiName: 'SpeechRecognition' | 'webkitSpeechRecognition' | 'unavailable'
  standalone: boolean
  phase: string
  interpretationAttempts: number
  errorCode: string
  events: SpeechDiagnosticEvent[]
}

/** Copy-safe report. Spoken words, inventory, account data, and tokens are never included. */
export function formatSpeechDiagnosticReport(snapshot: SpeechDiagnosticSnapshot) {
  const lines = [
    'Resale Tracker speech diagnostics',
    `Speech API exposed: ${snapshot.apiAvailable ? snapshot.apiName : 'no'}`,
    `Standalone app display: ${snapshot.standalone ? 'yes' : 'no'}`,
    `Current state: ${snapshot.phase}`,
    `Automatic interpretation attempts: ${snapshot.interpretationAttempts}`,
    `Last recognition error code: ${snapshot.errorCode || 'none'}`,
    'Recent browser events (transcript content omitted):',
  ]
  const events = snapshot.events.slice(-20)
  if (!events.length) lines.push('- none yet')
  for (const event of events) {
    const seconds = Math.max(0, Math.round(event.at / 100) / 10)
    lines.push(`- +${seconds.toFixed(1)}s ${event.event}${event.code ? ` (${event.code})` : ''}`)
  }
  return lines.join('\n')
}
