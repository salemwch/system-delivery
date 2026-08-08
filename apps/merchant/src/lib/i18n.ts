/**
 * Copy for the merchant portal, in the three languages this market works in.
 *
 * French leads because it is the working language of Tunisian commerce, but a
 * merchant in Sfax may well prefer Arabic and the switch is always one tap away.
 *
 * Status labels come from the API (`statusLabel`) wherever it returns them, so a
 * status added to the state machine cannot render blank here.
 */

export const LOCALES = ["ar", "fr", "en"] as const;
export type Locale = (typeof LOCALES)[number];

const LOCALE_SET: ReadonlySet<string> = new Set<string>(LOCALES);

export function toLocale(value: string | undefined): Locale {
  return value !== undefined && LOCALE_SET.has(value) ? (value as Locale) : "fr";
}

export function directionOf(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

interface Messages {
  // ── Shell ────────────────────────────────────────────────────────────────
  readonly portal: string;
  readonly dashboard: string;
  readonly shipments: string;
  readonly newShipment: string;
  readonly addressBook: string;
  readonly signOut: string;
  readonly language: string;
  readonly loading: string;
  readonly retry: string;
  readonly somethingWentWrong: string;

  // ── Sign in ──────────────────────────────────────────────────────────────
  readonly signIn: string;
  readonly signInSubtitle: string;
  readonly email: string;
  readonly password: string;
  readonly signInAction: string;
  readonly signInFailed: string;

  // ── Dashboard ────────────────────────────────────────────────────────────
  readonly inProgress: string;
  readonly deliveredThisMonth: string;
  readonly deliveryRate: string;
  readonly codOutstanding: string;
  readonly codCollected: string;
  readonly noShipmentsYet: string;
  readonly createFirst: string;
  readonly needsAttention: string;

  // ── Shipment list ────────────────────────────────────────────────────────
  readonly allStatuses: string;
  readonly search: string;
  readonly searchHint: string;
  readonly noResults: string;
  readonly noResultsHint: string;
  readonly loadMore: string;
  readonly recipient: string;
  readonly status: string;
  readonly cod: string;
  readonly created: string;

  // ── Create ───────────────────────────────────────────────────────────────
  readonly recipientDetails: string;
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly recipientPhoneHint: string;
  readonly deliveryAddress: string;
  readonly addressHint: string;
  readonly city: string;
  readonly parcelDetails: string;
  readonly codAmount: string;
  readonly codAmountHint: string;
  readonly noCod: string;
  readonly weight: string;
  readonly weightHint: string;
  readonly parcelCount: string;
  readonly notes: string;
  readonly notesHint: string;
  readonly create: string;
  readonly creating: string;
  readonly created_success: string;
  readonly useSavedAddress: string;
  readonly savedAddressHint: string;

  // ── Detail ───────────────────────────────────────────────────────────────
  readonly history: string;
  readonly printLabel: string;
  readonly deliveryNote: string;
  readonly consignmentNote: string;
  readonly returnNote: string;
  readonly cancelShipment: string;
  readonly cancelConfirm: string;
  readonly cancelReason: string;
  readonly confirm: string;
  readonly back: string;
  readonly trackingLink: string;
  readonly copyLink: string;
  readonly sender: string;
  readonly notFound: string;

  // ── Address book ─────────────────────────────────────────────────────────
  // ── Application (nouveaux clients) ─────────────────────────────────────────
  readonly register: string;
  readonly registerTitle: string;
  readonly registerSubtitle: string;
  readonly businessName: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly expectedVolume: string;
  readonly expectedVolumeHint: string;
  readonly tellUsMore: string;
  readonly submitApplication: string;
  readonly applicationReceived: string;
  readonly applicationReceivedHint: string;
  readonly backToSignIn: string;
  readonly haveNoAccount: string;

  readonly addressBookEmpty: string;
  readonly addressBookHint: string;
  readonly lastUsed: string;
  readonly deliveries: string;
  readonly sendAgain: string;
}

export const MESSAGES: Readonly<Record<Locale, Messages>> = {
  fr: {
    portal: "Espace expéditeur",
    dashboard: "Tableau de bord",
    shipments: "Colis",
    newShipment: "Nouveau colis",
    addressBook: "Carnet d'adresses",
    signOut: "Se déconnecter",
    language: "Langue",
    loading: "Chargement…",
    retry: "Réessayer",
    somethingWentWrong: "Une erreur est survenue",

    signIn: "Connexion",
    signInSubtitle: "Accédez à vos colis et à vos règlements.",
    email: "E-mail",
    password: "Mot de passe",
    signInAction: "Se connecter",
    signInFailed: "E-mail ou mot de passe incorrect.",

    inProgress: "En cours",
    deliveredThisMonth: "Livrés",
    deliveryRate: "Taux de livraison",
    codOutstanding: "À encaisser",
    codCollected: "Encaissé",
    noShipmentsYet: "Aucun colis pour le moment",
    createFirst: "Créez votre premier colis",
    needsAttention: "À surveiller",

    allStatuses: "Tous les statuts",
    search: "Rechercher",
    searchHint: "N° de suivi ou destinataire",
    noResults: "Aucun colis trouvé",
    noResultsHint: "Essayez un autre filtre ou une autre recherche.",
    loadMore: "Afficher plus",
    recipient: "Destinataire",
    status: "Statut",
    cod: "Contre-remboursement",
    created: "Créé le",

    recipientDetails: "Destinataire",
    recipientName: "Nom complet",
    recipientPhone: "Téléphone",
    recipientPhoneHint: "Format international, ex. +216 20 123 456",
    deliveryAddress: "Adresse de livraison",
    addressHint: "Rue, immeuble, repère — le plus précis possible",
    city: "Ville",
    parcelDetails: "Colis",
    codAmount: "Montant à encaisser",
    codAmountHint: "Laissez vide si le colis est déjà payé",
    noCod: "Déjà payé",
    weight: "Poids",
    weightHint: "En grammes",
    parcelCount: "Nombre de colis",
    notes: "Instructions",
    notesHint: "Étage, code d'entrée, heure préférée…",
    create: "Créer le colis",
    creating: "Création…",
    created_success: "Colis créé",
    useSavedAddress: "Destinataire enregistré",
    savedAddressHint: "Choisissez pour remplir automatiquement",

    history: "Historique",
    printLabel: "Étiquette",
    deliveryNote: "Bon de livraison",
    consignmentNote: "Bon d'envoi",
    returnNote: "Bon de retour",
    cancelShipment: "Annuler le colis",
    cancelConfirm: "Annuler ce colis ? Cette action est définitive.",
    cancelReason: "Motif",
    confirm: "Confirmer",
    back: "Retour",
    trackingLink: "Lien de suivi",
    copyLink: "Copier",
    sender: "Expéditeur",
    notFound: "Colis introuvable",

    register: "Devenir client",
    registerTitle: "Demande d’ouverture de compte",
    registerSubtitle: "Remplissez ce formulaire, nous vous rappelons.",
    businessName: "Nom de l’entreprise",
    contactName: "Personne à contacter",
    contactPhone: "Téléphone",
    expectedVolume: "Colis par mois",
    expectedVolumeHint: "Une estimation suffit",
    tellUsMore: "Que livrez-vous ?",
    submitApplication: "Envoyer la demande",
    applicationReceived: "Demande reçue",
    applicationReceivedHint: "Nous vous contactons sous 48 heures.",
    backToSignIn: "Retour à la connexion",
    haveNoAccount: "Pas encore client ?",
    addressBookEmpty: "Votre carnet est vide",
    addressBookHint: "Les destinataires apparaissent ici après leur premier colis.",
    lastUsed: "Dernier envoi",
    deliveries: "colis",
    sendAgain: "Renvoyer",
  },
  ar: {
    portal: "فضاء المرسل",
    dashboard: "لوحة القيادة",
    shipments: "الطرود",
    newShipment: "طرد جديد",
    addressBook: "دفتر العناوين",
    signOut: "تسجيل الخروج",
    language: "اللغة",
    loading: "جاري التحميل…",
    retry: "إعادة المحاولة",
    somethingWentWrong: "حدث خطأ",

    signIn: "تسجيل الدخول",
    signInSubtitle: "تابع طرودك ومستحقاتك.",
    email: "البريد الإلكتروني",
    password: "كلمة المرور",
    signInAction: "دخول",
    signInFailed: "البريد الإلكتروني أو كلمة المرور غير صحيحة.",

    inProgress: "قيد التنفيذ",
    deliveredThisMonth: "تم التسليم",
    deliveryRate: "نسبة التسليم",
    codOutstanding: "في انتظار التحصيل",
    codCollected: "تم تحصيله",
    noShipmentsYet: "لا توجد طرود بعد",
    createFirst: "أنشئ أول طرد لك",
    needsAttention: "يتطلب متابعة",

    allStatuses: "كل الحالات",
    search: "بحث",
    searchHint: "رقم التتبع أو المرسل إليه",
    noResults: "لا توجد نتائج",
    noResultsHint: "جرب تصفية أو بحثا آخر.",
    loadMore: "عرض المزيد",
    recipient: "المرسل إليه",
    status: "الحالة",
    cod: "الدفع عند الاستلام",
    created: "تاريخ الإنشاء",

    recipientDetails: "المرسل إليه",
    recipientName: "الاسم الكامل",
    recipientPhone: "الهاتف",
    recipientPhoneHint: "بالصيغة الدولية، مثال ‎+216 20 123 456",
    deliveryAddress: "عنوان التسليم",
    addressHint: "الشارع، العمارة، علامة مميزة — بأكبر دقة ممكنة",
    city: "المدينة",
    parcelDetails: "الطرد",
    codAmount: "المبلغ المطلوب تحصيله",
    codAmountHint: "اتركه فارغا إذا كان الطرد مدفوعا مسبقا",
    noCod: "مدفوع مسبقا",
    weight: "الوزن",
    weightHint: "بالغرام",
    parcelCount: "عدد الطرود",
    notes: "تعليمات",
    notesHint: "الطابق، رمز الدخول، الوقت المفضل…",
    create: "إنشاء الطرد",
    creating: "جاري الإنشاء…",
    created_success: "تم إنشاء الطرد",
    useSavedAddress: "مرسل إليه محفوظ",
    savedAddressHint: "اختر للتعبئة التلقائية",

    history: "السجل",
    printLabel: "الملصق",
    deliveryNote: "بون توصيل",
    consignmentNote: "بون إرسال",
    returnNote: "بون إرجاع",
    cancelShipment: "إلغاء الطرد",
    cancelConfirm: "إلغاء هذا الطرد؟ لا يمكن التراجع.",
    cancelReason: "السبب",
    confirm: "تأكيد",
    back: "رجوع",
    trackingLink: "رابط التتبع",
    copyLink: "نسخ",
    sender: "المرسل",
    notFound: "الطرد غير موجود",

    register: "كن عميلا",
    registerTitle: "طلب فتح حساب",
    registerSubtitle: "املأ هذه الاستمارة وسنتصل بك.",
    businessName: "اسم المؤسسة",
    contactName: "الشخص المسؤول",
    contactPhone: "الهاتف",
    expectedVolume: "عدد الطرود شهريا",
    expectedVolumeHint: "تقدير تقريبي يكفي",
    tellUsMore: "ماذا توصّل؟",
    submitApplication: "إرسال الطلب",
    applicationReceived: "تم استلام الطلب",
    applicationReceivedHint: "سنتصل بك في ظرف 48 ساعة.",
    backToSignIn: "العودة إلى تسجيل الدخول",
    haveNoAccount: "لست عميلا بعد؟",
    addressBookEmpty: "دفترك فارغ",
    addressBookHint: "يظهر المرسل إليهم هنا بعد أول طرد.",
    lastUsed: "آخر إرسال",
    deliveries: "طرد",
    sendAgain: "إرسال مجددا",
  },
  en: {
    portal: "Sender portal",
    dashboard: "Dashboard",
    shipments: "Parcels",
    newShipment: "New parcel",
    addressBook: "Address book",
    signOut: "Sign out",
    language: "Language",
    loading: "Loading…",
    retry: "Try again",
    somethingWentWrong: "Something went wrong",

    signIn: "Sign in",
    signInSubtitle: "Track your parcels and settlements.",
    email: "Email",
    password: "Password",
    signInAction: "Sign in",
    signInFailed: "Incorrect email or password.",

    inProgress: "In progress",
    deliveredThisMonth: "Delivered",
    deliveryRate: "Delivery rate",
    codOutstanding: "To collect",
    codCollected: "Collected",
    noShipmentsYet: "No parcels yet",
    createFirst: "Create your first parcel",
    needsAttention: "Needs attention",

    allStatuses: "All statuses",
    search: "Search",
    searchHint: "Tracking number or recipient",
    noResults: "No parcels found",
    noResultsHint: "Try a different filter or search.",
    loadMore: "Show more",
    recipient: "Recipient",
    status: "Status",
    cod: "Cash on delivery",
    created: "Created",

    recipientDetails: "Recipient",
    recipientName: "Full name",
    recipientPhone: "Phone",
    recipientPhoneHint: "International format, e.g. +216 20 123 456",
    deliveryAddress: "Delivery address",
    addressHint: "Street, building, landmark — as precise as you can",
    city: "City",
    parcelDetails: "Parcel",
    codAmount: "Amount to collect",
    codAmountHint: "Leave empty if already paid",
    noCod: "Already paid",
    weight: "Weight",
    weightHint: "In grams",
    parcelCount: "Number of parcels",
    notes: "Instructions",
    notesHint: "Floor, entry code, preferred time…",
    create: "Create parcel",
    creating: "Creating…",
    created_success: "Parcel created",
    useSavedAddress: "Saved recipient",
    savedAddressHint: "Pick one to fill the form",

    history: "History",
    printLabel: "Label",
    deliveryNote: "Delivery note",
    consignmentNote: "Consignment note",
    returnNote: "Return note",
    cancelShipment: "Cancel parcel",
    cancelConfirm: "Cancel this parcel? This cannot be undone.",
    cancelReason: "Reason",
    confirm: "Confirm",
    back: "Back",
    trackingLink: "Tracking link",
    copyLink: "Copy",
    sender: "Sender",
    notFound: "Parcel not found",

    register: "Become a client",
    registerTitle: "Account application",
    registerSubtitle: "Fill this in and we will call you back.",
    businessName: "Business name",
    contactName: "Contact person",
    contactPhone: "Phone",
    expectedVolume: "Parcels per month",
    expectedVolumeHint: "An estimate is fine",
    tellUsMore: "What do you ship?",
    submitApplication: "Send application",
    applicationReceived: "Application received",
    applicationReceivedHint: "We will be in touch within 48 hours.",
    backToSignIn: "Back to sign in",
    haveNoAccount: "Not a client yet?",
    addressBookEmpty: "Your address book is empty",
    addressBookHint: "Recipients appear here after their first parcel.",
    lastUsed: "Last sent",
    deliveries: "parcels",
    sendAgain: "Send again",
  },
};

/**
 * Shipment status labels.
 *
 * ⚠️ Status is shown as TEXT plus an icon, never colour alone (docs/08 §10):
 * red/green is the primary signal in logistics and colour-blind merchants exist.
 */
export const STATUS_LABELS: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  fr: {
    CREATED: "Créé",
    ASSIGNED: "Assigné",
    PICKED_UP: "Récupéré",
    AT_HUB: "Au centre",
    IN_TRANSIT: "En transit",
    OUT_FOR_DELIVERY: "En livraison",
    DELIVERED: "Livré",
    ATTEMPT_FAILED: "Échec de livraison",
    RETURN_PENDING: "Retour en cours",
    RETURNED: "Retourné",
    CANCELLED: "Annulé",
  },
  ar: {
    CREATED: "تم الإنشاء",
    ASSIGNED: "تم التعيين",
    PICKED_UP: "تم الاستلام",
    AT_HUB: "في المركز",
    IN_TRANSIT: "في الطريق",
    OUT_FOR_DELIVERY: "قيد التوصيل",
    DELIVERED: "تم التسليم",
    ATTEMPT_FAILED: "فشل التسليم",
    RETURN_PENDING: "قيد الإرجاع",
    RETURNED: "تم الإرجاع",
    CANCELLED: "ملغى",
  },
  en: {
    CREATED: "Created",
    ASSIGNED: "Assigned",
    PICKED_UP: "Picked up",
    AT_HUB: "At hub",
    IN_TRANSIT: "In transit",
    OUT_FOR_DELIVERY: "Out for delivery",
    DELIVERED: "Delivered",
    ATTEMPT_FAILED: "Delivery failed",
    RETURN_PENDING: "Returning",
    RETURNED: "Returned",
    CANCELLED: "Cancelled",
  },
};

