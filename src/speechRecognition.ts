export interface SpeechRecognizer {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  abort(): void
}
export type SpeechRecognizerConstructor = new () => SpeechRecognizer
export type SpeechWindow = Window & { SpeechRecognition?: SpeechRecognizerConstructor; webkitSpeechRecognition?: SpeechRecognizerConstructor }

export function browserSpeechRecognitionAvailable(target: SpeechWindow = window as SpeechWindow): boolean {
  return Boolean(target.SpeechRecognition ?? target.webkitSpeechRecognition)
}
