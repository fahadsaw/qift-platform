# Phase 3 — Variants + Inventory Architecture

**Status:** Architecture / design document only. No code, no migrations, no frontend or backend implementation lands with this PR.

**Scope:** Two new commerce models — variant-level inventory (boxed) and weight-based shared pool inventory (bulk). Closed-beta-safe, additive, fully backward-compatible with the current `SIMPLE` product model.

**Reading order:** Audit findings (§1) → Locked decisions (§2) → Schema (§3) → Reservation + checkout (§4) → Merchant + storefront UX (§5–§6) → Migration phases (§7) → Rollback + safety (§8–§9) → Open items (§10).

---

## 1. Audit findings — what the current model assumes

### 1.1 Current `Product` shape (`prisma/schema.prisma:722`)

```
Product {
  id, storeId, name, price, imageUrl, category,
  isFastDelivery, sourceType, externalProductId,
  stockStatus  String  @default("in_stock")     ← BINARY
  isAvailable  Boolean @default(true)           ← soft-disable flag
  videoUrl, videoType                            ← Phase 2.5a
  images: ProductImage[]                         ← Phase 5 gallery
}
```

### 1.2 Single-unit assumptions in the codebase

| Layer | Assumption | Anchor |
|---|---|---|
| `Product` row | One product = one SKU = one price = one binary stock state | `prisma/schema.prisma:722` |
| `Product.stockStatus` | `'in_stock' \| 'out_of_stock'` — no quantity tracking | line 733 |
| `Product.price` | Float SAR, denormalized into `Order.productPrice` at checkout | line 725 |
| `Order` / `Gift` | One `productId` per order; one denormalized `productName` / `productPrice` per row | `prisma/schema.prisma:826, 334` |
| `ProductsService.checkAvailability()` | Throws on `!isAvailable` or `stockStatus !== 'in_stock'`. No quantity check, no reservation | `apps/api/src/products/products.service.ts:306` |
| Frontend checkout | URL carries one `productId`; `POST /orders` body has `productPrice: Float` | `app/checkout/page.tsx:57` |
| Frontend ProductModal | One `name`, one `price`, one `category` per `Product` row (gallery is multi-image but single-product) | `components/ProductModal.tsx` |
| Storefront render | Per-product card; no variant picker; no quantity selector; no weight picker | `components/storefront/StorefrontPage.tsx` |

### 1.3 Parallel infrastructure already on main (Phase 9.1.a)

Multi-merchant cart schema exists but is not wired into the closed-beta single-gift flow:

| Model | Quantity-aware? | Variant-aware? | Unit-aware? |
|---|---|---|---|
| `MerchantOrderLineItem` (line 2439) | ✓ `quantity: Int`, `unitPriceAtPurchase: Int` | ✗ no variant FK | ✗ no unit |
| `ShipmentLineItem` (line 2493) | ✓ `quantityShipped: Int` | ✗ | ✗ |
| `RefundRequest`, `PaymentAllocation` | derived from line totals | ✗ | ✗ |

The shape already tracks "how many of X", but **every "unit" is implicitly a countable identical item**. Nothing today supports "0.25 kg of bulk product" or "the medium-size variant."

### 1.4 What breaks under the new requirements

| Requirement | What breaks today | Severity |
|---|---|---|
| Per-variant inventory (Royal Oud: 10 boxes of 1/8 kg, 5 of 1/4 kg, etc.) | `Product` is the only inventory anchor; sibling variants would need to be separate Products — wrong because they share a wishlist, gallery, name, category | **Hard breaker** |
| Per-variant price | `Product.price` is the only price field. Variant prices would need separate Products | **Hard breaker** |
| Shared inventory pool (10 kg → sold as tola / 1/8 kg / etc.) | No concept of a shared pool. `stockStatus` is binary. No way to deduct fractional inventory | **Hard breaker** |
| Dynamic unit availability (1 kg disabled because only 0.5 kg left) | No quantity, no unit, no remaining-inventory math anywhere | **Hard breaker** |
| Structured units (tola = 11.66 g, with safe conversions) | No `MeasurementUnit` model. Unit is implicit "1 of product" | **Hard breaker** |
| Concurrent-safe sales (two buyers grab the last 0.5 kg simultaneously) | No reservation layer. `checkAvailability()` is a read; order-create doesn't atomically deduct inventory | **Hard breaker** |
| Stale wishlist row that points at a sold-out variant | `Wish.productId` only. Variant-level wish needs a different anchor | Medium (Phase 3.5) |
| Per-variant images | `ProductImage` is per-product. Variant-specific imagery needs a new FK | Medium (deferred per §2 decision 3) |
| Gift posts referencing variants | `Gift.productId` + `productName` snapshot only | Medium (Phase 3.4) |

---

## 2. Locked decisions

The following decisions are FINAL for closed-beta Phase 3. All subsequent sections of this document are written against them.

