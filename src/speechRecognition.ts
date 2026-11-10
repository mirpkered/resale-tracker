export interface SpeechRecognizer {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onstart: (() => void) | null
  onaudiostart: (() => void) | null
  onaudioend: (() => void) | null
  onspeechstart: (() => void) | null
  onspeechend: (() => void) | null
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
  onAudioEnd?: () => void
  onSpeechStart?: () => void
  onSpeechEnd?: () => void
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
  let endDelivered = false
  recognition.onstart = () => { started = true; handlers.onStart?.() }
  recognition.onaudiostart = () => handlers.onAudioStart?.()
  recognition.onaudioend = () => handlers.onAudioEnd?.()
  recognition.onspeechstart = () => handlers.onSpeechStart?.()
  recognition.onspeechend = () => handlers.onSpeechEnd?.()
  recognition.onresult = (event) => { hasResult = Array.from(event.results).some((result) => result.isFinal && result[0].transcript.trim().length > 0); handlers.onResult(event) }
  recognition.onnomatch = () => handlers.onNoMatch?.()
  recognition.onerror = (event) => handlers.onError?.(event.error)
  const detach = () => {
    recognition.onstart = null; recognition.onaudiostart = null; recognition.onaudioend = null
    recognition.onspeechstart = null; recognition.onspeechend = null; recognition.onresult = null
    recognition.onnomatch = null; recognition.onerror = null; recognition.onend = null
  }
  recognition.onend = () => { if (endDelivered) return; endDelivered = true; handlers.onEnd({ cancelled, started, hasResult }); detach() }
  return {
    start() { if (startRequested || cancelled) return; startRequested = true; recognition.start() },
    cancel() { if (cancelled) return; cancelled = true; recognition.abort() },
    dispose() { endDelivered = true; detach() },
  }
}

export interface SpeechResultEvent {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

/** Holds final segments across result events and exposes the latest interim text. */
export class SpeechTranscriptBuffer {
  private readonly finalSegments = new Map<number, string>()
  private interimSegments = new Map<number, string>()

  update(event: SpeechResultEvent) {
    const interim = new Map<number, string>()
    for (let index = 0; index < event.results.length; index++) {
      const result = event.results[index]
      const transcript = result[0]?.transcript?.trim() ?? ''
      if (result.isFinal) {
        if (transcript) this.finalSegments.set(index, transcript)
        else this.finalSegments.delete(index)
      } else if (transcript) interim.set(index, transcript)
    }
    this.interimSegments = interim
    return { finalTranscript: this.finalTranscript(), interimTranscript: [...interim.values()].join(' ').trim() }
  }

  finalTranscript() { return [...this.finalSegments.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join(' ').trim() }
  usableTranscript() { return this.finalTranscript() || [...this.interimSegments.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join(' ').trim() }
  reset() { this.finalSegments.clear(); this.interimSegments.clear() }
}

/** Isolated transcript and one-shot completion state for one microphone attempt. */
export function createSpeechCommandSession() {
  const transcript = new SpeechTranscriptBuffer()
  const completion = createOnceGate()
  let active = true
  let completed = false
  return {
    update(event: SpeechResultEvent) { return active ? transcript.update(event) : null },
    complete() {
      if (!active) return null
      const value = transcript.usableTranscript()
      if (!value || !completion.run(() => { active = false; completed = true })) return null
      return value
    },
    cancel() { active = false; transcript.reset() },
    isActive() { return active },
    isCompleted() { return completed },
  }
}

/** A per-session gate that prevents duplicate final-result handling. */
export function createOnceGate() {
  let used = false
  return {
    run(action: () => void) { if (used) return false; used = true; action(); return true },
    reset() { used = false },
  }
}

export function browserSpeechRecognitionAvailable(target: SpeechWindow = window as SpeechWindow): boolean {
  return Boolean(target.SpeechRecognition ?? target.webkitSpeechRecognition)
}
