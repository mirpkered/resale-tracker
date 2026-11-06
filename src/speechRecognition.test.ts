import { describe, expect, it } from 'vitest'
import { browserSpeechRecognitionAvailable, type SpeechWindow } from './speechRecognition'

describe('browser speech recognition capability', () => {
  it('detects standard and WebKit-prefixed browser speech recognition', () => {
    expect(browserSpeechRecognitionAvailable({ SpeechRecognition: class {} } as unknown as SpeechWindow)).toBe(true)
    expect(browserSpeechRecognitionAvailable({ webkitSpeechRecognition: class {} } as unknown as SpeechWindow)).toBe(true)
  })

  it('provides typed-command fallback when the browser does not expose speech recognition', () => {
    expect(browserSpeechRecognitionAvailable({} as SpeechWindow)).toBe(false)
  })
})