| # | Decision | Rationale |
|---|---|---|
| **D-1** | **Reservation TTL = 15 minutes** (configurable via env, but the default is 15 min) | Long enough to complete a real checkout; short enough that abandoned carts release inventory quickly. Reservations live in `InventoryReservation` rows (see §4); a sweep worker transitions stale rows to `EXPIRED` |
| **D-2** | **Bulk refund / restock = MANUAL ONLY** | Refunds affect finance only by default. Returned bulk inventory is NEVER automatically restocked. For categories like oud, incense, perfume, flowers, chocolate, food, the returned goods may not be sellable again. Restock requires an explicit merchant or admin action via a dedicated "Restock returned inventory" surface (Phase 3.6) |
| **D-3** | **Variant-specific images are DEFERRED**. Phase 3.2 falls back to product-level gallery images for every variant | Keeps the variant editor minimal during closed beta; merchants can ship variants without juggling per-size imagery. Reconsidered in Phase 3.7 polish |
| **D-4** | **Measurement units are READ-ONLY** and shipped via code / admin migration only. Merchants cannot create arbitrary measurement units during closed beta | Prevents merchant-side mistakes (typos, wrong conversion factors) from corrupting inventory math. Custom units come back as a polish slice once the system surface is proven |
| **D-5** | **Tola conversion = 11.66 g** for initial seed. Domain expert validation required before public launch | Common literature value. Recorded with an explicit follow-up flag in `MeasurementUnit.notes` so a future migration can correct the seed if a domain expert lands on a more precise figure |
| **D-6** | **Default bulk pricing mode = `PER_UNIT`** | Most merchants think "1/8 kilo = 80 SAR, 1/4 kilo = 150 SAR" — not in price-per-gram. `PER_BASE` remains supported as an alternative mode for merchants who genuinely price per gram |
| **D-7** | **This PR is document-only.** No code, no migrations, no frontend, no backend implementation lands here | Architecture is reviewed and approved before any implementation begins. Phase 3.1 is the first slice that ships code |

---

## 3. Schema proposal

All shapes below are **proposals**. None of them land with this PR. The Phase 3.1 implementation slice will commit the exact Prisma syntax.

### 3.1 `ProductInventoryMode` — top-level discriminator

A new column on `Product`:

```
enum ProductInventoryMode {
  SIMPLE     // existing closed-beta path; one product = one inventory unit;
             // backward-compatible with every legacy Product row
  VARIANT    // boxed model — fixed per-variant SKUs with own stock + price
  BULK_POOL  // weight/volume-based pool — total inventory in a normalized
             // base unit, sold in merchant-allowed units
}

Product {
  ...
  inventoryMode  ProductInventoryMode  @default(SIMPLE)
}
```

**Why an enum, not a boolean:** even though closed beta needs only 2 of the 3 user-driven modes, keeping `SIMPLE` as the default means every legacy `Product` is in a defined state with zero migration writes. Future modes (bundle, subscription, dynamic-pricing) extend the enum without breaking older clients.

### 3.2 `ProductVariant` — boxed inventory

```
ProductVariant {
  id              String   @id @default(cuid())
  productId       String
  product         Product  @relation(...)

  // Display
  name            String   // "1/8 kilo", "Medium", "Red — Size 42"
  displayOrder    Int      @default(0)

  // D-3: Variant-specific images deferred. No imageUrl column on
  // ProductVariant in Phase 3.2. Storefront falls back to
  // Product.images[0] for every variant. Add `imageUrl String?`
  // in a Phase 3.7 polish migration when the feature is needed.

  // Pricing (overrides Product.price for this variant)
  price           Int      // minor units — halalas for SAR (see §3.6)
  currency        String   @default("SAR")

  // Inventory
  stockCount      Int      @default(0)  // remaining sellable units
  isAvailable     Boolean  @default(true)
  // Stable merchant-side SKU. Optional. Indexed for the API sync
  // path (sourceType='api').
  externalSku     String?

  // Optional weight stamp — useful for shipping calculation even
  // on boxed products (e.g. a 1/8-kg box weighs ~125 g + packaging).
  // Pure metadata; doesn't drive variant selection.
  weightGrams     Int?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  reservations    InventoryReservation[]

  @@unique([productId, displayOrder])
  @@unique([productId, externalSku])
  @@index([productId, isAvailable])
}
```

**Invariants** (app-layer assertions; not DB CHECKs):

- `Product.inventoryMode = 'VARIANT'` ⇒ every variant must have `price`, `stockCount ≥ 0`, non-empty `name`.
- `Product.inventoryMode != 'VARIANT'` ⇒ no `ProductVariant` rows exist for that product (empty `variants` relation).
- Variant deletion cascades from Product deletion.
- A merchant's Royal Oud example becomes: 1 `Product` (mode=VARIANT, name="Royal Oud") + 4 `ProductVariant` rows (1/8 kg with stockCount=10, 1/4 kg with stockCount=5, 1/2 kg with stockCount=2, 1 kg with stockCount=1).

### 3.3 `MeasurementUnit` — structured units (D-4: read-only)

```
enum MeasurementDimension {
  WEIGHT   // base: gram
  VOLUME   // base: millilitre — reserved for future
  COUNT    // base: piece — for countable items if needed
}

MeasurementUnit {
  id              String   @id @default(cuid())
  // Stable identifier used by API + UI. NOT user-editable in
  // closed beta (D-4). Future merchant-custom units land via a
  // separate migration with isSystem=false; closed beta seeds
  // only isSystem=true rows.
  code            String   @unique
  dimension       MeasurementDimension
  // How many BASE units one of THIS unit equals. Stored as
  // Decimal(20,6) (or as BigInt micro-base-units — see §3.6).
  basePerUnit     Decimal  // tola → 11.66, eighth_kilo → 125, ...
  // i18n label key — actual strings live in lib/translations.ts.
  labelKey        String
  // Sort order in the merchant unit picker.
  displayOrder    Int      @default(0)
  // System-defined vs merchant-custom. Closed beta = always true.
  isSystem        Boolean  @default(true)
  // Free-text operator note. Used by D-5 to flag the tola seed
  // for domain-expert validation before public launch.
  notes           String?
  createdAt       DateTime @default(now())

  pools           InventoryPoolUnit[]

  @@index([dimension])
}
```

