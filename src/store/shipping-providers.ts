// Shipping provider catalog. Stable codes + display names + a
// tracking-URL template the frontend stitches with the tracking
// number to produce a deep-link. New couriers slot in without a
// migration — Shipment.provider is just a free string.
//
// `template` is `${TRACK}` substituted with the tracking number.
// `null` template means we have no public tracking page (manual
// drop-off, in-store pickup); the frontend just renders the
// number.
export type ShippingProvider = {
  code: string;
  nameAr: string;
  nameEn: string;
  trackingUrlTemplate: string | null;
};

export const SHIPPING_PROVIDERS: ShippingProvider[] = [
  {
    code: 'smsa',
    nameAr: 'SMSA إكسبرس',
    nameEn: 'SMSA Express',
    trackingUrlTemplate:
      'https://www.smsaexpress.com/trackingdetails?tracknumbers=${TRACK}',
  },
  {
    code: 'aramex',
    nameAr: 'أرامكس',
    nameEn: 'Aramex',
    trackingUrlTemplate:
      'https://www.aramex.com/track/results?ShipmentNumber=${TRACK}',
  },
  {
    code: 'dhl',
    nameAr: 'DHL',
    nameEn: 'DHL',
    trackingUrlTemplate:
      'https://www.dhl.com/global-en/home/tracking.html?tracking-id=${TRACK}',
  },
  {
    code: 'spl',
    nameAr: 'البريد السعودي (سبل)',
    nameEn: 'Saudi Post (SPL)',
    trackingUrlTemplate:
      'https://splonline.com.sa/en/track-trace/?article=${TRACK}',
  },
  {
    code: 'manual',
    nameAr: 'تسليم يدوي',
    nameEn: 'Manual handoff',
    trackingUrlTemplate: null,
  },
  {
    code: 'other',
    nameAr: 'مزود آخر',
    nameEn: 'Other provider',
    trackingUrlTemplate: null,
  },
];

export function isKnownProvider(code: string): boolean {
  return SHIPPING_PROVIDERS.some((p) => p.code === code);
}

export function buildTrackingUrl(
  providerCode: string,
  trackingNumber: string | null | undefined,
): string | null {
  if (!trackingNumber) return null;
  const provider = SHIPPING_PROVIDERS.find((p) => p.code === providerCode);
  if (!provider?.trackingUrlTemplate) return null;
  return provider.trackingUrlTemplate.replace(
    '${TRACK}',
    encodeURIComponent(trackingNumber),
  );
}

// Allowed shipment statuses. Keep this list in sync with the
// frontend's timeline renderer and with the localised label
// table. A future provider integration can pump granular states
// into the same vocabulary; the merchant editor offers the
// human-meaningful subset.
export const SHIPMENT_STATUSES = [
  'registered',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'cancelled',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export function isShipmentStatus(value: string): value is ShipmentStatus {
  return (SHIPMENT_STATUSES as readonly string[]).includes(value);
}
