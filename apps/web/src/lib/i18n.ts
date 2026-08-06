export type Locale = "ar" | "fr" | "en";
const DEFAULT_LOCALE: Locale = "fr";

export function toLocale(value: string): Locale {
  const lower = value.toLowerCase();
  if (lower === "ar" || lower === "fr" || lower === "en") {
    return lower;
  }
  return DEFAULT_LOCALE;
}

export function directionOf(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

interface Messages {
  readonly title: string;
  readonly login: string;
  readonly email: string;
  readonly password: string;
  readonly signIn: string;
  readonly signOut: string;
  readonly invalidCredentials: string;
  readonly language: string;
  readonly dashboard: string;
  readonly shipments: string;
  readonly dispatch: string;
  readonly fleet: string;
  readonly network: string;
  readonly merchants: string;
  readonly pickups: string;
  readonly custody: string;
  readonly finance: string;
  readonly complaints: string;
  readonly users: string;
  readonly settings: string;
  readonly audit: string;
  readonly search: string;
  readonly loading: string;
  readonly noResults: string;
  readonly create: string;
  readonly save: string;
  readonly cancel: string;
  readonly confirm: string;
  readonly delete: string;
  readonly actions: string;
  readonly status: string;
  readonly details: string;
  readonly total: string;
  readonly today: string;
  readonly mfaRequired: string;
  readonly mfaCode: string;
  readonly mfaVerify: string;
  readonly mfaEnrolRequired: string;
  readonly mfaEnrolInstructions: string;

  // ── Merchant accounts (the commercial's book of business) ─────────────────
  readonly newMerchant: string;
  readonly merchantName: string;
  readonly merchantCode: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly contactEmail: string;
  readonly fullName: string;
  readonly phone: string;
  readonly accountManager: string;
  readonly houseManaged: string;
  readonly assignAccountManager: string;
  readonly portalLogin: string;
  readonly createPortalLogin: string;
  readonly credentialShownOnce: string;
  readonly temporaryPassword: string;
  readonly performance: string;
  readonly totalShipments: string;
  readonly deliveryRate: string;
  readonly codCollected: string;
  readonly avgAttempts: string;
  readonly requestFailed: string;
  readonly back: string;

  // ── Pickup runs ───────────────────────────────────────────────────────────
  readonly reference: string;
  readonly contact: string;
  readonly parcels: string;
  readonly pickupWindow: string;
  readonly claimPickup: string;
  readonly pickupNotClaimable: string;
  readonly assignedToYou: string;
}

export const MESSAGES: Readonly<Record<Locale, Messages>> = {
  ar: {
    title: "لوحة التحكم",
    login: "تسجيل الدخول",
    email: "البريد الإلكتروني",
    password: "كلمة المرور",
    signIn: "دخول",
    signOut: "خروج",
    invalidCredentials: "بيانات الدخول غير صحيحة",
    language: "اللغة",
    dashboard: "الرئيسية",
    shipments: "الطرود",
    dispatch: "التوزيع",
    fleet: "الأسطول",
    network: "الشبكة",
    merchants: "التجار",
    pickups: "الاستلام",
    custody: "الحراسة",
    finance: "المالية",
    complaints: "الشكاوى",
    users: "المستخدمون",
    settings: "الإعدادات",
    audit: "سجل المراجعة",
    search: "بحث",
    loading: "جاري التحميل…",
    noResults: "لا توجد نتائج",
    create: "إنشاء",
    save: "حفظ",
    cancel: "إلغاء",
    confirm: "تأكيد",
    delete: "حذف",
    actions: "إجراءات",
    status: "الحالة",
    details: "التفاصيل",
    total: "المجموع",
    today: "اليوم",
    mfaRequired: "أدخل رمز المصادقة",
    mfaCode: "رمز التحقق",
    mfaVerify: "تحقق",
    mfaEnrolRequired: "يجب تفعيل المصادقة الثنائية",
    mfaEnrolInstructions: "امسح رمز QR بتطبيق المصادقة",

    newMerchant: "تاجر جديد",
    merchantName: "اسم التاجر",
    merchantCode: "رمز التاجر",
    contactName: "اسم جهة الاتصال",
    contactPhone: "هاتف جهة الاتصال",
    contactEmail: "بريد جهة الاتصال",
    fullName: "الاسم الكامل",
    phone: "الهاتف",
    accountManager: "المسؤول التجاري",
    houseManaged: "غير مُسنَد",
    assignAccountManager: "إسناد المسؤول التجاري",
    portalLogin: "حساب بوابة التاجر",
    createPortalLogin: "إنشاء حساب للتاجر",
    credentialShownOnce: "تُعرض كلمة المرور مرة واحدة فقط. سلّمها للتاجر الآن.",
    temporaryPassword: "كلمة المرور المؤقتة",
    performance: "الأداء",
    totalShipments: "إجمالي الطرود",
    deliveryRate: "نسبة التسليم",
    codCollected: "المبالغ المحصّلة",
    avgAttempts: "متوسط المحاولات",
    requestFailed: "تعذّر تنفيذ الطلب",
    back: "رجوع",

    reference: "المرجع",
    contact: "جهة الاتصال",
    parcels: "الطرود",
    pickupWindow: "الموعد",
    claimPickup: "أتكفّل بها",
    pickupNotClaimable: "لم تعد متاحة",
    assignedToYou: "مُسندة إليك",
  },
  fr: {
    title: "Tableau de bord",
    login: "Connexion",
    email: "Adresse e-mail",
    password: "Mot de passe",
    signIn: "Se connecter",
    signOut: "Déconnexion",
    invalidCredentials: "Identifiants invalides",
    language: "Langue",
    dashboard: "Tableau de bord",
    shipments: "Expéditions",
    dispatch: "Dispatch",
    fleet: "Flotte",
    network: "Réseau",
    merchants: "Commerçants",
    pickups: "Ramassages",
    custody: "Custody",
    finance: "Finance",
    complaints: "Réclamations",
    users: "Utilisateurs",
    settings: "Paramètres",
    audit: "Journal d'audit",
    search: "Rechercher",
    loading: "Chargement…",
    noResults: "Aucun résultat",
    create: "Créer",
    save: "Enregistrer",
    cancel: "Annuler",
    confirm: "Confirmer",
    delete: "Supprimer",
    actions: "Actions",
    status: "Statut",
    details: "Détails",
    total: "Total",
    today: "Aujourd'hui",
    mfaRequired: "Entrez le code d'authentification",
    mfaCode: "Code de vérification",
    mfaVerify: "Vérifier",
    mfaEnrolRequired: "L'authentification à deux facteurs est requise",
    mfaEnrolInstructions: "Scannez le code QR avec votre application d'authentification",

    newMerchant: "Nouveau commerçant",
    merchantName: "Nom du commerçant",
    merchantCode: "Code commerçant",
    contactName: "Nom du contact",
    contactPhone: "Téléphone du contact",
    contactEmail: "E-mail du contact",
    fullName: "Nom complet",
    phone: "Téléphone",
    accountManager: "Commercial",
    houseManaged: "Non attribué",
    assignAccountManager: "Attribuer le commercial",
    portalLogin: "Accès portail commerçant",
    createPortalLogin: "Créer l'accès du commerçant",
    credentialShownOnce:
      "Le mot de passe n'est affiché qu'une seule fois. Remettez-le au commerçant maintenant.",
    temporaryPassword: "Mot de passe temporaire",
    performance: "Performance",
    totalShipments: "Total des colis",
    deliveryRate: "Taux de livraison",
    codCollected: "Encaissements COD",
    avgAttempts: "Tentatives moyennes",
    requestFailed: "La requête a échoué",
    back: "Retour",

    reference: "Référence",
    contact: "Contact",
    parcels: "Colis",
    pickupWindow: "Créneau",
    claimPickup: "Je m'en charge",
    pickupNotClaimable: "Plus disponible",
    assignedToYou: "Qui vous est attribué",
  },
  en: {
    title: "Dashboard",
    login: "Sign in",
    email: "Email address",
    password: "Password",
    signIn: "Sign in",
    signOut: "Sign out",
    invalidCredentials: "Invalid credentials",
    language: "Language",
    dashboard: "Dashboard",
    shipments: "Shipments",
    dispatch: "Dispatch",
    fleet: "Fleet",
    network: "Network",
    merchants: "Merchants",
    pickups: "Pickups",
    custody: "Custody",
    finance: "Finance",
    complaints: "Complaints",
    users: "Users",
    settings: "Settings",
    audit: "Audit log",
    search: "Search",
    loading: "Loading…",
    noResults: "No results",
    create: "Create",
    save: "Save",
    cancel: "Cancel",
    confirm: "Confirm",
    delete: "Delete",
    actions: "Actions",
    status: "Status",
    details: "Details",
    total: "Total",
    today: "Today",
    mfaRequired: "Enter your authentication code",
    mfaCode: "Verification code",
    mfaVerify: "Verify",
    mfaEnrolRequired: "Two-factor authentication is required",
    mfaEnrolInstructions: "Scan the QR code with your authenticator app",

    newMerchant: "New merchant",
    merchantName: "Merchant name",
    merchantCode: "Merchant code",
    contactName: "Contact name",
    contactPhone: "Contact phone",
    contactEmail: "Contact email",
    fullName: "Full name",
    phone: "Phone",
    accountManager: "Account manager",
    houseManaged: "Unassigned",
    assignAccountManager: "Assign account manager",
    portalLogin: "Merchant portal login",
    createPortalLogin: "Create merchant login",
    credentialShownOnce: "The password is shown once. Hand it to the merchant now.",
    temporaryPassword: "Temporary password",
    performance: "Performance",
    totalShipments: "Total shipments",
    deliveryRate: "Delivery rate",
    codCollected: "COD collected",
    avgAttempts: "Average attempts",
    requestFailed: "The request failed",
    back: "Back",

    reference: "Reference",
    contact: "Contact",
    parcels: "Parcels",
    pickupWindow: "Window",
    claimPickup: "I'll take it",
    pickupNotClaimable: "No longer available",
    assignedToYou: "Assigned to you",
  },
};

export const STATUS_LABELS: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  ar: {
    CREATED: "جديد",
    PICKUP_ASSIGNED: "معيّن للاستلام",
    PICKED_UP: "تم الاستلام",
    AT_HUB: "في المركز",
    IN_TRANSIT: "قيد النقل",
    OUT_FOR_DELIVERY: "خارج للتوصيل",
    DELIVERED: "تم التسليم",
    FAILED_ATTEMPT: "محاولة فاشلة",
    RETURN_PENDING: "قيد الإرجاع",
    RETURNED: "مُرجع",
    CANCELLED: "ملغى",
  },
  fr: {
    CREATED: "Créé",
    PICKUP_ASSIGNED: "Ramassage assigné",
    PICKED_UP: "Ramassé",
    AT_HUB: "Au hub",
    IN_TRANSIT: "En transit",
    OUT_FOR_DELIVERY: "En livraison",
    DELIVERED: "Livré",
    FAILED_ATTEMPT: "Tentative échouée",
    RETURN_PENDING: "Retour en cours",
    RETURNED: "Retourné",
    CANCELLED: "Annulé",
  },
  en: {
    CREATED: "Created",
    PICKUP_ASSIGNED: "Pickup assigned",
    PICKED_UP: "Picked up",
    AT_HUB: "At hub",
    IN_TRANSIT: "In transit",
    OUT_FOR_DELIVERY: "Out for delivery",
    DELIVERED: "Delivered",
    FAILED_ATTEMPT: "Failed attempt",
    RETURN_PENDING: "Return pending",
    RETURNED: "Returned",
    CANCELLED: "Cancelled",
  },
};