**Seed data for closed beta** (D-4: shipped in the Phase 3.1 migration):

| `code` | `dimension` | `basePerUnit` | `labelKey` | `notes` |
|---|---|---|---|---|
| `gram` | WEIGHT | 1 | `units.label_gram` | — |
| `tola` | WEIGHT | 11.66 | `units.label_tola` | **D-5: validate before public launch** |
| `eighth_kilo` | WEIGHT | 125 | `units.label_eighth_kilo` | — |
| `quarter_kilo` | WEIGHT | 250 | `units.label_quarter_kilo` | — |
| `half_kilo` | WEIGHT | 500 | `units.label_half_kilo` | — |
| `kilo` | WEIGHT | 1000 | `units.label_kilo` | — |

System units are READ-ONLY via the API. New units land via migration only. This gives a clean audit trail (`git log prisma/migrations/`) for every unit ever offered to merchants.

### 3.4 `InventoryPool` — bulk inventory

```
enum BulkPricingMode {
  PER_BASE    // price defined per base unit (e.g. SAR/g)
  PER_UNIT    // each allowed unit has its own price (D-6: default)
}

InventoryPool {
  id                       String   @id @default(cuid())
  productId                String   @unique
  product                  Product  @relation(...)

  dimension                MeasurementDimension

  // §3.6: BigInt micro-base-units. 1 gram = 1_000_000 micros.
  // Stored this way to avoid Decimal-on-Prisma quirks across
  // aggregation paths while keeping lossless tola arithmetic.
  totalQuantityBaseMicros     BigInt
  // Already-sold (CONFIRMED reservations). Decremented from
  // remaining = total - sold - reserved.
  soldQuantityBaseMicros      BigInt   @default(0)
  // Sum of ACTIVE reservations.
  reservedQuantityBaseMicros  BigInt   @default(0)

  // D-6: default = PER_UNIT.
  pricingMode              BulkPricingMode  @default(PER_UNIT)
  // PER_BASE only. Minor units per base unit (halalas/gram).
  // Null for PER_UNIT pools.
  pricePerBase             Int?
  currency                 String   @default("SAR")

  // Optional minimum sale quantity (in base micros). Prevents
  // accidental 0.001 g sales.
  minSaleQuantityBaseMicros BigInt?

  createdAt                DateTime @default(now())
  updatedAt                DateTime @updatedAt

  allowedUnits             InventoryPoolUnit[]
  reservations             InventoryReservation[]

  @@index([productId])
}

// Junction: which units (from MeasurementUnit) does this pool
// allow as sale increments? Optional per-unit price override
// when pricingMode = PER_UNIT.
InventoryPoolUnit {
  id              String   @id @default(cuid())
  poolId          String
  pool            InventoryPool @relation(...)
  unitId          String
  unit            MeasurementUnit @relation(...)
  // D-6: PER_UNIT pools require pricePerUnit. PER_BASE pools
  // leave it null; price derived from
  //   basePerUnit × pool.pricePerBase
  pricePerUnit    Int?
  displayOrder    Int      @default(0)
  // Merchant can toggle a unit "off" without deleting the row.
  isEnabled       Boolean  @default(true)
  createdAt       DateTime @default(now())

  @@unique([poolId, unitId])
  @@index([poolId, displayOrder])
}
```

**Invariants** (app-layer):

- `Product.inventoryMode = 'BULK_POOL'` ⇔ exactly one `InventoryPool` row exists for this product.
- Every `InventoryPoolUnit.unitId` must reference a `MeasurementUnit` of the matching `dimension`.
- Remaining = `totalQuantityBaseMicros − soldQuantityBaseMicros − reservedQuantityBaseMicros`. Must always be ≥ 0.
- For `PER_BASE` pools, `pricePerBase` is required and every `InventoryPoolUnit.pricePerUnit` is null.
- For `PER_UNIT` pools (D-6 default), every enabled `InventoryPoolUnit` must have a `pricePerUnit`. `pricePerBase` is null.

### 3.5 `InventoryReservation` — concurrency-safe deduction

```
enum ReservationStatus {
  ACTIVE       // holding inventory; counts against pool.reservedQuantityBaseMicros
  CONFIRMED    // payment succeeded; deducted from pool.soldQuantityBaseMicros
  RELEASED     // explicitly released (payment failed, order cancelled)
  EXPIRED      // sweep job released after expiresAt
}

InventoryReservation {
  id                String   @id @default(cuid())
  // Exactly ONE of poolId / variantId is non-null. App-layer
  // assertion (DB CHECK constraint optional).
  poolId            String?
  pool              InventoryPool? @relation(...)
  variantId         String?
  variant           ProductVariant? @relation(...)
  // Quantity in micro-base-units for pool reservations; for
  // variants, this is just the count (in micros for uniform
  // arithmetic — 1 variant = 1_000_000 micros).
  quantityBaseMicros BigInt
  status            ReservationStatus  @default(ACTIVE)
  // Owning order context. Joined via lineItemId so a partial
  // refund / cancel releases just that line's reservation.
  lineItemId        String?
  lineItem          MerchantOrderLineItem? @relation(...)
  // D-1: 15-minute TTL for closed beta. Set at creation time
  // as createdAt + 15min. Sweep job transitions ACTIVE rows
  // past expiresAt to EXPIRED.
  expiresAt         DateTime
  releasedAt        DateTime?
  confirmedAt       DateTime?
  createdAt         DateTime   @default(now())

  @@index([poolId, status])
  @@index([variantId, status])
  @@index([expiresAt, status])  // drives the sweep query
}
```

