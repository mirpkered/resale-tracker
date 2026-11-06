import { describe, expect, it } from 'vitest'
import type { InventoryItem, TrackerData } from './domain'
import { commandSaleDefaults, analyzeVoiceCommand, canProcessVoiceCommand, interpretVoiceTranscript, verifyVoiceCommandSession } from './voiceCommand'
import { recordQuickSale } from './quickSale'

const item = (id: string, title: string, overrides: Partial<InventoryItem> = {}): InventoryItem => ({
  id, title, category: 'DVD', quantity: 1, originalQuantity: 1, lotId: 'halloween', costCents: 100,
  askingCents: 500, platform: 'Vinted', status: 'active',
  fieldVerification: { askingCents: 'confirmed', platform: 'confirmed', costCents: 'confirmed' }, ...overrides,
})
const fixture = (items = [item('vi', '30 — VI Music Video Collection'), item('joan', 'Joan of Arcadia Season 2'), item('grizzly', 'The Life and Times of Grizzly Adams')]): TrackerData => ({
  lots: [{ id: 'halloween', name: 'Halloween DVD Haul', date: '2026-10-31', source: 'Thrift store', purchaseCents: 2300, expensesCents: 0 }],
  items, units: items.map((entry, index) => ({ id: `unit-${index}`, itemId: entry.id, copyNumber: 1, status: entry.status })),
  sales: [], expenses: [], credit: [], platforms: [{ id: 'vinted', name: 'Vinted', kind: 'sales' }],
})

