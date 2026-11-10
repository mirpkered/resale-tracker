import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Mic, Search, Square, X } from 'lucide-react'
import type { InventoryItem, LedgerTransaction, Sale, TrackerData } from '../domain'
import { ACTIVE_STATUSES, dollarsToCents, formatMoney } from '../domain'
import { QuickSaleFields } from './QuickSaleFields'
import type { QuickSaleInitial } from '../quickSaleForm'
import { voiceSaleInitial } from '../quickSaleForm'
import { canProcessVoiceCommand, interpretVoiceTranscript, verifyVoiceCommandSession, type VoiceAnalysis } from '../voiceCommand'
import type { QuickSaleInput } from '../quickSale'
import { attachSpeechLifecycle, browserSpeechRecognitionAvailable, createSpeechCommandSession, type SpeechRecognizer, type SpeechWindow } from '../speechRecognition'
import { formatSpeechDiagnosticReport, type SpeechDiagnosticEvent } from '../speechDiagnostics'
import { currentFinancialAmount, type FinancialCommandAnalysis, type FinancialCommand } from '../financialVoiceCommand'
export function VoiceCommandDialog({ data, authenticated, verifySession, onClose, onConfirmSale, onConfirmFinancial, onOpenLot }: {
  data: TrackerData
  authenticated: boolean
  verifySession: () => Promise<void>
  onClose: () => void
  onConfirmSale: (itemId: string, input: QuickSaleInput) => Promise<void>
  onConfirmFinancial: (command: FinancialCommand, recordId: string | undefined, amountCents: number, expectedRecord: LedgerTransaction | Sale | undefined, markReceived: boolean) => Promise<void>
  onOpenLot: (lotId: string) => void
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
  const [financialAmount, setFinancialAmount] = useState('')
  const [selectedFinancialRecordId, setSelectedFinancialRecordId] = useState('')
  const [financialReceived, setFinancialReceived] = useState(false)
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
  const activeSpeechSessionRef = useRef<ReturnType<typeof createSpeechCommandSession> | null>(null)
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
    function close() { recordSpeechEvent('modal_closed');cancelledRef.current = true;activeSpeechSessionRef.current?.cancel();activeSpeechSessionRef.current=null;lifecycleRef.current?.cancel();lifecycleRef.current?.dispose(); lifecycleRef.current = null; recognitionRef.current = null; onCloseRef.current() }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => { mountedRef.current = false;window.removeEventListener('keydown', onKey); clearSpeechTimers(); activeSpeechSessionRef.current?.cancel();activeSpeechSessionRef.current=null;lifecycleRef.current?.cancel();lifecycleRef.current?.dispose(); lifecycleRef.current = null; recognitionRef.current = null; document.body.style.overflow = previousOverflow }
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
      if (result.kind === 'financial') {
        const matchingId = result.matches.length === 1 ? result.matches[0].id : result.sales.length === 1 ? result.sales[0].id : ''
        setSelectedFinancialRecordId(matchingId)
        const amount = currentFinancialAmount(result, matchingId || undefined)
        setFinancialAmount(amount === undefined ? '' : (amount / 100).toFixed(2))
        setFinancialReceived(result.command.explicitReceipt)
      } else {
        setSelectedFinancialRecordId('')
        setFinancialAmount('')
        setFinancialReceived(false)
      }
    } catch (cause) {
      if (requestId !== interpretationRef.current) return
      setPhase('error'); setError(cause instanceof Error ? cause.message : 'Could not verify your private session. No sale was recorded.')
    }
  }

  const finalizeTranscript = (session: ReturnType<typeof createSpeechCommandSession>) => {
    if (activeSpeechSessionRef.current !== session || cancelledRef.current) return false
    const transcript = session.complete()?.trim()
    if (!transcript) return false
    finalizeCompletedTranscript(transcript)
    return true
  }

  function finalizeCompletedTranscript(transcript: string) {
    const value = transcript.trim()
    if (!value || cancelledRef.current) return
    finalReceivedRef.current = true
    setFinalTranscript(value);setInterimTranscript('');setText(value)
    setAttempt((previous) => previous + 1);setAnalysis(null);setSelectedItemId('')
    commandIdRef.current = `voice-${crypto.randomUUID()}`
    recordSpeechEvent('automatic_interpretation_attempted');setInterpretationAttempts((previous) => previous + 1)
    void interpretTranscript(value)
  }

  const startListening = () => {
    if (recognitionRef.current || activeSpeechSessionRef.current?.isActive()) return
    interpretationRef.current++
    setError(''); recognitionErrorRef.current='';recognitionErrorCodeRef.current='';commandIdRef.current='';setAnalysis(null); setSelectedItemId(''); finalReceivedRef.current = false
    setInterimTranscript('');setFinalTranscript('')
    if (!canProcessVoiceCommand(authenticated)) { setPhase('error'); setError('Your private session is unavailable. Sign in again before using inventory commands.'); return }
    if (recognitionRef.current) return
    const speechWindow = window as SpeechWindow
    const SpeechRecognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
    if (!SpeechRecognition) { recognitionErrorCodeRef.current='api-unavailable';setPhase('error'); setError('This browser does not expose speech transcription. You can still type, or use the iPhone keyboard microphone if available.'); return }
    try {
      const recognition = new SpeechRecognition()
      const speechSession = createSpeechCommandSession()
      activeSpeechSessionRef.current = speechSession
      recognition.lang = 'en-US'; recognition.continuous = false; recognition.interimResults = true
      cancelledRef.current = false
      startedRef.current = false
      speechStartedAtRef.current=performance.now()
      setSpeechEvents([{at:0,event:'start_requested_by_tap'}]);setDiagnosticsCopied('')
      const lifecycle = attachSpeechLifecycle(recognition, {
      onResult: (event) => {
        if(cancelledRef.current || !mountedRef.current || activeSpeechSessionRef.current !== speechSession || !speechSession.isActive())return
        const result=speechSession.update(event)
        if(!result)return
        setInterimTranscript(result.interimTranscript);setFinalTranscript(result.finalTranscript)
        const visible=[result.finalTranscript,result.interimTranscript].filter(Boolean).join(' ').trim()
        if(visible)setText(visible)
        if(result.finalTranscript){
          finalReceivedRef.current=true;setPhase('transcript_received');recordSpeechEvent('final_result_received')
          if(finalSettleTimerRef.current!==null)window.clearTimeout(finalSettleTimerRef.current)
          finalSettleTimerRef.current=window.setTimeout(()=>{finalSettleTimerRef.current=null;finalizeTranscript(speechSession)},900)
        } else if(result.interimTranscript) recordSpeechEvent('interim_result_received')
      },
      onError: (errorCode) => {
        if (cancelledRef.current || activeSpeechSessionRef.current !== speechSession || !speechSession.isActive()) return
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
        if(!finalReceivedRef.current){setPhase('error');setError(reason)}
      },
      onStart: () => { if(cancelledRef.current || !mountedRef.current || activeSpeechSessionRef.current!==speechSession)return;recordSpeechEvent('recognition_start');startedRef.current=true;if(startWatchdogRef.current!==null)window.clearTimeout(startWatchdogRef.current);startWatchdogRef.current=null;listenWatchdogRef.current=window.setTimeout(()=>{if(activeSpeechSessionRef.current!==speechSession)return;recognitionErrorCodeRef.current='listening-timeout';recordSpeechEvent('listening_timeout');setError('Listening timed out without a completed transcript. iPhone may expose the API without returning speech. Retry, use keyboard dictation, or type.');setPhase('error');clearSpeechTimers();cancelledRef.current=true;speechSession.cancel();activeSpeechSessionRef.current=null;lifecycleRef.current?.cancel();lifecycleRef.current?.dispose();lifecycleRef.current=null;recognitionRef.current=null},45000);setPhase('listening') },
      onAudioStart: () => { if(activeSpeechSessionRef.current!==speechSession||!speechSession.isActive())return;recordSpeechEvent('audio_start');if (!finalReceivedRef.current && mountedRef.current) setPhase('listening') },
      onAudioEnd: () => {if(activeSpeechSessionRef.current===speechSession)recordSpeechEvent('audio_end')},
      onSpeechStart: () => {if(activeSpeechSessionRef.current!==speechSession||!speechSession.isActive())return;recordSpeechEvent('speech_start');if(mountedRef.current)setPhase('listening')},
      onSpeechEnd: () => {if(activeSpeechSessionRef.current===speechSession)recordSpeechEvent('speech_end')},
      onNoMatch: () => {if(activeSpeechSessionRef.current===speechSession)recordSpeechEvent('no_match')},
      onEnd: ({ cancelled, started, hasResult }) => {
        if (activeSpeechSessionRef.current !== speechSession) return
        recordSpeechEvent('recognition_end',hasResult?'final-result-present':'no-final-result')
        clearSpeechTimers()
        recognitionRef.current = null
        lifecycleRef.current = null
        if(!mountedRef.current)return
        if (cancelled || cancelledRef.current) { speechSession.cancel();activeSpeechSessionRef.current=null;if(recognitionErrorRef.current){setPhase('error');setError(recognitionErrorRef.current)}else setPhase('cancelled');return }
        const transcript=speechSession.complete()
        activeSpeechSessionRef.current = null
        if(transcript){setPhase('transcript_received');finalizeCompletedTranscript(transcript);return}
        if(speechSession.isCompleted())return
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
      startWatchdogRef.current=window.setTimeout(()=>{if(activeSpeechSessionRef.current!==speechSession)return;recognitionErrorCodeRef.current='start-timeout';recognitionErrorRef.current='The browser did not report recognition start within 10 seconds.';recordSpeechEvent('start_timeout');setError(`${recognitionErrorRef.current} Check Safari permission or use keyboard dictation.`);setPhase('error');clearSpeechTimers();cancelledRef.current=true;speechSession.cancel();activeSpeechSessionRef.current=null;lifecycleRef.current?.cancel();lifecycleRef.current?.dispose();lifecycleRef.current=null;recognitionRef.current=null},10000)
      lifecycle.start()
    } catch (cause) {
      recognitionErrorCodeRef.current='start-exception';recordSpeechEvent('start_threw');clearSpeechTimers();activeSpeechSessionRef.current?.cancel();activeSpeechSessionRef.current=null;lifecycleRef.current?.cancel(); lifecycleRef.current = null; recognitionRef.current = null; setPhase('error')
      setError(cause instanceof Error ? `${cause.message} Check microphone permission, retry, or use iPhone keyboard dictation.` : 'Speech recognition could not start. Check microphone permission or use iPhone keyboard dictation.')
    }
  }

  const cancelListening = () => { recordSpeechEvent('cancelled_by_user');cancelledRef.current = true;recognitionErrorRef.current='';recognitionErrorCodeRef.current='';clearSpeechTimers();activeSpeechSessionRef.current?.cancel();activeSpeechSessionRef.current=null;lifecycleRef.current?.cancel();lifecycleRef.current?.dispose(); lifecycleRef.current = null; recognitionRef.current = null; setError(''); setPhase('cancelled') }
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

  const confirmFinancial = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (analysis?.kind !== 'financial' || confirmingRef.current) return
    confirmingRef.current = true; setPhase('processing'); setError('')
    try {
      await verifyVoiceCommandSession(authenticated, verifySession)
      const amountCents = dollarsToCents(financialAmount)
      const expectedRecord = analysis.matches.find((entry) => entry.id === selectedFinancialRecordId) ?? analysis.sales.find((entry)=>entry.id===selectedFinancialRecordId)
      if (expectedRecord) {
        const current = 'type' in expectedRecord ? (latestRef.current.data.ledgerTransactions ?? []).find((entry) => entry.id === expectedRecord.id) : latestRef.current.data.sales.find((entry)=>entry.id===expectedRecord.id)
        if (!current || JSON.stringify(current) !== JSON.stringify(expectedRecord)) throw new Error('This transaction changed while the proposal was open. No change was made. Interpret the command again to review the latest record.')
      }
      await onConfirmFinancial(analysis.command, selectedFinancialRecordId || undefined, amountCents, expectedRecord, financialReceived)
    } catch (cause) { setPhase('result'); setError(cause instanceof Error ? cause.message : 'The financial change was not saved. Review the proposal and retry.') }
    finally { confirmingRef.current = false }
  }

  const lotName = resolvedItem ? data.lots.find((lot) => lot.id === resolvedItem.lotId)?.name ?? 'Standalone acquisition' : ''
  const previewValues = command && resolvedItem ? voiceSaleInitial(command, resolvedItem) : undefined
  const closeDialog = () => { recordSpeechEvent('modal_closed');cancelledRef.current = true; clearSpeechTimers();activeSpeechSessionRef.current?.cancel();activeSpeechSessionRef.current=null;lifecycleRef.current?.cancel();lifecycleRef.current?.dispose(); lifecycleRef.current = null; recognitionRef.current = null; onCloseRef.current() }
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
      <label className="voice-command-label">Command<textarea value={text} disabled={phase==='starting'||phase==='listening'||busy} onChange={(event) => { interpretationRef.current++;commandIdRef.current='';setText(event.currentTarget.value);setInterimTranscript('');setFinalTranscript('');setAttempt((value) => value + 1);setAnalysis(null);setSelectedItemId('');setSelectedFinancialRecordId('');setFinancialAmount('');setError('');setPhase('ready') }} rows={2} placeholder="Sold VI Music for ten dollars on Vinted."/><small>The command stays in this field. On iPhone, use the keyboard microphone to dictate here whenever Speak command is unavailable.</small></label>
      {(interimTranscript || finalTranscript) && <div className="speech-transcript-status" aria-live="polite">{interimTranscript&&<div><span>Interim transcript</span><b>{interimTranscript}</b></div>}{finalTranscript&&<div><span>Final transcript</span><b>{finalTranscript}</b></div>}</div>}
      <details className="speech-diagnostics" open={diagnosticsOpen} onToggle={(event)=>setDiagnosticsOpen(event.currentTarget.open)}>
        <summary>Speech diagnostics</summary>
        <div className="speech-diagnostic-grid"><div><span>Browser API</span><b>{speechAvailable?`${speechApiName} exposed`:'Not exposed'}</b><small>API exposure does not guarantee an iOS speech service will return text.</small></div><div><span>App display</span><b>{standalone?'Home Screen / standalone':'Browser tab'}</b></div><div><span>Current state</span><b>{phaseLabel}</b></div><div><span>Automatic interpretation</span><b>{interpretationAttempts ? `Attempted ${interpretationAttempts} time${interpretationAttempts===1?'':'s'}` : 'Not attempted'}</b></div><div><span>Last error code</span><b>{recognitionErrorCodeRef.current||'None'}</b></div></div>
        {speechEvents.length>0&&<ul className="speech-diagnostic-events" aria-label="Recent browser speech events">{speechEvents.slice(-12).map((event,index)=><li key={`${event.at}-${event.event}-${index}`}><span>+{(event.at/1000).toFixed(1)}s</span><b>{event.event}</b>{event.code&&<em>{event.code}</em>}</li>)}</ul>}
        <div className="speech-diagnostic-actions"><button type="button" className="secondary" onClick={()=>void copyDiagnostics()}>Copy diagnostics</button><small>{diagnosticsCopied||'Copied report omits transcript, inventory, account details, and tokens. Nothing is transmitted.'}</small></div>
      </details>
      <div className="voice-interpret-actions"><button className="secondary" disabled={busy || phase === 'starting' || phase === 'listening' || !text.trim() || Boolean(analysis)} onClick={() => void interpretTranscript(text)}>{phase === 'processing' || phase === 'interpreting' ? <><LoaderCircle size={16} className="spin"/> Interpreting command…</> : <><Search size={16}/> Interpret command</>}</button><span>{phase === 'error' ? 'Action needed' : phase === 'starting' ? 'Starting recognition' : phase === 'listening' ? 'Listening' : phase === 'transcript_received' ? 'Transcript received' : phase === 'interpreting' || phase === 'processing' ? 'Checking inventory' : analysis?'Review the proposal below':phase==='cancelled'?'Listening cancelled':'Ready'}</span></div>
      {error&&<div className="voice-error" role="alert">{error}</div>}
      {analysis?.kind === 'read_only'&&<section className="voice-result"><h3>Inventory result</h3><p>{analysis.response}</p>{choices.length>0&&<VoiceItemChoices items={choices} data={data} selectedId={selectedItemId} openOnly onChoose={(item)=>onOpenLot(item.lotId??'__standalone__')}/>}</section>}
      {analysis?.kind === 'unsupported'&&<div className="voice-error" role="status">{analysis.message}</div>}
      {analysis?.kind === 'open_lot'&&<section className="voice-result"><h3>Purchase lot</h3><p>{analysis.message}</p><button className="primary" onClick={()=>onOpenLot(analysis.lotId)}>Open {analysis.lotName}</button></section>}
      {analysis?.kind === 'financial'&&<FinancialVoiceProposal analysis={analysis} amount={financialAmount} setAmount={setFinancialAmount} selectedRecordId={selectedFinancialRecordId} setSelectedRecordId={(id)=>{setSelectedFinancialRecordId(id);const amount=currentFinancialAmount(analysis,id||undefined);setFinancialAmount(amount===undefined?'':(amount/100).toFixed(2))}} received={financialReceived} setReceived={setFinancialReceived} onSubmit={confirmFinancial} busy={busy} data={data}/>}
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

function FinancialVoiceProposal({analysis,amount,setAmount,selectedRecordId,setSelectedRecordId,received,setReceived,onSubmit,busy,data}:{analysis:FinancialCommandAnalysis;amount:string;setAmount:(value:string)=>void;selectedRecordId:string;setSelectedRecordId:(id:string)=>void;received:boolean;setReceived:(value:boolean)=>void;onSubmit:(event:React.FormEvent<HTMLFormElement>)=>void;busy:boolean;data:TrackerData}){
  const {command,matches}=analysis
  const match=matches.find((entry)=>entry.id===selectedRecordId)??(matches.length===1?matches[0]:undefined)
  const sale=analysis.sales.find((entry)=>entry.id===selectedRecordId)??(analysis.sales.length===1?analysis.sales[0]:undefined)
  const lot=data.lots.find((entry)=>entry.id===(command.lotId??match?.lotId))
  const amountCents=/^\d+(?:\.\d{0,2})?$/.test(amount)?Math.floor(Number(amount.split('.')[0])*100+Number((amount.split('.')[1]??'').padEnd(2,'0'))):undefined
  const currentAmount=match?(match.paymentStatus==='confirmed'?match.receivedCents:match.expectedCents||match.grossCents):sale?command.expenseField==='feeCents'?sale.feeCents:command.expenseField==='shippingCents'?sale.shippingCents:sale.otherExpenseCents:command.action==='update_lot_expenses'?lot?.expensesCents:undefined
  const title:Record<FinancialCommand['action'],string>={update_payout_amount:'Update existing payout amount',mark_payout_received:'Confirm payout received',record_payout_received:'Record payout received',issue_store_credit:'Record store credit',record_cash_expense:'Record cash expense',update_lot_expenses:'Correct purchase expenses',update_sale_expense:'Correct sale expense'}
  let effect=''
  if(amountCents!==undefined){
    if(command.action==='issue_store_credit')effect=`Store credit increases by ${formatMoney(amountCents)}. Cash received does not change.`
    else if(command.action==='record_cash_expense')effect=`Cash position decreases by ${formatMoney(amountCents)}.`
    else if(command.action==='update_lot_expenses')effect=`Acquisition spending changes by ${formatMoney(amountCents-(lot?.expensesCents??0))}; no sale proceeds are created.`
    else if(command.action==='update_sale_expense')effect=`Sale expense changes by ${formatMoney(amountCents-(currentAmount??0))}. Confirmed net cash and profit recalculate through the existing sale record.`
    else if(received){const expected=match?.paymentStatus==='pending'?match.expectedCents:0;effect=`Confirmed cash increases by ${formatMoney(amountCents)}; pending proceeds decrease by ${formatMoney(expected)}.`}
    else effect=`Pending amount changes by ${formatMoney(amountCents-(currentAmount??0))}. No cash is counted as received.`
  }
  const hasUnresolvedAmount=Boolean(command.amountChoicesCents?.length)&&!amount
  const cannotUpdateMissing=(command.action==='update_payout_amount'&&matches.length===0)||(command.action==='update_sale_expense'&&analysis.sales.length===0)
  const recordCount=matches.length+analysis.sales.length
  return <section className="voice-result financial-voice-proposal"><h3>{title[command.action]} · not saved</h3><p>Review the matching record and exact amount. Nothing changes until you confirm.</p>
    {recordCount>1&&<fieldset className="financial-match-list"><legend>Select the exact existing record</legend>{matches.map((entry)=><label key={entry.id}><input type="radio" name="financial-match" checked={selectedRecordId===entry.id} onChange={()=>setSelectedRecordId(entry.id)}/><span><b>{entry.platform} · {data.lots.find((candidate)=>candidate.id===entry.lotId)?.name??'Unassigned lot'}</b><small>{entry.type.replaceAll('_',' ')} · {entry.paymentStatus} · current {formatMoney(entry.paymentStatus==='confirmed'?entry.receivedCents:entry.expectedCents||entry.grossCents)}</small></span></label>)}{analysis.sales.map((entry)=><label key={entry.id}><input type="radio" name="financial-match" checked={selectedRecordId===entry.id} onChange={()=>setSelectedRecordId(entry.id)}/><span><b>{entry.platform} · {entry.itemIds.map((id)=>data.items.find((item)=>item.id===id)?.title??'Item').join(', ')}</b><small>Sale · {entry.paymentStatus} · current {formatMoney(command.expenseField==='feeCents'?entry.feeCents:command.expenseField==='shippingCents'?entry.shippingCents:entry.otherExpenseCents)}</small></span></label>)}</fieldset>}
    <div className="voice-proposal"><div><span>Merchant / platform</span><b>{command.merchant??match?.platform??sale?.platform??'Not specified'}</b></div><div><span>Purchase lot</span><b>{lot?.name??(sale?'Associated item lot':'Not identified')}</b></div><div><span>Existing record</span><b>{match?`${match.type.replaceAll('_',' ')} · ${match.paymentStatus}`:sale?`Sale · ${sale.paymentStatus}`:recordCount?'Choose one above':cannotUpdateMissing?'No matching record':'New record · not yet saved'}</b></div>{currentAmount!==undefined&&<div><span>Current amount</span><b>{formatMoney(currentAmount)}{match?.paymentStatus==='confirmed'?' · received':sale?' · currently recorded':' · pending'}</b></div>}<div><span>Proposed amount</span><b>{amountCents===undefined?'Choose or enter an amount':formatMoney(amountCents)}</b></div></div>
    {command.amountChoicesCents?.length&&<fieldset className="financial-amount-choices"><legend>The spoken digits may mean either amount</legend>{command.amountChoicesCents.map((choice)=><label key={choice}><input type="radio" name="financial-amount-choice" checked={amount===(choice/100).toFixed(2)} onChange={()=>setAmount((choice/100).toFixed(2))}/>{formatMoney(choice)}</label>)}</fieldset>}
    <form className="financial-confirm-form" onSubmit={onSubmit}><label>Amount<input inputMode="decimal" type="number" min="0" step="0.01" value={amount} onChange={(event)=>setAmount(event.currentTarget.value)} required/></label>
      {(command.action==='mark_payout_received'||command.action==='update_payout_amount')&&<fieldset><legend>Payment status</legend><label><input type="radio" name="voice-payout-status" checked={!received} onChange={()=>setReceived(false)}/> Still pending · not cash</label><label><input type="radio" name="voice-payout-status" checked={received} onChange={()=>setReceived(true)}/> I received the payment</label></fieldset>}
      {effect&&<div className="financial-effect"><b>Financial effect</b><span>{effect}</span></div>}
      {analysis.message&&<p className="voice-error" role="status">{analysis.message}</p>}
      <div className="voice-sale-actions"><button type="button" className="secondary" onClick={()=>{setAmount('');setSelectedRecordId('')}}>Cancel proposal</button><button className="primary" type="submit" disabled={busy||amountCents===undefined||hasUnresolvedAmount||cannotUpdateMissing||Boolean(recordCount>1&&!selectedRecordId)}>{busy?'Checking sign-in…':'Confirm financial update'}</button></div>
    </form>
  </section>
}

function VoiceItemChoices({items,data,selectedId,onChoose,openOnly=false}:{items:InventoryItem[];data:TrackerData;selectedId:string;onChoose:(item:InventoryItem)=>void;openOnly?:boolean}){
  return <div className="voice-item-choices">{items.map((item)=>{const lot=data.lots.find((entry)=>entry.id===item.lotId);const available=ACTIVE_STATUSES.includes(item.status)&&item.quantity>0;return <button type="button" key={item.id} className={`voice-item-choice ${selectedId===item.id?'selected':''}`} disabled={!available&&!openOnly} onClick={()=>onChoose(item)}><span><b>{item.title}</b><small>{lot?.name??'Standalone'} · {item.quantity} available · {item.platform||'No platform set'}{!available?' · unavailable':''} {openOnly?'· Open lot':''}</small></span><strong>{formatMoney(item.costCents)}</strong></button>})}</div>
}
