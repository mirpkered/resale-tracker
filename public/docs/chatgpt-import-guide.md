# ChatGPT import guide

Resale Tracker accepts manual JSON exports. It cannot read the Resale Tracker ChatGPT Project automatically. Current import format: `resale-tracker-migration`, schema version `1.0`.

- [Formal JSON Schema](./resale-migration.schema.v1.json)
- [Empty downloadable template](../examples/migration-template.v1.json)
- The app's **Reconciliation** screen validates each file and previews its effects before approval.

The examples and reference records in this guide are instructions only. They are not preloaded into a browser workspace or the private repository. Do not submit an example as a verified batch without replacing it with records checked against your conversations, receipts, and sale history.

## Required file structure

The root object requires `format`, `schemaVersion`, `source`, `purchaseGroups`, `purchaseLots`, `inventoryItems`, and `transactions`. `sales` is represented as `cash_sale` transaction records so sales, item quantities, and cash share a stable transaction ID.

```json
{
  "format": "resale-tracker-migration",
  "schemaVersion": "1.0",
  "source": { "id": "resale-tracker-project", "name": "Reviewed ChatGPT conversation records" },
  "purchaseGroups": [],
  "purchaseLots": [],
  "inventoryItems": [],
  "transactions": []
}
```

### Required fields by record

- Purchase group: `externalId`, `name`, and `verification.name`.
- Purchase lot: `externalId`, `name`, ISO `date` (`YYYY-MM-DD`), `source`, integer-cent `purchaseCents`, and verification for each supplied field.
- Inventory item: `externalId`, `title`, positive integer `quantity`, and verification for each supplied field. Use `lotExternalId` to connect it to a lot in this file or already imported under the same `source.id`.
- Transaction: `externalId`, `type`, ISO `date`, `paymentStatus`, and verification for each supplied field. A cash sale linked to inventory also needs one `itemQuantities` value for each `itemExternalIds` entry.
- `source.id` is required and must remain stable across every update batch from the same source. `source.name` is a human-readable label.

All amounts are non-negative integer cents: `$14.75` is `1475`. Do not use dollar decimals. `verification` maps every supplied material field name to one of the statuses below.

## Verification statuses

Use exactly one status for each imported field:

- `confirmed`: checked against a receipt, completed transaction record, or direct user confirmation.
- `estimated`: an approximate value with a known basis. It is not part of confirmed cash totals.
- `suggested`: proposed title, price, platform, or categorization. A suggested asking amount is potential value, never sale revenue.
- `pending`: awaiting payment, confirmation, or reconciliation.
- `unknown`: not available in the source material.

Unknown or absent values must not be invented. Listing suggestions stay drafts. A record is an active listing only when it has `listingState: "confirmed_active"` and `verification.listingState: "confirmed"`.

## Stable identifiers and repeat imports

Use lowercase, readable, source-specific IDs that do not depend on title, price, date formatting, or array position. Examples: `lot-goodwill-2026-11-01`, `item-ds-cartridge-black-01`, `sale-vinted-transaction-abc123`. A duplicate physical copy gets its own `unitExternalIds` value. Keep the same IDs and `source.id` on later exports.

If an incoming ID matches an existing record and all values match, the record is shown as existing and is not added twice. If values differ, the app shows a conflict with proposed fields. The user must check **Approve update** for that record and confirm the import. Title/date/lot fallback matching can flag likely duplicates; ambiguous matches block the import for manual review. Never assign a fresh ID to a correction; reuse the original stable ID.

For historical updates, include the complete record again with its original ID. This is especially important for purchase lots and inventory items: the preview shows changes to quantity, cost, price, and status before approval. A transaction's `externalId` protects it from duplicate import. Correcting the quantity on an already imported cash sale requires correcting the underlying return/inventory movement first; do not silently replay a sale with different units.

## Record fields

### Purchase groups

`purchaseGroups[]`: `externalId`, `name`, `verification`. Groups are reporting labels only. Each purchase transaction stays in `purchaseLots[]` and contributes its cost once.

### Purchase lots

`purchaseLots[]`: `externalId`, `name`, `date`, `source`, `purchaseCents`, optional `expensesCents`, `groupExternalId`, `notes`, `verification`. Item allocation totals may not exceed the lot's purchase price plus expenses. Any remainder stays unallocated and visible.

### Inventory items and copies

`inventoryItems[]`: `externalId`, optional `lotExternalId`, `title`, `description`, `category`, `quantity`, optional `inventoryStatus`, `allocatedCostCents`, `askingCents`, `suggestedAskingCents`, `platform`, `listingState`, `listingUrl`, `imageUrl`, `unitExternalIds`, `notes`, `verification`.

- `allocatedCostCents` is this item's total acquisition allocation across its copies.
- `askingCents` is a confirmed current asking price; `suggestedAskingCents` is kept separately.
- `quantity` is the number of copies represented. Supply a unique `unitExternalIds` entry for every tracked copy, or let the app generate internal copy IDs.
- Supported statuses: `acquired`, `draft`, `active`, `reserved`, `awaiting_payment`, `awaiting_fulfillment`, `completed`, `returned`, `traded`, `donated`, `disposed`.

