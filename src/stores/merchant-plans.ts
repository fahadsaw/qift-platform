// Merchant plan capability map.
//
// Single source of truth for "what can a merchant on plan X do?".
// Mirrored on the frontend at `lib/merchantPlans.ts` — keep the
// keys + tier names in sync.
//
// We deliberately model capabilities as a pure function of the
// plan string, not as a DB join. Capability checks happen in hot
// paths (every connect-integration call, every merchant dashboard
// render) and a per-request DB roundtrip would be wasted work.
//
// What we do NOT model here:
//   - Subscription billing / renewal / expiry — there is no
//     self-serve upgrade flow yet. Admins assign plans manually
//     via PATCH /admin/stores/:id/plan.
//   - Plan-change side effects — downgrade behaviour (e.g. what
//     happens to a Pro store's API integrations when they're
//     dropped to Starter) is deliberately a future decision.
//   - Trials / promo codes / discounts.

export const MERCHANT_PLANS = ['starter', 'pro', 'enterprise'] as const;
export type MerchantPlan = (typeof MERCHANT_PLANS)[number];

export function isMerchantPlan(value: string): value is MerchantPlan {
  return (MERCHANT_PLANS as readonly string[]).includes(value);
}

// Capability keys. Adding a new one means adding it here AND
// mirroring it on the frontend. Use sparingly — a capability per
// feature explodes the matrix; group features by intent.
export type MerchantCapability =
  // In-Qift storefront, manual products, gifting, basic
  // analytics, coverage zones, order management. Every plan
  // includes these.
  | 'core_storefront'
  // External catalog sync (Shopify / WooCommerce / custom API).
  // Pro+.
  | 'api_integrations'
  // Multi-courier auto-tracking + provider webhooks. Today the
  // shipment UI is open to all merchants for manual entry; the
  // capability gates only the future webhook-receiving side.
  | 'shipping_integrations'
  // Top funnel slots: featured rails, search boost, etc. Pro+.
  | 'priority_placement'
  // Campaigns / promotions / coupons. Pro+.
  | 'campaigns'
  // Rule-based automation (auto-prepare, auto-ship-on-event,
  // notification templates). Pro+.
  | 'automation'
  // Deeper analytics breakdowns: cohort, retention, custom
  // ranges, exports. Pro+.
  | 'advanced_analytics'
  // Custom logo + cover branding on receiver-side gift reveal,
  // tracking page, receipts. Enterprise.
  | 'branded_gifting'
  // White-glove integration support + named contact. Enterprise.
  | 'sla_support'
  // Future split-payment + held-funds gateway. Enterprise.
  | 'split_payment'
  // Gallery storefront theme (image-led, magazine grid). Pro+.
  // Theme gating is enforced server-side by StoreService on every
  // theme set + every storefront render — the dispatcher reads
  // live plan, so a downgrade falls back to Classic automatically.
  | 'theme_gallery'
  // Editorial storefront theme (premium serif, story-blocks).
  // Enterprise. Same server-side enforcement.
  | 'theme_editorial';

const CAPABILITIES_BY_PLAN: Record<MerchantPlan, MerchantCapability[]> = {
  starter: ['core_storefront'],
  pro: [
    'core_storefront',
    'api_integrations',
    'shipping_integrations',
    'priority_placement',
    'campaigns',
    'automation',
    'advanced_analytics',
    'theme_gallery',
  ],
  enterprise: [
    'core_storefront',
    'api_integrations',
    'shipping_integrations',
    'priority_placement',
    'campaigns',
    'automation',
    'advanced_analytics',
    'branded_gifting',
    'sla_support',
    'split_payment',
    'theme_gallery',
    'theme_editorial',
  ],
};

export function capabilitiesFor(plan: string): Set<MerchantCapability> {
  const safe = isMerchantPlan(plan) ? plan : 'starter';
  return new Set(CAPABILITIES_BY_PLAN[safe]);
}

export function planHas(plan: string, capability: MerchantCapability): boolean {
  return capabilitiesFor(plan).has(capability);
}
