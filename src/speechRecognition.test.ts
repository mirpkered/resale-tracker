import { describe, expect, it } from 'vitest'
import { attachSpeechLifecycle, browserSpeechRecognitionAvailable, createOnceGate, SpeechTranscriptBuffer, type SpeechRecognizer, type SpeechWindow } from './speechRecognition'

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
    onaudiostart: null, onspeechstart: null, onaudioend: null, onspeechend: null, onnomatch: null, onend: null,
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
  it('does not count an empty final result as a usable transcript', () => {
    const speech=fakeRecognition(),ends:unknown[]=[]
    const session=attachSpeechLifecycle(speech,{onResult:()=>{},onEnd:state=>ends.push(state)})
    session.start();speech.onresult?.({resultIndex:0,results:[{isFinal:true,0:{transcript:'  '}}]});speech.end()
    expect(ends).toEqual([{cancelled:false,started:false,hasResult:false}])
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

  it('retains interim text for display and accepts a final result without any interim event',()=>{
    const buffer=new SpeechTranscriptBuffer()
    expect(buffer.update({resultIndex:0,results:[{isFinal:false,0:{transcript:'How many items'}}]})).toEqual({finalTranscript:'',interimTranscript:'How many items'})
    expect(buffer.update({resultIndex:0,results:[{isFinal:true,0:{transcript:'How many items do I have listed?'}}]})).toEqual({finalTranscript:'How many items do I have listed?',interimTranscript:''})
    const finalOnly=new SpeechTranscriptBuffer()
    expect(finalOnly.update({resultIndex:0,results:[{isFinal:true,0:{transcript:'How many items are available?'}}]}).finalTranscript).toBe('How many items are available?')
  })

  it('combines multiple final result events without losing earlier segments or duplicating repeated events',()=>{
    const buffer=new SpeechTranscriptBuffer()
    buffer.update({resultIndex:0,results:[{isFinal:true,0:{transcript:'How many items'}}]})
    expect(buffer.update({resultIndex:0,results:[{isFinal:true,0:{transcript:'How many items'}},{isFinal:true,0:{transcript:'are listed'}}]}).finalTranscript).toBe('How many items are listed')
    expect(buffer.finalTranscript()).toBe('How many items are listed')
  })

  it('does not promote an empty or interim-only result to a final transcript',()=>{
    const buffer=new SpeechTranscriptBuffer()
    buffer.update({resultIndex:0,results:[{isFinal:false,0:{transcript:'partial words'}}]})
    expect(buffer.finalTranscript()).toBe('')
    expect(buffer.update({resultIndex:0,results:[{isFinal:true,0:{transcript:'   '}}]}).finalTranscript).toBe('')
  })

  it('gates completed transcript interpretation to one attempt per recognition session',()=>{
    const gate=createOnceGate(),attempts:string[]=[]
    expect(gate.run(()=>attempts.push('final'))).toBe(true)
    expect(gate.run(()=>attempts.push('duplicate'))).toBe(false)
    expect(attempts).toEqual(['final'])
    gate.reset();expect(gate.run(()=>attempts.push('retry'))).toBe(true)
    expect(attempts).toEqual(['final','retry'])
  })
})
