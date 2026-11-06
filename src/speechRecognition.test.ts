import { describe, expect, it } from 'vitest'
import { attachSpeechLifecycle, browserSpeechRecognitionAvailable, type SpeechRecognizer, type SpeechWindow } from './speechRecognition'

describe('browser speech recognition capability', () => {
  it('detects standard and WebKit-prefixed browser speech recognition', () => {
    expect(browserSpeechRecognitionAvailable({ SpeechRecognition: class {} } as unknown as SpeechWindow)).toBe(true)
    expect(browserSpeechRecognitionAvailable({ webkitSpeechRecognition: class {} } as unknown as SpeechWindow)).toBe(true)
  })

  it('provides typed-command fallback when the browser does not expose speech recognition', () => {
    expect(browserSpeechRecognitionAvailable({} as SpeechWindow)).toBe(false)
  })
})

function fakeRecognition(): SpeechRecognizer & { starts: number; aborts: number; end: () => void; fail: (error: string) => void } {
  return {
    lang: '', continuous: false, interimResults: false, onresult: null, onerror: null, onstart: null,
    onaudiostart: null, onspeechstart: null, onaudioend: null, onnomatch: null, onend: null,
    starts: 0, aborts: 0, start() { this.starts++ }, abort() { this.aborts++ },
    end() { this.onend?.() }, fail(error) { this.onerror?.({error}) },
  }
}

describe('speech recognition lifecycle', () => {
  it('starts synchronously, reports start, and retains result through end', () => {
    const speech = fakeRecognition(), events: string[] = []
    const session = attachSpeechLifecycle(speech, {onStart:()=>events.push('start'),onResult:()=>events.push('result'),onEnd:state=>events.push(state.hasResult?'result-end':'empty-end')})
    session.start(); expect(speech.starts).toBe(1); speech.onstart?.()
    speech.onresult?.({resultIndex:0,results:[{isFinal:true,0:{transcript:'sold item'}}]})
    speech.end()
    expect(events).toEqual(['start','result','result-end'])
  })
  it('identifies unexpected immediate termination without a transcript', () => {
    const speech=fakeRecognition(),ends:unknown[]=[]
    attachSpeechLifecycle(speech,{onResult:()=>{},onEnd:state=>ends.push(state)}).start()
    speech.end();expect(ends).toEqual([{cancelled:false,started:false,hasResult:false}])
  })
  it.each(['not-allowed','service-not-allowed','network','no-speech','audio-capture'])('passes actionable browser failure code %s',error=>{
    const speech=fakeRecognition(),errors:string[]=[]
    attachSpeechLifecycle(speech,{onResult:()=>{},onError:code=>errors.push(code),onEnd:()=>{}}).start()
    speech.fail(error);expect(errors).toEqual([error])
  })
  it('treats cancellation distinctly and makes start and abort idempotent',()=>{
    const speech=fakeRecognition(),ends:unknown[]=[]
    const session=attachSpeechLifecycle(speech,{onResult:()=>{},onEnd:state=>ends.push(state)})
    session.start();session.start();expect(speech.starts).toBe(1)
    session.cancel();session.cancel();speech.end()
    expect(speech.aborts).toBe(1);expect(ends).toEqual([{cancelled:true,started:false,hasResult:false}])
  })
})
