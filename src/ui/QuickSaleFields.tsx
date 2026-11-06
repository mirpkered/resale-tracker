import { useMemo, useState } from 'react'
import type { InventoryItem, TrackerData } from '../domain'
import { dollarsToCents, formatMoney, isFieldConfirmed, PLATFORMS } from '../domain'
import { remainingAcquisitionCost } from '../lotView'
import type { QuickSaleInitial } from '../quickSaleForm'
import { defaultSellerShippingCents, estimateSellingFee, type AmazonFulfillment } from '../sellingFeeEstimates'

function moneyInput(cents: number | null | undefined) { return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2) }

export function QuickSaleFields({ data, item, initial = {} }: { data: TrackerData; item: InventoryItem; initial?: QuickSaleInitial }) {
  const initialPlatform = initial.platform ?? (isFieldConfirmed(item, 'platform') && item.platform.trim() ? item.platform : '')
  const [platform, setPlatform] = useState(initialPlatform)
  const [quantity, setQuantity] = useState(Math.max(1, Math.min(item.quantity, initial.quantity ?? 1)))
  const [amountMode, setAmountMode] = useState(initial.amountMode ?? 'total')
  const [feeOverride, setFeeOverride] = useState(initial.feeCents !== undefined && initial.feeCents !== null)
  const [fulfillment, setFulfillment] = useState<AmazonFulfillment>('seller')
  const defaultAsk = isFieldConfirmed(item, 'askingCents') && item.askingCents > 0 ? item.askingCents : null
  const [amount, setAmount] = useState(moneyInput(initial.amountCents ?? defaultAsk))
  const initialEstimate = estimateSellingFee(platform, initial.amountCents ?? defaultAsk, Math.max(1, initial.quantity ?? 1), item.category, 'seller')
  const initialFee = initial.feeCents !== undefined ? initial.feeCents : initialEstimate.cents
  const [fees, setFees] = useState(moneyInput(initialFee))
  const defaultShipping = defaultSellerShippingCents(platform)
  const [shipping, setShipping] = useState(moneyInput(initial.shippingCents !== undefined ? initial.shippingCents : defaultShipping))
  const lot = data.lots.find((entry) => entry.id === item.lotId)
  const originalAsk = isFieldConfirmed(item, 'askingCents') && item.askingCents > 0 ? formatMoney(item.askingCents) : null
  const allocation = remainingAcquisitionCost(data, item)
  const allocatedCostCents = quantity === item.quantity ? allocation : Math.floor(allocation * quantity / Math.max(item.quantity, 1))
  const platforms = useMemo(() => {
    const values = [...PLATFORMS, ...data.platforms].filter((entry) => entry.kind === 'sales' || entry.name.toLowerCase() === 'vintage stock')
    return [...new Map(values.map((entry) => [entry.name.toLowerCase(), entry])).values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [data.platforms])
  const estimated = (() => {
    try {
      if (!amount || !fees || !shipping) return null
      const saleCents = dollarsToCents(amount) * (amountMode === 'per_unit' ? quantity : 1)
      const expenseCents = dollarsToCents(fees) + dollarsToCents(shipping)
      if (!Number.isSafeInteger(saleCents) || expenseCents > saleCents) return null
      const net = saleCents - expenseCents
      return { gross: saleCents, net, profit: net - allocatedCostCents }
    } catch { return null }
  })()
  const totalGross = (() => { try { return amount ? dollarsToCents(amount) * (amountMode === 'per_unit' ? quantity : 1) : 0 } catch { return 0 } })()
  const suggestedFee = estimateSellingFee(platform, totalGross || null, quantity, item.category, fulfillment)
  const setAutoFee = (nextPlatform: string, nextAmount: string, nextQuantity: number, nextFulfillment = fulfillment) => {
    if (feeOverride) return
    let cents: number | null = null
    try { cents = estimateSellingFee(nextPlatform, nextAmount ? dollarsToCents(nextAmount) * (amountMode === 'per_unit' ? nextQuantity : 1) : null, nextQuantity, item.category, nextFulfillment).cents } catch { cents = null }
    setFees(moneyInput(cents))
  }

  return <div className="quick-sale-editor">
    <div className="quick-sale-identity"><span className="eyebrow">ITEM BEING SOLD</span><h3>{item.title}</h3><p>{lot ? `${lot.name} · ${lot.date}` : 'Standalone acquisition'} · {quantity} of {item.quantity} available</p><p>Original asking price: {originalAsk ?? 'none confirmed'} · preserved after sale</p>{item.suggestedAskingCents? <p>Suggested price is not treated as a confirmed listing or sale.</p>:null}</div>
    <div className="quick-sale-allocation"><span>Allocated cost</span><b>{formatMoney(allocatedCostCents)}</b><span>Remaining unit cost basis for this sale</span></div>
    <label>Sale date<input name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required/></label>
    <label>Selling platform<select name="platform" value={platform} onChange={(event) => { const next = event.currentTarget.value; setPlatform(next); setFeeOverride(false); setShipping(moneyInput(defaultSellerShippingCents(next,fulfillment)));const estimate=estimateSellingFee(next,totalGross||null,quantity,item.category,fulfillment);setFees(moneyInput(estimate.cents)) }} required><option value="">Choose platform</option>{platforms.map((entry) => <option key={entry.id} value={entry.name}>{entry.name}</option>)}</select></label>
    {platform.toLowerCase()==='amazon'&&<label>Amazon fulfillment<select value={fulfillment} onChange={(event)=>{const next=event.currentTarget.value as AmazonFulfillment;setFulfillment(next);setShipping(moneyInput(defaultSellerShippingCents(platform,next)))}}><option value="seller">Seller fulfilled</option><option value="fba">Fulfilled by Amazon</option></select></label>}
    <label>Quantity<input name="quantity" type="number" inputMode="numeric" min="1" max={item.quantity} value={quantity} onChange={(event) => {const next=Math.max(1, Math.min(item.quantity, Number(event.currentTarget.value) || 1));setQuantity(next);setAutoFee(platform,amount,next)}} required/></label>
    <label>Price entry<select value={amountMode} onChange={(event) => {const next=event.currentTarget.value as 'total' | 'per_unit';setAmountMode(next);if(!feeOverride){const saleCents=amount?dollarsToCents(amount)*(next==='per_unit'?quantity:1):null;setFees(moneyInput(estimateSellingFee(platform,saleCents,quantity,item.category,fulfillment).cents))}}}><option value="total">Total for this sale</option><option value="per_unit">Price per copy</option></select></label>
    <label>{amountMode === 'per_unit' ? 'Sale amount per copy' : 'Sale amount'}<input aria-label={amountMode === 'per_unit' ? 'Sale amount per copy' : 'Sale amount'} name="saleAmountEntry" type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(event) => {const next=event.currentTarget.value;setAmount(next);setAutoFee(platform,next,quantity)}} required placeholder="0.00"/><small>{amountMode === 'per_unit' ? `Total gross ${formatMoney(totalGross)}` : 'Enter the accepted price, even if it differs from the asking price.'}</small></label>
    <input type="hidden" name="gross" value={moneyInput(amount ? totalGross : null)}/>
    <label>Platform fees<input name="fees" type="number" inputMode="decimal" min="0" step="0.01" value={fees} onChange={(event) => {setFees(event.currentTarget.value);setFeeOverride(true)}} required placeholder="Enter amount"/><small>{suggestedFee.label}</small></label>
    <label>Seller-paid shipping<input name="shipping" type="number" inputMode="decimal" min="0" step="0.01" value={shipping} onChange={(event) => setShipping(event.currentTarget.value)} required placeholder={platform.toLowerCase()==='amazon'&&fulfillment==='seller'?'Enter if applicable':'0.00'}/><small>{platform.toLowerCase()==='amazon'&&fulfillment==='fba'?'FBA fulfillment charges are not included without a known rate.': 'Default is editable; enter the actual seller-paid amount.'}</small></label>
    <input type="hidden" name="other" value="0.00" />
    <div className="quick-sale-estimate full" aria-live="polite"><b>Estimated sale totals · not saved yet</b><div><span>Gross sale</span><strong>{estimated ? formatMoney(estimated.gross) : 'Complete amounts'}</strong></div><div><span>Estimated net proceeds</span><strong>{estimated ? formatMoney(estimated.net) : '—'}</strong></div><div><span>Estimated item profit</span><strong className={estimated && estimated.profit < 0 ? 'red-text' : ''}>{estimated ? formatMoney(estimated.profit) : '—'}</strong></div></div>
    <p className="quick-sale-cash-note full">Confirming records the sale as received cash immediately. The original asking price is preserved.</p>
  </div>
}
