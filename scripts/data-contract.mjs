import { createHash, randomUUID } from 'node:crypto'

export const DOCUMENT_SCHEMA = '2.0'
export const BATCH_SCHEMA = '1.0'

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function sha256(value) { return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex') }

export function emptyData() { return { lots: [], items: [], sales: [], expenses: [], credit: [], platforms: [] } }

export function emptyDocument(now = new Date().toISOString()) {
  return { schemaVersion: DOCUMENT_SCHEMA, revision: 0, updatedAt: now, lastBatchId: null, lastBatchHash: null, importedBatches: [], audit: [], data: emptyData() }
}

function assert(condition, message) { if (!condition) throw new Error(message) }
function uniqueIds(rows, label) {
  const ids = new Set()
  for (const row of rows) { assert(typeof row.id === 'string' && row.id.length > 0, `${label} record is missing an ID.`); assert(!ids.has(row.id), `Duplicate ${label} ID: ${row.id}`); ids.add(row.id) }
  return ids
}
function cents(value, label) { assert(Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative integer number of cents.`) }

export function validateData(data) {
  assert(data && typeof data === 'object', 'Data payload must be an object.')
  for (const key of ['lots', 'items', 'sales', 'expenses', 'credit', 'platforms']) assert(Array.isArray(data[key]), `Data is missing ${key}.`)
  const lots = uniqueIds(data.lots, 'lot'), items = uniqueIds(data.items, 'item'); uniqueIds(data.sales, 'sale')
  uniqueIds(data.expenses, 'expense'); uniqueIds(data.credit, 'store-credit transaction'); uniqueIds(data.platforms, 'platform')
  if (data.purchaseGroups !== undefined) uniqueIds(data.purchaseGroups, 'purchase group')
  if (data.units !== undefined) uniqueIds(data.units, 'inventory unit')
  if (data.ledgerTransactions !== undefined) {
    uniqueIds(data.ledgerTransactions, 'ledger transaction')
    const external = new Set()
    for (const transaction of data.ledgerTransactions) {
      const key = `${transaction.externalSource}:${transaction.externalId}`
      assert(transaction.externalSource && transaction.externalId && !external.has(key), `Missing or duplicate ledger external ID: ${key}`); external.add(key)
      for (const field of ['grossCents', 'feesCents', 'expensesCents', 'receivedCents', 'creditCents', 'expectedCents']) cents(transaction[field], `Ledger ${field}`)
      cents(transaction.shippingCents ?? 0, 'Ledger shipping')
      if (transaction.itemQuantities !== undefined) { assert(Array.isArray(transaction.itemExternalIds) && transaction.itemQuantities.length === transaction.itemExternalIds.length && transaction.itemQuantities.every((quantity) => Number.isSafeInteger(quantity) && quantity > 0), `Ledger ${key} item quantities are invalid.`); assert(new Set(transaction.itemExternalIds).size === transaction.itemExternalIds.length, `Ledger ${key} contains duplicate item references.`) }
      for (const field of ['saleAllocatedCostCents', 'saleAllocatedProceedsCents']) if (transaction[field] !== undefined) { assert(Array.isArray(transaction[field]) && transaction[field].length === (transaction.itemExternalIds ?? []).length, `Ledger ${key} ${field} does not match its item references.`); for (const amount of transaction[field]) cents(amount, `Ledger ${field}`) }
      if (transaction.itemUnitIds !== undefined) { assert(Array.isArray(transaction.itemUnitIds) && transaction.itemUnitIds.length === (transaction.itemExternalIds ?? []).length, `Ledger ${key} unit IDs do not match its item references.`); for (const ids of transaction.itemUnitIds) assert(Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === 'string'), `Ledger ${key} contains an invalid sold-unit list.`) }
    }
  }
  if (data.auditEvents !== undefined) { uniqueIds(data.auditEvents, 'local audit event'); for (const event of data.auditEvents) assert(typeof event.at === 'string' && typeof event.action === 'string' && typeof event.summary === 'string', `Local audit event ${event.id} is invalid.`) }
  const allocations = new Map()
  for (const lot of data.lots) { cents(lot.purchaseCents, 'Lot purchase cost'); cents(lot.expensesCents, 'Lot expenses') }
  for (const item of data.items) {
    cents(item.costCents, 'Item acquisition cost'); cents(item.askingCents, 'Item asking price')
    assert(Number.isSafeInteger(item.quantity) && item.quantity >= 0, `Item ${item.id} quantity is invalid.`)
    if (item.lotId !== null) { assert(lots.has(item.lotId), `Item ${item.id} references a missing purchase lot.`); allocations.set(item.lotId, (allocations.get(item.lotId) ?? 0) + item.costCents) }
  }
  for (const unit of data.units ?? []) assert(items.has(unit.itemId), `Inventory unit ${unit.id} references a missing item.`)
  const unitById = new Map((data.units ?? []).map((unit) => [unit.id, unit]))
  const soldUnits = new Set()
  const groups = new Set((data.purchaseGroups ?? []).map((group) => group.id))
  for (const lot of data.lots) if (lot.reportingGroupId) assert(groups.has(lot.reportingGroupId), `Purchase lot ${lot.id} references a missing reporting group.`)
  for (const lot of data.lots) assert((allocations.get(lot.id) ?? 0) <= lot.purchaseCents + lot.expensesCents, `Item allocations exceed purchase lot ${lot.id}.`)
  for (const sale of data.sales) {
    for (const key of ['grossCents', 'feeCents', 'shippingCents', 'otherExpenseCents', 'receivedCents', 'refundCents', 'creditCents']) cents(sale[key], `Sale ${sale.id} ${key}`)
    for (const line of sale.lines ?? []) { assert(items.has(line.itemId), `Sale ${sale.id} references missing item ${line.itemId}.`); assert(Number.isSafeInteger(line.quantity) && line.quantity > 0, `Sale ${sale.id} line quantity is invalid.`); assert(!line.unitIds || line.unitIds.length === line.quantity, `Sale ${sale.id} unit IDs do not match its quantity.`); cents(line.allocatedCostCents, 'Allocated acquisition cost'); cents(line.proceedsCents ?? 0, 'Allocated proceeds'); for (const [index, unitId] of (line.unitIds ?? []).entries()) { const unit = unitById.get(unitId); assert(unit && unit.itemId === line.itemId, `Sale ${sale.id} references an invalid inventory unit ${unitId}.`); if (index >= (line.returnedQuantity ?? 0)) { assert(!soldUnits.has(unitId), `Inventory unit ${unitId} appears in multiple unreturned sales.`); soldUnits.add(unitId) } } }
  }
  for (const expense of data.expenses) cents(expense.amountCents, 'Expense')
  for (const transaction of data.credit) cents(transaction.amountCents, 'Store credit amount')
  return data
}

export function validateDocument(document) {
  assert(document?.schemaVersion === DOCUMENT_SCHEMA, `Unsupported data schema version: ${document?.schemaVersion ?? 'missing'}.`)
  assert(Number.isSafeInteger(document.revision) && document.revision >= 0, 'Document revision is invalid.')
  assert(Array.isArray(document.importedBatches) && Array.isArray(document.audit), 'Document import history or audit history is invalid.')
  validateData(document.data)
  return document
}

export function makeBatch(data, baseRevision, batchId = randomUUID(), createdAt = new Date().toISOString()) {
  validateData(data)
  assert(Number.isSafeInteger(baseRevision) && baseRevision >= 0, 'Base revision is invalid.')
  return { format: 'resale-tracker-sync-batch', schemaVersion: BATCH_SCHEMA, batchId, baseRevision, createdAt, data }
}

export function applyBatch(current, batch, { now = new Date().toISOString(), actor = 'github-user' } = {}) {
  validateDocument(current)
  assert(batch?.format === 'resale-tracker-sync-batch' && batch.schemaVersion === BATCH_SCHEMA, 'Unsupported sync batch format.')
  assert(typeof batch.batchId === 'string' && batch.batchId.length > 0, 'Batch ID is required.')
  validateData(batch.data)
  const hash = sha256(batch)
  const prior = current.importedBatches.find((entry) => entry.batchId === batch.batchId)
  if (prior) {
    assert(prior.sha256 === hash, 'This batch ID was previously used with different content.')
    return { document: current, duplicate: true, hash }
  }
  assert(batch.baseRevision === current.revision, `Revision conflict: batch is based on ${batch.baseRevision}, current data is revision ${current.revision}.`)
  const revision = current.revision + 1
  const event = { id: randomUUID(), at: now, actor, action: 'sync_import', summary: `Applied batch ${batch.batchId}`, baseRevision: current.revision, revision, batchId: batch.batchId }
  const entry = { batchId: batch.batchId, sha256: hash, appliedRevision: revision, appliedAt: now }
  return { document: { ...current, schemaVersion: DOCUMENT_SCHEMA, revision, updatedAt: now, lastBatchId: batch.batchId, lastBatchHash: hash, importedBatches: [...current.importedBatches, entry], audit: [...current.audit, event], data: batch.data }, duplicate: false, hash }
}

export function restoreBackup(current, backup, { expectedRevision, now = new Date().toISOString(), actor = 'github-user' } = {}) {
  validateDocument(current); validateDocument(backup)
  assert(expectedRevision === current.revision, `Revision conflict: expected ${expectedRevision}, current data is revision ${current.revision}.`)
  const revision = current.revision + 1
  const restoreId = randomUUID()
  const event = { id: randomUUID(), at: now, actor, action: 'backup_restore', summary: `Restored data from revision ${backup.revision}`, baseRevision: current.revision, revision, batchId: restoreId }
  const batches = new Map([...current.importedBatches, ...backup.importedBatches].map((entry) => [entry.batchId, entry]))
  return { ...current, revision, updatedAt: now, lastBatchId: restoreId, lastBatchHash: sha256(backup.data), importedBatches: [...batches.values()], audit: [...current.audit, event], data: backup.data }
}

export function safeParseDocument(text) { return validateDocument(JSON.parse(text)) }