/** Timeline entry labels, keyed by the event type the API returns. */
export const EVENT_LABELS: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  fr: {
    created: "Colis créé",
    assigned: "Assigné à un livreur",
    picked_up: "Récupéré",
    arrived_at_hub: "Arrivé au centre",
    departed: "Parti du centre",
    out_for_delivery: "En cours de livraison",
    delivered: "Livré",
    delivery_failed: "Tentative échouée",
    return_initiated: "Retour engagé",
    returned: "Retourné",
    cancelled: "Annulé",
  },
  ar: {
    created: "تم إنشاء الطرد",
    assigned: "تم التعيين لموزع",
    picked_up: "تم الاستلام",
    arrived_at_hub: "وصل إلى المركز",
    departed: "غادر المركز",
    out_for_delivery: "قيد التوصيل",
    delivered: "تم التسليم",
    delivery_failed: "محاولة فاشلة",
    return_initiated: "بدأ الإرجاع",
    returned: "تم الإرجاع",
    cancelled: "ملغى",
  },
  en: {
    created: "Parcel created",
    assigned: "Assigned to a driver",
    picked_up: "Picked up",
    arrived_at_hub: "Arrived at hub",
    departed: "Left the hub",
    out_for_delivery: "Out for delivery",
    delivered: "Delivered",
    delivery_failed: "Attempt failed",
    return_initiated: "Return started",
    returned: "Returned",
    cancelled: "Cancelled",
  },
};

/**
 * Statuses a merchant should look at.
 *
 * A failed attempt or a parcel coming back needs a decision from them — that is
 * the difference between a dashboard that informs and one that is just numbers.
 */
export const ATTENTION_STATUSES: ReadonlySet<string> = new Set([
  "ATTEMPT_FAILED",
  "RETURN_PENDING",
  "RETURNED",
]);

/** Statuses where the parcel is still moving. */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "CREATED",
  "ASSIGNED",
  "PICKED_UP",
  "AT_HUB",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "ATTEMPT_FAILED",
]);
