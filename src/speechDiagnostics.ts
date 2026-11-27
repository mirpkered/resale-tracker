export interface SpeechDiagnosticEvent { attempt: number; sessionId: string; at: number; event: string; code?: string }

let nextAttempt=0
const diagnosticHistory:SpeechDiagnosticEvent[]=[]
const SESSION_EVENT_LIMIT=100

/** In-memory, transcript-free diagnostics retained while the app page remains open. */
export function beginSpeechDiagnosticAttempt(previousRecognizerRegistered:boolean) {
  const attempt=++nextAttempt
  const sessionId=`S${attempt}`
  const startedAt=performance.now()
  if(attempt>1)recordSpeechDiagnosticEvent(attempt,sessionId,startedAt,'retry_requested')
  recordSpeechDiagnosticEvent(attempt,sessionId,startedAt,'start_requested_by_tap',`previous_recognizer_registered=${previousRecognizerRegistered?'yes':'no'}`)
  return {attempt,sessionId,startedAt}
}

export function recordSpeechDiagnosticEvent(attempt:number,sessionId:string,startedAt:number,event:string,code?:string) {
  diagnosticHistory.push({attempt,sessionId,at:Math.max(0,performance.now()-startedAt),event,...(code?{code}:{})})
  if(diagnosticHistory.length>SESSION_EVENT_LIMIT)diagnosticHistory.splice(0,diagnosticHistory.length-SESSION_EVENT_LIMIT)
  return [...diagnosticHistory]
}

export function getSpeechDiagnosticEvents(){return [...diagnosticHistory]}
export function getSpeechDiagnosticAttemptCount(){return nextAttempt}

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
    lines.push(`- ${event.sessionId} (#${event.attempt}) +${seconds.toFixed(1)}s ${event.event}${event.code ? ` (${event.code})` : ''}`)
  }
  return lines.join('\n')
}
