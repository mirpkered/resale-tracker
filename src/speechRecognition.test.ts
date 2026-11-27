import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachSpeechLifecycle, browserSpeechRecognitionAvailable, createOnceGate, createSpeechAttempt, createSpeechCommandSession, SpeechTranscriptBuffer, type SpeechRecognizer, type SpeechWindow } from './speechRecognition'

describe('browser speech recognition capability', () => {
  it('detects standard and WebKit-prefixed browser speech recognition', () => {
    expect(browserSpeechRecognitionAvailable({ SpeechRecognition: class {} } as unknown as SpeechWindow)).toBe(true)
    expect(browserSpeechRecognitionAvailable({ webkitSpeechRecognition: class {} } as unknown as SpeechWindow)).toBe(true)
  })

  it('provides typed-command fallback when the browser does not expose speech recognition', () => {
    expect(browserSpeechRecognitionAvailable({} as SpeechWindow)).toBe(false)
  })
})

function fakeRecognition(): SpeechRecognizer & { starts: number; stops: number; aborts: number; end: () => void; fail: (error: string) => void; audio: () => void; result: (transcript: string, final?: boolean) => void } {
  return {
    lang: '', continuous: false, interimResults: false, onresult: null, onerror: null, onstart: null,
    onaudiostart: null, onspeechstart: null, onaudioend: null, onspeechend: null, onnomatch: null, onend: null,
    starts: 0, stops: 0, aborts: 0, start() { this.starts++ }, stop() { this.stops++ }, abort() { this.aborts++ },
    end() { this.onend?.() }, fail(error) { this.onerror?.({error}) }, audio() { this.onaudiostart?.() },
    result(transcript,final=true) { this.onresult?.({resultIndex:0,results:[{isFinal:final,0:{transcript}}]}) },
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

  it('automatically completes final and usable interim-only transcripts once per isolated session',()=>{
    const final=createSpeechCommandSession()
    final.update({resultIndex:0,results:[{isFinal:true,0:{transcript:'How many are listed?'}}]})
    expect(final.complete()).toBe('How many are listed?')
    expect(final.complete()).toBeNull()

    const interim=createSpeechCommandSession()
    interim.update({resultIndex:0,results:[{isFinal:false,0:{transcript:'Show my Halloween lot'}}]})
    expect(interim.complete()).toBe('Show my Halloween lot')
    expect(final.isCompleted()).toBe(true)
    expect(interim.isCompleted()).toBe(true)
  })

  it('does not complete empty or canceled speech and ignores late results',()=>{
    const empty=createSpeechCommandSession()
    empty.update({resultIndex:0,results:[{isFinal:false,0:{transcript:'   '}}]})
    expect(empty.complete()).toBeNull()
    const canceled=createSpeechCommandSession()
    canceled.update({resultIndex:0,results:[{isFinal:false,0:{transcript:'do not run'}}]})
    canceled.cancel()
    expect(canceled.complete()).toBeNull()
    expect(canceled.update({resultIndex:0,results:[{isFinal:true,0:{transcript:'stale'}}]})).toBeNull()
  })

  it('keeps sequential voice transcripts separate across three or more recognition sessions',()=>{
    const sessions=Array.from({length:4},(_,index)=>{
      const session=createSpeechCommandSession()
      session.update({resultIndex:0,results:[{isFinal:true,0:{transcript:`command ${index+1}`}}]})
      return session
    })
    expect(sessions.map((session)=>session.complete())).toEqual(['command 1','command 2','command 3','command 4'])
  })

  it('detaches completed lifecycle callbacks so an old recognizer cannot affect the next session',()=>{
    const old=fakeRecognition(),next=fakeRecognition(),events:string[]=[]
    const oldLifecycle=attachSpeechLifecycle(old,{onResult:()=>events.push('old result'),onEnd:()=>events.push('old end')})
    const nextLifecycle=attachSpeechLifecycle(next,{onResult:()=>events.push('new result'),onEnd:()=>events.push('new end')})
    oldLifecycle.start();old.end();nextLifecycle.start()
    old.onresult?.({resultIndex:0,results:[{isFinal:true,0:{transcript:'late'}}]})
    next.onresult?.({resultIndex:0,results:[{isFinal:true,0:{transcript:'new'}}]})
    expect(events).toEqual(['old end','new result'])
  })
})