### 3.6 Money + quantity precision

**Money:** ALL prices in minor units (halalas for SAR) as `Int`. Matches the existing `MerchantOrderLineItem.unitPriceAtPurchase: Int` convention.

**Quantity:** `BigInt` in **micro-base-units**. Naming convention: `quantityBaseMicros: BigInt`. The "base unit" is the dimension's base (gram / millilitre / piece); micros gives 6 decimal places of lossless precision.

| Display | Base unit | Micros |
|---|---|---|
| 1 gram | 1 g | `1_000_000` |
| 1 tola (D-5: 11.66 g) | 11.66 g | `11_660_000` |
| 1/8 kilo (125 g) | 125 g | `125_000_000` |
| 1 kilo | 1000 g | `1_000_000_000` |
| 10 kg pool total | 10_000 g | `10_000_000_000` |

**Why micros instead of `Decimal`:**

- `BigInt` arithmetic is exact, fast, and well-supported across Prisma + Postgres aggregations.
- Eliminates the float-drift concern from repeated tola subtraction (`11.66 + 11.66 + …`).
- Display conversion is a single multiply/divide at the wire boundary — `displayGrams = Number(microsBigInt) / 1_000_000`.

### 3.7 Snapshot fields on Order / Gift / MerchantOrderLineItem

All three rows need to remember the variant / unit context at the moment of sale, so changes to the underlying Product / Variant / Pool don't rewrite history:

```
Order {                              // legacy closed-beta path
  ...
  variantId                    String?
  variantNameAtPurchase        String?
  poolUnitCode                 String?    // 'eighth_kilo'
  poolUnitLabelAtPurchase      String?    // 'ثُمن كيلو' — snapshot
  poolUnitQuantityBaseMicros   BigInt?    // 125_000_000
  reservationId                String?    @unique
  reservation                  InventoryReservation? @relation(...)
}

Gift {
  ...
  variantNameAtPurchase        String?
  poolUnitLabelAtPurchase      String?
  poolUnitQuantityBaseMicros   BigInt?
}

MerchantOrderLineItem {              // future cart path (Phase 9.1.a)
  ...
  variantId                    String?
  variantNameAtPurchase        String?
  poolUnitCode                 String?
  poolUnitLabelAtPurchase      String?
  poolUnitQuantityBaseMicros   BigInt?
  reservationId                String?    @unique
  reservation                  InventoryReservation? @relation(...)
}
```

Every new column is nullable. Legacy rows have `null` everywhere; the renderer falls back to `productName`.

---

## 4. Checkout + reservation strategy

### 4.1 Mode-aware `checkAvailability`

Three branches, consolidated in `ProductsService`:

```
checkAvailability({
  productId,
  variantId?,           // VARIANT
  poolUnitCode?,        // BULK_POOL
  quantityBaseMicros?,  // BULK_POOL
})
```

| Mode | Validation |
|---|---|
| `SIMPLE` | Legacy behaviour: `isAvailable && stockStatus === 'in_stock'` |
| `VARIANT` | `variantId` required. Check variant exists + is published + `isAvailable` + `stockCount > 0` |
| `BULK_POOL` | `poolUnitCode` + `quantityBaseMicros` required. Validate the unit is enabled for this pool, the requested quantity matches `unit.basePerUnit × micros` exactly (no fractional units), and `pool.remaining ≥ quantityBaseMicros` |

Returns the productId, storeId, and an optional `unitPriceAtPurchase` the caller embeds in the line-item snapshot.

### 4.2 Reservation lifecycle (D-1: 15-minute TTL)

```
                          payment success
ACTIVE ────────────────────────────────────────→ CONFIRMED
   │                                                  │
   ├── payment fail / order cancel ─────→ RELEASED    │
   │                                                  │
   └── expiresAt < now() (sweep) ───────→ EXPIRED     │
                                                      │
                  D-2: refund DOES NOT auto-restock   │
                                                      ▼
                                          (CONFIRMED is terminal
                                           for the closed-beta
                                           refund path; manual
                                           restock surface is
                                           a separate Phase 3.6
                                           operation that creates
                                           a NEW positive
                                           InventoryEvent)
```

### 4.3 Atomic pool / variant updates

| Transition | `reservedQuantityBaseMicros` | `soldQuantityBaseMicros` | variant `stockCount` |
|---|---|---|---|
| `null → ACTIVE` (pool) | `+qty` | — | — |
| `null → ACTIVE` (variant) | — | — | `−1` |
| `ACTIVE → CONFIRMED` (pool) | `−qty` | `+qty` | — |
| `ACTIVE → CONFIRMED` (variant) | — | — | (no further change) |
| `ACTIVE → RELEASED / EXPIRED` (pool) | `−qty` | — | — |
| `ACTIVE → RELEASED / EXPIRED` (variant) | — | — | `+1` |
| `CONFIRMED → REFUNDED` | — | **NO CHANGE** (D-2) | **NO CHANGE** (D-2) |

