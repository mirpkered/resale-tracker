import { isFieldConfirmed, PLATFORMS, type LedgerTransaction, type PurchaseLot, type Sale, type TrackerData } from './domain'

export type FinancialCommandAction = 'update_payout_amount' | 'mark_payout_received' | 'record_payout_received' | 'issue_store_credit' | 'record_cash_expense' | 'update_lot_expenses' | 'update_sale_expense'

export interface FinancialCommand {
  action: FinancialCommandAction
  sourceText: string
  commandId: string
  merchant?: string
  lotId?: string
  amountCents?: number
  amountChoicesCents?: number[]
  explicitReceipt: boolean
  expenseField?: 'feeCents'|'shippingCents'|'otherExpenseCents'
}

export interface FinancialCommandAnalysis {
  kind: 'financial'
  command: FinancialCommand
  matches: LedgerTransaction[]
  sales: Sale[]
  matchedLot: PurchaseLot | null
  message?: string
}

const SMALL: Record<string, number> = { zero:0, oh:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19 }
const TENS: Record<string, number> = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 }
const NUMBER_WORD = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)'
const WORD_PHRASE = `${NUMBER_WORD}(?:[ -]+${NUMBER_WORD}){0,4}`

function integerFromWords(value: string): number | null {
  const tokens = value.toLowerCase().replaceAll('-', ' ').trim().split(/\s+/).filter(Boolean)
  let total = 0, current = 0
  for (const token of tokens) {
    if (token in SMALL) current += SMALL[token]
    else if (token in TENS) current += TENS[token]
    else if (token === 'hundred') current = Math.max(1, current) * 100
    else return null
  }
  total += current
  return total
}

export interface ParsedMoney { amountCents?: number; choicesCents?: number[]; raw: string }

/** Parses spoken currency precisely and leaves digit strings such as “3649” ambiguous. */
export function parseFinancialAmount(text: string): ParsedMoney | null {
  const explicitWords = new RegExp(`\\b(${WORD_PHRASE})\\s+dollars?\\s+and\\s+(${WORD_PHRASE})\\s+cents?\\b`, 'i').exec(text)
  if (explicitWords) {
    const dollars = integerFromWords(explicitWords[1]), cents = integerFromWords(explicitWords[2])
    if (dollars !== null && cents !== null && cents < 100) return { amountCents: dollars * 100 + cents, raw: explicitWords[0] }
  }
  const point = /\b(\d{1,6})\s+point\s+(\d{1,2})\b/i.exec(text)
  if (point) return { amountCents: Number(point[1]) * 100 + Number(point[2].padEnd(2, '0')), raw: point[0] }
  const dotted = /\$\s*(\d{1,7})(?:\.(\d{1,2}))?|\b(\d{1,7})\.(\d{1,2})\b|\b(\d{1,7})\s*(?:dollars?|bucks?)\b/i.exec(text)
  if (dotted) {
    const whole = Number(dotted[1] ?? dotted[3] ?? dotted[5])
    const fraction = dotted[2] ?? dotted[4] ?? ''
    const amountCents = whole * 100 + Number(fraction.padEnd(2, '0'))
    return Number.isSafeInteger(amountCents) ? { amountCents, raw: dotted[0] } : null
  }
  const spokenPair = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -](one|two|three|four|five|six|seven|eight|nine))?\s+(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -](one|two|three|four|five|six|seven|eight|nine))?\b/i.exec(text)
  if (spokenPair) {
    const dollars = TENS[spokenPair[1].toLowerCase()] + (spokenPair[2] ? SMALL[spokenPair[2].toLowerCase()] : 0)
    const cents = TENS[spokenPair[3].toLowerCase()] + (spokenPair[4] ? SMALL[spokenPair[4].toLowerCase()] : 0)
    return { amountCents: dollars * 100 + cents, raw: spokenPair[0] }
  }
  const wordCurrency = new RegExp(`\\b(${WORD_PHRASE})(?:\\s+(?:dollars?|bucks?))?\\b`, 'i').exec(text)
  if (wordCurrency && /\b(?:dollars?|bucks?|payout|paid|payment|credit|spent|expense|being|to)\b/i.test(text)) {
    const tokens = wordCurrency[1].trim().split(/[ -]+/)
    if (tokens.length >= 2 && tokens.length <= 4) {
      const split = Math.ceil(tokens.length / 2), dollars = integerFromWords(tokens.slice(0, split).join(' ')), cents = integerFromWords(tokens.slice(split).join(' '))
      if (dollars !== null && cents !== null && dollars <= 99 && cents > 0 && cents < 100) return { amountCents: dollars * 100 + cents, raw: wordCurrency[1] }
    }
    const dollars = integerFromWords(wordCurrency[1])
    if (dollars !== null) return { amountCents: dollars * 100, raw: wordCurrency[0] }
  }
  const splitDigits = /\b(\d{1,2})\s+(\d{2})\b/.exec(text)
  if (splitDigits) {
    const likely = Number(splitDigits[1]) * 100 + Number(splitDigits[2])
    return { choicesCents: [likely, Number(splitDigits[0].replaceAll(/\s/g, '')) * 100], raw: splitDigits[0] }
  }
  const concatenated = /\b(\d{3,7})\b/.exec(text)
  if (concatenated && /\b(?:payout|paid|payment|credit|spent|expense|being|amount|dollars?)\b/i.test(text)) {
    const digits = Number(concatenated[1])
    if (Number.isSafeInteger(digits * 100)) return { choicesCents: [digits, digits * 100], raw: concatenated[1] }
  }
  return null
}