### Transactions

`transactions[]` supports `cash_sale`, `buyback_payout`, `store_credit`, `reward`, `pending_offer`, and `other_expense`.

Fields: `externalId`, `type`, `date`, optional `platform`, `grossCents`, `feesCents`, `shippingCents`, `expensesCents`, `receivedCents`, `creditCents`, `creditDirection`, `expectedCents`, `paymentStatus`, `itemExternalIds`, `itemQuantities`, `notes`, `verification`.

- Cash sale: use actual gross, fees, seller-paid `shippingCents`, other `expensesCents`, confirmed received amount, and linked item IDs/quantities. Only `paymentStatus: "confirmed"` and confirmed `receivedCents` count as cash. This reduces available inventory and records item-level realized profit.
- Buyback payout: enter the completed payout as `buyback_payout`. An unaccepted offer remains `pending_offer`.
- Pending buyback/sale offer: `pending_offer` and `paymentStatus: "pending"`; use `expectedCents`. It never counts as received cash.
- Store credit and rewards: use `creditDirection: "issued"` or `"redeemed"` and `creditCents`. These never count as cash proceeds.
- Cash expense: `other_expense`, with a confirmed amount and `paymentStatus: "confirmed"`.

Do not import an asking price as gross or received sale money. Do not treat an offer as a completed sale. Bundle sales list each item once and include the quantity sold for each.

## Historical record handling notes

These are user-supplied reference facts, not seeded records. Validate the individual rows against original conversations/receipts before importing:

- If multiple receipts belong to one reporting group, create one lot per receipt and link them to the group. Never add a group-level purchase transaction or duplicate member-lot cost.
- Use only records verified in the source conversation, receipts, or current app. Do not infer a sale, pending transaction, proceeds, or inventory quantity from a listing or offer suggestion.
- For duplicate merchandise, assign a distinct stable copy ID to each physical unit. Estimated purchase costs and suggested listing values must remain marked unconfirmed until verified. Listing text remains a draft until the listing is confirmed active.

The app does not automatically generate those records. The user still has to approve the final preview.

## Complete example file

The following is a clearly fictional format example for schema testing. It is not a user record and should never be imported into the personal workspace as real inventory.

```json
{
  "format": "resale-tracker-migration",
  "schemaVersion": "1.0",
  "source": { "id": "fictional-format-example", "name": "Fictional schema example only" },
  "purchaseGroups": [
    { "externalId": "group-weekend", "name": "Weekend example purchases", "verification": { "name": "confirmed" } }
  ],
  "purchaseLots": [
    { "externalId": "lot-example-2026-05-01", "name": "Example shop lot", "date": "2026-05-01", "source": "Example shop", "purchaseCents": 1200, "expensesCents": 0, "groupExternalId": "group-weekend", "verification": { "name": "confirmed", "date": "confirmed", "source": "confirmed", "purchaseCents": "confirmed", "expensesCents": "confirmed", "groupExternalId": "confirmed" } }
  ],
  "inventoryItems": [
    { "externalId": "item-example-game-copy-a", "lotExternalId": "lot-example-2026-05-01", "title": "Example handheld game", "description": "Fictional example record", "category": "Games", "quantity": 2, "unitExternalIds": ["copy-example-a", "copy-example-b"], "allocatedCostCents": 1200, "suggestedAskingCents": 900, "platform": "Vinted", "listingState": "draft_suggestion", "verification": { "title": "confirmed", "description": "suggested", "category": "confirmed", "quantity": "confirmed", "unitExternalIds": "confirmed", "allocatedCostCents": "confirmed", "suggestedAskingCents": "suggested", "platform": "suggested", "listingState": "suggested" } }
  ],
  "transactions": [
    { "externalId": "offer-example-01", "type": "pending_offer", "date": "2026-05-02", "platform": "Vinted", "expectedCents": 800, "paymentStatus": "pending", "itemExternalIds": ["item-example-game-copy-a"], "notes": "Fictional pending offer", "verification": { "type": "confirmed", "date": "confirmed", "platform": "confirmed", "expectedCents": "pending", "paymentStatus": "pending", "itemExternalIds": "confirmed", "notes": "suggested" } }
  ]
}
```

## Approval and GitHub sync steps

1. Start an empty **Personal workspace**; demo records are isolated.
2. Have ChatGPT produce JSON using this guide and the schema. Verify IDs, dates, quantities, costs, listing confirmation, and transaction evidence.
3. In **Reconciliation**, select the JSON and run **Validate & preview**. Review existing records, potential duplicates, unverified/missing information, inventory quantity, purchase investment, asking value, confirmed cash, and realized profit.
4. Approve only reviewed conflicts, then confirm the import. The result is local to this browser at this point.
5. Open **Imports → GitHub data sync**, prepare the batch, upload it under `incoming/` in the private `mirpkered/resale-tracker-data` repository, and manually run its **Apply private data batch** Actions workflow.
6. Download `current/resale-data.v2.json` from the private repository and import it into the app to confirm the committed revision. A local change is not called persistent until that snapshot confirms it.

Never include GitHub tokens, secrets, or the private snapshot in a ChatGPT prompt or in the public app repository.
