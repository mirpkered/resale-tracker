import { useMemo, useState } from 'react'
import type { InventoryItem, TrackerData } from '../domain'
import { dollarsToCents, formatMoney, isFieldConfirmed, PLATFORMS } from '../domain'
import { remainingAcquisitionCost } from '../lotView'
import type { QuickSaleInitial } from '../quickSaleForm'

function moneyInput(cents: number | null | undefined) { return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2) }

export function QuickSaleFields({ data, item, initial = {} }: { data: TrackerData; item: InventoryItem; initial?: QuickSaleInitial }) {
  const initialPlatform = initial.platform ?? (isFieldConfirmed(item, 'platform') && item.platform.trim() ? item.platform : '')
  const [platform, setPlatform] = useState(initialPlatform)
  const [quantity, setQuantity] = useState(Math.max(1, Math.min(item.quantity, initial.quantity ?? 1)))
  const [amountMode, setAmountMode] = useState(initial.amountMode ?? 'total')
  const defaultAsk = isFieldConfirmed(item, 'askingCents') && item.askingCents > 0 ? item.askingCents : null
  const [amount, setAmount] = useState(moneyInput(initial.amountCents ?? defaultAsk))
  const initialFee = initial.feeCents !== undefined ? initial.feeCents : platform.toLowerCase() === 'vinted' ? 0 : null
  const [fees, setFees] = useState(moneyInput(initialFee))
  const [shipping, setShipping] = useState(moneyInput(initial.shippingCents))
  const [other, setOther] = useState(moneyInput(initial.otherExpenseCents))
  const lot = data.lots.find((entry) => entry.id === item.lotId)
  const originalAsk = isFieldConfirmed(item, 'askingCents') && item.askingCents > 0 ? formatMoney(item.askingCents) : null
  const allocation = remainingAcquisitionCost(data, item)
  const allocatedCostCents = quantity === item.quantity ? allocation : Math.floor(allocation * quantity / Math.max(item.quantity, 1))
  const platforms = useMemo(() => {
    const values = [...PLATFORMS, ...data.platforms].filter((entry) => entry.kind === 'sales')
    return [...new Map(values.map((entry) => [entry.name.toLowerCase(), entry])).values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [data.platforms])
  const estimated = (() => {
    try {
      if (!amount || !fees || !shipping || !other) return null
      const saleCents = dollarsToCents(amount) * (amountMode === 'per_unit' ? quantity : 1)
      const expenseCents = dollarsToCents(fees) + dollarsToCents(shipping) + dollarsToCents(other)
      if (!Number.isSafeInteger(saleCents) || expenseCents > saleCents) return null
      const net = saleCents - expenseCents
      return { gross: saleCents, net, profit: net - allocatedCostCents }
    } catch { return null }
  })()
  const totalGross = (() => { try { return amount ? dollarsToCents(amount) * (amountMode === 'per_unit' ? quantity : 1) : 0 } catch { return 0 } })()

  return <div className="quick-sale-editor">
    <div className="quick-sale-identity"><span className="eyebrow">ITEM BEING SOLD</span><h3>{item.title}</h3><p>{lot ? `${lot.name} · ${lot.date}` : 'Standalone acquisition'} · {quantity} of {item.quantity} available</p><p>Original asking price: {originalAsk ?? 'none confirmed'} · preserved after sale</p>{item.suggestedAskingCents? <p>Suggested price is not treated as a confirmed listing or sale.</p>:null}</div>
    <div className="quick-sale-allocation"><span>Allocated cost</span><b>{formatMoney(allocatedCostCents)}</b><span>Remaining unit cost basis for this sale</span></div>
    <label>Sale date<input name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required/></label>
    <label>Selling platform<select name="platform" value={platform} onChange={(event) => { const next = event.currentTarget.value; setPlatform(next); setFees(next.toLowerCase() === 'vinted' ? '0.00' : '') }} required><option value="">Choose platform</option>{platforms.map((entry) => <option key={entry.id} value={entry.name}>{entry.name}</option>)}</select></label>
    <label>Quantity<input name="quantity" type="number" inputMode="numeric" min="1" max={item.quantity} value={quantity} onChange={(event) => setQuantity(Math.max(1, Math.min(item.quantity, Number(event.currentTarget.value) || 1)))} required/></label>
    <label>Price entry<select value={amountMode} onChange={(event) => setAmountMode(event.currentTarget.value as 'total' | 'per_unit')}><option value="total">Total for this sale</option><option value="per_unit">Price per copy</option></select></label>
    <label>{amountMode === 'per_unit' ? 'Sale amount per copy' : 'Sale amount'}<input aria-label={amountMode === 'per_unit' ? 'Sale amount per copy' : 'Sale amount'} name="saleAmountEntry" type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.currentTarget.value)} required placeholder="0.00"/><small>{amountMode === 'per_unit' ? `Total gross ${formatMoney(totalGross)}` : 'Enter the accepted price, even if it differs from the asking price.'}</small></label>
    <input type="hidden" name="gross" value={moneyInput(amount ? totalGross : null)}/>
    <label>Platform fees<input name="fees" type="number" inputMode="decimal" min="0" step="0.01" value={fees} onChange={(event) => setFees(event.currentTarget.value)} required placeholder="Enter amount"/><small>{platform.toLowerCase() === 'vinted' ? 'Vinted seller fees default to $0.00.' : 'Enter actual fees; no universal estimate is applied.'}</small></label>
    <label>Seller-paid shipping<input name="shipping" type="number" inputMode="decimal" min="0" step="0.01" value={shipping} onChange={(event) => setShipping(event.currentTarget.value)} required placeholder="Enter amount"/></label>
    <label className="full">Other selling expenses<input name="other" type="number" inputMode="decimal" min="0" step="0.01" value={other} onChange={(event) => setOther(event.currentTarget.value)} required placeholder="Enter amount"/></label>
    <div className="quick-sale-estimate full" aria-live="polite"><b>Estimated sale totals · not saved yet</b><div><span>Gross sale</span><strong>{estimated ? formatMoney(estimated.gross) : 'Complete amounts'}</strong></div><div><span>Estimated net proceeds</span><strong>{estimated ? formatMoney(estimated.net) : '—'}</strong></div><div><span>Estimated item profit</span><strong className={estimated && estimated.profit < 0 ? 'red-text' : ''}>{estimated ? formatMoney(estimated.profit) : '—'}</strong></div></div>
    <p className="quick-sale-cash-note full">Confirming records the sale as received cash immediately. The original asking price is preserved.</p>
  </div>
}
