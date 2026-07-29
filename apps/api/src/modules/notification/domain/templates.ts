/**
 * Built-in default message templates and rendering (docs/04-context-map.md §3.11).
 *
 * Templates are per-tenant AND per-locale; a tenant may override any of these in
 * `notification_templates`. These defaults let the pipeline work out of the box
 * (and be tested) without seeding a template first. Arabic/French/English are all
 * first-class — RTL Arabic is not an afterthought.
 *
 * Pure — no I/O.
 */

export const NOTIFICATION_LOCALES = ["ar", "fr", "en"] as const;
export type Locale = (typeof NOTIFICATION_LOCALES)[number];

const LOCALE_SET: ReadonlySet<string> = new Set<string>(NOTIFICATION_LOCALES);

export function toLocale(value: string | undefined, fallback: Locale = "fr"): Locale {
  return value !== undefined && LOCALE_SET.has(value) ? (value as Locale) : fallback;
}

/**
 * Default SMS bodies keyed by template key, then locale. `{{token}}` placeholders
 * are substituted from the event params at send time.
 */
export const DEFAULT_TEMPLATES: Readonly<Record<string, Readonly<Record<Locale, string>>>> = {
  "shipment.out_for_delivery": {
    fr: "Votre colis {{trackingNumber}} est en cours de livraison aujourd'hui.",
    ar: "طردك {{trackingNumber}} قيد التوصيل اليوم.",
    en: "Your parcel {{trackingNumber}} is out for delivery today.",
  },
  "shipment.delivered": {
    fr: "Votre colis {{trackingNumber}} a été livré. Merci.",
    ar: "تم تسليم طردك {{trackingNumber}}. شكرا.",
    en: "Your parcel {{trackingNumber}} has been delivered. Thank you.",
  },
  "delivery.failed": {
    fr: "La livraison de votre colis {{trackingNumber}} a échoué. Nous réessaierons.",
    ar: "فشل تسليم طردك {{trackingNumber}}. سنحاول مرة أخرى.",
    en: "Delivery of your parcel {{trackingNumber}} failed. We will try again.",
  },
  // The parcel is going back. The recipient is told because the most common cause
  // is that they were unreachable, and they may still want to intervene.
  "shipment.return_pending": {
    fr: "Votre colis {{trackingNumber}} va être retourné à l'expéditeur.",
    ar: "سيتم إرجاع طردك {{trackingNumber}} إلى المرسل.",
    en: "Your parcel {{trackingNumber}} is being returned to the sender.",
  },
  "shipment.cancelled": {
    fr: "Votre colis {{trackingNumber}} a été annulé.",
    ar: "تم إلغاء طردك {{trackingNumber}}.",
    en: "Your parcel {{trackingNumber}} has been cancelled.",
  },

  // ── Merchant-facing ────────────────────────────────────────────────────────
  //
  // The two questions a merchant actually asks: has my parcel been collected, and
  // has my money been paid.
  "pickup.completed": {
    fr: "Collecte confirmée : {{parcelCount}} colis récupérés.",
    ar: "تم تأكيد الاستلام: {{parcelCount}} طرد.",
    en: "Pickup confirmed: {{parcelCount}} parcels collected.",
  },
  "settlement.paid": {
    fr: "Règlement {{reference}} payé : {{amount}}.",
    ar: "تم دفع التسوية {{reference}}: {{amount}}.",
    en: "Settlement {{reference}} paid: {{amount}}.",
  },

  // ── Driver-facing (PUSH, not SMS) ──────────────────────────────────────────
  //
  // The driver app renders these and they are operational rather than commercial,
  // so they go over a channel that costs nothing per message.
  "route.published": {
    fr: "Nouvelle tournée : {{stopCount}} arrêts.",
    ar: "مسار جديد: {{stopCount}} محطة.",
    en: "New route: {{stopCount}} stops.",
  },
  "shipment.assigned": {
    fr: "Nouveau colis assigné : {{trackingNumber}}.",
    ar: "طرد جديد مُعيَّن: {{trackingNumber}}.",
    en: "New parcel assigned: {{trackingNumber}}.",
  },
};

/** The default body for a key+locale, or undefined if the key is unknown. */
export function defaultTemplateBody(key: string, locale: Locale): string | undefined {
  return DEFAULT_TEMPLATES[key]?.[locale];
}

/**
 * Substitutes `{{token}}` placeholders from `params`. An unknown token renders as
 * the empty string rather than leaking the literal `{{token}}` to a customer.
 */
export function renderTemplate(body: string, params: Readonly<Record<string, unknown>>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, token: string) => {
    const value = params[token];
    if (typeof value === "string") {
      return value;
    }
    // Only primitives are safely stringifiable; an object token renders empty
    // rather than leaking "[object Object]" (or the literal placeholder) to a
    // customer.
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return String(value);
    }
    return "";
  });
}

/** GSM-7 fits 160 characters per segment; anything outside it forces UCS-2 at 70. */
const GSM7_SEGMENT = 160;
const UCS2_SEGMENT = 70;

/**
 * A conservative GSM-7 alphabet check.
 *
 * ⚠️ Arabic — and any accented Latin outside the GSM-7 extension — forces the
 * WHOLE message to UCS-2, where a segment holds 70 characters instead of 160. One
 * non-representable character therefore more than doubles the cost of every
 * segment in the message.
 *
 * Deliberately conservative: over-estimating a segment costs a fraction of a
 * millime, under-estimating hides a real invoice.
 */
const GSM7_PATTERN =
  /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}[\]~|€]*$/u;

/**
 * How many SMS segments a rendered body will cost.
 *
 * Exists so that a template edit which triples the per-message cost shows up in a
 * test rather than on an invoice three weeks later. An Arabic body that reads
 * naturally in review is easily three segments.
 */
export function estimateSegments(body: string): number {
  if (body.length === 0) {
    return 0;
  }
  const size = GSM7_PATTERN.test(body) ? GSM7_SEGMENT : UCS2_SEGMENT;
  return Math.ceil(body.length / size);
}