describe('voice command interpretation', () => {
  it('matches exact inventory and converts spoken dollars to cents', () => {
    const result = analyzeVoiceCommand('I sold VI Music for ten dollars on Vinted.', fixture(), 'cmd-1')
    expect(result.kind).toBe('sale')
    if (result.kind !== 'sale') return
    expect(result.matched?.id).toBe('vi')
    expect(result.command.amountCents).toBe(1000)
    expect(result.command.platform).toBe('Vinted')
  })

  it('understands spoken cents and accepted lower offers without treating asking price as sale revenue', () => {
    const data = fixture()
    const result = analyzeVoiceCommand('Mark Joan of Arcadia season two sold for three fifty.', data, 'cmd-2')
    expect(result.kind).toBe('sale')
    if (result.kind !== 'sale') return
    expect(result.command.amountCents).toBe(350)
    expect(result.matched?.askingCents).toBe(500)
  })

  it('understands an accepted spoken offer and identifies the named item', () => {
    const result = analyzeVoiceCommand('I accepted a five-dollar offer for Grizzly Adams.', fixture(), 'cmd-offer')
    expect(result.kind).toBe('sale')
    if (result.kind === 'sale') {
      expect(result.matched?.id).toBe('grizzly')
      expect(result.command.amountCents).toBe(500)
    }
  })

  it('extracts a quantity and per-unit price', () => {
    const data = fixture([item('game', 'Nintendo game', { quantity: 2, originalQuantity: 2, costCents: 200 })])
    const result = analyzeVoiceCommand('Sold two copies of Nintendo game for four dollars each on Vinted.', data, 'cmd-3')
    expect(result.kind).toBe('sale')
    if (result.kind !== 'sale') return
    expect(result.command.quantity).toBe(2)
    expect(result.command.amountMode).toBe('per_unit')
    expect(result.command.amountCents).toBe(400)
  })

  it('extracts explicitly stated fees and shipping without polluting the matched title', () => {
    const result = analyzeVoiceCommand('Sold VI Music for ten dollars on Vinted with $1 fees and $2 shipping.', fixture(), 'cmd-expenses')
    expect(result.kind).toBe('sale')
    if (result.kind === 'sale') {
      expect(result.matched?.id).toBe('vi')
      expect(result.command.amountCents).toBe(1000)
      expect(result.command.feeCents).toBe(100)
      expect(result.command.shippingCents).toBe(200)
    }
  })

  it('requires item selection when duplicate copies match the title', () => {
    const result = analyzeVoiceCommand('Sold Entourage Season 1 for five dollars on Vinted.', fixture([item('copy-a', 'Entourage Season 1'), item('copy-b', 'Entourage Season 1')]), 'cmd-4')
    expect(result.kind).toBe('sale')
    if (result.kind === 'sale') { expect(result.ambiguous).toBe(true); expect(result.matched).toBeNull(); expect(result.matches).toHaveLength(2) }
  })

  it('does not create inventory or a sale when no reliable item matches', () => {
    const data = fixture()
    const result = analyzeVoiceCommand('Sold nonexistent boxed set for five dollars on Vinted.', data, 'cmd-5')
    expect(result.kind).toBe('unmatched')
    expect(data.sales).toHaveLength(0)
    expect(data.items).toHaveLength(3)
  })

  it('keeps an interpreted sale proposal read-only until explicit confirmation', () => {
    const data = fixture()
    const before = JSON.stringify(data)
    const result = analyzeVoiceCommand('Sold VI Music for ten dollars on Vinted.', data, 'cmd-unconfirmed')
    expect(result.kind).toBe('sale')
    expect(data.sales).toHaveLength(0)
    expect(data.items.find((entry) => entry.id === 'vi')?.quantity).toBe(1)
    expect(JSON.stringify(data)).toBe(before)
  })

  it('automatically interprets a completed transcript into a review-only proposal', async () => {
    const data=fixture(),before=JSON.stringify(data),verify=async()=>{}
    const result=await interpretVoiceTranscript('Sold VI Music for ten dollars on Vinted.',data,true,verify,'voice-auto-1')
    expect(result).toMatchObject({kind:'sale',matched:{id:'vi'}})
    expect(JSON.stringify(data)).toBe(before)
    expect(data.sales).toHaveLength(0)
  })

  it('does not expose inventory to automatic interpretation when the session expires', async () => {
    const verify=async()=>{throw new Error('GitHub authorization expired')}
    await expect(interpretVoiceTranscript('Sold VI Music for ten dollars on Vinted.',fixture(),true,verify,'voice-expired')).rejects.toThrow(/expired/)
  })

  it('leaves missing platform and unrecognized sale amount for explicit editing', () => {
    const result = analyzeVoiceCommand('Sold Joan of Arcadia season two.', fixture(), 'cmd-6')
    expect(result.kind).toBe('sale')
    if (result.kind !== 'sale') return
    expect(result.command.platform).toBeUndefined()
    expect(result.command.amountCents).toBeUndefined()
    const values = commandSaleDefaults(result.command, result.matched!)
    expect(values.platform).toBe('Vinted') // confirmed existing platform can be safely prefilled
    expect(values.amountCents).toBe(500) // confirmed asking remains an editable prefill
    expect(values.feeCents).toBe(0)
  })

  it('parses only supported read-only inventory questions outside sale intent', () => {
    expect(analyzeVoiceCommand('How many items do I still have available?', fixture(), 'read-1')).toMatchObject({ kind: 'read_only', response: expect.stringContaining('3 available item units') })
    expect(analyzeVoiceCommand('Undo the eBay sale for Joan', fixture(), 'unsafe')).toMatchObject({ kind: 'unsupported' })
  })

  it('answers listed, available, unlisted, sold, disposed and platform-specific unit counts', () => {
    const data = fixture([
      item('listed-a', 'Entourage Season 1', { status: 'active', platform: 'Vinted', quantity: 2, originalQuantity: 2 }),
      item('listed-b', 'Entourage Season 3', { status: 'active', platform: 'Vinted' }),
      item('unlisted', 'Joan of Arcadia Season 2', { status: 'acquired', platform: '' }),
      item('sold', 'VI Music Video Collection', { status: 'completed', quantity: 0 }),
      item('disposed', 'Incomplete DVD set', { status: 'disposed', quantity: 0 }),
    ])
    data.items.forEach((entry) => { entry.lotId = 'halloween' })
    data.units = [
      { id: 'a1', itemId: 'listed-a', copyNumber: 1, status: 'active' }, { id: 'a2', itemId: 'listed-a', copyNumber: 2, status: 'active' },
      { id: 'b1', itemId: 'listed-b', copyNumber: 1, status: 'active' }, { id: 'u1', itemId: 'unlisted', copyNumber: 1, status: 'acquired' },
      { id: 's1', itemId: 'sold', copyNumber: 1, status: 'completed' }, { id: 'd1', itemId: 'disposed', copyNumber: 1, status: 'disposed' },
    ]
    expect(analyzeVoiceCommand('How many items do I have listed?', data, 'c1')).toMatchObject({ kind: 'read_only', response: expect.stringMatching(/3 listed item units.*2 inventory records/) })
    expect(analyzeVoiceCommand('How many items are available?', data, 'c2')).toMatchObject({ kind: 'read_only', response: expect.stringMatching(/4 available item units/) })
    expect(analyzeVoiceCommand('How many items are unlisted?', data, 'c3')).toMatchObject({ kind: 'read_only', response: expect.stringMatching(/1 unlisted item unit/) })
    expect(analyzeVoiceCommand('How many items have sold?', data, 'c4')).toMatchObject({ kind: 'read_only', response: expect.stringMatching(/1 sold item unit/) })
    expect(analyzeVoiceCommand('How many items have been disposed?', data, 'c5')).toMatchObject({ kind: 'read_only', response: expect.stringMatching(/1 disposed item unit/) })
    expect(analyzeVoiceCommand('How many items do I have listed on Vinted?', data, 'c6')).toMatchObject({ kind: 'read_only', response: expect.stringMatching(/3 listed item units on Vinted/) })
    expect(analyzeVoiceCommand('How many Halloween DVDs are still available?', data, 'c7')).toMatchObject({ kind: 'read_only', response: expect.stringMatching(/4 available item units.*Halloween DVD Haul/) })
  })

  it('does not turn a count question into an empty-title inventory search', () => {
    const result = analyzeVoiceCommand('How many items do I have listed?', fixture(), 'count')
    expect(result.kind).toBe('read_only')
    expect(result).not.toMatchObject({ kind: 'read_only', response: expect.stringContaining('No inventory match for “”.') })
  })

  it('requires authentication before inventory commands can be processed', () => {
    expect(canProcessVoiceCommand(false)).toBe(false)
    expect(canProcessVoiceCommand(true)).toBe(true)
  })

  it('stops command interpretation or sale confirmation when the cloud session has expired', async () => {
    let checks = 0
    const expired = () => { checks++; return Promise.reject(new Error('GitHub authorization expired')) }
    await expect(verifyVoiceCommandSession(true, expired)).rejects.toThrow(/expired/)
    await expect(verifyVoiceCommandSession(false, async () => { checks++ })).rejects.toThrow(/Sign in/)
    expect(checks).toBe(1)
  })

  it('uses idempotent transaction IDs for retries of a confirmed voice command', () => {
    const data = fixture()
    const first = recordQuickSale(data, 'vi', { date: '2026-11-05', platform: 'Vinted', grossCents: 1000, feeCents: 0, shippingCents: 0, otherExpenseCents: 0, externalSource: 'voice-command', externalId: 'cmd-repeat' })
    const retry = recordQuickSale(first.data, 'vi', { date: '2026-11-05', platform: 'Vinted', grossCents: 1000, feeCents: 0, shippingCents: 0, otherExpenseCents: 0, externalSource: 'voice-command', externalId: 'cmd-repeat' })
    expect(first.duplicate).toBe(false)
    expect(retry.duplicate).toBe(true)
    expect(retry.data).toBe(first.data)
    expect(retry.data.sales).toHaveLength(1)
  })
})
