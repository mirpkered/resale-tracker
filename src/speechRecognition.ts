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
  stop?(): void
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
  let stopRequested = false
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
    stop() { if (stopRequested || cancelled || endDelivered) return; if (!recognition.stop) throw new Error('SpeechRecognition.stop is unavailable'); stopRequested = true; recognition.stop() },
    cancel() { if (cancelled || endDelivered) return; cancelled = true; recognition.abort() },
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

export interface SpeechAttemptResult { transcript: string | null; cancelled: boolean; code?: string; endReceived: boolean; recognitionStarted: boolean; audioStarted: boolean }
export interface SpeechAttemptHandlers {
  onState: (state: 'starting' | 'listening' | 'stopping' | 'cancelling') => void
  onEvent: (event: string, code?: string) => void
  onTranscript: (result: { finalTranscript: string; interimTranscript: string }) => void
  onNoTranscript: () => void
  onComplete: (result: SpeechAttemptResult) => void
}
export interface SpeechAttemptTimeouts {
  startMs?: number; noTranscriptNoticeMs?: number; listenMs?: number; finalSettleMs?: number
  stopMs?: number; cancelMs?: number; errorEndMs?: number
}

/** Owns one recognizer and all of its callbacks/timers until a safe terminal state. */
export function createSpeechAttempt(recognition: SpeechRecognizer, handlers: SpeechAttemptHandlers, timeouts: SpeechAttemptTimeouts = {}) {
  const durations = { startMs:10_000,noTranscriptNoticeMs:10_000,listenMs:45_000,finalSettleMs:1_000,stopMs:5_000,cancelMs:1_200,errorEndMs:1_500,...timeouts }
  const session=createSpeechCommandSession()
  let state:'starting'|'listening'|'stopping'|'cancelling'|'finished'='starting'
  let active=true, cancelled=false, endReceived=false, audioStarted=false, recognitionStarted=false, textReceived=false, abortRequested=false
  let lifecycle:ReturnType<typeof attachSpeechLifecycle>|null=null
  let errorCode:string|undefined
  const timers:Partial<Record<keyof SpeechAttemptTimeouts,ReturnType<typeof setTimeout>>>={}
  const clearTimer=(key:keyof SpeechAttemptTimeouts)=>{if(timers[key]!==undefined)clearTimeout(timers[key]);delete timers[key]}
  const clearTimers=()=>{for(const key of Object.keys(timers) as (keyof SpeechAttemptTimeouts)[])clearTimer(key)}
  const abortOnce=()=>{if(abortRequested||!active)return;abortRequested=true;try{lifecycle?.cancel()}catch{handlers.onEvent('abort_threw','application')}}
  const finish=(code?:string)=>{
    if(!active)return
    active=false;state='finished';clearTimers();lifecycle?.dispose();lifecycle=null
    const transcript=cancelled?null:session.complete()
    if(!transcript)session.cancel()
    handlers.onEvent('cleanup_completed',endReceived?'onend-received':'without-onend')
    handlers.onComplete({transcript,cancelled,code:code??(transcript?undefined:errorCode),endReceived,recognitionStarted,audioStarted})
  }
  const requestStop=(source:'user'|'final-result')=>{
    if(!active||state==='stopping'||state==='cancelling')return
    state='stopping';handlers.onState('stopping');handlers.onEvent(source==='user'?'stop_requested_by_user':'stop_requested_after_final_result')
    try{lifecycle?.stop()}catch{handlers.onEvent('stop_threw','application');errorCode='stop-exception';abortOnce();finish(errorCode);return}
    if(!active)return
    clearTimer('listenMs');clearTimer('noTranscriptNoticeMs')
    timers.stopMs=setTimeout(()=>{if(!active)return;handlers.onEvent('application_timeout','stop-timeout');errorCode=errorCode??'stop-timeout';abortOnce();finish(errorCode)},durations.stopMs)
  }
  lifecycle=attachSpeechLifecycle(recognition,{
    onStart:()=>{if(!active||cancelled)return;recognitionStarted=true;handlers.onEvent('recognition_start');clearTimer('startMs');state='listening';handlers.onState('listening');timers.noTranscriptNoticeMs=setTimeout(()=>{if(active&&!cancelled&&!textReceived){handlers.onEvent('no_transcript_notice');handlers.onNoTranscript()}},durations.noTranscriptNoticeMs);timers.listenMs=setTimeout(()=>{if(!active||cancelled)return;handlers.onEvent('application_timeout','listening-timeout');errorCode='listening-timeout';abortOnce();finish(errorCode)},durations.listenMs)},
    onAudioStart:()=>{if(active&&!cancelled){audioStarted=true;handlers.onEvent('audio_start')}},
    onAudioEnd:()=>{if(active&&!cancelled)handlers.onEvent('audio_end')},
    onSpeechStart:()=>{if(active&&!cancelled)handlers.onEvent('speech_start')},
    onSpeechEnd:()=>{if(active&&!cancelled)handlers.onEvent('speech_end')},
    onNoMatch:()=>{if(active&&!cancelled)handlers.onEvent('no_match')},
    onResult:event=>{if(!active||cancelled)return;const result=session.update(event);if(!result)return;if(result.finalTranscript||result.interimTranscript){textReceived=true;clearTimer('noTranscriptNoticeMs')}handlers.onTranscript(result);if(result.finalTranscript){clearTimer('finalSettleMs');timers.finalSettleMs=setTimeout(()=>requestStop('final-result'),durations.finalSettleMs)}},
    onError:code=>{if(!active)return;if(cancelled){handlers.onEvent('browser_error_after_cancel',code);return}errorCode=code;handlers.onEvent('browser_error',code);clearTimer('startMs');clearTimer('noTranscriptNoticeMs');clearTimer('listenMs');timers.errorEndMs=setTimeout(()=>{if(active&&!endReceived){handlers.onEvent('application_timeout','error-end-timeout');abortOnce();if(active)finish(errorCode)}},durations.errorEndMs)},
    onEnd:({cancelled:lifecycleCancelled})=>{if(!active)return;endReceived=true;clearTimer('stopMs');clearTimer('cancelMs');clearTimer('errorEndMs');handlers.onEvent('recognition_end',lifecycleCancelled?'browser-aborted':'onend');if(lifecycleCancelled&&!cancelled){finish(errorCode??'recognition-aborted');return}finish(errorCode)},
  })
  return {
    start(){if(!active)return;state='starting';handlers.onState('starting');handlers.onEvent('start_called');timers.startMs=setTimeout(()=>{if(!active)return;handlers.onEvent('application_timeout','start-timeout');errorCode='start-timeout';abortOnce();finish(errorCode)},durations.startMs);try{lifecycle?.start()}catch{handlers.onEvent('start_threw','application');errorCode='start-exception';abortOnce();finish(errorCode)}},
    stop(){requestStop('user')},
    cancel(reason='user'){if(!active)return;cancelled=true;state='cancelling';clearTimer('startMs');clearTimer('listenMs');clearTimer('noTranscriptNoticeMs');clearTimer('finalSettleMs');clearTimer('stopMs');clearTimer('errorEndMs');handlers.onEvent(reason==='user'?'cancel_requested_by_user':'recognition_interrupted',reason==='user'?undefined:reason);handlers.onState('cancelling');abortOnce();if(!active)return;timers.cancelMs=setTimeout(()=>{if(!active)return;handlers.onEvent('application_timeout','cancel-end-timeout');finish(errorCode)},durations.cancelMs)},
    isActive(){return active},getState(){return state},hasAudioStarted(){return audioStarted},
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
