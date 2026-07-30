/**
 * Copy for the public tracking page, in the three languages this market reads.
 *
 * ⚠️ The language switcher is VISIBLE, not buried (docs/08 §7): a recipient
 * arrives from an SMS and their language is unknown. French is the default
 * because it is the working language of Tunisian courier administration, but a
 * third of recipients will want Arabic and the switch has to be one tap away.
 *
 * Status labels are NOT here — they come from the API, which already returns
 * `statusLabel` per locale. One vocabulary, defined once, so a status added to
 * the state machine cannot render as a blank on this page.
 */

export const LOCALES = ["ar", "fr", "en"] as const;
export type Locale = (typeof LOCALES)[number];

const LOCALE_SET: ReadonlySet<string> = new Set<string>(LOCALES);

/** French by default — see above. Anything unrecognised falls back rather than 404s. */
export function toLocale(value: string | undefined): Locale {
  return value !== undefined && LOCALE_SET.has(value) ? (value as Locale) : "fr";
}

/** Arabic is the only RTL language here. */
export function directionOf(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

interface Messages {
  readonly title: string;
  readonly trackingNumber: string;
  readonly estimatedArrival: string;
  readonly recipient: string;
  readonly toPay: string;
  readonly cash: string;
  readonly prepareExactAmount: string;
  readonly needHelp: string;
  readonly notFound: string;
  readonly notFoundDetail: string;
  readonly linkExpired: string;
  readonly linkExpiredDetail: string;
  readonly history: string;
  readonly language: string;
}

export const MESSAGES: Readonly<Record<Locale, Messages>> = {
  fr: {
    title: "Suivi de colis",
    trackingNumber: "N° de suivi",
    estimatedArrival: "Arrivée estimée",
    recipient: "Destinataire",
    toPay: "À payer",
    cash: "Espèces",
    // A small COD-market touch that measurably reduces failed deliveries from
    // INSUFFICIENT_CASH (docs/08 §7) — the driver rarely carries change.
    prepareExactAmount: "Préparez le montant exact si possible",
    needHelp: "Besoin d'aide ?",
    notFound: "Colis introuvable",
    notFoundDetail: "Vérifiez le lien reçu par SMS.",
    linkExpired: "Lien expiré",
    linkExpiredDetail: "Demandez un nouveau lien à votre expéditeur.",
    history: "Historique",
    language: "Langue",
  },
  ar: {
    title: "تتبع الطرد",
    trackingNumber: "رقم التتبع",
    estimatedArrival: "الوصول المتوقع",
    recipient: "المرسل إليه",
    toPay: "المبلغ المطلوب",
    cash: "نقدا",
    prepareExactAmount: "يرجى تحضير المبلغ بالضبط إن أمكن",
    needHelp: "تحتاج مساعدة؟",
    notFound: "الطرد غير موجود",
    notFoundDetail: "تحقق من الرابط الذي وصلك عبر رسالة قصيرة.",
    linkExpired: "انتهت صلاحية الرابط",
    linkExpiredDetail: "اطلب رابطا جديدا من المرسل.",
    history: "السجل",
    language: "اللغة",
  },
  en: {
    title: "Parcel tracking",
    trackingNumber: "Tracking no.",
    estimatedArrival: "Estimated arrival",
    recipient: "Recipient",
    toPay: "To pay",
    cash: "Cash",
    prepareExactAmount: "Please have the exact amount ready if you can",
    needHelp: "Need help?",
    notFound: "Parcel not found",
    notFoundDetail: "Check the link you received by SMS.",
    linkExpired: "Link expired",
    linkExpiredDetail: "Ask your sender for a new link.",
    history: "History",
    language: "Language",
  },
};

/** Timeline entry labels, keyed by the event type the API returns. */
export const TIMELINE_LABELS: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  fr: {
    CREATED: "Commande créée",
    PICKED_UP: "Colis collecté",
    AT_HUB: "Au centre de tri",
    IN_TRANSIT: "En transit",
    OUT_FOR_DELIVERY: "En cours de livraison",
    DELIVERED: "Livré",
    DELIVERY_FAILED: "Tentative échouée",
    RETURN_INITIATED: "Retour engagé",
    RETURNED: "Retourné",
    CANCELLED: "Annulé",
  },
  ar: {
    CREATED: "تم إنشاء الطلب",
    PICKED_UP: "تم استلام الطرد",
    AT_HUB: "في مركز الفرز",
    IN_TRANSIT: "في الطريق",
    OUT_FOR_DELIVERY: "قيد التوصيل",
    DELIVERED: "تم التسليم",
    DELIVERY_FAILED: "محاولة فاشلة",
    RETURN_INITIATED: "بدأ الإرجاع",
    RETURNED: "تم الإرجاع",
    CANCELLED: "ملغى",
  },
  en: {
    CREATED: "Order created",
    PICKED_UP: "Parcel collected",
    AT_HUB: "At sorting hub",
    IN_TRANSIT: "In transit",
    OUT_FOR_DELIVERY: "Out for delivery",
    DELIVERED: "Delivered",
    DELIVERY_FAILED: "Attempt failed",
    RETURN_INITIATED: "Return started",
    RETURNED: "Returned",
    CANCELLED: "Cancelled",
  },
};
