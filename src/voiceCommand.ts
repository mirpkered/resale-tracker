import { ACTIVE_STATUSES, formatMoney, getMetrics, isFieldConfirmed, lineNetProceedsCents, PLATFORMS, retainedCostCents, type InventoryItem, type TrackerData } from './domain'
import { summarizeLot } from './lotView'

export interface ParsedSaleCommand {
  intent: 'record_sale'
  sourceText: string
  itemQuery: string
  quantity: number
  amountCents?: number
  amountMode: 'total' | 'per_unit'
  platform?: string
  feeCents?: number
  shippingCents?: number
  otherExpenseCents?: number
  commandId: string
}

export type VoiceAnalysis =
  | { kind: 'sale'; command: ParsedSaleCommand; matches: InventoryItem[]; matched: InventoryItem | null; ambiguous: boolean; query: string }
  | { kind: 'read_only'; response: string; matches: InventoryItem[] }
  | { kind: 'unmatched'; query: string; suggestions: InventoryItem[]; message: string }
  | { kind: 'unsupported'; message: string }

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
}
const WORD_NUMBER = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|')
const MONEY_PATTERN = String.raw`(?:\$\s*\d+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s*(?:dollars?|bucks?)?|(?:${WORD_NUMBER})(?:[\s-]+(?:${WORD_NUMBER}))?[- ]?(?:dollars?|bucks?|dollar)?(?:\s+(?:each|per copy))?)`

function numericWords(value: string): number | null {
  const words = value.toLowerCase().replaceAll('-', ' ').trim().split(/\s+/).filter((word) => word in NUMBER_WORDS)
  if (!words.length) return null
  if (words.length === 2 && NUMBER_WORDS[words[1]] >= 10 && NUMBER_WORDS[words[0]] < 10) return NUMBER_WORDS[words[0]] * 100 + NUMBER_WORDS[words[1]]
  let total = 0, current = 0
  for (const word of words) {
    const number = NUMBER_WORDS[word]
    if (number === 100) current = Math.max(1, current) * 100
    else if (number >= 20 && current > 0 && current < 10) current += number
    else { total += current; current = number }
  }
  return total + current
}

function moneyCents(expression: string): number | undefined {
  const input = expression.toLowerCase().replaceAll(/\b(?:dollars?|bucks?|each|per copy)\b/g, '').replace(/\$/g, '').trim()
  if (/^\d/.test(input)) {
    const match = input.match(/^(\d+)(?:\.(\d{1,2}))?$/)
    if (!match) return undefined
    const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
    return Number.isSafeInteger(cents) ? cents : undefined
  }
  const words = input.replaceAll('-', ' ').trim().split(/\s+/)
  if (words.length === 2 && NUMBER_WORDS[words[0]] >= 1 && NUMBER_WORDS[words[0]] <= 9 && NUMBER_WORDS[words[1]] >= 10 && NUMBER_WORDS[words[1]] <= 99) return NUMBER_WORDS[words[0]] * 100 + NUMBER_WORDS[words[1]]
  const amount = numericWords(input)
  const cents = amount === null ? undefined : amount * 100
  return cents !== undefined && Number.isSafeInteger(cents) && cents >= 0 ? cents : undefined
}

function explicitExpense(text: string, labels: string[]): number | undefined {
  const pattern = new RegExp(`\\b(?:${labels.join('|')})\\b\\s*(?:of|is|are|:)?\\s*(${MONEY_PATTERN})`, 'i')
  const match = text.match(pattern)
  if (match) return moneyCents(match[1])
  const beforeLabel = new RegExp(`(${MONEY_PATTERN})\\s*(?:of\\s+)?\\b(?:${labels.join('|')})\\b`, 'i').exec(text)
  return beforeLabel ? moneyCents(beforeLabel[1]) : undefined
}

function saleMoneyMatch(text: string): { value: string; index: number } | undefined {
  const forPrice = new RegExp(`\\bfor\\s+(${MONEY_PATTERN})`, 'i').exec(text)
  if (forPrice) return { value: forPrice[1], index: forPrice.index + forPrice[0].indexOf(forPrice[1]) }
  const offerPrice = new RegExp(`(${MONEY_PATTERN})\\s+(?:dollar\\s+)?offer\\b`, 'i').exec(text)
  if (offerPrice) return { value: offerPrice[1], index: offerPrice.index }
  // A currency marker makes an amount unambiguous even if it precedes the item
  // name, as in “accepted a five-dollar offer for Grizzly Adams”.
  const markedPrice = /(?:\$\s*\d+(?:\.\d{1,2})?|\b\d+(?:\.\d{1,2})?\s*(?:dollars?|bucks?)\b|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -](?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety))?[- ]dollars?\b)/i.exec(text)
  return markedPrice ? { value: markedPrice[0], index: markedPrice.index } : undefined
}

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\bseason\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (_m, word: string) => `season ${NUMBER_WORDS[word]}`)
    .replace(/\b(series|volume|vol)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (_m, kind: string, word: string) => `${kind} ${NUMBER_WORDS[word]}`)
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
}