const normalize = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')

function merchantFromText(text: string, data: TrackerData): string | undefined {
  const names = [...new Set([...data.platforms, ...PLATFORMS].map((platform) => platform.name).concat(['World of Books', 'Half Price Books', 'Vintage Stock', 'Staples', 'Play It Again Sports']))].sort((a,b)=>b.length-a.length)
  return names.find((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '\\s+')}\\b`, 'i').test(text)) ?? (/\bWOB\b/i.test(text) ? 'World of Books' : undefined)
}

function lotFromText(text: string, data: TrackerData): PurchaseLot | null {
  const input = normalize(text)
  const words = new Set(input.split(' '))
  const matches = data.lots.map((lot) => {
    const tokens = normalize(lot.name).split(' ').filter((token) => !['the','lot','haul','purchase','payout','payment','books','book'].includes(token))
    const score = tokens.length ? tokens.filter((token) => words.has(token) || words.has(token.replace(/s$/, ''))).length / tokens.length : 0
    return { lot, score }
  }).filter((entry) => entry.score >= 0.5).sort((a,b)=>b.score-a.score)
  return matches[0]?.lot ?? null
}

function payoutMatches(data: TrackerData, merchant: string, lotId?: string) {
  const target = normalize(merchant)
  return (data.ledgerTransactions ?? []).filter((entry) => {
    if (!['pending_offer','buyback_payout'].includes(entry.type) || !entry.platform || normalize(entry.platform) !== target) return false
    return !lotId || entry.lotId === lotId
  })
}

/** Returns a review-only proposal for supported financial commands. */
export function analyzeFinancialCommand(text: string, data: TrackerData, commandId: string): FinancialCommandAnalysis | null {
  const input = text.trim()
  const amount = parseFinancialAmount(input)
  const merchant = merchantFromText(input, data)
  const lot = lotFromText(input, data)
  const isCredit = /\b(?:store\s+credit|trade\s+credit|credit|rewards?)\b/i.test(input) && /\b(?:received|got|earned|issued|redeemed)\b/i.test(input)
  const isExpense = /\b(?:spent|expense|expenses|shipping|fees?)\b/i.test(input) && /\b(?:spent|record|log|add|expense|expenses)\b/i.test(input)
  const isLotExpenseCorrection = /\b(?:change|correct|update|set)\b/i.test(input) && /\b(?:purchase|acquisition|lot)\b/i.test(input) && /\b(?:expense|expenses|cost)\b/i.test(input)
  const isSaleExpenseCorrection = /\b(?:change|correct|update|set)\b/i.test(input) && /\b(?:sale|fees?|shipping|selling expenses?)\b/i.test(input) && !/\b(?:purchase|acquisition)\b/i.test(input)
  const payoutContext = /\b(?:payout|buyback|payment|paid me|paid out|world of books|half price books|vintage stock|play it again sports)\b/i.test(input)
  const saysReceived = /\b(?:paid me|paid out|received|got paid|payment as received|mark .* received)\b/i.test(input)
  const saysUpdate = /\b(?:change|correct|update|ended up being|turned out to be|is now|set to)\b/i.test(input)

  let action: FinancialCommand['action'] | null = null
  if (isCredit && amount) action = 'issue_store_credit'
  else if (isLotExpenseCorrection && amount && lot) action = 'update_lot_expenses'
  else if (isSaleExpenseCorrection && amount) action = 'update_sale_expense'
  else if (isExpense && amount) action = 'record_cash_expense'
  else if (payoutContext && saysReceived) action = 'mark_payout_received'
  else if (payoutContext && saysUpdate && amount) action = 'update_payout_amount'
  else return null

  const matches = action === 'mark_payout_received' || action === 'update_payout_amount' ? merchant ? payoutMatches(data, merchant, lot?.id) : [] : []
  const expenseField=action==='update_sale_expense'?( /\bfees?\b/i.test(input)?'feeCents' as const:/\bshipping\b/i.test(input)?'shippingCents' as const:'otherExpenseCents' as const):undefined
  let saleSearchText=input.replace(/\b(?:change|correct|update|set|my|the|sale|sales|fees?|shipping|seller-paid|expense|expenses|to|is|are|from|on|for|amount|please)\b/gi,' ').replace(/\$?\d+(?:\.\d{1,2})?/g,' ')
  if(merchant)saleSearchText=saleSearchText.replace(new RegExp(merchant.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'ig'),' ')
  if(lot)saleSearchText=saleSearchText.replace(new RegExp(lot.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'ig'),' ')
  const saleTerms=normalize(saleSearchText)
  const sales=action==='update_sale_expense'?(data.sales??[]).filter((sale)=>{
    if(merchant&&normalize(sale.platform)!==normalize(merchant))return false
    if(lot&&!(sale.lines??[]).some((line)=>data.items.find((item)=>item.id===line.itemId)?.lotId===lot.id)&&!sale.itemIds.some((id)=>data.items.find((item)=>item.id===id)?.lotId===lot.id))return false
    if(!saleTerms)return true
    const titles=(sale.lines??[]).map((line)=>data.items.find((item)=>item.id===line.itemId)?.title??'').concat(sale.itemIds.map((id)=>data.items.find((item)=>item.id===id)?.title??'')).join(' ')
    const title=normalize(titles)
    return saleTerms.split(' ').filter(Boolean).every((token)=>title.includes(token))
  }):[]
  const explicitReceipt = action === 'mark_payout_received'
  const saleLots=action==='update_sale_expense'?new Set(sales.flatMap((sale)=>(sale.lines??[]).map((line)=>data.items.find((item)=>item.id===line.itemId)?.lotId).concat(sale.itemIds.map((id)=>data.items.find((item)=>item.id===id)?.lotId)).filter((id):id is string=>Boolean(id)))):new Set<string>()
  const command: FinancialCommand = { action, sourceText: input, commandId, merchant, lotId: lot?.id ?? matches[0]?.lotId ?? (saleLots.size===1?[...saleLots][0]:undefined), amountCents: amount?.amountCents, amountChoicesCents: amount?.choicesCents, explicitReceipt, expenseField }
  const matchedLot = data.lots.find((entry) => entry.id === command.lotId) ?? lot
  let message: string | undefined
  if (action.startsWith('update_payout') || action === 'mark_payout_received') {
    if (!merchant) message = 'Name the payout platform or merchant so I can find the right record.'
    else if (!matches.length && action === 'update_payout_amount') message = `No existing ${merchant} payout or pending offer matches this request. No payout was created.`
    else if (!matches.length) message = `No existing ${merchant} payment was found. Review the merchant and lot before recording a new payment.`
  }
  if (action === 'update_lot_expenses' && !lot) message = 'Name the purchase lot whose acquisition expenses you want to correct.'
  if (action==='update_sale_expense'&&!sales.length)message='No matching sale was found. Name the item or sale and its platform; no expense was changed.'
  return { kind: 'financial', command, matches, sales, matchedLot, message }
}

export function applyFinancialCommand(data: TrackerData, command: FinancialCommand, amountCents: number, selectedRecordId?: string, markReceived = command.action === 'mark_payout_received', date = new Date().toISOString().slice(0,10)): { data: TrackerData; duplicate: boolean } {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error('Choose a valid non-negative amount before confirming.')
  const existingTransactions = data.ledgerTransactions ?? []
  const stableExternalId = `voice-v1-${stableHash(`${command.action}|${normalize(command.sourceText)}|${date}|${amountCents}`)}`
  const duplicate = existingTransactions.find((entry) => entry.externalSource === 'voice-command' && (entry.externalId === command.commandId || entry.externalId === stableExternalId))
  if (duplicate && ['issue_store_credit','record_cash_expense','mark_payout_received'].includes(command.action)) return { data, duplicate: true }

  if (command.action === 'update_lot_expenses') {
    const lot = data.lots.find((entry) => entry.id === command.lotId)
    if (!lot) throw new Error('The purchase lot changed or is no longer available. Reopen the command and review it again.')
    if (lot.expensesCents === amountCents && isFieldConfirmed(lot,'expensesCents')) return { data, duplicate: true }
    return { data: { ...data, lots: data.lots.map((entry) => entry.id === lot.id ? { ...entry, expensesCents: amountCents, fieldVerification: { ...entry.fieldVerification, expensesCents: 'confirmed' } } : entry) }, duplicate: false }
  }

  if(command.action==='update_sale_expense'){
    const matches=data.sales.filter((sale)=>{
      if(command.merchant&&normalize(sale.platform)!==normalize(command.merchant))return false
      if(command.lotId&&!sale.itemIds.some((id)=>data.items.find((item)=>item.id===id)?.lotId===command.lotId)&&!(sale.lines??[]).some((line)=>data.items.find((item)=>item.id===line.itemId)?.lotId===command.lotId))return false
      const old=command.sourceText
      let queryText=old.replace(/\b(?:change|correct|update|set|my|the|sale|sales|fees?|shipping|seller-paid|expense|expenses|to|is|are|from|on|for|amount|please)\b/gi,' ').replace(/\$?\d+(?:\.\d{1,2})?/g,' ')
      if(command.merchant)queryText=queryText.replace(new RegExp(command.merchant.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'ig'),' ')
      const matchingLot=data.lots.find((entry)=>entry.id===command.lotId)
      if(matchingLot)queryText=queryText.replace(new RegExp(matchingLot.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'ig'),' ')
      const query=normalize(queryText)
      const title=normalize((sale.lines??[]).map((line)=>data.items.find((item)=>item.id===line.itemId)?.title??'').concat(sale.itemIds.map((id)=>data.items.find((item)=>item.id===id)?.title??'')).join(' '))
      return !query||query.split(' ').filter(Boolean).every((token)=>title.includes(token))
    })
    if(matches.length>1&&!selectedRecordId)throw new Error('More than one sale matches. Select the exact sale before confirming.')
    const match=matches.find((sale)=>sale.id===selectedRecordId)??(matches.length===1?matches[0]:undefined)
    if(!match)throw new Error('The sale no longer matches the current inventory. No change was made.')
    const field=command.expenseField??'otherExpenseCents'
    if(match[field]===amountCents)return {data,duplicate:true}
    const fees=field==='feeCents'?amountCents:match.feeCents,shipping=field==='shippingCents'?amountCents:match.shippingCents,other=field==='otherExpenseCents'?amountCents:match.otherExpenseCents
    if(fees+shipping+other+match.refundCents>match.grossCents)throw new Error('The expense total would exceed the sale amount. Review the amount before confirming.')
    const updatedSale={...match,[field]:amountCents,receivedCents:match.paymentStatus==='unpaid'?0:match.grossCents-fees-shipping-other-match.refundCents,fieldVerification:{...match.fieldVerification,[field]:'confirmed',receivedCents:match.paymentStatus==='unpaid'?'pending':'confirmed'} as Sale['fieldVerification']}
    return {data:{...data,sales:data.sales.map((sale)=>sale.id===match.id?updatedSale:sale)},duplicate:false}
  }

  if (command.action === 'update_payout_amount' || command.action === 'mark_payout_received') {
    const candidates = payoutMatches(data, command.merchant ?? '', command.lotId)
    if (candidates.length > 1 && !selectedRecordId) throw new Error('More than one payout matches. Select the exact existing record before confirming.')
    const match = candidates.find((entry) => entry.id === selectedRecordId) ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (!match) {
      if (command.action === 'update_payout_amount') throw new Error('The payout no longer matches the current inventory. No change was made.')
      if (!command.explicitReceipt) throw new Error('Confirm that this payment was actually received before recording it.')
      const payout: LedgerTransaction = { id: crypto.randomUUID(), externalSource: 'voice-command', externalId: stableExternalId, type: 'buyback_payout', date, platform: command.merchant, lotId: command.lotId, grossCents: amountCents, feesCents: 0, shippingCents: 0, expensesCents: 0, receivedCents: amountCents, creditCents: 0, expectedCents: 0, paymentStatus: 'confirmed', notes: 'Recorded by explicitly confirmed voice command.', fieldVerification: { type:'confirmed',date:'confirmed',platform:'confirmed',grossCents:'confirmed',receivedCents:'confirmed',paymentStatus:'confirmed',expectedCents:'confirmed' } }
      return { data: { ...data, ledgerTransactions: [...existingTransactions, payout] }, duplicate: false }
    }
    const received = markReceived || match.paymentStatus === 'confirmed'
    if(received&&match.type==='buyback_payout'&&match.paymentStatus==='confirmed'&&match.grossCents===amountCents&&match.receivedCents===amountCents&&match.expectedCents===0)return {data,duplicate:true}
    if(!received&&match.type==='pending_offer'&&match.expectedCents===amountCents&&isFieldConfirmed(match,'expectedCents'))return {data,duplicate:true}
    const updated: LedgerTransaction = received
      ? { ...match, type:'buyback_payout', grossCents:amountCents, receivedCents:amountCents, expectedCents:0, paymentStatus:'confirmed', fieldVerification:{...match.fieldVerification,type:'confirmed',grossCents:'confirmed',expectedCents:'confirmed',receivedCents:'confirmed',paymentStatus:'confirmed'} }
      : { ...match, expectedCents:amountCents, paymentStatus:'pending', fieldVerification:{...match.fieldVerification,expectedCents:'confirmed',paymentStatus:'pending'} }
    return { data: { ...data, ledgerTransactions: existingTransactions.map((entry) => entry.id === match.id ? updated : entry) }, duplicate: false }
  }

  if (command.action === 'issue_store_credit') {
    const record: LedgerTransaction = { id: crypto.randomUUID(), externalSource: 'voice-command', externalId: stableExternalId, type: 'store_credit', date, platform: command.merchant, lotId: command.lotId, grossCents: 0, feesCents: 0, shippingCents: 0, expensesCents: 0, receivedCents: 0, creditCents: amountCents, creditDirection: 'issued', expectedCents: 0, paymentStatus: 'confirmed', notes: 'Store credit recorded by explicitly confirmed voice command; not cash.', fieldVerification: { type:'confirmed',date:'confirmed',platform:'confirmed',creditCents:'confirmed',creditDirection:'confirmed',paymentStatus:'confirmed' } }
    return { data: { ...data, ledgerTransactions: [...existingTransactions, record] }, duplicate: false }
  }

  const record: LedgerTransaction = { id: crypto.randomUUID(), externalSource: 'voice-command', externalId: stableExternalId, type: 'other_expense', date, platform: command.merchant, lotId: command.lotId, grossCents: 0, feesCents: 0, shippingCents: 0, expensesCents: amountCents, receivedCents: 0, creditCents: 0, expectedCents: 0, paymentStatus: 'confirmed', notes: 'Cash expense recorded by explicitly confirmed voice command.', fieldVerification: { type:'confirmed',date:'confirmed',platform:'confirmed',expensesCents:'confirmed',paymentStatus:'confirmed' } }
  return { data: { ...data, ledgerTransactions: [...existingTransactions, record] }, duplicate: false }
}

function stableHash(input:string){let hash=14695981039346656037n;for(const byte of new TextEncoder().encode(input)){hash^=BigInt(byte);hash=BigInt.asUintN(64,hash*1099511628211n)}return hash.toString(16)}

export function currentFinancialAmount(analysis: FinancialCommandAnalysis, selectedRecordId?: string): number | undefined {
  if(analysis.command.action==='update_sale_expense'){
    const sale=analysis.sales.find((entry)=>entry.id===selectedRecordId)??(analysis.sales.length===1?analysis.sales[0]:undefined)
    if(!sale)return analysis.command.amountCents
    return analysis.command.expenseField==='feeCents'?sale.feeCents:analysis.command.expenseField==='shippingCents'?sale.shippingCents:sale.otherExpenseCents
  }
  const match = analysis.matches.find((entry) => entry.id === selectedRecordId) ?? (analysis.matches.length === 1 ? analysis.matches[0] : undefined)
  if (analysis.command.amountCents !== undefined || analysis.command.amountChoicesCents?.length) return analysis.command.amountCents
  if (!match) return undefined
  return match.paymentStatus === 'confirmed' ? match.receivedCents : match.expectedCents || match.grossCents
}

export function financialCommandTargetLot(analysis: FinancialCommandAnalysis, data: TrackerData): PurchaseLot | null {
  return data.lots.find((lot) => lot.id === analysis.command.lotId) ?? analysis.matchedLot
}
