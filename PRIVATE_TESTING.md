# Qift — Private Testing Walkthrough

This file documents the seeded test merchants and the full
end-to-end flow for private testing.

> ⚠️ **Dev / staging only.** The seeded merchant accounts use a
> shared, predictable password. Do **not** run the seed against
> production. There is no automated guard against this — operator
> discipline only.

## 1. Run the seed

```bash
cd apps/api
npx prisma migrate deploy   # only needed once after schema changes
npx prisma db seed
```

The seed is idempotent — every entity uses a stable id, so re-runs
update existing rows in place rather than duplicating them. You can
re-seed safely whenever you want to reset the demo data.

## 2. Test merchant accounts

All six merchant accounts share the same password:

```
qift-merchant-dev
```

| Username (qiftUsername) | Phone           | Store name        | City      | Category   |
| ----------------------- | --------------- | ----------------- | --------- | ---------- |
| `merchant.rosary`       | `+966500000101` | روزاري            | الرياض    | flowers    |
| `merchant.cocoa`        | `+966500000102` | كوكوا هاوس        | الرياض    | chocolate  |
| `merchant.patisserie`   | `+966500000103` | باتسري نوارا      | جدة       | cake       |
| `merchant.maison`       | `+966500000104` | ميسون عطر         | الرياض    | perfume    |
| `merchant.gifted`       | `+966500000105` | هدايا مختارة      | الدمام    | gifts      |
| `merchant.rosajeddah`   | `+966500000106` | روزا جدة          | جدة       | flowers    |

Each account:
- has `role = 'store'` (so `/settings → Account` shows the
  **Store dashboard** link).
- has `phoneVerifiedAt` stamped (so the OTP flow doesn't gate them
  during local dev).
- owns one `Store` row with `status = 'approved'` (so the merchant
  fulfilment queue surfaces the orders immediately).
- has its products created under that store row.

## 3. Get an admin account

The first admin must be promoted by hand (no UI bootstrap path —
this is intentional, see `apps/api/src/admin/admin.guard.ts`):

```sql
UPDATE "User" SET role = 'admin' WHERE qiftUsername = 'your-test-username';
```

After that, the admin can promote / demote anyone else from
`/admin → Users`.

## 4. Full end-to-end flow

Two browsers (or two profiles) make this much easier — one for the
sender, one for the recipient. The merchant uses a third session.

### Step 1 — Recipient: add a default address
1. Sign in as the recipient.
2. Go to `/settings → Addresses → + Add address`.
3. Fill the form, leave the **default** toggle on, save.

### Step 2 — Sender: send a gift
1. Sign in as the sender (different account).
2. Go to `/stores`, pick one of the seeded merchant stores
   (e.g. **روزاري**), open it, pick a product, tap **Send as gift**.
3. Type the recipient's `@username`. The pre-flight check confirms
   "Recipient ready" if step 1 was done.
4. Optionally add a message + media + flip the surprise / anonymous
   toggles, then tap **Continue to checkout**.
5. On `/checkout`, tap **Pay** → mock gateway returns success → gift
   is created.

### Step 3 — Recipient: confirm address (or wait for auto-default)
- The recipient gets a notification. Tapping it deep-links to
  `/gifts/<id>`.
- They tap **Confirm address** (the default address is preselected;
  if they have multiple, they can pick one).
- Status moves to `address_confirmed`.
- A green "Address confirmed 🎉" flash appears.

> If the recipient ignores the prompt, the 24-hour `GiftsAutoDefaultService`
> sweep flips the gift to `default_address_used` automatically using
> their saved default address.

### Step 4 — Merchant: fulfil
1. Sign in as the matching merchant
   (e.g. `merchant.rosary` / `qift-merchant-dev` for a روزاري gift).
2. Open `/store-dashboard`. The fulfilment queue shows the order
   with the recipient's full address (this is the only place the
   address is exposed; the sender never sees it).
3. Tap **Mark preparing** → status `preparing`. Sender + recipient
   both get a notification.
4. Tap **Mark shipped**, optionally fill a tracking number + carrier.
   Status → `shipped`. Notifications fire.
5. Tap **Mark delivered**. Status → `delivered`.

### Step 5 — Recipient: see the message reveal
- Once the gift hits `delivered`, the message + media reveal gate
  flips on (`applyMessageReveal` in
  `apps/api/src/gifts/gift-visibility.ts`).
- The recipient opens `/gifts/<id>` and now sees:
  - The full message text the sender wrote.
  - Any attached image / video.
  - The sender's identity, unless `isAnonymous` was set.
  - The product / store name, even if `isSurprise` was set
    (`applySurpriseReveal` flips on at `delivered` too).
- The sender sees `delivered` on their own copy and gets a
  "Your gift was delivered" notification.

## 5. Admin views

While running the flow, the admin dashboard reflects everything in
near-real-time:

- `/admin → Users` lists every account; the seeded merchants show
  the `Store` role badge.
- `/admin → Stores` shows the six seeded stores with `approved`
  status. An admin can flip any of them to `suspended` to test the
  hide-from-queue behaviour.
- `/admin → Gifts` shows the recent 100 gifts and their status
  (no message / address / media — admin operational view only).
- `/admin → Reports` shows any reports filed during testing.
- `/admin → System` shows total counts + integration flags
  (R2, VAPID, Taqnyat).

## 6. Reset the demo data

The seed is idempotent — re-running brings everything back to the
canonical state. Existing test gifts created during a session stay
in place; only the seeded fixtures are updated.

If you want a clean reset (wipe everything except schema):

```bash
cd apps/api
npx prisma migrate reset --skip-seed   # destroys data + re-applies migrations
npx prisma db seed                     # repopulates fixtures
```

`migrate reset` is **destructive**. Only run it on the dev / local
database.