function matchScore(query: string, item: InventoryItem): number {
  const q = normalize(query), title = normalize(item.title), description = normalize(item.description ?? '')
  if (!q || !title) return 0
  if (q === title) return 1
  if (title.includes(q)) return 0.96
  const tokens = q.split(' ').filter((word) => !['my', 'copy', 'of', 'the', 'a', 'an', 'item', 'this'].includes(word))
  if (!tokens.length) return 0
  const titleTokens = new Set(`${title} ${description}`.split(' '))
  const overlap = tokens.filter((token) => titleTokens.has(token)).length / tokens.length
  return overlap >= 0.8 && tokens.length >= 2 ? 0.82 + overlap * 0.1 : overlap
}

function cleanItemQuery(text: string, moneyMatch?: { value: string; index: number }): string {
  let result = text
  if (moneyMatch) {
    const before = result.slice(0, moneyMatch.index), after = result.slice(moneyMatch.index + moneyMatch.value.length)
    if (/offer\s+for\s*$/i.test(after)) result = after.replace(/^\s*offer\s+for\s*/i, '')
    else if (/\b(?:accepted|accepting)\b/i.test(before) && /offer/i.test(after) && /\bfor\b/i.test(after)) result = after.slice(after.toLowerCase().lastIndexOf('for') + 3)
    else if (/\bfor\s*$/i.test(before)) result = before.slice(0, before.toLowerCase().lastIndexOf('for'))
    else result = `${before} ${after}`
  }
  result = result.replace(/\b(?:sold|sell|selling|mark|as|i|we|just|accepted|accepting|an?|the|copy|copies|of|this|item|for|at|on)\b/gi, ' ')
  result = result.replace(/\b(?:platform\s+)?fees?\b|\b(?:seller-paid\s+)?shipping\b|\b(?:other|selling)\s+expenses?\b/gi, ' ')
  result = result.replace(/\$\s*\d+(?:\.\d{1,2})?|\b\d+(?:\.\d{1,2})?\s*(?:dollars?|bucks?)\b/gi, ' ')
  result = result.replace(/\b\d+\s*(?:copies|copy|units?)\b/gi, ' ')
  result = result.replace(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:copies|copy|units?)\b/gi, ' ')
  result = result.replace(/\b(?:on\s+)?(?:vinted|ebay|amazon|world of books|local sale|other)\b/gi, ' ')
  result = result.replace(/\b(?:for|sold)\s*$/gi, ' ')
  return result.replace(/[.,!?;:]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function spokenQuantity(text: string): number {
  const match = text.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:copies|copy|units?)\b/i)
  if (!match) return 1
  const value = /^\d+$/.test(match[1]) ? Number(match[1]) : NUMBER_WORDS[match[1].toLowerCase()]
  return Number.isSafeInteger(value) && value > 0 ? value : 1
}