All transitions occur inside a Prisma `$transaction` with a row-lock on `InventoryPool` or `ProductVariant` (`SELECT ... FOR UPDATE`) to prevent races.

### 4.4 The reservation step in order-create

`OrdersService.create` / future `GiftSessionsService.create` gains a step **before** writing the Order row:

1. Open transaction.
2. Row-lock the target variant or pool.
3. Re-read the remaining inventory inside the lock.
4. If sufficient → write `InventoryReservation` row with `ACTIVE`, update pool/variant counters atomically.
5. Embed `reservationId` into the Order / MerchantOrderLineItem row.
6. Commit.

If insufficient → throw `409 Conflict` with a stable code (`inventory_unavailable` or `unit_unavailable`). The frontend translates to a calm "another buyer just took this — try a different size" message.

### 4.5 Sweep worker for expired reservations

A background worker (mirrors `OccasionReminderWorker` pattern in `apps/api/src/notifications/`):

```
ReservationSweepWorker (cron / interval):
  - findMany InventoryReservation WHERE status='ACTIVE' AND expiresAt < NOW()
  - per row, atomically transition to EXPIRED + restore pool/variant counters
  - cap at N rows/run; log each transition to AuditLog
```

Closed beta defaults:

| Setting | Value |
|---|---|
| Reservation TTL (`expiresAt = createdAt + N min`) | **15 min** (D-1) |
| Sweep interval | 5 min |
| Per-run row cap | 200 |

Both TTL and interval are env-tunable (`RESERVATION_TTL_MINUTES`, `RESERVATION_SWEEP_INTERVAL_MINUTES`).

### 4.6 D-2: Refund does NOT auto-restock

When a CONFIRMED order is refunded (`RefundRequest` flow):

- The `PaymentAllocation` / `FinancialLedgerEntry` entries reverse the financial side. This is normal refund handling and DOES happen.
- The inventory counters (`pool.soldQuantityBaseMicros`, `variant.stockCount`) **do NOT change**.
- For oud / incense / perfume / flowers / chocolate / food / similar categories, the returned goods are typically not sellable again. Auto-restocking would silently overstate inventory and cause overselling.

To restock returned inventory, the merchant or admin uses an explicit "Restock returned inventory" surface (Phase 3.6):

- The surface lists CONFIRMED-then-REFUNDED rows that haven't been restocked yet.
- The operator picks specific orders to restock, optionally specifying the restock quantity (in case partial inventory survived).
- The action creates a positive `InventoryEvent` (audit-traceable) and updates `pool.soldQuantityBaseMicros -= restockedQty` (or `variant.stockCount += 1`).
- Default position: nothing happens unless an operator explicitly clicks.

This is the load-bearing safety invariant: **the inventory ledger never moves without an explicit operator decision after a sale is confirmed.**

---

## 5. Merchant dashboard UX

### 5.1 Mode picker

Top of the ProductModal, **before any other input**:

```
○ Simple — one product, one price, in stock / out of stock
○ Variants — fixed boxes or sizes with their own stock counts
○ Bulk inventory — sell from a shared pool by weight
```

Mode is **immutable once set** for closed beta. Changing mode mid-flight would orphan variants or pools; the UI offers "delete + recreate" instead. Phase 4 polish: a guarded migration tool with explicit operator confirmation.

### 5.2 Mode-specific forms

**SIMPLE** (default): the current ProductModal form unchanged. Name, price, isFastDelivery, stockStatus toggle, image gallery (Phase 2.5b).

**VARIANT:**
- Product-level: name, category, image gallery, isFastDelivery.
- Variants table (inline editable rows):
  ```
  Variant name | Price (SAR) | Stock | Weight (g) | Enabled | ⇅ ✕
  1/8 kilo     | 80          | 10    | 125        | ✓       | ⇅ ✕
  1/4 kilo     | 150         | 5     | 250        | ✓       | ⇅ ✕
  ...
  ```
- "Add variant" button; reorder via up/down chevrons (closed-beta) or drag (Phase 3.7).
- Minimum 1 variant required to publish.
- D-3: **no per-variant image input**. Every variant uses `Product.images[0]` as its display image.

**BULK_POOL:**
- Product-level: same as variant.
- Pool config:
  - Dimension: locked to **WEIGHT** for closed beta (UI hides the choice).
  - Total quantity input with a unit dropdown: "10" + "kg". Converted to base micros on submit.
  - Live readout of `remaining / sold / reserved` once writes happen ("8.5 kg sold of 10 kg, 0.5 kg reserved").
- Pricing mode toggle (D-6: defaults to **`PER_UNIT`**):
  - PER_UNIT (default): each enabled unit chip gets its own price input.
  - PER_BASE: single "price per gram" input at the top; per-unit price computed live.
- Allowed units chip selector (system units only, D-4):
  - tola / 1/8 kilo / 1/4 kilo / 1/2 kilo / 1 kilo
  - Each chip shows: label, calculated unit price ("125 g → 80 SAR"), enable toggle.
