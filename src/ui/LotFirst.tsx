import { ArrowLeft, ChevronRight, CircleDollarSign, Moon, Package, Pencil, Plus, ShoppingBag, Sun, WalletCards } from 'lucide-react'
import { ACTIVE_STATUSES, formatMoney, getMetrics, STATUS_LABELS, type InventoryItem, type PurchaseLot, type TrackerData } from '../domain'
import { itemSales, sortLotInventoryItems, summarizeLot } from '../lotView'

export function LotsOverview({ data, onOpenLot, onEditLot }: { data: TrackerData; onOpenLot: (id: string) => void; onEditLot: (lot: PurchaseLot) => void }) {
  if (!data.lots.length && !data.items.some((item) => !item.lotId)) return <div className="lot-empty panel"><div className="lot-empty-icon"><ShoppingBag size={25}/></div><h2>No purchase lots yet</h2><p>Lots imported from your Resale Tracker conversations will appear here.</p></div>
  return <div className="lot-card-list">{data.items.some((item) => !item.lotId) && <article className="lot-card panel"><button className="lot-card-main" onClick={() => onOpenLot('__standalone__')}><div className="lot-card-heading"><span className="lot-card-icon"><Package size={19}/></span><div><h2>Standalone acquisitions</h2><p>Items without a linked purchase lot</p></div><ChevronRight size={20}/></div><div className="lot-card-counts"><div><b>{data.items.filter((item) => !item.lotId).reduce((sum, item) => sum + (item.originalQuantity ?? item.quantity), 0)}</b><span>Purchased</span></div><div><b>{data.items.filter((item) => !item.lotId).reduce((sum, item) => sum + itemSales(data, item).reduce((sales, entry) => sales + entry.quantity, 0), 0)}</b><span>Sold</span></div><div><b>{data.items.filter((item) => !item.lotId && ACTIVE_STATUSES.includes(item.status)).reduce((sum, item) => sum + item.quantity, 0)}</b><span>Remaining</span></div></div><div className="lot-card-financials"><div><span>Allocated acquisition cost</span><b>{formatMoney(data.items.filter((item) => !item.lotId).reduce((sum, item) => sum + item.costCents, 0))}</b></div><div><span>Asking value · potential only</span><b>{formatMoney(data.items.filter((item) => !item.lotId && ACTIVE_STATUSES.includes(item.status)).reduce((sum, item) => sum + item.askingCents * item.quantity, 0))}</b></div></div></button></article>}{data.lots.map((lot) => {
    const summary = summarizeLot(data, lot)
    return <article className="lot-card panel" key={lot.id}>
      <button className="lot-card-main" onClick={() => onOpenLot(lot.id)} aria-label={`Open ${lot.name}`}>
        <div className="lot-card-heading"><span className="lot-card-icon"><ShoppingBag size={19}/></span><div><h2>{lot.name}</h2><p>{lot.acquisitions?.length ? `${lot.acquisitions[0].date} – ${lot.acquisitions.at(-1)?.date} · ${lot.source || 'Source not recorded'}` : `${lot.date} · ${lot.source || 'Source not recorded'}`}</p></div><ChevronRight size={20}/></div>
        <div className="lot-card-investment"><span>Purchase cost</span><strong>{formatMoney(lot.purchaseCents + lot.expensesCents)}</strong></div>
        <div className="lot-card-counts"><div><b>{summary.purchased}</b><span>Purchased</span></div><div><b>{summary.sold}</b><span>Sold</span></div><div><b>{summary.remaining}</b><span>Remaining</span></div></div>
        <div className="lot-card-financials"><div><span>Confirmed gross sales</span><b>{formatMoney(summary.grossConfirmedSalesCents)}</b></div><div><span>Lot cash position</span><b className={summary.cashPositionCents < 0 ? 'red-text' : 'green-text'}>{formatMoney(summary.cashPositionCents)}</b></div>{summary.storeCreditReceivedCents > 0 && <div><span>Store credit · not cash</span><b>{formatMoney(summary.storeCreditReceivedCents)}</b></div>}{summary.pendingOfferCents>0&&<div><span>Pending offers · not cash</span><b>{formatMoney(summary.pendingOfferCents)}</b></div>}</div>
      </button>
      <button className="lot-edit-action" onClick={() => onEditLot(lot)} aria-label={`Edit ${lot.name}`}><Pencil size={16}/> Edit lot</button>
    </article>
  })}</div>
}

