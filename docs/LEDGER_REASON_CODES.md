# Ledger Reason-Code Registry (FC Ch. 5.1 / Ch. 14)

**Governance:** the Financial Constitution's account-mapping law — *a
new `reasonCode` enters this registry before its first production use*
(Ch. 14 change governance). `eventType` is the frozen taxonomy
(`financial-events.ts`); `reasonCode` is the account-classification
axis this registry defines. A producer using a reason code not listed
here is a review error.

| reasonCode | Account class | Money whose? | Producer (event) | Since |
|---|---|---|---|---|
| `ORDER_PAID` | Cash-in (collection) | mixed → allocated | `order.paid` (consumer order group) | FIN-4 |
| `QIFT_SERVICE_FEE` | Qift revenue (fee) | Qift | `qift.service_fee.accrued` | FIN-4 |
| `MERCHANT_PAYABLE` | Merchant payable (client money, safeguarding) | Merchant | `merchant.payable.accrued` — consumer order group; **and per-receipt goods conversion (SETTLE-1)** | FIN-4 / C-PR2 |
| `DELIVERY_FEE` | Delivery pass-through | Carrier leg | `delivery.fee.accrued` | FIN-4 |
| `CORPORATE_RECEIVABLE` | Receivable (Qift asset) | Company owes | `corporate.invoice.issued` | Track B |
| `MERCHANT_GOODS_INVOICED` | Facilitated goods (pass-through memo) | Merchant | `merchant.invoice.issued` | Track B |
| `SETTLEMENT_STARTED` | Lifecycle marker (zero-amount) | — | `settlement.started` | C-PR1 |
| `SETTLEMENT_SUPERSEDED` | Lifecycle marker (zero-amount) | — | `settlement.superseded` | C-PR1 |
| `INVOICE_PAYMENT` | Cash-in (collection against a document) — goods → safeguarding, fee → operating (metadata `account`) | Goods: client money · Fee: Qift | `invoice.payment.received:{receiptId}` | C-PR2 |
| `QIFT_REVENUE` | Qift revenue recognized (fee net of VAT; VAT posted at issuance per FC 7.6) | Qift | `qift.revenue.recognized:{invoiceId}` under the recorded recognition-policy version | C-PR2 |

Reserved next (enter here before first use): remittance
(`merchant.remittance.paid`), receivable accrual/recovery, reserve
held/released, refund/chargeback families.
