/**
 * Driver app strings: Arabic (right-to-left), French and English
 * (docs/01 4.11, §7.3). A typed dictionary, the same shape as the web apps'
 * MESSAGES: a missing string is a compile error in every language, not a key
 * shown to a driver.
 */
export type Locale = "ar" | "fr" | "en";

export interface Messages {
  readonly appName: string;
  readonly courierCode: string;
  readonly phone: string;
  readonly sendCode: string;
  readonly code: string;
  readonly signIn: string;
  readonly signOut: string;
  readonly unknownCourier: string;
  readonly wrongCode: string;
  readonly offline: string;
  readonly tryAgain: string;
  readonly disclosureTitle: string;
  readonly disclosureBody: string;
  readonly disclosureAccept: string;
  readonly disclosureDecline: string;
  readonly permissionDenied: string;
  readonly openSettings: string;
  readonly shiftOpen: string;
  readonly shiftNone: string;
  readonly startShift: string;
  readonly endShift: string;
  readonly noRoute: string;
  readonly tracking: string;
  readonly notTracking: string;
  readonly diagnostics: string;
  readonly battery: string;
  readonly charging: string;
  readonly batteryOptimised: string;
  readonly batteryExempt: string;
  readonly fixBattery: string;
  readonly backgroundPermission: string;
  readonly granted: string;
  readonly missing: string;
  readonly queued: string;
  readonly lastFix: string;
  readonly lastUpload: string;
  readonly never: string;
  readonly samplingMode: string;
  readonly moving: string;
  readonly slow: string;
  readonly stationary: string;
}