export function LotInventory({ data, lot, onBack, onOpenItem, onAddItem, onEditLot }: { data: TrackerData; lot: PurchaseLot | null; onBack: () => void; onOpenItem: (item: InventoryItem) => void; onAddItem: () => void; onEditLot: () => void }) {
  const summary = lot ? summarizeLot(data, lot) : null
  const items = sortLotInventoryItems(data.items.filter((item) => lot ? item.lotId === lot.id : !item.lotId))
  const standalonePurchased = items.reduce((sum, item) => sum + (data.units?.filter((unit) => unit.itemId === item.id).length || item.originalQuantity || item.quantity), 0)
  const standaloneRemaining = items.filter((item) => ACTIVE_STATUSES.includes(item.status)).reduce((sum, item) => sum + item.quantity, 0)
  return <section className="lot-detail-view">
    <button className="back-link" onClick={onBack}><ArrowLeft size={17}/> All lots</button>
    <div className="lot-detail-header panel"><div><div className="eyebrow">{lot ? `PURCHASE LOT · ${lot.acquisitions?.length ? `${lot.acquisitions[0].date} – ${lot.acquisitions.at(-1)?.date}` : lot.date}` : 'STANDALONE ITEMS'}</div><h2>{lot?.name ?? 'Standalone acquisitions'}</h2><p>{lot?.source || (lot ? 'Source not recorded' : 'These items have no linked purchase lot.')}</p></div>{lot&&<button className="secondary" onClick={onEditLot}><Pencil size={16}/> Edit lot</button>}
      {lot?.acquisitions?.length ? <div className="lot-acquisitions"><b>Purchase records</b>{lot.acquisitions.map((acquisition) => <div key={acquisition.id}><span>{acquisition.date} · {acquisition.source}</span><strong>{formatMoney(acquisition.purchaseCents)}</strong>{acquisition.notes && <small>{acquisition.notes}</small>}</div>)}</div> : null}
      <div className="lot-detail-summary"><div><span>{lot ? 'Invested' : 'Allocated cost'}</span><b>{formatMoney(lot ? lot.purchaseCents + lot.expensesCents : items.reduce((sum, item) => sum + item.costCents, 0))}</b></div><div><span>Items remaining</span><b>{summary?.remaining ?? standaloneRemaining}</b></div>{summary&&<div><span>Cash position</span><b className={summary.cashPositionCents < 0 ? 'red-text' : 'green-text'}>{formatMoney(summary.cashPositionCents)}</b></div>}{summary&&summary.storeCreditReceivedCents>0&&<div><span>Store credit · not cash</span><b>{formatMoney(summary.storeCreditReceivedCents)}</b></div>}{summary&&summary.pendingOfferCents>0&&<div><span>Pending offers · not cash</span><b>{formatMoney(summary.pendingOfferCents)}</b></div>}</div>
    </div>
    <div className="lot-items-heading"><div><h2>{lot ? 'Items in this lot' : 'Standalone items'}</h2><p>{items.length} inventory records · {summary?.purchased ?? standalonePurchased} original units</p></div>{lot&&<button className="secondary" onClick={onAddItem}><Plus size={17}/> Add item</button>}</div>
    {items.length === 0 ? <div className="panel"><p className="muted">No items are linked to this lot yet.</p></div> : <div className="lot-item-list">{items.map((item) => {
      const sales = itemSales(data, item)
      const actual = sales.reduce((sum, entry) => sum + entry.grossCents, 0)
      const active = ACTIVE_STATUSES.includes(item.status) && item.quantity > 0
      return <button key={item.id} className="lot-item-card panel" onClick={() => onOpenItem(item)}>
        <span className="lot-item-image">{item.image ? <img src={item.image} alt=""/> : <Package size={20}/>}</span>
        <span className="lot-item-content"><b>{item.title}</b><span>{item.status === 'active' && item.platform.trim() ? `Listed on ${item.platform}` : item.platform || 'No platform'}{item.quantity > 1 ? ` · ${item.quantity} copies available` : ''}</span><span className="item-card-badges"><em className={`item-status status-${item.status}`}>{STATUS_LABELS[item.status]}</em>{sales.length > 0 && <em className="actual-price">Sale price {formatMoney(actual)}</em>}</span></span>
        <span className="lot-item-asking">{item.askingCents > 0 ? <><small>{item.status === 'active' ? 'Current asking' : 'Original asking'}</small><b>{formatMoney(item.askingCents)}</b></> : item.suggestedAskingCents ? <><small>Historical ask · unconfirmed</small><b>{formatMoney(item.suggestedAskingCents)}</b></> : <small>No asking price</small>}<ChevronRight size={17}/></span>
        {!active && sales.length === 0 && <span className="lot-item-terminal">{STATUS_LABELS[item.status]}</span>}
      </button>
    })}</div>}
  </section>
}