- Minimum sale quantity input ("Don't allow sales below: 10 g").

### 5.3 Restock surface (Phase 3.6, mentioned here for completeness)

A dedicated "Restock returned inventory" admin/merchant page (D-2):

- Lists `CONFIRMED → REFUNDED` orders where no restock event exists yet.
- Filterable by date, product, merchant, refund reason.
- Operator action: "Restock all" / "Restock partial (specify qty)" / "Mark unsellable".
- Every action creates a positive `InventoryEvent` row for audit.
- Bulk operations require an explicit confirm modal.

---

## 6. Storefront UX

### 6.1 SIMPLE products
Unchanged. Existing storefront renders as today.

### 6.2 VARIANT products

- Pill / chip row above the price: each pill shows the variant name.
- Active pill: bold, primary-accent border.
- Disabled pill (variant out of stock): muted, struck-through label, tooltip "Out of stock".
- Price display updates to the selected variant's price.
- D-3: image carousel uses `Product.images` regardless of variant. Variant-specific images come in Phase 3.7 polish.
- "Add to cart" / "Send as gift" CTA passes `variantId` through to the checkout URL.

### 6.3 BULK_POOL products

- Weight selector pills, one per enabled unit:
  ```
  [ Tola ] [ 1/8 kilo ] [ 1/4 kilo ] [ 1/2 kilo ] [ 1 kilo ]
  ```
- Each pill displays the unit label + the unit price (D-6: prices come from `InventoryPoolUnit.pricePerUnit` when PER_UNIT; computed when PER_BASE).
- **Dynamic disabled state:** a unit pill is greyed-out + non-clickable when `pool.remainingBaseMicros < unit.basePerUnit × 1_000_000`. Hovering / long-pressing shows "only 0.3 kg left" so the buyer understands.
- Below the picker, a discreet "X kg available" indicator (only if `remainingBaseMicros < 20% × totalBaseMicros` — soft pressure UX, not panic).
- "Add to cart" passes `poolUnitCode` + `quantityBaseMicros` through to checkout.

### 6.4 Cache invalidation note

Public product reads include `remainingBaseMicros`. Closed-beta caches at the CDN edge for `< 60 s`. A buyer might see a stale "available" pill that's actually sold out by the time they reach `POST /orders` — the reservation step (§4.4) catches this with a 409 + calm UI message. CDN TTL tuning is a Phase 4 polish item.

---

## 7. Migration phases

Every phase is **additive**. Every existing `Product` stays alive in `SIMPLE` mode without any data write. The closed-beta single-gift flow keeps working unchanged through every phase.

### Phase 3.0 — Architecture document (this PR)
No code. Document approved before any implementation.

### Phase 3.1 — Schema + read-only API (backend-only)

Scope:
- Migration: `ALTER TABLE "Product" ADD COLUMN "inventoryMode" TEXT DEFAULT 'SIMPLE' NOT NULL`.
- Migration: create `ProductVariant`, `MeasurementUnit`, `InventoryPool`, `InventoryPoolUnit`, `InventoryReservation` tables.
- Migration: add nullable variant / pool snapshot columns on `Order`, `Gift`, `MerchantOrderLineItem`.
- Migration: seed `MeasurementUnit` rows (gram, tola, eighth_kilo, quarter_kilo, half_kilo, kilo). The tola row carries the D-5 follow-up note.
- `ProductsService` read paths surface the new fields (always empty/null for `SIMPLE` products).
- **No writes accepted yet.** `POST/PATCH /products` rejects `variants` or `pool` body if sent.
- `checkAvailability` unchanged — still on the legacy `stockStatus` path.

Verification:
- Full backend test suite remains green.
- Every closed-beta gift still works unchanged.
- New tables are queryable but empty.

### Phase 3.2 — Variant writes (boxed mode)

Scope:
- `POST/PATCH /products` accept `inventoryMode='VARIANT'` + a `variants[]` array.
- `ProductsService.create/update` writes `ProductVariant` rows transactionally.
- `checkAvailability` becomes mode-aware: VARIANT branch checks `variant.stockCount > 0`.
- `OrdersService.create` + `GiftsService.create` accept optional `variantId` — when present, validate, decrement variant `stockCount` atomically via `InventoryReservation`, snapshot `variantNameAtPurchase`.
- `MerchantOrderLineItem` gains `variantId` + `variantNameAtPurchase` columns (in the Phase 3.1 migration; consumed here).
- Frontend: ProductModal gains mode picker + Variants inline editor.
- Storefront: per-product variant picker.
- D-3: no per-variant images. Storefront uses `Product.images` for every variant.

Closed-beta safety:
- Variants are opt-in per product.
- Existing `SIMPLE` products continue to work unchanged.
- No legacy gift loses fidelity.

### Phase 3.3 — Bulk pool writes (weight-based mode)

Scope:
- `POST/PATCH /products` accept `inventoryMode='BULK_POOL'` + a `pool` object.
- `ProductsService.create/update` writes `InventoryPool` + `InventoryPoolUnit` rows transactionally.
- D-6: `pricingMode` defaults to `PER_UNIT`.
- `checkAvailability` BULK_POOL branch: validates `(poolUnitCode, quantityBaseMicros)` against `pool.remaining` and `allowedUnits`.
- `InventoryReservation` lifecycle wired in — `OrdersService.create` reserves at order create; `PaymentsService.confirmMock` confirms on payment success; cancel path releases.
- D-1: 15-minute reservation TTL via `RESERVATION_TTL_MINUTES`.
- D-4: only system-defined `MeasurementUnit` rows are exposed; the API rejects writes that reference non-system unit codes.
- `ReservationSweepWorker` deployed.
- Frontend: ProductModal Bulk inventory form.
- Storefront: weight picker with dynamic disabled-state.