export const MESSAGES: Readonly<Record<Locale, Messages>> = {
  ar: {
    appName: "تطبيق السائق",
    courierCode: "رمز شركة التوصيل",
    phone: "رقم الهاتف",
    sendCode: "إرسال الرمز",
    code: "رمز التحقق",
    signIn: "تسجيل الدخول",
    signOut: "تسجيل الخروج",
    unknownCourier: "رمز الشركة غير معروف",
    wrongCode: "الرمز غير صحيح أو منتهي الصلاحية",
    offline: "لا يوجد اتصال بالشبكة",
    tryAgain: "إعادة المحاولة",
    disclosureTitle: "مشاركة موقعك أثناء العمل",
    disclosureBody:
      "يجمع هذا التطبيق موقعك، حتى عندما يكون مغلقًا أو غير مستخدم، وذلك فقط أثناء ورديتك المفتوحة، لعرض مسارك ووصولك إلى العناوين على فريق التوزيع. يتوقف الجمع عند إغلاق الوردية.",
    disclosureAccept: "موافق، متابعة",
    disclosureDecline: "ليس الآن",
    permissionDenied: "إذن الموقع في الخلفية مطلوب لتتبع الوردية",
    openSettings: "فتح الإعدادات",
    shiftOpen: "الوردية مفتوحة",
    shiftNone: "لا توجد وردية مفتوحة",
    startShift: "بدء الوردية",
    endShift: "إنهاء الوردية",
    noRoute: "لا يوجد مسار لك اليوم. اتصل بفريق التوزيع.",
    tracking: "التتبع يعمل",
    notTracking: "التتبع متوقف",
    diagnostics: "التشخيص",
    battery: "البطارية",
    charging: "قيد الشحن",
    batteryOptimised: "تحسين البطارية مفعل: قد يوقف الهاتف التتبع",
    batteryExempt: "التطبيق مستثنى من تحسين البطارية",
    fixBattery: "إيقاف تحسين البطارية",
    backgroundPermission: "الموقع في الخلفية",
    granted: "مسموح",
    missing: "غير مسموح",
    queued: "نقاط بانتظار الإرسال",
    lastFix: "آخر موقع",
    lastUpload: "آخر إرسال",
    never: "لم يحدث بعد",
    samplingMode: "وضع الأخذ",
    moving: "يتحرك",
    slow: "بطيء",
    stationary: "متوقف",
  },
  fr: {
    appName: "Application chauffeur",
    courierCode: "Code du transporteur",
    phone: "Numéro de téléphone",
    sendCode: "Envoyer le code",
    code: "Code de vérification",
    signIn: "Se connecter",
    signOut: "Se déconnecter",
    unknownCourier: "Code transporteur inconnu",
    wrongCode: "Code incorrect ou expiré",
    offline: "Pas de connexion réseau",
    tryAgain: "Réessayer",
    disclosureTitle: "Partage de votre position pendant le service",
    disclosureBody:
      "Cette application collecte votre position, y compris lorsqu'elle est fermée ou non utilisée, uniquement pendant votre service ouvert, pour montrer votre tournée et vos arrivées à l'équipe de dispatch. La collecte s'arrête à la clôture du service.",
    disclosureAccept: "J'accepte, continuer",
    disclosureDecline: "Pas maintenant",
    permissionDenied: "La localisation en arrière-plan est nécessaire pour suivre le service",
    openSettings: "Ouvrir les réglages",
    shiftOpen: "Service ouvert",
    shiftNone: "Aucun service ouvert",
    startShift: "Commencer le service",
    endShift: "Terminer le service",
    noRoute: "Aucune tournée pour vous aujourd'hui. Contactez le dispatch.",
    tracking: "Suivi actif",
    notTracking: "Suivi arrêté",
    diagnostics: "Diagnostic",
    battery: "Batterie",
    charging: "En charge",
    batteryOptimised: "Optimisation de batterie active : le téléphone peut couper le suivi",
    batteryExempt: "Application exemptée de l'optimisation de batterie",
    fixBattery: "Désactiver l'optimisation",
    backgroundPermission: "Position en arrière-plan",
    granted: "Autorisée",
    missing: "Refusée",
    queued: "Points en attente d'envoi",
    lastFix: "Dernière position",
    lastUpload: "Dernier envoi",
    never: "Pas encore",
    samplingMode: "Mode d'échantillonnage",
    moving: "En mouvement",
    slow: "Lent",
    stationary: "À l'arrêt",
  },
  en: {
    appName: "Driver",
    courierCode: "Courier code",
    phone: "Phone number",
    sendCode: "Send code",
    code: "Verification code",
    signIn: "Sign in",
    signOut: "Sign out",
    unknownCourier: "Unknown courier code",
    wrongCode: "Wrong or expired code",
    offline: "No network connection",
    tryAgain: "Try again",
    disclosureTitle: "Sharing your location during your shift",
    disclosureBody:
      "This app collects your location, including when the app is closed or not in use, only while your shift is open, to show your route and arrivals to dispatch. Collection stops when the shift closes.",
    disclosureAccept: "I agree, continue",
    disclosureDecline: "Not now",
    permissionDenied: "Background location is required to track your shift",
    openSettings: "Open settings",
    shiftOpen: "Shift open",
    shiftNone: "No open shift",
    startShift: "Start shift",
    endShift: "End shift",
    noRoute: "No route for you today. Contact dispatch.",
    tracking: "Tracking on",
    notTracking: "Tracking off",
    diagnostics: "Diagnostics",
    battery: "Battery",
    charging: "Charging",
    batteryOptimised: "Battery optimisation is on: the phone may stop tracking",
    batteryExempt: "App is exempt from battery optimisation",
    fixBattery: "Turn off optimisation",
    backgroundPermission: "Background location",
    granted: "Allowed",
    missing: "Not allowed",
    queued: "Points waiting to send",
    lastFix: "Last position",
    lastUpload: "Last upload",
    never: "Not yet",
    samplingMode: "Sampling mode",
    moving: "Moving",
    slow: "Slow",
    stationary: "Stopped",
  },
};

/**
 * The device's preferred supported language, French by default: the business
 * language of Tunisian couriers (docs/01 §7.3, MVP-O5).
 */
export function pickLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const language = tag.toLowerCase().split(/[-_]/u)[0];
    if (language === "ar" || language === "fr" || language === "en") {
      return language;
    }
  }
  return "fr";
}

export function isRtl(locale: Locale): boolean {
  return locale === "ar";
}

/**
 * What a Tunisian types (`24201314`, `24 201 314`, `+216 24 201 314`) to the
 * E.164 the API demands; null when it cannot be one. The SAME rule as
 * apps/web/src/lib/phone.ts, so a number accepted on one screen is accepted on
 * every screen: every non-digit stripped (pasted non-breaking spaces too), an
 * explicit `+` or `00` kept international, a bare 8-digit number taken as
 * Tunisian, anything else refused rather than guessed.
 */
export function toE164(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/gu, "");
  if (digits === "") {
    return null;
  }
  if (trimmed.startsWith("+")) {
    return checkE164(`+${digits}`);
  }
  if (digits.startsWith("00")) {
    return checkE164(`+${digits.slice(2)}`);
  }
  return digits.length === 8 ? checkE164(`+216${digits}`) : null;
}

function checkE164(candidate: string): string | null {
  return /^\+[1-9]\d{6,14}$/u.test(candidate) ? candidate : null;
}