export function ItemDetails({ data, item, onBack, onEdit, onMarkSold }: { data: TrackerData; item: InventoryItem; onBack: () => void; onEdit: () => void; onMarkSold: () => void }) {
  const lot = data.lots.find((entry) => entry.id === item.lotId)
  const sales = itemSales(data, item)
  const soldQuantity = sales.reduce((sum, entry) => sum + entry.quantity, 0)
  const available = ACTIVE_STATUSES.includes(item.status) && item.quantity > 0
  return <section className="item-detail-view">
    <button className="back-link" onClick={onBack}><ArrowLeft size={17}/> {lot?.name ?? 'Lots'}</button>
    <article className="item-detail-card panel">
      {item.image && <img className="item-detail-image" src={item.image} alt=""/>}
      <div className="eyebrow">{lot ? `${lot.name} · ${lot.date}` : 'Standalone acquisition'}</div>
      <div className="item-detail-title"><h2>{item.title}</h2><button className="secondary" onClick={onEdit}><Pencil size={16}/> Edit</button></div>
      <p className="item-description">{item.description || 'No description recorded.'}</p>
      <div className="item-detail-status"><span className={`item-status status-${item.status}`}>{STATUS_LABELS[item.status]}</span><span>{item.quantity} available · {soldQuantity} sold</span></div>
      <div className="item-detail-financials"><div><span>Category</span><b>{item.category}</b></div><div><span>Allocated cost</span><b>{formatMoney(item.costCents)}</b></div><div><span>Current asking price</span><b>{item.askingCents ? formatMoney(item.askingCents) : 'Not set'}</b></div>{Boolean(item.suggestedAskingCents)&&<div><span>Historical ask · unconfirmed</span><b>{formatMoney(item.suggestedAskingCents??0)}</b></div>}<div><span>Listing platform</span><b>{item.status === 'active' && item.platform.trim() ? `Listed on ${item.platform}` : item.platform || 'Not listed'}</b></div><div><span>Actual sale price</span><b>{sales.length ? formatMoney(sales.reduce((sum, entry) => sum + entry.grossCents, 0)) : 'No sale recorded'}</b></div></div>
      {item.url && <a className="item-listing-link" href={item.url} target="_blank" rel="noreferrer">Open listing</a>}
      {item.notes && <div className="item-notes"><b>Notes</b><p>{item.notes}</p></div>}
      {sales.length > 0 && <section className="item-sale-history"><h3>Sale history</h3>{sales.map(({ sale, grossCents, quantity }) => <div className="item-sale-row" key={sale.id}><div><b>{formatMoney(grossCents)} · {sale.platform}</b><span>{sale.date||'Date unknown'} · {quantity} unit{quantity === 1 ? '' : 's'} · {sale.paymentStatus === 'paid' ? 'Cash received' : sale.paymentStatus === 'unpaid' ? 'Awaiting payment' : sale.paymentStatus}</span></div><span>{sale.feeCents + sale.shippingCents + sale.otherExpenseCents > 0 ? `${formatMoney(sale.feeCents + sale.shippingCents + sale.otherExpenseCents)} expenses` : 'No selling expenses'}</span></div>)}</section>}
      <div className="item-detail-actions">{available && <button className="primary mark-sold-button" onClick={onMarkSold}><CircleDollarSign size={19}/> Mark Sold</button>}<p>Asking prices are not sale revenue. Sales count as cash only after payment is confirmed.</p></div>
    </article>
  </section>
}

export function SettingsHome({ metrics, onOpen, dark, onToggleTheme, account, onSignOut }: { metrics: ReturnType<typeof getMetrics>; onOpen: (view: 'reports' | 'data' | 'transactions') => void; dark: boolean; onToggleTheme: () => void; account: string; onSignOut: () => void }) {
  const items = [
    { title: 'Financial reports', body: 'Profitability, cash recovery, monthly totals, and exports.', icon: WalletCards, action: 'reports' as const },
    { title: 'Transactions & expenses', body: 'Review and correct recorded sales, returns, payouts, and expenses.', icon: CircleDollarSign, action: 'transactions' as const },
    { title: 'Data management', body: 'Imports, reconciliation, backup, restore, and purchase record maintenance.', icon: Package, action: 'data' as const },
  ]
  return <section className="settings-home">
    <div className="settings-summary panel"><div className="eyebrow">PRIVATE WORKSPACE</div><h2>Settings</h2><p>Cloud records are protected by GitHub sign-in and revision-checked automatic saves.</p><div><span>Connected GitHub account</span><b>{account}</b></div><div><span>Current cash position</span><b>{formatMoney(metrics.overallCashPositionCents)}</b></div><div className="settings-account-actions"><button className="secondary" onClick={onToggleTheme}>{dark ? <Sun size={16}/> : <Moon size={16}/>} {dark ? 'Light theme' : 'Dark theme'}</button><button className="secondary" onClick={onSignOut}>Sign out</button></div></div>
    <div className="settings-card-list">{items.map(({ title, body, icon: Icon, action }) => <button className="settings-card panel" key={action} onClick={() => onOpen(action)}><span className="settings-card-icon"><Icon size={19}/></span><span><b>{title}</b><small>{body}</small></span><ChevronRight size={19}/></button>)}</div>
  </section>
}