function parseSale(text: string, platforms: TrackerData['platforms'], commandId: string): ParsedSaleCommand | null {
  if (!/\b(?:sold|sell|mark\b.*\bsold|accepted\b.*\boffer)\b/i.test(text)) return null
  const amountMatch = saleMoneyMatch(text)
  const amountCents = amountMatch ? moneyCents(amountMatch.value) : undefined
  const amountMode = amountMatch && /\b(?:each|per copy)\b/i.test(text.slice(amountMatch.index, amountMatch.index + amountMatch.value.length)) ? 'per_unit' as const : 'total' as const
  const quantity = spokenQuantity(text)
  const words = [...platforms, ...PLATFORMS].filter((entry) => entry.kind === 'sales').map((entry) => entry.name).sort((a, b) => b.length - a.length)
  const platform = words.find((name) => new RegExp(`\\bon\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))
  const itemQuery = cleanItemQuery(text, amountMatch)
  const feeCents = explicitExpense(text, ['fees?', 'platform fees?'])
  const shippingCents = explicitExpense(text, ['shipping', 'seller-paid shipping'])
  const otherExpenseCents = explicitExpense(text, ['other expenses?', 'selling expenses?'])
  if (!itemQuery) return { intent: 'record_sale', sourceText: text, itemQuery: '', quantity, amountCents, amountMode, platform, feeCents, shippingCents, otherExpenseCents, commandId }
  return { intent: 'record_sale', sourceText: text, itemQuery, quantity, amountCents, amountMode, platform, feeCents, shippingCents, otherExpenseCents, commandId }
}

function activeItems(data: TrackerData) { return data.items.filter((item) => ACTIVE_STATUSES.includes(item.status) && item.quantity > 0 && !item.archived) }

function readOnlyQuery(text: string, data: TrackerData): VoiceAnalysis | null {
  const metrics = getMetrics(data)
  if (/\bhow many\b.*\b(?:items?|copies|units?)\b.*\b(?:available|left|remaining)\b/i.test(text) || /\bhow many\b.*\bstill have\b/i.test(text)) {
    return { kind: 'read_only', response: `You have ${metrics.remainingQuantity} item units available.`, matches: [] }
  }
  if (/\b(?:how much|what).*(?:recovered|cash|profit|investment)\b/i.test(text)) {
    const lotQuery = text.replace(/^.*?\b(?:from|on|for)\s+/i, '').replace(/\b(?:haul|lot|purchase|profit|cash|recovered|have i|how much|money|the)\b/gi, ' ').replace(/[?.!,]/g, ' ').replace(/\s+/g, ' ').trim()
    const lots = data.lots.map((lot) => ({ lot, score: matchScore(lotQuery, { id: lot.id, title: lot.name } as InventoryItem) })).filter((entry) => entry.score >= 0.55).sort((a, b) => b.score - a.score)
    if (lots.length) {
      const summary = summarizeLot(data, lots[0].lot)
      const lotItems = new Set(data.items.filter((item) => item.lotId === lots[0].lot.id).map((item) => item.id))
      const realizedProfit = data.sales.filter((sale) => sale.paymentStatus !== 'unpaid' && isFieldConfirmed(sale, 'receivedCents')).reduce((total, sale) => total + (sale.lines ?? []).filter((line) => lotItems.has(line.itemId)).reduce((sum, line) => sum + lineNetProceedsCents(sale, line) - retainedCostCents(line), 0), 0)
      return { kind: 'read_only', response: `${lots[0].lot.name}: ${formatMoney(summary.cashReceivedCents)} confirmed cash recovered; realized item profit ${formatMoney(realizedProfit)}; cash position ${formatMoney(summary.cashPositionCents)}.`, matches: [] }
    }
    return { kind: 'read_only', response: `Overall: ${formatMoney(metrics.netCashProceedsCents)} confirmed cash received; cash position ${formatMoney(metrics.overallCashPositionCents)}.`, matches: [] }
  }
  if (/\b(?:find|search|do i have|show me)\b/i.test(text)) {
    const query = text.replace(/^.*?\b(?:find|search|do i have|show me)\s+/i, '').replace(/\b(?:listed|listing|my|copy|of|the|a|an)\b/gi, ' ').replace(/[?.!,]/g, ' ').trim()
    const results = data.items.filter((item) => matchScore(query, item) >= 0.5).slice(0, 8)
    return { kind: 'read_only', response: results.length ? `${results.length} matching inventory record${results.length === 1 ? '' : 's'}.` : `No inventory match for “${query}”.`, matches: results }
  }
  return null
}

export function analyzeVoiceCommand(text: string, data: TrackerData, commandId: string): VoiceAnalysis {
  const input = text.trim()
  if (!input) return { kind: 'unsupported', message: 'Type or say a command first.' }
  const query = readOnlyQuery(input, data)
  if (query) return query
  const command = parseSale(input, data.platforms, commandId)
  if (!command) return { kind: 'unsupported', message: 'Supported commands are sales, inventory search, available-item counts, and purchase-lot cash reports.' }
  if (!command.itemQuery) return { kind: 'unsupported', message: 'I could not identify the item title. Try “Sold [item title] for [amount] on [platform].”' }
  const available = activeItems(data)
  const ranked = available.map((item) => ({ item, score: matchScore(command.itemQuery, item) })).filter((entry) => entry.score >= 0.5).sort((a, b) => b.score - a.score)
  const matches = ranked.map((entry) => entry.item)
  if (!matches.length) {
    const suggestions = data.items.map((item) => ({ item, score: matchScore(command.itemQuery, item) })).filter((entry) => entry.score >= 0.2).sort((a, b) => b.score - a.score).slice(0, 5).map((entry) => entry.item)
    return { kind: 'unmatched', query: command.itemQuery, suggestions, message: suggestions.length ? 'No available exact match. Review these possible records; unavailable items cannot be sold.' : 'No reliable inventory match. No item or sale was created.' }
  }
  const ambiguous = matches.length > 1 && (ranked[0].score - ranked[1].score < 0.12 || ranked[1].score >= 0.85)
  return { kind: 'sale', command, matches, matched: ambiguous ? null : matches[0], ambiguous, query: command.itemQuery }
}

export function commandSaleDefaults(command: ParsedSaleCommand, item: InventoryItem): { amountCents: number | null; platform: string; feeCents: number | null; shippingCents: number | null; otherExpenseCents: number | null } {
  const confirmedAsk = isFieldConfirmed(item, 'askingCents') && item.askingCents > 0 ? item.askingCents : null
  const platform = command.platform ?? (isFieldConfirmed(item, 'platform') && item.platform.trim() ? item.platform.trim() : '')
  return {
    amountCents: command.amountCents ?? confirmedAsk,
    platform,
    feeCents: command.feeCents ?? (platform.toLowerCase() === 'vinted' ? 0 : null),
    shippingCents: command.shippingCents ?? null,
    otherExpenseCents: command.otherExpenseCents ?? null,
  }
}

export function canProcessVoiceCommand(authenticated: boolean): boolean { return authenticated }

export async function verifyVoiceCommandSession(authenticated: boolean, verify: () => Promise<void>): Promise<void> {
  if (!canProcessVoiceCommand(authenticated)) throw new Error('Sign in to your private inventory before processing this command.')
  await verify()
}
