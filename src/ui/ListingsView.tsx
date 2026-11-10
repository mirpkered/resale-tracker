import { ArrowUpRight, Archive, Package, Search, Tag } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { InventoryItem, TrackerData } from '../domain'
import { formatMoney } from '../domain'
import { listingGroupLabel, listingPriceLabel, selectGlobalListings, type ListingsFilter } from '../listingsView'

export function ListingsView({ data, onOpenItem, onOpenLot, onEditItem, hidden = false }: {
  data: TrackerData
  onOpenItem: (item: InventoryItem) => void
  onOpenLot: (lotId: string) => void
  onEditItem: (item: InventoryItem) => void
  hidden?: boolean
}) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ListingsFilter>('listed')
  const [platform, setPlatform] = useState('')
  const [lotId, setLotId] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const rows = useMemo(() => selectGlobalListings(data, { search, status, platform, lotId, showArchived }), [data, search, status, platform, lotId, showArchived])
  const archivedCount = data.items.filter((item) => item.archived).length
  const platforms = [...new Set([...data.platforms.map((entry) => entry.name), ...data.items.map((item) => item.platform).filter(Boolean)])].sort((a, b) => a.localeCompare(b))
  return <section className="global-listings" hidden={hidden} aria-label="Global listings">
    <div className="panel listings-filters">
      <label className="listing-search"><span>Search inventory</span><span className="listing-search-control"><Search size={17}/><input type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Title, category, lot…"/></span></label>
      <label>Status<select value={status} onChange={(event) => setStatus(event.currentTarget.value as ListingsFilter)}><option value="listed">Listed</option><option value="unlisted">Unlisted</option><option value="sold">Sold</option><option value="disposed">Disposed</option><option value="all">All statuses</option></select></label>
      <label>Platform<select value={platform} onChange={(event) => setPlatform(event.currentTarget.value)}><option value="">All platforms</option>{platforms.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      <label>Purchase lot<select value={lotId} onChange={(event) => setLotId(event.currentTarget.value)}><option value="">All lots</option><option value="__standalone__">Standalone acquisitions</option>{data.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.name}</option>)}</select></label>
      {archivedCount > 0 && <label className="listings-archived-toggle"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.currentTarget.checked)}/> Show archived items ({archivedCount})</label>}
    </div>
    <div className="listing-results-heading"><div><h2>{status === 'all' ? 'All inventory' : `${status[0].toUpperCase()}${status.slice(1)} inventory`}</h2><p>{rows.length} item record{rows.length === 1 ? '' : 's'} · records represent individual inventory entries</p></div></div>
    {rows.length === 0 ? <div className="panel listings-empty"><span><Archive size={20}/></span><b>No matching inventory</b><small>Try another status, platform, lot, or search.</small></div> : <div className="global-listing-list">{rows.map((item) => {
      const lot = data.lots.find((entry) => entry.id === item.lotId)
      const price = listingPriceLabel(data, item)
      const group = listingGroupLabel(item)
      const activeCopies = item.status === 'active' ? item.quantity : 0
      return <article className="global-listing-card panel" key={item.id}>
        <button className="global-listing-main" type="button" onClick={() => onOpenItem(item)}>
          <span className="global-listing-icon">{item.image ? <img src={item.image} alt=""/> : <Package size={19}/>}</span>
          <span className="global-listing-copy"><b>{item.title}{item.archived && <em className="archived-item-badge">Archived</em>}</b><small>{lot?.name ?? 'Standalone acquisition'} · {item.category || 'Uncategorized'}</small><span className={`item-status status-${item.status}`}>{group}{item.platform && group === 'Listed' ? ` on ${item.platform}` : ''}{activeCopies > 1 ? ` · ${activeCopies} available copies` : ''}</span></span>
          <span className="global-listing-price"><small>{price.label}</small>{price.cents !== undefined && <b>{formatMoney(price.cents)}</b>}</span>
        </button>
        <div className="global-listing-actions"><button className="secondary" type="button" onClick={() => onEditItem(item)}><Tag size={15}/> Edit item</button><button className="listing-lot-link" type="button" onClick={() => onOpenLot(item.lotId ?? '__standalone__')}>Open lot <ArrowUpRight size={14}/></button></div>
      </article>
    })}</div>}
  </section>
}
