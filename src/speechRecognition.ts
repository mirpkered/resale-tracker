export interface SpeechRecognizer {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onstart: (() => void) | null
  onaudiostart: (() => void) | null
  onspeechstart: (() => void) | null
  onaudioend: (() => void) | null
  onnomatch: (() => void) | null
  onend: (() => void) | null
  start(): void
  abort(): void
}
export type SpeechRecognizerConstructor = new () => SpeechRecognizer
export type SpeechWindow = Window & { SpeechRecognition?: SpeechRecognizerConstructor; webkitSpeechRecognition?: SpeechRecognizerConstructor }
export interface SpeechLifecycleHandlers {
  onStart?: () => void
  onAudioStart?: () => void
  onSpeechStart?: () => void
  onResult: (event: Parameters<NonNullable<SpeechRecognizer['onresult']>>[0]) => void
  onError?: (error: string) => void
  onNoMatch?: () => void
  onEnd: (state: { cancelled: boolean; started: boolean; hasResult: boolean }) => void
}

/** Installs event handlers before start and provides idempotent cancellation. */
export function attachSpeechLifecycle(recognition: SpeechRecognizer, handlers: SpeechLifecycleHandlers) {
  let cancelled = false
  let started = false
  let hasResult = false
  let startRequested = false
  recognition.onstart = () => { started = true; handlers.onStart?.() }
  recognition.onaudiostart = () => handlers.onAudioStart?.()
  recognition.onspeechstart = () => handlers.onSpeechStart?.()
  recognition.onresult = (event) => { hasResult = Array.from(event.results).some((result) => result.isFinal && result[0].transcript.trim().length > 0); handlers.onResult(event) }
  recognition.onnomatch = () => handlers.onNoMatch?.()
  recognition.onerror = (event) => handlers.onError?.(event.error)
  recognition.onend = () => handlers.onEnd({ cancelled, started, hasResult })
  return {
    start() { if (startRequested || cancelled) return; startRequested = true; recognition.start() },
    cancel() { if (cancelled) return; cancelled = true; recognition.abort() },
  }
}

export function browserSpeechRecognitionAvailable(target: SpeechWindow = window as SpeechWindow): boolean {
  return Boolean(target.SpeechRecognition ?? target.webkitSpeechRecognition)
}
