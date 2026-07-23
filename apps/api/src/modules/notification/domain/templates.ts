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
