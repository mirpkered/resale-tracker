import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Mic, Search, Square, X } from 'lucide-react'
import type { InventoryItem, LedgerTransaction, Sale, TrackerData } from '../domain'
import { ACTIVE_STATUSES, dollarsToCents, formatMoney, PLATFORMS } from '../domain'
import { QuickSaleFields } from './QuickSaleFields'
import type { QuickSaleInitial } from '../quickSaleForm'
import { voiceSaleInitial } from '../quickSaleForm'
import { canProcessVoiceCommand, interpretVoiceTranscript, searchAvailableInventory, verifyVoiceCommandSession, type VoiceAnalysis, type VoiceSaleTarget } from '../voiceCommand'
import type { QuickSaleInput } from '../quickSale'
import { remainingAcquisitionCost } from '../lotView'
import { browserSpeechRecognitionAvailable, createSpeechAttempt, type SpeechWindow } from '../speechRecognition'
import { beginSpeechDiagnosticAttempt, formatSpeechDiagnosticReport, getSpeechDiagnosticEvents, recordSpeechDiagnosticEvent, type SpeechDiagnosticEvent } from '../speechDiagnostics'
import { currentFinancialAmount, type FinancialCommandAnalysis, type FinancialCommand } from '../financialVoiceCommand'
import { localDateInputValue } from '../localDate'

