# Resale Tracker migration JSON schema 1.0

Use this format to migrate manually verified records from ChatGPT conversations. Resale Tracker does not read Project conversations automatically. Begin with the downloadable empty template, replace its source identifier, then add only records supported by your records or mark uncertain fields with a verification status.

The formal [JSON Schema file](./resale-migration.schema.v1.json) can be attached to a ChatGPT prompt when generating a draft migration. The app also validates cross-record IDs, duplicate matches, and financial allocations before presenting its preview.

The app previews the migration first. Nothing is added until **Approve import into this browser** is confirmed. That approval changes only the current browser workspace. Durable storage requires the separate private GitHub workflow.

## Top level

```json
{
  "format": "resale-tracker-migration",
  "schemaVersion": "1.0",
  "source": { "id": "chat-history-2026", "name": "Verified resale conversations" },
  "purchaseGroups": [],
  "purchaseLots": [],
  "inventoryItems": [],
  "transactions": []
}
```

Every entity needs a stable `externalId`. Within one source, external IDs must be unique across groups, lots, items, and transactions. Reuse the same source ID and external ID when re-importing the same record. Repeated external identifiers with changed data are shown as conflicts. Exact title and purchase-lot matches are also detected; multiple possible matches are blocked as ambiguous.

## Verification

Each lot, item, and transaction needs a `verification` map. Values are `confirmed`, `estimated`, `suggested`, `pending`, or `unknown`. Apply the status to each material field, for example:

```json
"verification": {
  "purchaseCents": "confirmed",
  "expensesCents": "unknown",
  "title": "confirmed",
  "allocatedCostCents": "estimated",
  "askingCents": "suggested",
  "listingState": "pending"
}
```

All money fields are non-negative **integer cents**. For example, `1475` represents $14.75. Do not use decimal dollar strings or binary floating point values. Unverified acquisition values do not count as confirmed cash investment; unverified asking values are shown separately from confirmed asking value. Expected offers never count as received cash.

## Purchase groups and lots

`purchaseGroups` contains `{ "externalId", "name", "verification" }`. A purchase group is a reporting label only. Each transaction remains its own entry in `purchaseLots` with its own date, purchase amount, expenses, inventory allocations, and external ID. `groupExternalId` links a lot to one reporting group; group totals are sums of member lots and never create another cost.

```json
{
  "externalId": "lot-goodwill-2026-11-01",
  "name": "Thrift Purchase Lot A",
  "date": "2025-06-12",
  "source": "Local thrift store",
  "purchaseCents": 1475,
  "expensesCents": 0,
  "groupExternalId": "november-thrift-weekend",
  "notes": "Receipt photo reference",
  "verification": { "name": "confirmed", "source": "confirmed", "purchaseCents": "confirmed", "expensesCents": "confirmed", "date": "confirmed", "groupExternalId": "confirmed" }
}
```

Item `allocatedCostCents` totals for each lot may not exceed that lot's purchase and acquisition expense cost. An unallocated remainder remains visible after import.

## Inventory items and copies

Each `inventoryItems` record has `externalId`, `title`, and positive integer `quantity`. Optional values include `lotExternalId`, description, category, allocated cost, prices, platform, listing URL, image URL, notes, and `unitExternalIds`. If `unitExternalIds` is supplied, provide one distinct stable ID per copy. The app also creates an individual internal unit ID for every copy where unit IDs were omitted.

`listingState` is either `draft_suggestion` or `confirmed_active`. An item becomes an active listing only when `listingState` is `confirmed_active` **and** `verification.listingState` is `confirmed`. Suggested titles/prices or a generated listing draft remain unlisted/draft. `askingCents` is for a confirmed asking price; `suggestedAskingCents` is kept separately.

Optional `inventoryStatus` supports the app statuses `acquired`, `draft`, `active`, `reserved`, `awaiting_payment`, `awaiting_fulfillment`, `completed`, `returned`, `traded`, `donated`, or `disposed`. It applies only when `verification.inventoryStatus` is `confirmed`.

```json
{
  "externalId": "nintendo-game-copies-01",
  "lotExternalId": "lot-goodwill-2026-11-01",
  "title": "Nintendo DS game",
  "category": "Games",
  "quantity": 2,
  "unitExternalIds": ["game-copy-a", "game-copy-b"],
  "allocatedCostCents": 1200,
  "askingCents": 0,
  "suggestedAskingCents": 1800,
  "listingState": "draft_suggestion",
  "verification": { "title": "confirmed", "category": "confirmed", "lotExternalId": "confirmed", "quantity": "confirmed", "unitExternalIds": "confirmed", "allocatedCostCents": "estimated", "askingCents": "unknown", "suggestedAskingCents": "suggested", "listingState": "pending" }
}
```

## Financial transactions

Each transaction needs a unique external ID, ISO date, type, payment status, and verification map. Types:

- `cash_sale`: sale proceeds; only confirmed `receivedCents` with `paymentStatus: confirmed` count as cash.
- `buyback_payout`: a trade-in/buyback cash payout, subject to the same confirmed-payment rule.
- `store_credit`: credit ledger entry; set `creditDirection` to `issued` or `redeemed`. It is not cash.
- `reward`: rewards balance entry; set `creditDirection` to `issued` or `redeemed`. It is not cash.
- `pending_offer`: expected proceeds only; use `expectedCents` and `paymentStatus: pending`. It never counts as cash received.
- `other_expense`: cash outflow in `expensesCents` once confirmed and paid.

Optional money fields include `grossCents`, `feesCents`, `expensesCents`, `receivedCents`, `creditCents`, and `expectedCents`. Use `itemExternalIds` to associate related inventory where known. For example:

```json
{
  "externalId": "offer-ebay-2026-11-10-1",
  "type": "pending_offer",
  "date": "2026-11-10",
  "platform": "eBay",
  "grossCents": 2400,
  "feesCents": 0,
  "expensesCents": 0,
  "receivedCents": 0,
  "expectedCents": 2400,
  "paymentStatus": "pending",
  "itemExternalIds": ["nintendo-game-copies-01"],
  "verification": { "grossCents": "suggested", "expectedCents": "suggested", "paymentStatus": "pending" }
}
```

The financial preview reports changes to confirmed purchase investment, inventory quantity, confirmed asking value, cash received, and expected future proceeds. Estimated/suggested/pending/unknown amounts remain labeled and do not become cash.