Closed-beta safety:
- Bulk pool is opt-in per product.
- The reservation worker is new infrastructure but parallel to existing flows — pool products are the only consumers.

### Phase 3.4 — Variant-aware checkout polish + cart integration

Scope:
- `Gift` card display surfaces variant / unit context: "Royal Oud — 1/8 kilo" instead of just "Royal Oud".
- `GiftSession` flow (multi-merchant cart) starts treating `MerchantOrderLineItem.variantId` + pool fields as first-class.
- Recipient confirmation page (Phase 8.A) surfaces variant / unit context.
- Notification copy (gift received, gift shipped, etc.) interpolates variant / unit labels.

### Phase 3.5 — Storefront search + discovery surfaces

Scope:
- Search results show variant range ("3 sizes available") rather than primary-only.
- Wishlist anchors at product OR variant level (user can heart "Royal Oud — 1/4 kilo" specifically).
- Gift posts can optionally surface the variant context.

### Phase 3.6 — Manual restock surface (D-2)

Scope:
- Merchant / admin "Restock returned inventory" page.
- `InventoryEvent` audit table for every positive (restock) and negative (manual write-down) operator action.
- Bulk action support.

### Phase 3.7 — Polish + future-ready items

Scope (any order, low priority):
- D-3 reversal: variant-specific images (`ProductVariant.imageUrl`).
- D-4 partial relaxation: a tightly-controlled "request custom unit" admin-only workflow.
- VOLUME dimension wired up for perfume / attar merchants.
- COUNT dimension for non-boxed countable items.
- Real-time stock-pressure UI ("only 2 left!") on storefront.
- Multi-quantity per line (3 × 1/8 kg) — depends on `MerchantOrderLineItem.quantity` semantics evolution.

---

## 8. Rollback strategy

Every migration in this Phase is **additive**. Rollback is safe at every step.

### 8.1 Phase 3.1 — schema additions only

If a problem surfaces after Phase 3.1 ships:

- **Soft rollback (operational):** flip a feature flag to hide the new schema in read responses. The closed-beta clients ignore unknown fields; they keep working.
- **Application rollback (`git revert`):** removes the new column from API responses + reverts `ProductsService` reads. Schema tables remain; they sit unused.
- **Full schema rollback:** a follow-up migration drops the new columns/tables. Every existing Product / Order / Gift row is unaffected because the new columns defaulted to NULL and no `ProductVariant` / `InventoryPool` rows were written by any code path during Phase 3.1.

### 8.2 Phase 3.2 — variant writes

If variant writes destabilize anything:

- **Soft rollback:** stop accepting `variants[]` in the API; existing variants stay queryable but no new ones are created. SIMPLE-mode products are unaffected.
- **Application rollback (`git revert`):** removes the write paths. Existing variant rows stay in the DB but become read-only; merchants can't add new ones until a fix lands.
- **Surgical rollback for a single product:** the merchant or admin can manually flip `inventoryMode` back to `SIMPLE` (cascading delete on variants). UI affordance is the "delete + recreate" flow described in §5.1.

### 8.3 Phase 3.3 — bulk pool writes + reservations

If bulk pool destabilizes anything:

- **Soft rollback:** stop accepting `pool` in the API + disable the reservation worker. Existing pool reservations on disk are still queryable; no new ones are created.
- **Reservation worker rollback:** disable the cron / interval that runs `ReservationSweepWorker`. Existing ACTIVE reservations slowly time out at the cap (15 min) and never get transitioned to EXPIRED — they're functionally inert. A one-shot SQL fix can mark them EXPIRED if needed.
- **Application rollback (`git revert`):** removes the write paths + reservation hook. Existing pool rows + reservations stay in the DB read-only.

### 8.4 Catastrophic rollback (very rare)

If the entire Phase 3 infrastructure needs to come out:

1. Drop new endpoints / wire them off (`git revert`).
2. Run a follow-up migration that drops the new tables and the new columns on legacy tables. Every drop is metadata-only on PostgreSQL.
3. No legacy production data is at risk — the new tables are append-only and the new columns are all nullable.

---

## 9. Closed-beta safety rules

These are the invariants the implementation MUST preserve through every Phase 3 slice.

### S-1: Legacy flow continues to work unchanged

Every existing `Product` is `SIMPLE`-mode. Every `SIMPLE`-mode product follows the existing code path:
- `checkAvailability` checks `isAvailable + stockStatus`.
- `OrdersService.create` writes `Order.productPrice` from the request body.
- `Gift` renders `productName` directly.

No SIMPLE-mode code path may be modified without a parallel test pinning the legacy behaviour.

### S-2: No mode change in flight

`Product.inventoryMode` is immutable after the first non-SIMPLE write. The merchant cannot flip a `VARIANT` product to `BULK_POOL` mid-life. The "delete + recreate" pattern enforces this without write churn in the schema.

### S-3: No automatic restock (D-2)