function speechFailureMessage(code:string,audioStarted:boolean,recognitionStarted:boolean):string {
  if(code==='not-allowed'||code==='service-not-allowed')return 'iPhone denied or could not start its speech-recognition service. Check Microphone and Speech Recognition access for Safari/the installed web app, and make sure Siri is enabled in iPhone Settings. Retry, or use the keyboard microphone in Command.'
  if(code==='no-speech')return 'The speech service reported that it detected no speech. This can happen even when the microphone indicator appears. Retry after the listening indicator shows, or use keyboard dictation.'
  if(code==='audio-capture')return 'The browser could not access microphone audio. Check the site’s microphone permission and iPhone privacy settings, then retry or use keyboard dictation.'
  if(code==='network')return 'The browser speech service could not connect. Resale Tracker does not upload audio. Check connectivity and retry, or use keyboard dictation or typing.'
  if(code==='language-not-supported')return 'The browser speech service does not support English recognition in this session. Use keyboard dictation or type the command.'
  if(code==='start-timeout')return 'The speech service did not report that it started. The attempt was cleaned up; you can retry or use keyboard dictation.'
  if(code==='listening-timeout')return 'The speech service returned no transcript before the listening limit. The attempt was cleaned up; retry or use keyboard dictation.'
  if(code==='stop-timeout')return 'The speech service did not finish after Stop listening. Any transcript received was kept; otherwise no command was interpreted. Retry or use keyboard dictation.'
  if(code==='stop-exception')return 'This browser could not finish recognition gracefully. The recording was cancelled safely; retry or use the iPhone keyboard microphone.'
  if(code==='no-final-transcript')return audioStarted?'The browser started and reported audio capture, but returned no recognized text. The microphone indicator does not prove usable audio reached the speech service. Retry; if this repeats, use the iPhone keyboard microphone in Command or type.':'The speech service ended without returning recognized text. Retry or use the iPhone keyboard microphone in Command.'
  if(code==='start-exception')return 'The browser could not start speech recognition. Check permissions and retry, or use keyboard dictation.'
  return recognitionStarted?'Speech recognition ended without a usable transcript. No command was interpreted. Retry or use keyboard dictation or typing.':'The speech service ended before reporting that it started. Retry or use keyboard dictation or typing.'
}
export function VoiceCommandDialog({ data, authenticated, verifySession, onClose, onConfirmSale, onConfirmFinancial, onOpenLot }: {
  data: TrackerData
  authenticated: boolean
  verifySession: () => Promise<void>
  onClose: () => void
  onConfirmSale: (selections: {itemId:string;quantity:number}[], input: QuickSaleInput) => Promise<void>
  onConfirmFinancial: (command: FinancialCommand, recordId: string | undefined, amountCents: number, expectedRecord: LedgerTransaction | Sale | undefined, markReceived: boolean) => Promise<void>
  onOpenLot: (lotId: string) => void
}) {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<'ready' | 'starting' | 'listening' | 'stopping' | 'cancelling' | 'transcript_received' | 'interpreting' | 'processing' | 'result' | 'cancelled' | 'error'>('ready')
  const [analysis, setAnalysis] = useState<VoiceAnalysis | null>(null)
  const [selectedItemId, setSelectedItemId] = useState('')
  const [selectedBundleItemIds, setSelectedBundleItemIds] = useState<Record<number,string>>({})
  const [editableBundleTargets, setEditableBundleTargets] = useState<VoiceSaleTarget[]>([])
  const [bundleSearches, setBundleSearches] = useState<Record<number,string>>({})
  const [bundleQuantities, setBundleQuantities] = useState<Record<number,number>>({})
  const [bundleDetailsValid, setBundleDetailsValid] = useState(false)
  const [error, setError] = useState('')
  const [interimTranscript, setInterimTranscript] = useState('')
  const [finalTranscript, setFinalTranscript] = useState('')
  const [speechEvents, setSpeechEvents] = useState<SpeechDiagnosticEvent[]>(()=>getSpeechDiagnosticEvents())
  const [listeningMessage, setListeningMessage] = useState('')
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [diagnosticsCopied, setDiagnosticsCopied] = useState('')
  const [interpretationAttempts, setInterpretationAttempts] = useState(0)
  const [financialAmount, setFinancialAmount] = useState('')
  const [selectedFinancialRecordId, setSelectedFinancialRecordId] = useState('')
  const [financialReceived, setFinancialReceived] = useState(false)
  const recognitionErrorCodeRef = useRef('')
  const [attempt, setAttempt] = useState(0)
  const [detailsOpen, setDetailsOpen] = useState(true)
  const speechAttemptRef = useRef<ReturnType<typeof createSpeechAttempt> | null>(null)
  const diagnosticAttemptRef = useRef<ReturnType<typeof beginSpeechDiagnosticAttempt> | null>(null)
  const mountedRef = useRef(false)
  const interruptedRef = useRef('')
  const finalTranscriptSeenRef = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const latestRef = useRef({ data, authenticated, verifySession })
  latestRef.current = { data, authenticated, verifySession }
  const confirmingRef = useRef(false)
  const commandIdRef = useRef('')
  const interpretationRef = useRef(0)
  const formRef = useRef<HTMLFormElement>(null)
  const recordSpeechEvent = (event: string, code?: string, attemptInfo=diagnosticAttemptRef.current) => {
    if(!attemptInfo)return
    const events=recordSpeechDiagnosticEvent(attemptInfo.attempt,attemptInfo.sessionId,attemptInfo.startedAt,event,code)
    if(mountedRef.current)setSpeechEvents(events)
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
    if (analysis?.kind === 'sale') return analysis.matched ?? analysis.targets[0]?.matches.find((item) => item.id === (selectedBundleItemIds[0]||selectedItemId)) ?? choices.find((item) => item.id === selectedItemId) ?? null
    if (analysis?.kind === 'unmatched') return choices.find((item) => item.id === selectedItemId) ?? null
    return null
  }, [analysis, choices, selectedItemId, selectedBundleItemIds])
  const initial: QuickSaleInitial | undefined = command && resolvedItem ? voiceSaleInitial(command, resolvedItem) : undefined
  const saleTargets = analysis?.kind === 'sale' ? editableBundleTargets : []
  const bundleProposal = Boolean(command && (/\bbundle\b|\btogether\b/i.test(command.sourceText) || saleTargets.length > 1))
  const selectedBundleItems = saleTargets.map((target,index) => {
    const id = selectedBundleItemIds[index] || target.matched?.id || ''
    const item=data.items.find((candidate)=>candidate.id===id)
    const tracked=(data.units??[]).filter((unit)=>unit.itemId===id)
    const sold=new Set(data.sales.flatMap((sale)=>(sale.lines??[]).flatMap((line)=>(line.unitIds??[]).slice(line.returnedQuantity??0))))
    const available=item&&!item.archived&&ACTIVE_STATUSES.includes(item.status)?(tracked.length?tracked.filter((unit)=>ACTIVE_STATUSES.includes(unit.status)&&!sold.has(unit.id)).length:item.quantity):0
    return { target: {...target,quantity:bundleQuantities[index]??target.quantity}, item: item&&available>=(bundleQuantities[index]??target.quantity)?item:null }
  })
  const bundleSelections = selectedBundleItems.filter((entry):entry is {target:VoiceSaleTarget;item:InventoryItem}=>Boolean(entry.item)).map(({target,item})=>({itemId:item.id,quantity:target.quantity}))
  const selectionCounts = new Map<string,number>()
  for(const selection of bundleSelections)selectionCounts.set(selection.itemId,(selectionCounts.get(selection.itemId)??0)+selection.quantity)
  const bundleSelectionValid = bundleProposal&&selectedBundleItems.length>0&&selectedBundleItems.every((entry)=>Boolean(entry.item))&&[...selectionCounts].every(([id,quantity])=>{
    const item=data.items.find((candidate)=>candidate.id===id)
    if(!item||item.archived||!ACTIVE_STATUSES.includes(item.status)||item.quantity<quantity)return false
    const tracked=(data.units??[]).filter((unit)=>unit.itemId===id)
    if(!tracked.length)return true
    const alreadySold=new Set(data.sales.flatMap((sale)=>(sale.lines??[]).flatMap((line)=>(line.unitIds??[]).slice(line.returnedQuantity??0))))
    return tracked.filter((unit)=>ACTIVE_STATUSES.includes(unit.status)&&!alreadySold.has(unit.id)).length>=quantity
  })

  useEffect(() => {
    if (analysis?.kind !== 'sale' || !bundleProposal) { setBundleDetailsValid(false); return }
    const frame = window.requestAnimationFrame(() => setBundleDetailsValid(Boolean(formRef.current?.checkValidity())))
    return () => window.cancelAnimationFrame(frame)
  }, [analysis, selectedBundleItemIds, editableBundleTargets, bundleProposal])

  useEffect(() => {
    mountedRef.current = true
    setSpeechEvents(getSpeechDiagnosticEvents())
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    const interrupt=()=>{const current=speechAttemptRef.current;if(current?.isActive()){interruptedRef.current='app-backgrounded';current.cancel('app-backgrounded')}}
    const onVisibility=()=>{if(document.visibilityState==='hidden')interrupt()}
    const onPageShow=()=>{if(document.visibilityState==='visible'&&interruptedRef.current==='app-backgrounded'){recordSpeechEvent('app_resumed');setPhase('cancelled');setError('Speech was interrupted when the app went to the background. Tap Speak to start a fresh attempt, use the iPhone keyboard microphone, or type.') }}
    function close() { recordSpeechEvent('dialog_closed');speechAttemptRef.current?.cancel('dialog-closed');onCloseRef.current() }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    document.addEventListener('visibilitychange',onVisibility)
    window.addEventListener('pagehide',interrupt)
    window.addEventListener('pageshow',onPageShow)
    return () => { mountedRef.current = false;window.removeEventListener('keydown', onKey);document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('pagehide',interrupt);window.removeEventListener('pageshow',onPageShow);speechAttemptRef.current?.cancel('dialog-unmounted');speechAttemptRef.current=null;document.body.style.overflow = previousOverflow }
  }, [])

  const interpretTranscript = async (value: string) => {
    const commandText = value.trim()
    if (!commandText) { setError('No transcript was received. Try Speak again, use the iPhone keyboard microphone, or type a command.'); setPhase('error'); return }
    const current = latestRef.current
    if (!canProcessVoiceCommand(current.authenticated)) { setError('Your private session expired. Sign in again; no sale was recorded.'); setPhase('error'); return }
    const requestId = ++interpretationRef.current
    const commandId = commandIdRef.current || (commandIdRef.current = `voice-${crypto.randomUUID()}`)
    setBundleDetailsValid(false);setPhase('interpreting'); setError('')
    try {
      const result = await interpretVoiceTranscript(commandText, current.data, current.authenticated, current.verifySession, commandId)
      if (requestId !== interpretationRef.current) return
      setAnalysis(result); setSelectedItemId(result.kind === 'sale' && result.matched ? result.matched.id : '')
      setSelectedBundleItemIds(result.kind==='sale'?Object.fromEntries(result.targets.map((target,index)=>[index,target.matched?.id??''])):{})
      setEditableBundleTargets(result.kind==='sale'?result.targets:[]);setBundleSearches({});setBundleQuantities({})
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

  function finalizeCompletedTranscript(transcript: string) {
    const value = transcript.trim()
    if (!value) return
    setFinalTranscript(value);setInterimTranscript('');setText(value)
    setAttempt((previous) => previous + 1);setAnalysis(null);setSelectedItemId('');setSelectedBundleItemIds({})
    commandIdRef.current = 'voice-' + crypto.randomUUID()
    recordSpeechEvent('automatic_interpretation_attempted');setInterpretationAttempts((previous) => previous + 1)
    void interpretTranscript(value)
  }

  const startListening = () => {
    const previousRegistered = Boolean(speechAttemptRef.current)
    if (speechAttemptRef.current?.isActive()) {
      recordSpeechEvent('new_attempt_blocked_previous_active')
      return
    }
    if (speechAttemptRef.current) {
      speechAttemptRef.current = null
      recordSpeechEvent('stale_recognizer_reference_cleared')
    }
    const diagnostic = beginSpeechDiagnosticAttempt(previousRegistered)
    diagnosticAttemptRef.current = diagnostic
    setSpeechEvents(getSpeechDiagnosticEvents())
    setDiagnosticsCopied('')
    setListeningMessage('')
    interruptedRef.current = ''
    interpretationRef.current++
    setError('');recognitionErrorCodeRef.current='';commandIdRef.current=''
    setAnalysis(null);setSelectedItemId('');setSelectedBundleItemIds({})
    setInterimTranscript('');setFinalTranscript('')

    if (!canProcessVoiceCommand(authenticated)) {
      recognitionErrorCodeRef.current='session-unavailable'
      recordSpeechEvent('session_check_failed','application')
      setPhase('error')
      setError('Your private session is unavailable. Sign in again before using inventory commands.')
      return
    }

    const speechWindow = window as SpeechWindow
    const SpeechRecognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
    if (!SpeechRecognition) {
      recognitionErrorCodeRef.current='api-unavailable'
      recordSpeechEvent('recognition_api_unavailable','application')
      setPhase('error')
      setError('This browser does not expose speech transcription. Use the iPhone keyboard microphone in the Command field if available, or type.')
      return
    }

    try {
      const standalone=window.matchMedia?.('(display-mode: standalone)').matches===true||(navigator as Navigator&{standalone?:boolean}).standalone===true
      recordSpeechEvent('recognition_api_available',(speechWindow.SpeechRecognition?'SpeechRecognition':'webkitSpeechRecognition')+';standalone='+(standalone?'yes':'no'))
      const recognition = new SpeechRecognition()
      recognition.lang='en-US';recognition.continuous=false;recognition.interimResults=true
      const ownedAttempt = createSpeechAttempt(recognition, {
        onState: (next) => {
          if(!mountedRef.current || speechAttemptRef.current!==ownedAttempt)return
          setPhase(next)
          if(next==='starting')setListeningMessage('Starting the browser speech service…')
          else if(next==='listening')setListeningMessage('Recognition started. Waiting for the browser to report audio and recognized words.')
          else if(next==='stopping')setListeningMessage('Stop requested. The browser is finishing recognition for speech already captured.')
          else if(next==='cancelling')setListeningMessage('Cancelling recording. This attempt will not be interpreted.')
        },
        onEvent: (event, code) => {
          if(speechAttemptRef.current===ownedAttempt&&(event==='browser_error'||event==='application_timeout'||event==='start_threw'||event==='stop_threw'))recognitionErrorCodeRef.current=code??event
          if(mountedRef.current&&speechAttemptRef.current===ownedAttempt&&event==='audio_start')setListeningMessage('The browser reports audio capture. This does not confirm that its speech service is returning words.')
          if(mountedRef.current&&speechAttemptRef.current===ownedAttempt&&event==='speech_start')setListeningMessage('The browser reports speech activity. Waiting for recognized words.')
          recordSpeechEvent(event,code,diagnostic)
        },
        onTranscript: ({finalTranscript,interimTranscript}) => {
          if(!mountedRef.current || speechAttemptRef.current!==ownedAttempt)return
          setFinalTranscript(finalTranscript);setInterimTranscript(interimTranscript)
          const visible=[finalTranscript,interimTranscript].filter(Boolean).join(' ').trim()
          if(visible)setText(visible)
          if(finalTranscript){finalTranscriptSeenRef.current=true;setPhase('transcript_received')}
          else if(interimTranscript)recordSpeechEvent('interim_transcript_displayed')
        },
        onNoTranscript: () => {
          if(!mountedRef.current || speechAttemptRef.current!==ownedAttempt)return
          setListeningMessage('No recognized words have arrived yet. You can keep listening, stop so the browser can finish, or cancel this recording.')
        },
        onComplete: (result) => {
          if(speechAttemptRef.current===ownedAttempt)speechAttemptRef.current=null
          if(!mountedRef.current)return
          setListeningMessage('')
          if(result.cancelled){
            if(interruptedRef.current){
              const reason=interruptedRef.current
              interruptedRef.current=''
              recordSpeechEvent('attempt_cancelled',reason)
              setPhase('cancelled')
              setError('Speech was interrupted because the app '+(reason==='app-backgrounded'?'went to the background':'closed')+'. No command was interpreted. Tap Speak to start fresh, use the iPhone keyboard microphone, or type.')
            }else{
              setPhase('cancelled')
              setError('Recording cancelled. No command was interpreted. Retry, use the iPhone keyboard microphone, or type.')
            }
            return
          }
          if(result.transcript){
            finalTranscriptSeenRef.current=true
            setFinalTranscript(result.transcript);setInterimTranscript('');setText(result.transcript)
            setPhase('transcript_received')
            finalizeCompletedTranscript(result.transcript)
            return
          }
          const failureCode=result.code??recognitionErrorCodeRef.current??'no-final-transcript'
          recognitionErrorCodeRef.current=failureCode
          recordSpeechEvent('attempt_failed',failureCode)
          setPhase('error')
          setError(speechFailureMessage(failureCode,result.audioStarted,result.recognitionStarted))
        },
      })
      speechAttemptRef.current=ownedAttempt
      ownedAttempt.start()
    } catch (cause) {
      recognitionErrorCodeRef.current='start-exception'
      recordSpeechEvent('start_threw','application')
      setPhase('error')
      setError(cause instanceof Error ? 'The browser could not start speech recognition (' + cause.message + '). Check microphone permission, retry, or use iPhone keyboard dictation.' : 'Speech recognition could not start. Check microphone permission or use iPhone keyboard dictation.')
    }
  }

  const stopListening = () => {
    const current=speechAttemptRef.current
    if(!current?.isActive())return
    setError('')
    current.stop()
  }

  const cancelListening = () => {
    const current=speechAttemptRef.current
    if(!current?.isActive())return
    interruptedRef.current=''
    recognitionErrorCodeRef.current=''
    setError('')
    current.cancel('user')
  }
  const chooseItem = (item: InventoryItem) => {
    setSelectedItemId(item.id)
    setSelectedBundleItemIds((previous)=>({...previous,0:item.id}))
    setDetailsOpen(true)
    setError('')
  }

  const confirmSale = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!command || analysis?.kind!=='sale' || confirmingRef.current) return
    const multi = bundleProposal
    if ((bundleProposal ? !bundleSelectionValid : !resolvedItem)) { setError('Choose an available inventory record for every title before confirming.');return }
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
        quantity: Number(form.get('quantity')||command.quantity),
        paymentReceived: form.get('paymentReceived')==='yes',
        externalSource: 'voice-command',
        externalId: command!.commandId,
      }
      const selections=multi?bundleSelections:[{itemId:resolvedItem!.id,quantity:input.quantity??1}]
      await onConfirmSale(selections, input)
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

  const previewValues = command && resolvedItem ? voiceSaleInitial(command, resolvedItem) : undefined
  const closeDialog = () => { recordSpeechEvent('dialog_closed');speechAttemptRef.current?.cancel('dialog-closed');onCloseRef.current() }
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
  const speechBusy = phase === 'starting' || phase === 'listening' || phase === 'stopping' || phase === 'cancelling' || phase === 'transcript_received'
  const phaseLabel = phase === 'ready' ? 'Ready' : phase.replaceAll('_',' ')

  return <div className="modal-backdrop voice-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog() }} onFocusCapture={(event) => { const target = event.target; if (target instanceof HTMLElement && target.matches('input,select,textarea')) window.setTimeout(() => target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 150) }}>
    <section className="modal voice-dialog" role="dialog" aria-modal="true" aria-labelledby="voice-dialog-title" aria-describedby="voice-dialog-help">
      <header><div><span className="eyebrow">PRIVATE INVENTORY COMMAND</span><h2 id="voice-dialog-title">Voice command</h2></div><button className="icon-button" aria-label="Close voice command" onClick={closeDialog}><X size={19}/></button></header>
      <p id="voice-dialog-help" className="voice-privacy-note">Speech is processed by your browser and may use its speech service. Resale Tracker does not save raw audio or send your inventory for transcription. Typed commands stay on this device.</p>
      <div className="voice-input-actions">
        {speechAvailable && <button className={`primary voice-mic ${phase === 'listening' || phase === 'transcript_received' ? 'listening' : ''}`} disabled={busy || phase === 'stopping' || phase === 'cancelling'} onClick={phase === 'starting' ? cancelListening : phase === 'listening' || phase === 'transcript_received' ? stopListening : startListening}>{phase === 'starting' ? 'Cancel starting' : phase === 'listening' ? <><Square size={16}/> Stop listening</> : phase === 'transcript_received' ? 'Finish recognition' : phase === 'stopping' ? 'Finishing…' : phase === 'cancelling' ? 'Cancelling…' : busy ? 'Interpreting…' : <><Mic size={17}/> Speak command</>}</button>}
        {(phase === 'starting' || phase === 'listening' || phase === 'stopping' || phase === 'cancelling' || phase === 'transcript_received')&&<span className="listening-indicator" role="status"><i/>{listeningMessage|| (phase==='starting'?'Starting speech service…':phase==='listening'?'Listening for speech':phase==='stopping'?'Finishing recognition…':phase==='cancelling'?'Cancelling recording…':'Transcript received; finishing recognition…')}</span>}
        {(phase === 'listening' || phase === 'transcript_received' || phase === 'stopping')&&<button className="secondary voice-cancel" type="button" onClick={cancelListening}>Cancel recording</button>}
      </div>
      <label className="voice-command-label">Command<textarea value={text} disabled={speechBusy||busy} onChange={(event) => { interpretationRef.current++;commandIdRef.current='';setText(event.currentTarget.value);setInterimTranscript('');setFinalTranscript('');setAttempt((value) => value + 1);setAnalysis(null);setSelectedItemId('');setSelectedBundleItemIds({});setSelectedFinancialRecordId('');setFinancialAmount('');setError('');setPhase('ready') }} rows={2} placeholder="Sold VI Music for ten dollars on Vinted."/><small>The command stays in this field. On iPhone, use the keyboard microphone to dictate here whenever Speak command is unavailable.</small></label>
      {(interimTranscript || finalTranscript) && <div className="speech-transcript-status" aria-live="polite">{interimTranscript&&<div><span>Interim transcript</span><b>{interimTranscript}</b></div>}{finalTranscript&&<div><span>Final transcript</span><b>{finalTranscript}</b></div>}</div>}
      <details className="speech-diagnostics" open={diagnosticsOpen} onToggle={(event)=>setDiagnosticsOpen(event.currentTarget.open)}>
        <summary>Speech diagnostics</summary>
        <div className="speech-diagnostic-grid"><div><span>Browser API</span><b>{speechAvailable?`${speechApiName} exposed`:'Not exposed'}</b><small>API exposure does not guarantee an iOS speech service will return text.</small></div><div><span>App display</span><b>{standalone?'Home Screen / standalone':'Browser tab'}</b></div><div><span>Current state</span><b>{phaseLabel}</b></div><div><span>Automatic interpretation</span><b>{interpretationAttempts ? `Attempted ${interpretationAttempts} time${interpretationAttempts===1?'':'s'}` : 'Not attempted'}</b></div><div><span>Last error code</span><b>{recognitionErrorCodeRef.current||'None'}</b></div></div>
        {speechEvents.length>0&&<ul className="speech-diagnostic-events" aria-label="Recent browser speech events">{speechEvents.slice(-12).map((event,index)=><li key={`${event.sessionId}-${event.at}-${event.event}-${index}`}><span>{event.sessionId} +{(event.at/1000).toFixed(1)}s</span><b>{event.event}</b>{event.code&&<em>{event.code}</em>}</li>)}</ul>}
        <div className="speech-diagnostic-actions"><button type="button" className="secondary" onClick={()=>void copyDiagnostics()}>Copy diagnostics</button><small>{diagnosticsCopied||'Copied report omits transcript, inventory, account details, and tokens. Nothing is transmitted.'}</small></div>
      </details>
      <div className="voice-interpret-actions"><button className="secondary" disabled={busy || speechBusy || !text.trim() || Boolean(analysis)} onClick={() => void interpretTranscript(text)}>{phase === 'processing' || phase === 'interpreting' ? <><LoaderCircle size={16} className="spin"/> Interpreting command…</> : <><Search size={16}/> Interpret command</>}</button><span>{phase === 'error' ? 'Action needed' : phase === 'starting' ? 'Starting recognition' : phase === 'listening' ? 'Listening' : phase === 'stopping' ? 'Finishing recognition' : phase === 'cancelling' ? 'Cancelling recording' : phase === 'transcript_received' ? 'Transcript received' : phase === 'interpreting' || phase === 'processing' ? 'Checking inventory' : analysis?'Review the proposal below':phase==='cancelled'?'Listening cancelled':'Ready'}</span></div>
      {error&&<div className="voice-error" role="alert">{error}</div>}
      {analysis?.kind === 'read_only'&&<section className="voice-result"><h3>Inventory result</h3><p>{analysis.response}</p>{choices.length>0&&<VoiceItemChoices items={choices} data={data} selectedId={selectedItemId} openOnly onChoose={(item)=>onOpenLot(item.lotId??'__standalone__')}/>}</section>}
      {analysis?.kind === 'unsupported'&&<div className="voice-error" role="status">{analysis.message}</div>}
      {analysis?.kind === 'open_lot'&&<section className="voice-result"><h3>Purchase lot</h3><p>{analysis.message}</p><button className="primary" onClick={()=>onOpenLot(analysis.lotId)}>Open {analysis.lotName}</button></section>}
      {analysis?.kind === 'financial'&&<FinancialVoiceProposal analysis={analysis} amount={financialAmount} setAmount={setFinancialAmount} selectedRecordId={selectedFinancialRecordId} setSelectedRecordId={(id)=>{setSelectedFinancialRecordId(id);const amount=currentFinancialAmount(analysis,id||undefined);setFinancialAmount(amount===undefined?'':(amount/100).toFixed(2))}} received={financialReceived} setReceived={setFinancialReceived} onSubmit={confirmFinancial} busy={busy} data={data}/>}
      {analysis?.kind === 'unmatched'&&<section className="voice-result"><h3>No reliable available match</h3><p>{analysis.message}</p>{choices.length>0&&<VoiceItemChoices items={choices} data={data} selectedId={selectedItemId} onChoose={chooseItem}/>}</section>}
      {analysis?.kind === 'sale'&&<section className="voice-result"><h3>{bundleProposal?'Proposed bundle sale · not saved':'Proposed sale · not saved'}</h3>
        {bundleProposal&&<p className="bundle-total-callout">One total price applies to the complete bundle. Individual item proceeds remain unallocated unless you later provide verified item shares.</p>}
        <p className="voice-required-note">Original command: <q>{command!.sourceText}</q> · {saleTargets.length} title target{saleTargets.length===1?'':'s'} · {selectedBundleItems.filter((entry)=>entry.item).length} matched · {selectedBundleItems.filter((entry)=>!entry.item).length} unresolved</p>
        <div className="voice-sale-target-list">{saleTargets.map((target,index)=><SaleTargetPicker key={`${command!.commandId}-${index}`} target={target} index={index} data={data} selectedId={selectedBundleItemIds[index]||target.matched?.id||''} search={bundleSearches[index]??''} onSearch={(value)=>setBundleSearches((previous)=>({...previous,[index]:value}))} quantity={bundleQuantities[index]??target.quantity} onQuantity={(quantity)=>setBundleQuantities((previous)=>({...previous,[index]:quantity}))} onChange={(id)=>{setSelectedBundleItemIds((previous)=>({...previous,[index]:id}));if(index===0)setSelectedItemId(id)}} onRemove={bundleProposal?()=>{setEditableBundleTargets((previous)=>previous.filter((_entry,targetIndex)=>targetIndex!==index));setSelectedBundleItemIds((previous)=>Object.fromEntries(Object.entries(previous).filter(([key])=>Number(key)!==index).map(([key,value])=>[Number(key)>index?String(Number(key)-1):key,value])));setBundleSearches((previous)=>Object.fromEntries(Object.entries(previous).filter(([key])=>Number(key)!==index).map(([key,value])=>[Number(key)>index?String(Number(key)-1):key,value])));setBundleQuantities((previous)=>Object.fromEntries(Object.entries(previous).filter(([key])=>Number(key)!==index).map(([key,value])=>[Number(key)>index?String(Number(key)-1):key,value]))) }:undefined}/> )}</div>
        {bundleProposal&&<button type="button" className="secondary" onClick={()=>setEditableBundleTargets((previous)=>[...previous,{query:'Additional item',quantity:1,matches:[],suggestions:[],matched:null,ambiguous:true}])}>Add another item</button>}
        {!selectedBundleItems.some((entry)=>entry.item)&&bundleProposal&&<p className="voice-error" role="status">Bundle incomplete — no inventory items matched yet. Search inventory below to add or match an item.</p>}
        {!bundleProposal&&saleTargets.length===1&&resolvedItem&&<form ref={formRef} className="form-grid voice-sale-form" onSubmit={confirmSale}>
          <div className="voice-proposal full"><div><span>Marketplace</span><b>{previewValues?.platform||'Choose before confirming'}</b></div><div><span>Sale amount</span><b>{previewValues?.amountCents===null||previewValues?.amountCents===undefined?'Enter or confirm amount':formatMoney(previewValues.amountCents)}{command!.amountMode==='per_unit'?' each':''}</b></div><div><span>Quantity</span><b>{command!.quantity}</b></div></div>
          <details className="voice-edit-details full" open={detailsOpen} onToggle={(event) => setDetailsOpen((event.currentTarget as HTMLDetailsElement).open)}><summary>Edit Details</summary><QuickSaleFields key={`${resolvedItem.id}:${command!.commandId}`} data={data} item={resolvedItem} initial={initial} voiceConfirmation/></details>
          <div className="voice-sale-actions full"><button type="button" className="secondary" onClick={closeDialog}>Cancel</button><button type="submit" className="primary" disabled={phase==='processing'||!previewValues?.platform}>{phase==='processing'?'Checking sign-in…':'Confirm Sale'}</button></div>
          <small className="voice-required-note full">A spoken “sold” does not confirm payout. Select Payment has been received only if the money is in your account. No sale is saved until you tap Confirm Sale.</small>
        </form>}
        {bundleProposal&&<form ref={formRef} className="form-grid voice-sale-form" onInput={(event)=>setBundleDetailsValid(event.currentTarget.checkValidity())} onSubmit={confirmSale}>
          <BundleSaleFields key={command!.commandId} data={data} command={command!} selections={selectedBundleItems.filter((entry):entry is {target:VoiceSaleTarget;item:InventoryItem}=>Boolean(entry.item)).map((entry)=>({item:entry.item,quantity:entry.target.quantity}))}/>
          <div className="voice-sale-actions full"><button type="button" className="secondary" onClick={closeDialog}>Cancel</button><button type="submit" className="primary" disabled={phase==='processing'||!bundleSelectionValid||!bundleDetailsValid}>{phase==='processing'?'Checking sign-in…':'Confirm Sale'}</button></div>
          <small className="voice-required-note full">Confirm every title, its lot, the marketplace, shared expenses, and payment status. Unmatched, ambiguous, unavailable, or duplicate selections must be resolved first.</small>
        </form>}
      </section>}
      <footer className="voice-dialog-footer"><span>{attempt ? `Interpretation ${attempt} · no changes are saved before confirmation.` : 'Read-only queries and confirmed sales only.'}</span><button className="secondary" onClick={closeDialog}>Cancel</button></footer>
    </section>
  </div>
}