describe('recoverable speech attempts', () => {
  afterEach(() => vi.useRealTimers())
  const shortTimeouts={startMs:100,noTranscriptNoticeMs:100,listenMs:500,finalSettleMs:20,stopMs:80,cancelMs:30,errorEndMs:30}
  function attemptFor(speech:ReturnType<typeof fakeRecognition>, timeouts=shortTimeouts) {
    const complete=vi.fn(), event=vi.fn(), transcript=vi.fn(), noTranscript=vi.fn(), state=vi.fn()
    const attempt=createSpeechAttempt(speech,{onComplete:complete,onEvent:event,onTranscript:transcript,onNoTranscript:noTranscript,onState:state},timeouts)
    return {attempt,complete,event,transcript,noTranscript,state}
  }

  it('completes five consecutive sessions independently and interprets each transcript once',()=>{
    vi.useFakeTimers()
    const results:string[]=[]
    for(let index=0;index<5;index++){
      const speech=fakeRecognition(),current=attemptFor(speech)
      current.attempt.start();speech.onstart?.();speech.result('command '+(index+1));vi.advanceTimersByTime(20);speech.end()
      expect(current.complete).toHaveBeenCalledTimes(1)
      results.push(current.complete.mock.calls[0][0].transcript)
      speech.result('late duplicate')
      expect(current.complete).toHaveBeenCalledTimes(1)
    }
    expect(results).toEqual(['command 1','command 2','command 3','command 4','command 5'])
  })

  it('requests graceful stop after a final transcript and waits for late result/end delivery',()=>{
    vi.useFakeTimers()
    const speech=fakeRecognition(),current=attemptFor(speech)
    current.attempt.start();speech.onstart?.();speech.result('partial one',true);vi.advanceTimersByTime(20)
    expect(speech.stops).toBe(1);expect(speech.aborts).toBe(0);expect(current.complete).not.toHaveBeenCalled()
    speech.result('partial one final',true);vi.advanceTimersByTime(20);speech.end()
    expect(current.complete).toHaveBeenCalledTimes(1)
    expect(current.complete.mock.calls[0][0].transcript).toBe('partial one final')
  })

  it('Stop preserves usable interim speech and calls stop instead of abort',()=>{
    const speech=fakeRecognition(),current=attemptFor(speech)
    current.attempt.start();speech.onstart?.();speech.result('show inventory',false);current.attempt.stop()
    expect(speech.stops).toBe(1);expect(speech.aborts).toBe(0)
    speech.end()
    expect(current.complete.mock.calls[0][0].transcript).toBe('show inventory')
    expect(current.complete.mock.calls[0][0].cancelled).toBe(false)
  })

  it('Cancel aborts and discards transcript; a cleaned-up retry can start immediately',()=>{
    const first=fakeRecognition(),old=attemptFor(first)
    old.attempt.start();first.onstart?.();first.result('discard this',false);old.attempt.cancel()
    expect(first.aborts).toBe(1);first.end()
    expect(old.complete.mock.calls[0][0]).toMatchObject({transcript:null,cancelled:true})
    const second=fakeRecognition(),next=attemptFor(second)
    next.attempt.start();second.onstart?.();second.result('fresh command');second.end()
    expect(next.complete.mock.calls[0][0].transcript).toBe('fresh command')
  })

  it('ignores a late transcript after cancellation and logs an app interruption without exposing text',()=>{
    const speech=fakeRecognition(),current=attemptFor(speech)
    current.attempt.start();current.attempt.cancel('app-backgrounded');speech.onstart?.();speech.audio();speech.result('private spoken text')
    expect(current.transcript).not.toHaveBeenCalled()
    expect(current.state).not.toHaveBeenCalledWith('listening')
    speech.end()
    expect(current.complete.mock.calls[0][0]).toMatchObject({transcript:null,cancelled:true})
    expect(current.event).toHaveBeenCalledWith('recognition_interrupted','app-backgrounded')
    expect(current.event.mock.calls.flat().join(' ')).not.toContain('private spoken text')
  })

  it('handles repeated stop and cancel safely without duplicate abort or completion',()=>{
    vi.useFakeTimers()
    const speech=fakeRecognition(),current=attemptFor(speech)
    current.attempt.start();speech.onstart?.();current.attempt.stop();current.attempt.stop();current.attempt.cancel();current.attempt.cancel();speech.end()
    expect(speech.stops).toBe(1);expect(speech.aborts).toBe(1);expect(current.complete).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(500);expect(current.complete).toHaveBeenCalledTimes(1)
  })

  it('keeps audio-started/no-text visible before ending with an actionable empty result',()=>{
    vi.useFakeTimers()
    const speech=fakeRecognition(),current=attemptFor(speech,{...shortTimeouts,listenMs:400})
    current.attempt.start();speech.onstart?.();speech.audio();vi.advanceTimersByTime(100)
    expect(current.noTranscript).toHaveBeenCalledTimes(1);expect(current.attempt.isActive()).toBe(true)
    vi.advanceTimersByTime(300)
    expect(current.complete.mock.calls[0][0]).toMatchObject({transcript:null,audioStarted:true,recognitionStarted:true,code:'listening-timeout'})
    expect(current.event).toHaveBeenCalledWith('application_timeout','listening-timeout')
  })

  it('does not call a session transcript-free after interim words have arrived',()=>{
    vi.useFakeTimers()
    const speech=fakeRecognition(),current=attemptFor(speech)
    current.attempt.start();speech.onstart?.();speech.result('recognized interim words',false);vi.advanceTimersByTime(100)
    expect(current.noTranscript).not.toHaveBeenCalled()
    expect(current.transcript).toHaveBeenCalledWith({finalTranscript:'',interimTranscript:'recognized interim words'})
    current.attempt.cancel();speech.end()
  })

  it('allows a no-transcript session to stop, then resolves as empty when the service ends',()=>{
    const speech=fakeRecognition(),current=attemptFor(speech)
    current.attempt.start();speech.onstart?.();speech.audio();current.attempt.stop();speech.end()
    expect(current.complete.mock.calls[0][0]).toMatchObject({transcript:null,code:undefined,endReceived:true})
  })

  it('cleans up a stop that never receives onend and records an application timeout',()=>{
    vi.useFakeTimers()
    const speech=fakeRecognition(),current=attemptFor(speech)
    current.attempt.start();speech.onstart?.();speech.result('recognized');current.attempt.stop();vi.advanceTimersByTime(80)
    expect(speech.aborts).toBe(1)
    expect(current.complete.mock.calls[0][0]).toMatchObject({transcript:'recognized',code:'stop-timeout',endReceived:false})
    expect(current.event).toHaveBeenCalledWith('cleanup_completed','without-onend')
  })

  it('recovers from missing onend after cancellation without interpreting',()=>{
    vi.useFakeTimers()
    const speech=fakeRecognition(),current=attemptFor(speech)
    current.attempt.start();speech.onstart?.();speech.result('do not interpret');current.attempt.cancel();vi.advanceTimersByTime(30)
    expect(current.complete.mock.calls[0][0]).toMatchObject({transcript:null,cancelled:true,endReceived:false})
  })

  it.each(['not-allowed','service-not-allowed','audio-capture','network','no-speech'])('cleans up browser error %s whether it arrives before or after audio',error=>{
    vi.useFakeTimers()
    const speech=fakeRecognition(),current=attemptFor(speech)
    current.attempt.start();if(error!=='not-allowed') {speech.onstart?.();speech.audio()}speech.fail(error);speech.end()
    expect(current.complete.mock.calls[0][0]).toMatchObject({transcript:null,code:error,endReceived:true})
    expect(current.event).toHaveBeenCalledWith('browser_error',error)
  })

  it('bounds an error without onend and a start that throws',()=>{
    vi.useFakeTimers()
    const errored=fakeRecognition(),pending=attemptFor(errored)
    pending.attempt.start();errored.fail('network');vi.advanceTimersByTime(30)
    expect(pending.complete.mock.calls[0][0]).toMatchObject({code:'network',endReceived:false})
    expect(errored.aborts).toBe(1)
    const broken=fakeRecognition();broken.start=()=>{throw new Error('gesture rejected')};const failed=attemptFor(broken)
    failed.attempt.start()
    expect(failed.complete.mock.calls[0][0]).toMatchObject({code:'start-exception',endReceived:false})
  })

  it('cleans up a start timeout and does not retain a retry blocker',()=>{
    vi.useFakeTimers()
    const speech=fakeRecognition(),current=attemptFor(speech)
    current.attempt.start();vi.advanceTimersByTime(100)
    expect(current.complete.mock.calls[0][0]).toMatchObject({code:'start-timeout',endReceived:false})
    expect(current.attempt.isActive()).toBe(false)
  })

  it('ignores late callbacks from a finished recognizer and does not create a second completion',()=>{
    const oldSpeech=fakeRecognition(),old=attemptFor(oldSpeech)
    old.attempt.start();oldSpeech.onstart?.();oldSpeech.result('first');oldSpeech.end()
    const nextSpeech=fakeRecognition(),next=attemptFor(nextSpeech)
    next.attempt.start();nextSpeech.onstart?.();oldSpeech.result('stale');oldSpeech.fail('network');oldSpeech.end()
    expect(old.complete).toHaveBeenCalledTimes(1);expect(next.complete).not.toHaveBeenCalled()
    nextSpeech.result('second');nextSpeech.end();expect(next.complete.mock.calls[0][0].transcript).toBe('second')
  })
})
