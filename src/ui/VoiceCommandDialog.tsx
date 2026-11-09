import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Mic, Search, Square, X } from 'lucide-react'
import type { InventoryItem, TrackerData } from '../domain'
import { ACTIVE_STATUSES, dollarsToCents, formatMoney } from '../domain'
import { QuickSaleFields } from './QuickSaleFields'
import type { QuickSaleInitial } from '../quickSaleForm'
import { voiceSaleInitial } from '../quickSaleForm'
import { canProcessVoiceCommand, interpretVoiceTranscript, verifyVoiceCommandSession, type VoiceAnalysis } from '../voiceCommand'
import type { QuickSaleInput } from '../quickSale'
import { attachSpeechLifecycle, browserSpeechRecognitionAvailable, createOnceGate, SpeechTranscriptBuffer, type SpeechRecognizer, type SpeechWindow } from '../speechRecognition'
import { formatSpeechDiagnosticReport, type SpeechDiagnosticEvent } from '../speechDiagnostics'
export function VoiceCommandDialog({ data, authenticated, verifySession, onClose, onConfirmSale }: {
  data: TrackerData
  authenticated: boolean
  verifySession: () => Promise<void>
  onClose: () => void
  onConfirmSale: (itemId: string, input: QuickSaleInput) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<'ready' | 'starting' | 'listening' | 'transcript_received' | 'interpreting' | 'processing' | 'result' | 'cancelled' | 'error'>('ready')
  const [analysis, setAnalysis] = useState<VoiceAnalysis | null>(null)
  const [selectedItemId, setSelectedItemId] = useState('')
  const [error, setError] = useState('')
  const [interimTranscript, setInterimTranscript] = useState('')
  const [finalTranscript, setFinalTranscript] = useState('')
  const [speechEvents, setSpeechEvents] = useState<SpeechDiagnosticEvent[]>([])
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [diagnosticsCopied, setDiagnosticsCopied] = useState('')
  const [interpretationAttempts, setInterpretationAttempts] = useState(0)
  const recognitionErrorRef = useRef('')
  const recognitionErrorCodeRef = useRef('')
  const startWatchdogRef = useRef<number | null>(null)
  const listenWatchdogRef = useRef<number | null>(null)
  const finalSettleTimerRef = useRef<number | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [detailsOpen, setDetailsOpen] = useState(true)
  const recognitionRef = useRef<SpeechRecognizer | null>(null)
  const lifecycleRef = useRef<ReturnType<typeof attachSpeechLifecycle> | null>(null)
  const finalReceivedRef = useRef(false)
  const transcriptBufferRef = useRef(new SpeechTranscriptBuffer())
  const transcriptGateRef = useRef(createOnceGate())
  const speechStartedAtRef = useRef<number | null>(null)
  const mountedRef = useRef(false)
  const cancelledRef = useRef(false)
  const startedRef = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const latestRef = useRef({ data, authenticated, verifySession })
  latestRef.current = { data, authenticated, verifySession }
  const confirmingRef = useRef(false)
  const commandIdRef = useRef('')
  const interpretationRef = useRef(0)
  const formRef = useRef<HTMLFormElement>(null)
  const clearSpeechTimers = useCallback(() => { if(startWatchdogRef.current!==null)window.clearTimeout(startWatchdogRef.current);if(listenWatchdogRef.current!==null)window.clearTimeout(listenWatchdogRef.current);if(finalSettleTimerRef.current!==null)window.clearTimeout(finalSettleTimerRef.current);startWatchdogRef.current=null;listenWatchdogRef.current=null;finalSettleTimerRef.current=null },[])

  const recordSpeechEvent = (event: string, code?: string) => {
    if (!mountedRef.current) return
    const start = speechStartedAtRef.current ?? performance.now()
    setSpeechEvents((previous) => [...previous, { at: Math.max(0, performance.now() - start), event, ...(code ? { code } : {}) }].slice(-20))
  }

  const speechAvailable = browserSpeechRecognitionAvailable()
  const command = analysis?.kind === 'sale' ? analysis.command : null
  const choices = useMemo(() => {
    if (!analysis) return []
    if (analysis.kind === 'sale') return analysis.matches
    if (analysis.kind === 'unmatched') return analysis.suggestions
    return analysis.kind === 'read_only' ? analysis.matches : []
  }, [analysis])
  const resolvedItem = useMemo(() => {
    if (analysis?.kind === 'sale') return analysis.matched ?? choices.find((item) => item.id === selectedItemId) ?? null
    if (analysis?.kind === 'unmatched') return choices.find((item) => item.id === selectedItemId) ?? null
    return null
  }, [analysis, choices, selectedItemId])
  const initial: QuickSaleInitial | undefined = command && resolvedItem ? voiceSaleInitial(command, resolvedItem) : undefined

  useEffect(() => {
    mountedRef.current = true
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    function close() { recordSpeechEvent('modal_closed');cancelledRef.current = true; lifecycleRef.current?.cancel(); lifecycleRef.current = null; recognitionRef.current = null; onCloseRef.current() }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => { mountedRef.current = false;window.removeEventListener('keydown', onKey); clearSpeechTimers(); lifecycleRef.current?.cancel(); lifecycleRef.current = null; recognitionRef.current = null; document.body.style.overflow = previousOverflow }
  }, [clearSpeechTimers])

  const interpretTranscript = async (value: string) => {
    const commandText = value.trim()
    if (!commandText) { setError('No transcript was received. Try Speak again, use the iPhone keyboard microphone, or type a command.'); setPhase('error'); return }
    const current = latestRef.current
    if (!canProcessVoiceCommand(current.authenticated)) { setError('Your private session expired. Sign in again; no sale was recorded.'); setPhase('error'); return }
    const requestId = ++interpretationRef.current
    const commandId = commandIdRef.current || (commandIdRef.current = `voice-${crypto.randomUUID()}`)
    setPhase('interpreting'); setError('')
    try {
      const result = await interpretVoiceTranscript(commandText, current.data, current.authenticated, current.verifySession, commandId)
      if (requestId !== interpretationRef.current) return
      setAnalysis(result); setSelectedItemId(result.kind === 'sale' && result.matched ? result.matched.id : '')
      setDetailsOpen(true)
      setPhase('result')
      if (result.kind === 'unsupported' || result.kind === 'unmatched') setError(result.message)
    } catch (cause) {
      if (requestId !== interpretationRef.current) return
      setPhase('error'); setError(cause instanceof Error ? cause.message : 'Could not verify your private session. No sale was recorded.')
    }
  }

  const finalizeTranscript = (value = transcriptBufferRef.current.finalTranscript()) => {
    const transcript = value.trim()
    if (!transcript || cancelledRef.current) return false
    return transcriptGateRef.current.run(() => {
      finalReceivedRef.current = true
      setFinalTranscript(transcript);setInterimTranscript('');setText(transcript)
      setAttempt((previous) => previous + 1);setAnalysis(null);setSelectedItemId('')
      commandIdRef.current = `voice-${crypto.randomUUID()}`
      recordSpeechEvent('automatic_interpretation_attempted')
      setInterpretationAttempts((previous) => previous + 1)
      void interpretTranscript(transcript)
    })
  }

  const startListening = () => {
    setError(''); recognitionErrorRef.current='';recognitionErrorCodeRef.current='';commandIdRef.current='';setAnalysis(null); setSelectedItemId(''); finalReceivedRef.current = false
    setInterimTranscript('');setFinalTranscript('');transcriptBufferRef.current.reset();transcriptGateRef.current.reset()
    if (!canProcessVoiceCommand(authenticated)) { setPhase('error'); setError('Your private session is unavailable. Sign in again before using inventory commands.'); return }
    if (recognitionRef.current) return
    const speechWindow = window as SpeechWindow
    const SpeechRecognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
    if (!SpeechRecognition) { recognitionErrorCodeRef.current='api-unavailable';setPhase('error'); setError('This browser does not expose speech transcription. You can still type, or use the iPhone keyboard microphone if available.'); return }
    try {
      const recognition = new SpeechRecognition()
      recognition.lang = 'en-US'; recognition.continuous = false; recognition.interimResults = true
      cancelledRef.current = false
      startedRef.current = false
      speechStartedAtRef.current=performance.now()
      setSpeechEvents([{at:0,event:'start_requested_by_tap'}]);setDiagnosticsCopied('')
      const lifecycle = attachSpeechLifecycle(recognition, {
      onResult: (event) => {
        if(cancelledRef.current || !mountedRef.current)return
        const result=transcriptBufferRef.current.update(event)
        setInterimTranscript(result.interimTranscript);setFinalTranscript(result.finalTranscript)
        const visible=[result.finalTranscript,result.interimTranscript].filter(Boolean).join(' ').trim()
        if(visible)setText(visible)
        if(result.finalTranscript){
          finalReceivedRef.current=true;setPhase('transcript_received');recordSpeechEvent('final_result_received')
          if(finalSettleTimerRef.current!==null)window.clearTimeout(finalSettleTimerRef.current)
          finalSettleTimerRef.current=window.setTimeout(()=>{finalSettleTimerRef.current=null;finalizeTranscript()},900)
        } else if(result.interimTranscript) recordSpeechEvent('interim_result_received')
      },
      onError: (errorCode) => {
        if (cancelledRef.current) return
        recognitionErrorCodeRef.current=errorCode
        recordSpeechEvent('recognition_error',errorCode)
        const reasons: Record<string, string> = {
          'not-allowed': 'The browser denied speech recognition. Check microphone and speech-recognition permission for Safari in iPhone Settings, then retry. Keyboard dictation and typing remain available.',
          'service-not-allowed': 'The browser exposed speech recognition, but its speech service refused the request. This is a browser/service limitation; retry later or use keyboard dictation or typing.',
          'no-speech': 'No speech was detected. Tap Speak and begin talking after the listening indicator appears, or use keyboard dictation.',
          'audio-capture': 'The microphone is unavailable to this browser. Check microphone permission, then retry or use keyboard dictation.',
          network: 'The browser speech service could not connect. Resale Tracker does not upload audio; retry with a connection or use keyboard dictation or typing.',
          'language-not-supported': 'English speech recognition is unavailable here. Use keyboard dictation or type the command.',
        }
        const reason = reasons[errorCode] ?? 'Speech recognition ended unexpectedly. Try again or use the microphone on the iPhone keyboard to dictate into the command box.'
        recognitionErrorRef.current = reason
        if(!transcriptBufferRef.current.finalTranscript()){setPhase('error');setError(reason)}
      },
      onStart: () => { if(cancelledRef.current || !mountedRef.current)return;recordSpeechEvent('recognition_start');startedRef.current=true;if(startWatchdogRef.current!==null)window.clearTimeout(startWatchdogRef.current);startWatchdogRef.current=null;listenWatchdogRef.current=window.setTimeout(()=>{if(!recognitionRef.current)return;recognitionErrorCodeRef.current='listening-timeout';recordSpeechEvent('listening_timeout');setError('Listening timed out without a completed transcript. iPhone may expose the API without returning speech. Retry, use keyboard dictation, or type.');setPhase('error');clearSpeechTimers();cancelledRef.current=true;lifecycleRef.current?.cancel();lifecycleRef.current=null;recognitionRef.current=null},45000);setPhase('listening') },
      onAudioStart: () => { recordSpeechEvent('audio_start');if (!finalReceivedRef.current && mountedRef.current) setPhase('listening') },
      onAudioEnd: () => recordSpeechEvent('audio_end'),
      onSpeechStart: () => {recordSpeechEvent('speech_start');if(mountedRef.current)setPhase('listening')},
      onSpeechEnd: () => recordSpeechEvent('speech_end'),
      onNoMatch: () => recordSpeechEvent('no_match'),
      onEnd: ({ cancelled, started, hasResult }) => {
        recordSpeechEvent('recognition_end',hasResult?'final-result-present':'no-final-result')
        clearSpeechTimers()
        recognitionRef.current = null
        lifecycleRef.current = null
        if(!mountedRef.current)return
        if (cancelled || cancelledRef.current) { if(recognitionErrorRef.current){setPhase('error');setError(recognitionErrorRef.current)}else setPhase('cancelled');return }
        const transcript=transcriptBufferRef.current.finalTranscript()
        if(transcript){setPhase('transcript_received');finalizeTranscript(transcript);return}
        if (hasResult || finalReceivedRef.current) return
        if (!recognitionErrorCodeRef.current) recognitionErrorCodeRef.current='no-final-transcript'
        setPhase('error')
        setError(recognitionErrorRef.current || (started || startedRef.current ? 'The browser started, but ended without a final transcript. A microphone indicator confirms audio capture, not speech transcription. In iPhone standalone mode, retry or use the keyboard microphone in the Command field; typing also works.' : 'The speech service ended before reporting start. Check Safari microphone permission, retry, or use keyboard dictation or typing.'))
      },
      })
      recognitionRef.current = recognition
      lifecycleRef.current = lifecycle
      setPhase('starting')
      // WebKit requires start() directly in the user's tap handler. Do not await
      // network/session work before consuming the gesture; session is verified
      // before interpretation and again before any confirmed sale.
      startWatchdogRef.current=window.setTimeout(()=>{if(!recognitionRef.current)return;recognitionErrorCodeRef.current='start-timeout';recognitionErrorRef.current='The browser did not report recognition start within 10 seconds.';recordSpeechEvent('start_timeout');setError(`${recognitionErrorRef.current} Check Safari permission or use keyboard dictation.`);setPhase('error');clearSpeechTimers();cancelledRef.current=true;lifecycleRef.current?.cancel();lifecycleRef.current=null;recognitionRef.current=null},10000)
      lifecycle.start()
    } catch (cause) {
      recognitionErrorCodeRef.current='start-exception';recordSpeechEvent('start_threw');clearSpeechTimers();lifecycleRef.current?.cancel(); lifecycleRef.current = null; recognitionRef.current = null; setPhase('error')
      setError(cause instanceof Error ? `${cause.message} Check microphone permission, retry, or use iPhone keyboard dictation.` : 'Speech recognition could not start. Check microphone permission or use iPhone keyboard dictation.')
    }
  }

  const cancelListening = () => { recordSpeechEvent('cancelled_by_user');cancelledRef.current = true; recognitionErrorRef.current='';recognitionErrorCodeRef.current='';clearSpeechTimers();lifecycleRef.current?.cancel(); lifecycleRef.current = null; recognitionRef.current = null; setError(''); setPhase('cancelled') }
  const chooseItem = (item: InventoryItem) => {
    setSelectedItemId(item.id)
    setDetailsOpen(true)
    setError('')
  }

  const confirmSale = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!command || !resolvedItem || confirmingRef.current) return
    confirmingRef.current = true; setPhase('processing'); setError('')
    try {
      await verifyVoiceCommandSession(authenticated, verifySession)
      const form = new FormData(event.currentTarget)
      const amountCents = dollarsToCents(String(form.get('gross') ?? ''))
      const input: QuickSaleInput = {
        date: String(form.get('date')),
        platform: String(form.get('platform')),
        grossCents: amountCents,
        feeCents: dollarsToCents(String(form.get('fees'))),
        shippingCents: dollarsToCents(String(form.get('shipping'))),
        otherExpenseCents: dollarsToCents(String(form.get('other'))),
        quantity: Number(form.get('quantity')),
        externalSource: 'voice-command',
        externalId: command!.commandId,
      }
      await onConfirmSale(resolvedItem.id, input)
    } catch (cause) { setPhase('error'); setError(cause instanceof Error ? cause.message : 'The sale was not recorded. Review the details and retry.') }
    finally { confirmingRef.current = false }
  }

  const lotName = resolvedItem ? data.lots.find((lot) => lot.id === resolvedItem.lotId)?.name ?? 'Standalone acquisition' : ''
  const previewValues = command && resolvedItem ? voiceSaleInitial(command, resolvedItem) : undefined
  const closeDialog = () => { recordSpeechEvent('modal_closed');cancelledRef.current = true; clearSpeechTimers();lifecycleRef.current?.cancel(); lifecycleRef.current = null; recognitionRef.current = null; onCloseRef.current() }
  const speechWindow = window as SpeechWindow
  const speechApiName = speechWindow.SpeechRecognition ? 'SpeechRecognition' : speechWindow.webkitSpeechRecognition ? 'webkitSpeechRecognition' : 'unavailable'
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true
  const copyDiagnostics = async () => {
    const report = formatSpeechDiagnosticReport({ apiAvailable: speechAvailable, apiName: speechApiName, standalone, phase, interpretationAttempts, errorCode: recognitionErrorCodeRef.current, events: speechEvents })
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(report)
      else {
        const input=document.createElement('textarea');input.value=report;input.setAttribute('readonly','');input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();const copied=document.execCommand('copy');input.remove();if(!copied)throw new Error('Clipboard unavailable')
      }
      setDiagnosticsCopied('Diagnostics copied. Transcript text is excluded.')
    } catch { setDiagnosticsCopied('Could not access the clipboard. Select and copy the diagnostic details instead.') }
  }
  const busy = phase === 'processing' || phase === 'interpreting'
  const phaseLabel = phase === 'ready' ? 'Ready' : phase.replaceAll('_',' ')

  return <div className="modal-backdrop voice-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog() }} onFocusCapture={(event) => { const target = event.target; if (target instanceof HTMLElement && target.matches('input,select,textarea')) window.setTimeout(() => target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 150) }}>
    <section className="modal voice-dialog" role="dialog" aria-modal="true" aria-labelledby="voice-dialog-title" aria-describedby="voice-dialog-help">
      <header><div><span className="eyebrow">PRIVATE INVENTORY COMMAND</span><h2 id="voice-dialog-title">Voice command</h2></div><button className="icon-button" aria-label="Close voice command" onClick={closeDialog}><X size={19}/></button></header>
      <p id="voice-dialog-help" className="voice-privacy-note">Speech is processed by your browser and may use its speech service. Resale Tracker does not save raw audio or send your inventory for transcription. Typed commands stay on this device.</p>
      <div className="voice-input-actions">
        {speechAvailable ? <button className={`primary voice-mic ${phase === 'listening' ? 'listening' : ''}`} disabled={busy} onClick={phase === 'listening' || phase === 'starting' ? cancelListening : startListening}>{phase === 'starting' ? 'Cancel starting' : phase === 'listening' ? <><Square size={16}/> Stop listening</> : phase === 'interpreting' ? 'Interpreting…' : <><Mic size={17}/> Speak command</>}</button> : <span className="voice-unavailable">This browser does not provide speech transcription. Use the iPhone keyboard microphone in the Command field if available, or type.</span>}
        {(phase === 'starting' || phase === 'listening')&&<span className="listening-indicator" role="status"><i/>{phase === 'starting' ? 'Starting speech service…' : 'Listening for speech'}</span>}
      </div>
      <label className="voice-command-label">Command<textarea value={text} disabled={phase==='starting'||phase==='listening'||busy} onChange={(event) => { interpretationRef.current++;commandIdRef.current='';setText(event.currentTarget.value);setInterimTranscript('');setFinalTranscript('');setAttempt((value) => value + 1);setAnalysis(null);setSelectedItemId('');setError('');setPhase('ready') }} rows={2} placeholder="Sold VI Music for ten dollars on Vinted."/><small>The command stays in this field. On iPhone, use the keyboard microphone to dictate here whenever Speak command is unavailable.</small></label>
      {(interimTranscript || finalTranscript) && <div className="speech-transcript-status" aria-live="polite">{interimTranscript&&<div><span>Interim transcript</span><b>{interimTranscript}</b></div>}{finalTranscript&&<div><span>Final transcript</span><b>{finalTranscript}</b></div>}</div>}
      <details className="speech-diagnostics" open={diagnosticsOpen} onToggle={(event)=>setDiagnosticsOpen(event.currentTarget.open)}>
        <summary>Speech diagnostics</summary>
        <div className="speech-diagnostic-grid"><div><span>Browser API</span><b>{speechAvailable?`${speechApiName} exposed`:'Not exposed'}</b><small>API exposure does not guarantee an iOS speech service will return text.</small></div><div><span>App display</span><b>{standalone?'Home Screen / standalone':'Browser tab'}</b></div><div><span>Current state</span><b>{phaseLabel}</b></div><div><span>Automatic interpretation</span><b>{interpretationAttempts ? `Attempted ${interpretationAttempts} time${interpretationAttempts===1?'':'s'}` : 'Not attempted'}</b></div><div><span>Last error code</span><b>{recognitionErrorCodeRef.current||'None'}</b></div></div>
        {speechEvents.length>0&&<ul className="speech-diagnostic-events" aria-label="Recent browser speech events">{speechEvents.slice(-12).map((event,index)=><li key={`${event.at}-${event.event}-${index}`}><span>+{(event.at/1000).toFixed(1)}s</span><b>{event.event}</b>{event.code&&<em>{event.code}</em>}</li>)}</ul>}
        <div className="speech-diagnostic-actions"><button type="button" className="secondary" onClick={()=>void copyDiagnostics()}>Copy diagnostics</button><small>{diagnosticsCopied||'Copied report omits transcript, inventory, account details, and tokens. Nothing is transmitted.'}</small></div>
      </details>
      <div className="voice-interpret-actions"><button className="secondary" disabled={busy || phase === 'starting' || phase === 'listening' || !text.trim()} onClick={() => void interpretTranscript(text)}>{phase === 'processing' || phase === 'interpreting' ? <><LoaderCircle size={16} className="spin"/> Interpreting command…</> : <><Search size={16}/> Interpret command</>}</button><span>{phase === 'error' ? 'Action needed' : phase === 'starting' ? 'Starting recognition' : phase === 'listening' ? 'Listening' : phase === 'transcript_received' ? 'Transcript received' : phase === 'interpreting' || phase === 'processing' ? 'Checking inventory' : analysis?'Review the proposal below':phase==='cancelled'?'Listening cancelled':'Ready'}</span></div>
      {error&&<div className="voice-error" role="alert">{error}</div>}
      {analysis?.kind === 'read_only'&&<section className="voice-result"><h3>Inventory result</h3><p>{analysis.response}</p>{choices.length>0&&<VoiceItemChoices items={choices} data={data} selectedId={selectedItemId} onChoose={chooseItem}/>}</section>}
      {analysis?.kind === 'unsupported'&&<div className="voice-error" role="status">{analysis.message}</div>}
      {analysis?.kind === 'unmatched'&&<section className="voice-result"><h3>No reliable available match</h3><p>{analysis.message}</p>{choices.length>0&&<VoiceItemChoices items={choices} data={data} selectedId={selectedItemId} onChoose={chooseItem}/>}</section>}
      {analysis?.kind === 'sale'&&<section className="voice-result"><h3>Proposed sale · not saved</h3><div className="voice-proposal"><div><span>Item</span><b>{resolvedItem?.title??analysis.query}</b></div><div><span>Purchase lot</span><b>{lotName||'Select an item'}</b></div><div><span>Platform</span><b>{previewValues?.platform||'Choose before confirming'}</b></div><div><span>Sale amount</span><b>{previewValues?.amountCents===null||previewValues?.amountCents===undefined?'Enter or confirm amount':formatMoney(previewValues.amountCents)}{command!.amountMode==='per_unit'?' each':''}</b></div><div><span>Quantity</span><b>{command!.quantity}</b></div><div><span>Seller fees</span><b>{previewValues?.feeCents===null||previewValues?.feeCents===undefined?'Enter actual fees':formatMoney(previewValues.feeCents)}</b></div><div><span>Seller-paid shipping</span><b>{previewValues?.shippingCents===null||previewValues?.shippingCents===undefined?'Enter amount':formatMoney(previewValues.shippingCents)}</b></div></div>{analysis.ambiguous&&!resolvedItem&&<><p>More than one inventory record matches. Select the exact item before continuing.</p><VoiceItemChoices items={choices} data={data} selectedId={selectedItemId} onChoose={chooseItem}/></>}
        {resolvedItem&&<form ref={formRef} className="form-grid voice-sale-form" onSubmit={confirmSale}>
          <details className="voice-edit-details" open={detailsOpen} onToggle={(event) => setDetailsOpen((event.currentTarget as HTMLDetailsElement).open)}><summary>Edit Details</summary><QuickSaleFields key={`${resolvedItem.id}:${command!.commandId}`} data={data} item={resolvedItem} initial={initial}/></details>
          <div className="voice-sale-actions full"><button type="button" className="secondary" onClick={closeDialog}>Cancel</button><button type="submit" className="primary" disabled={phase==='processing'}>{phase==='processing'?'Checking sign-in…':'Confirm Sale'}</button></div>
          <small className="voice-required-note full">Review every field, including zero fees, shipping, and other expenses. Required values are checked before saving. No sale is saved until you tap Confirm Sale.</small>
        </form>}
      </section>}
      <footer className="voice-dialog-footer"><span>{attempt ? `Interpretation ${attempt} · no changes are saved before confirmation.` : 'Read-only queries and confirmed sales only.'}</span><button className="secondary" onClick={closeDialog}>Cancel</button></footer>
    </section>
  </div>
}

function VoiceItemChoices({items,data,selectedId,onChoose}:{items:InventoryItem[];data:TrackerData;selectedId:string;onChoose:(item:InventoryItem)=>void}){
  return <div className="voice-item-choices">{items.map((item)=>{const lot=data.lots.find((entry)=>entry.id===item.lotId);const available=ACTIVE_STATUSES.includes(item.status)&&item.quantity>0;return <button type="button" key={item.id} className={`voice-item-choice ${selectedId===item.id?'selected':''}`} disabled={!available} onClick={()=>onChoose(item)}><span><b>{item.title}</b><small>{lot?.name??'Standalone'} · {item.quantity} available · {item.platform||'No platform set'}{!available?' · unavailable':''}</small></span><strong>{formatMoney(item.costCents)}</strong></button>})}</div>
}