function SaleTargetPicker({target,data,index,selectedId,search,onSearch,quantity,onQuantity,onChange,onRemove}:{target:VoiceSaleTarget;data:TrackerData;index:number;selectedId:string;search:string;onSearch:(value:string)=>void;quantity:number;onQuantity:(value:number)=>void;onChange:(id:string)=>void;onRemove?:()=>void}){
  const selected=data.items.find((item)=>item.id===selectedId&&!item.archived&&ACTIVE_STATUSES.includes(item.status)&&item.quantity>0)
  const lot=selected?data.lots.find((entry)=>entry.id===selected.lotId):undefined
  const alreadySold=new Set(data.sales.flatMap((sale)=>(sale.lines??[]).flatMap((line)=>(line.unitIds??[]).slice(line.returnedQuantity??0))))
  const available=(item:InventoryItem)=>{if(item.archived||!ACTIVE_STATUSES.includes(item.status)||item.quantity<1)return 0;const units=(data.units??[]).filter((unit)=>unit.itemId===item.id);return units.length?units.filter((unit)=>ACTIVE_STATUSES.includes(unit.status)&&!alreadySold.has(unit.id)).length:item.quantity}
  const results=search.trim()?searchAvailableInventory(data,search).slice(0,20):[]
  return <article className={`voice-sale-target ${selected?'matched':'unmatched'}`}>
    <div className="voice-sale-target-heading"><span>{index+1}. Spoken title</span><b>{target.query}</b></div>
    {selected?<div className="voice-sale-target-match"><b>{selected.title}</b><span>{lot?.name??'Standalone acquisition'} · {quantity} unit{quantity===1?'':'s'} · {available(selected)} available · {selected.platform||'unlisted'}</span></div>:<div className="voice-error" role="status">No available item selected for “{target.query}”. Search every purchase lot below.</div>}
    <label>Search inventory across all lots<input type="search" value={search} onChange={(event)=>onSearch(event.currentTarget.value)} placeholder="Search title or purchase lot" aria-label={`Search inventory for ${target.query}`}/></label>
    {search.trim()&&<label>Choose the correct item<select aria-label={`Inventory match for ${target.query}`} value={selectedId} onChange={(event)=>onChange(event.currentTarget.value)}><option value="">Select an available item</option>{results.map((item)=><option key={item.id} value={item.id}>{item.title} · {data.lots.find((entry)=>entry.id===item.lotId)?.name??'Standalone'} · {available(item)} available · {item.status} · {item.platform||'unlisted'}</option>)}</select></label>}
    {selected&&<label>Quantity<input aria-label={`Quantity for ${selected.title}`} type="number" min="1" max={available(selected)} value={quantity} onChange={(event)=>onQuantity(Math.max(1,Number(event.currentTarget.value)||1))}/></label>}
    {onRemove&&<button type="button" className="secondary" onClick={onRemove}>Remove item from bundle</button>}
  </article>
}