The `CONFIRMED → REFUNDED` transition NEVER moves inventory. Every Phase 3.3+ test asserts this. The restock surface (Phase 3.6) is the only legitimate path that increments `stockCount` or decrements `soldQuantityBaseMicros`.

### S-4: System units are read-only (D-4)

The API rejects writes that try to create, update, or delete `MeasurementUnit` rows. The only legitimate creation path is via a migration. A failing assertion at boot time refuses to start the API if it detects a non-`isSystem` row during closed beta.

### S-5: Reservation TTL ceiling (D-1)

Reservation TTL is capped at 60 minutes via a hard-coded ceiling in the service. An env var that tries to set TTL above the ceiling is clamped and logged. This prevents a misconfigured deploy from holding inventory indefinitely.

### S-6: Variant + pool writes are atomic with the parent Product

`POST/PATCH /products` writes the Product row + variants + pool + pool units inside a single Prisma `$transaction`. A partial failure rolls back the entire change — never leaves a Product half-configured.

### S-7: Inventory deduction is row-locked

Every `InventoryReservation` lifecycle transition that touches `InventoryPool` or `ProductVariant` counters happens inside a `$transaction` with a `SELECT ... FOR UPDATE` on the parent row. No exception. Closed-beta volume is low so contention is minimal; the lock keeps the model correct under any concurrency.

### S-8: Snapshot fields never null on variant/pool sales

A confirmed sale of a `VARIANT` product MUST populate `variantNameAtPurchase`. A confirmed sale of a `BULK_POOL` product MUST populate `poolUnitLabelAtPurchase` + `poolUnitQuantityBaseMicros`. The API enforces this at order-create time; the Gift renderer asserts it at render time.

### S-9: Tola seed flagged for re-validation (D-5)

The `MeasurementUnit` row for tola ships with `notes = 'D-5: validate before public launch'`. A pre-launch checklist gates the public launch on this validation being completed (with a corrective migration if the figure needs updating).

### S-10: Doc-only PRs do not ship

This PR ships only `docs/architecture/PHASE_3_VARIANTS_AND_INVENTORY.md`. The first slice of Phase 3 code (Phase 3.1) lands as a separate, code-bearing PR — never combined with architecture documents to preserve a clean review trail.

---

## 10. Open items / future polish

These items are deliberately NOT decided here. They are recorded so future slices can pick them up without re-litigating Phase 3.

| # | Item | Notes |
|---|---|---|
| O-1 | Multi-quantity per line (`3 × 1/8 kg`) | `MerchantOrderLineItem.quantity` exists but is treated as "1 per line" in Phase 3. Multi-quantity per line is a Phase 5 enhancement, depends on cart UX evolving |
| O-2 | Per-variant images | Phase 3.7 (D-3 reversal). Schema migration adds `ProductVariant.imageUrl`; storefront + ProductModal updated |
| O-3 | Merchant-custom units | Phase 3.7 (D-4 partial relaxation). Tight admin-only workflow ("request custom unit" → admin approval → migration) |
| O-4 | VOLUME / COUNT dimensions | Schema supports them. Wire up when a real merchant needs them (perfume splits, attar, countable bulk items) |
| O-5 | Real-time stock-pressure UI ("only 2 left") | Phase 3.7. Copy + chip tuning |
| O-6 | Reservation conflict UX | Phase 3.3 minimum: calm "another buyer just took this" + reload. Phase 3.7 polish: auto-renew while buyer is actively typing |
| O-7 | Tola domain-expert validation (D-5) | Must complete before public launch. Corrective migration if 11.66 needs revising |
| O-8 | CDN cache TTL for storefront stock indicators | Phase 4 polish. Reservation step already catches stale "available" pills with a 409 |
| O-9 | Concurrency stress testing | Phase 4. Drive 100 simultaneous reservations against a single pool; assert no oversells |
| O-10 | Variant-of-variant (a variant having its own bulk pool) | Out of scope for closed beta. Not in this design. Would require a recursive `Product → Variant → Pool` tree |

---

## 11. Reference — cross-document anchors

| Document | Relevance |
|---|---|
| `QIFT_CORE_INVARIANTS.md` | Section 23: product availability states. Phase 3 extends those states without breaking the invariants |
| `QIFT_MASTER_ARCHITECTURE.md` | Storefront architecture + bounded `themeConfig`. Phase 3 doesn't change theme dispatch |
| `STAGE_10_FINANCIAL_SETTLEMENT_ARCHITECTURE.md` | Money flow (sender → PSP → Qift bank → allocation → payout). Phase 3 inventory ledger sits alongside the financial ledger; refunds touch finance only (D-2) |
| `PHASE_2_MULTI_CART_ARCHITECTURE.md` (future) | `GiftIntent` → `CheckoutSession` → `MerchantOrder` → `Gift` topology. Phase 3 variant/pool snapshots ride on the existing `MerchantOrderLineItem` shape |
| `RECIPIENT_CONFIRMATION_FRAMEWORK.md` | Phase 3.4 surfaces variant / unit context on confirmation prompts |
| `RISK_SIGNAL_EVENTS.md` | A future risk signal could flag suspicious bulk-pool deductions; out of scope for Phase 3 |

---

**End of architecture document.** Next step: human review + sign-off, then Phase 3.1 implementation as a separate code-bearing PR.
