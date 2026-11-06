import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Mic, Search, Square, X } from 'lucide-react'
import type { InventoryItem, TrackerData } from '../domain'
import { ACTIVE_STATUSES, dollarsToCents, formatMoney } from '../domain'
import { QuickSaleFields } from './QuickSaleFields'
import type { QuickSaleInitial } from '../quickSaleForm'
import { voiceSaleInitial } from '../quickSaleForm'
import { analyzeVoiceCommand, canProcessVoiceCommand, verifyVoiceCommandSession, type VoiceAnalysis } from '../voiceCommand'
import type { QuickSaleInput } from '../quickSale'
import { browserSpeechRecognitionAvailable, type SpeechRecognizer, type SpeechWindow } from '../speechRecognition'
export function VoiceCommandDialog({ data, authenticated, verifySession, onClose, onConfirmSale }: {
  data: TrackerData
  authenticated: boolean
  verifySession: () => Promise<void>
  onClose: () => void
  onConfirmSale: (itemId: string, input: QuickSaleInput) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<'ready' | 'listening' | 'processing' | 'error'>('ready')
  const [analysis, setAnalysis] = useState<VoiceAnalysis | null>(null)
  const [selectedItemId, setSelectedItemId] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [detailsOpen, setDetailsOpen] = useState(true)
  const recognitionRef = useRef<SpeechRecognizer | null>(null)
  const finalReceivedRef = useRef(false)
  const confirmingRef = useRef(false)
  const formRef = useRef<HTMLFormElement>(null)

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
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    function close() { recognitionRef.current?.abort(); recognitionRef.current = null; onClose() }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); recognitionRef.current?.abort(); recognitionRef.current = null; document.body.style.overflow = previousOverflow }
  }, [onClose])

  const startListening = async () => {
    setError(''); setAnalysis(null); setSelectedItemId(''); finalReceivedRef.current = false
    if (!canProcessVoiceCommand(authenticated)) { setPhase('error'); setError('Your private session is unavailable. Sign in again before using inventory commands.'); return }
    const SpeechRecognition = (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition
    if (!SpeechRecognition) { setPhase('error'); setError('Speech recognition is not available in this browser. Type the command below instead.'); return }
    try {
      await verifyVoiceCommandSession(authenticated, verifySession)
      const recognition = new SpeechRecognition()
      recognition.lang = 'en-US'; recognition.continuous = false; recognition.interimResults = true
      recognition.onresult = (event) => {
        let finalTranscript = ''
        for (let index = event.resultIndex; index < event.results.length; index++) {
          if (event.results[index].isFinal) finalTranscript += event.results[index][0].transcript
        }
        if (finalTranscript && !finalReceivedRef.current) {
          finalReceivedRef.current = true
          setText(finalTranscript.trim()); setAttempt((value) => value + 1); setAnalysis(null); setSelectedItemId('')
        }
      }
      recognition.onerror = (event) => {
        setPhase('error')
        const reason = event.error === 'not-allowed' || event.error === 'service-not-allowed' ? 'Microphone or browser speech permission is unavailable. Allow microphone access or type the command.' : event.error === 'no-speech' ? 'No speech was recognized. Try again or type the command.' : 'Speech recognition stopped. You can retry or type the command.'
        setError(reason)
      }
      recognition.onend = () => { recognitionRef.current = null; setPhase((current) => current === 'listening' ? 'ready' : current) }
      recognitionRef.current = recognition
      setPhase('listening')
      recognition.start()
    } catch (cause) {
      recognitionRef.current?.abort(); recognitionRef.current = null; setPhase('error')
      setError(cause instanceof Error ? cause.message : 'Speech recognition could not start. Type the command instead.')
    }
  }

  const cancelListening = () => { recognitionRef.current?.abort(); recognitionRef.current = null; setPhase('ready') }
  const interpret = async () => {
    if (!text.trim()) { setError('Enter or speak a command first.'); setPhase('error'); return }
    if (!canProcessVoiceCommand(authenticated)) { setError('Your private session expired. Sign in again; no sale was recorded.'); setPhase('error'); return }
    setPhase('processing'); setError('')
    try {
      await verifyVoiceCommandSession(authenticated, verifySession)
      const result = analyzeVoiceCommand(text, data, `voice-${crypto.randomUUID()}`)
      setAnalysis(result); setSelectedItemId(result.kind === 'sale' && result.matched ? result.matched.id : '')
      setDetailsOpen(true)
      setPhase('ready')
      if (result.kind === 'unsupported' || result.kind === 'unmatched') setError(result.message)
    } catch (cause) { setPhase('error'); setError(cause instanceof Error ? cause.message : 'Could not verify your private session. No sale was recorded.') }
  }

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
  const closeDialog = () => { recognitionRef.current?.abort(); recognitionRef.current = null; onClose() }

  return <div className="modal-backdrop voice-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog() }} onFocusCapture={(event) => { const target = event.target; if (target instanceof HTMLElement && target.matches('input,select,textarea')) window.setTimeout(() => target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 150) }}>
    <section className="modal voice-dialog" role="dialog" aria-modal="true" aria-labelledby="voice-dialog-title" aria-describedby="voice-dialog-help">
      <header><div><span className="eyebrow">PRIVATE INVENTORY COMMAND</span><h2 id="voice-dialog-title">Voice command</h2></div><button className="icon-button" aria-label="Close voice command" onClick={closeDialog}><X size={19}/></button></header>
      <p id="voice-dialog-help" className="voice-privacy-note">Speech is processed by your browser and may use its speech service. Resale Tracker does not save raw audio or send your inventory for transcription. Typed commands stay on this device.</p>
      <div className="voice-input-actions">
        {speechAvailable ? <button className={`primary voice-mic ${phase === 'listening' ? 'listening' : ''}`} onClick={phase === 'listening' ? cancelListening : () => void startListening()}>{phase === 'listening' ? <><Square size={16}/> Stop listening</> : <><Mic size={17}/> Speak command</>}</button> : <span className="voice-unavailable">Speech recognition is not supported here. Type a command instead.</span>}
        {phase === 'listening'&&<span className="listening-indicator" role="status"><i/> Listening now</span>}
      </div>
      <label className="voice-command-label">Command<textarea value={text} onChange={(event) => { setText(event.currentTarget.value); setAttempt((value) => value + 1); setAnalysis(null); setSelectedItemId(''); setError('') }} rows={2} placeholder="Sold VI Music for ten dollars on Vinted."/></label>
      <div className="voice-interpret-actions"><button className="secondary" disabled={phase === 'processing' || phase === 'listening' || !text.trim()} onClick={() => void interpret()}>{phase === 'processing' ? <><LoaderCircle size={16} className="spin"/> Checking inventory…</> : <><Search size={16}/> Interpret command</>}</button><span>{phase === 'error' ? 'Action needed' : phase === 'processing' ? 'Processing' : phase === 'listening' ? 'Listening' : 'Ready'}</span></div>
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