function BundleSaleFields({data,command,selections}:{data:TrackerData;command:NonNullable<Extract<VoiceAnalysis,{kind:'sale'}>['command']>;selections:{item:InventoryItem;quantity:number}[]}){
  const quantity=selections.reduce((sum,entry)=>sum+entry.quantity,0)
  const [platform,setPlatform]=useState(command.platform??'')
  const [amountMode,setAmountMode]=useState<'total'|'per_unit'>(command.amountMode)
  const [amount,setAmount]=useState(command.amountCents===undefined?'':(command.amountCents/100).toFixed(2))
  const [fees,setFees]=useState(command.feeCents===undefined?(command.platform?.toLowerCase()==='vinted'?'0.00':''):(command.feeCents/100).toFixed(2))
  const [shipping,setShipping]=useState(command.shippingCents===undefined?(command.platform?.toLowerCase()==='vinted'?'0.00':''):(command.shippingCents/100).toFixed(2))
  const [other,setOther]=useState(command.otherExpenseCents===undefined?'0.00':(command.otherExpenseCents/100).toFixed(2))
  const [paymentReceived,setPaymentReceived]=useState(false)
  const platforms=[...new Map([...PLATFORMS,...data.platforms].filter((entry)=>entry.kind==='sales').map((entry)=>[entry.name.toLowerCase(),entry])).values()].sort((a,b)=>a.name.localeCompare(b.name))
  const gross=(()=>{try{return amount?dollarsToCents(amount)*(amountMode==='per_unit'?quantity:1):0}catch{return 0}})()
  const cost=selections.reduce((sum,{item,quantity:count})=>{const availableCost=remainingAcquisitionCost(data,item);return sum+(count===item.quantity?availableCost:Math.floor(availableCost*count/Math.max(item.quantity,1)))},0)
  const net=(()=>{try{if(!amount||!fees||!shipping||!other)return null;const value=gross-dollarsToCents(fees)-dollarsToCents(shipping)-dollarsToCents(other);return value>=0?value:null}catch{return null}})()
  return <>
    <div className="bundle-selected-items full"><b>{quantity?`Bundle contents · ${quantity} physical item${quantity===1?'':'s'}`:'Bundle incomplete'}</b>{selections.map(({item,quantity:count})=><span key={item.id}>{item.title} — {data.lots.find((lot)=>lot.id===item.lotId)?.name??'Standalone acquisition'} · {count} unit{count===1?'':'s'} · allocated cost {formatMoney(remainingAcquisitionCost(data,item))}</span>)}{quantity>0&&<small>Estimated combined cost basis {formatMoney(cost)}. Individual profit is not shown because the bundle proceeds have no verified item-level split.</small>}</div>
    <label>Sale date<input name="date" type="date" defaultValue={localDateInputValue()} required/></label>
    <label>Selling platform<select name="platform" value={platform} onChange={(event)=>{const next=event.currentTarget.value;setPlatform(next);setFees(next.toLowerCase()==='vinted'?'0.00':'');setShipping(next.toLowerCase()==='vinted'?'0.00':'')}} required><option value="">Choose marketplace</option>{platforms.map((entry)=><option key={entry.id} value={entry.name}>{entry.name}</option>)}</select><small>Choose the marketplace used for this whole bundle; item listing platforms are not assumed.</small></label>
    <label>Price entry<select value={amountMode} onChange={(event)=>setAmountMode(event.currentTarget.value as 'total'|'per_unit')}><option value="total">Total for entire bundle</option><option value="per_unit">Same price per physical item</option></select></label>
    <label>{amountMode==='total'?'Total bundle sale price':'Sale price per item'}<input inputMode="decimal" type="number" min="0" step="0.01" value={amount} onChange={(event)=>setAmount(event.currentTarget.value)} required placeholder="0.00"/><small>{amountMode==='per_unit'?`Bundle gross ${formatMoney(gross)} · ${quantity} items`:'This amount is counted once across all sale lines.'}</small></label>
    <input type="hidden" name="gross" value={(gross/100).toFixed(2)}/><input type="hidden" name="quantity" value={quantity}/>
    <label>Platform fees<input name="fees" inputMode="decimal" type="number" min="0" step="0.01" value={fees} onChange={(event)=>setFees(event.currentTarget.value)} required placeholder="Enter actual amount"/></label>
    <label>Seller-paid shipping<input name="shipping" inputMode="decimal" type="number" min="0" step="0.01" value={shipping} onChange={(event)=>setShipping(event.currentTarget.value)} required placeholder="Enter actual amount"/></label>
    <label>Other shared selling expenses<input name="other" inputMode="decimal" type="number" min="0" step="0.01" value={other} onChange={(event)=>setOther(event.currentTarget.value)} required/></label>
    <div className="quick-sale-estimate full" aria-live="polite"><b>Bundle totals · not saved yet</b><div><span>Gross sale (counted once)</span><strong>{amount?formatMoney(gross):'Enter amount'}</strong></div><div><span>Estimated net proceeds</span><strong>{net===null?'Complete expenses':formatMoney(net)}</strong></div><div><span>Item profit</span><strong>Not allocated by item</strong></div></div>
    <label className="checkbox full"><input type="checkbox" name="paymentReceived" value="yes" checked={paymentReceived} onChange={(event)=>setPaymentReceived(event.currentTarget.checked)}/><span>Payment has been received</span></label>
    <p className="quick-sale-cash-note full">Unchecked is safest for marketplace payouts that are not yet received. It records the sold items and total sale, but does not count the bundle price as cash.</p>
  </>
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
