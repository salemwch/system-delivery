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
  readonly mfaEnrolManual: string;

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
  readonly invoices: string;
  readonly invoice: string;
  readonly creditNote: string;
  readonly newInvoice: string;
  readonly billingSettings: string;
  readonly invoiceNumber: string;
  readonly period: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly subtotalHt: string;
  readonly vat: string;
  readonly stampDuty: string;
  readonly totalTtc: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly amount: string;
  readonly addLine: string;
  readonly issueInvoice: string;
  readonly markPaid: string;
  readonly cancelDraft: string;
  readonly createCreditNote: string;
  readonly printInvoice: string;
  readonly reason: string;
  readonly vatRate: string;
  readonly paymentTerms: string;
  readonly legalName: string;
  readonly taxIdentifier: string;
  readonly legalAddress: string;
  readonly issueWarning: string;
  readonly correctsInvoice: string;
  readonly invoiceActionFailed: string;
  readonly assignedToYou: string;
  readonly pickupAddress: string;
  readonly pickupAddressHint: string;
  readonly city: string;
  readonly phoneHint: string;
  readonly addressOnFile: string;
  readonly addressMissing: string;
  readonly errorCodeTaken: string;
  readonly errorEmailTaken: string;
  readonly errorNotFound: string;
  readonly errorForbidden: string;
  readonly errorValidation: string;
  readonly errorRequired: string;
  readonly errorPhone: string;
  readonly errorFormat: string;
  readonly errorWindowOrder: string;
  readonly requestPickup: string;
  readonly acceptPickup: string;
  readonly pickupWindowFrom: string;
  readonly pickupWindowTo: string;
  readonly notes: string;
  readonly pickupCreated: string;
  readonly documents: string;
  readonly deliveryNote: string;
  readonly consignmentNote: string;
  readonly returnNote: string;
  readonly smsTemplates: string;
  readonly zones: string;
  readonly cities: string;
  readonly governorate: string;
  readonly postalCode: string;
  readonly deliveryFee: string;
  readonly returnFee: string;
  readonly deliveryDelay: string;
  readonly aliasesLabel: string;
  readonly aliasesHint: string;
  readonly nameArabic: string;
  readonly addCity: string;
  readonly retire: string;
  readonly restore: string;
  readonly searchCity: string;
  readonly unservedCities: string;
  readonly loadMore: string;
  readonly applications: string;
  readonly approveApplication: string;
  readonly rejectApplication: string;
  readonly logLead: string;
  readonly expectedVolume: string;
  readonly source: string;
  readonly sourcePublic: string;
  readonly sourceStaff: string;
  readonly pending: string;
  readonly approved: string;
  readonly rejected: string;
  readonly amendments: string;
  readonly noAmendments: string;
  readonly requestChange: string;
  readonly applyChange: string;
  readonly amendHint: string;
  readonly applied: string;
  readonly destination: string;
  /** The sidebar section and page title. */
  readonly remarks: string;
  /** The panel heading on a subject's page — distinguishes it from the section. */
  readonly internalRemarks: string;
  readonly noRemarks: string;
  readonly addRemark: string;
  readonly pin: string;
  readonly unpin: string;
  readonly resolveRemark: string;
  readonly reopen: string;
  readonly openRemarks: string;
  readonly resolvedRemarks: string;
  readonly subject: string;
  readonly importShipments: string;
  readonly templateDefault: string;
  readonly templateOverridden: string;
  readonly templateRevert: string;
  readonly smsSegments: string;
  readonly zoneRadius: string;
  readonly active: string;
  readonly inactive: string;
  readonly importFile: string;
  readonly importColumns: string;
  readonly importDelimiter: string;
  readonly importDelimiterHint: string;
  readonly importRowsReady: string;
  readonly importSucceeded: string;
  readonly importLine: string;
  readonly importEmpty: string;
  readonly importTooMany: string;
  readonly importMissingColumns: string;
  readonly importRowErrors: string;
  readonly importPartial: string;
  readonly import: string;
  readonly importPickMerchant: string;
  readonly print: string;
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
    mfaEnrolManual: "أو أدخل هذا المفتاح يدويًا:",

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
    invoices: "الفواتير",
    invoice: "فاتورة",
    creditNote: "إشعار دائن",
    newInvoice: "فاتورة جديدة",
    billingSettings: "إعدادات الفوترة",
    invoiceNumber: "رقم الفاتورة",
    period: "الفترة",
    issueDate: "تاريخ الإصدار",
    dueDate: "تاريخ الاستحقاق",
    subtotalHt: "المجموع دون أداء",
    vat: "الأداء على القيمة المضافة",
    stampDuty: "الطابع الجبائي",
    totalTtc: "المجموع بالأداء",
    description: "البيان",
    quantity: "الكمية",
    unitPrice: "سعر الوحدة",
    amount: "المبلغ",
    addLine: "إضافة سطر",
    issueInvoice: "إصدار الفاتورة",
    markPaid: "تسجيل الخلاص",
    cancelDraft: "إلغاء المسودة",
    createCreditNote: "إنشاء إشعار دائن",
    printInvoice: "طباعة",
    reason: "السبب",
    vatRate: "نسبة الأداء (%)",
    paymentTerms: "أجل الخلاص (أيام)",
    legalName: "الاسم القانوني",
    taxIdentifier: "المعرف الجبائي",
    legalAddress: "العنوان القانوني",
    issueWarning: "الإصدار نهائي: يستهلك رقمًا لا يمكن استرجاعه، وتصبح الفاتورة غير قابلة للتعديل.",
    correctsInvoice: "يلغي ويعوض الفاتورة",
    invoiceActionFailed: "تعذّر تنفيذ العملية.",
    pickupNotClaimable: "لم تعد متاحة",
    assignedToYou: "مُسندة إليك",
    pickupAddress: "عنوان الاستلام",
    pickupAddressHint: "بدونه لا يمكن طلب استلام لهذا التاجر",
    city: "المدينة",
    phoneHint: "24 201 314 أو 216 24 201 314+",
    addressOnFile: "عنوان الاستلام مسجَّل. أدخل عنوانًا جديدًا لتعويضه.",
    addressMissing: "لا يوجد عنوان استلام — لا يمكن طلب استلام لهذا التاجر.",
    errorCodeTaken: "رمز التاجر مستعمل من قبل. اختر رمزًا آخر.",
    errorEmailTaken: "البريد الإلكتروني مستعمل من قبل في هذه الشركة.",
    errorNotFound: "العنصر غير موجود أو خارج نطاقك.",
    errorForbidden: "لا تملك صلاحية هذا الإجراء.",
    errorValidation: "تحقّق من الحقول المميّزة.",
    errorRequired: "هذا الحقل مطلوب",
    errorPhone: "رقم هاتف غير صالح",
    errorFormat: "صيغة غير صالحة",
    errorWindowOrder: "يجب أن تكون النهاية بعد البداية",
    requestPickup: "طلب استلام",
    acceptPickup: "قبول",
    pickupWindowFrom: "من",
    pickupWindowTo: "إلى",
    notes: "ملاحظات",
    pickupCreated: "تم إنشاء طلب الاستلام. اقبله ثم تكفّل به.",
    documents: "الوثائق",
    deliveryNote: "وصل التسليم",
    consignmentNote: "وصل الإرسال",
    returnNote: "وصل الإرجاع",
    smsTemplates: "قوالب الرسائل",
    zones: "المناطق",
    cities: "المدن",
    governorate: "الولاية",
    postalCode: "الترقيم البريدي",
    deliveryFee: "تعريفة التوصيل",
    returnFee: "تعريفة الإرجاع",
    deliveryDelay: "مدة التوصيل",
    aliasesLabel: "تسميات أخرى",
    aliasesHint: "اسم في كل سطر",
    nameArabic: "الاسم بالعربية",
    addCity: "إضافة مدينة",
    retire: "إيقاف",
    restore: "تفعيل",
    searchCity: "ابحث عن مدينة",
    unservedCities: "مدن غير مغطاة",
    loadMore: "المزيد",
    applications: "عملاء جدد",
    approveApplication: "قبول",
    rejectApplication: "رفض",
    logLead: "تسجيل عميل محتمل",
    expectedVolume: "الحجم المتوقع",
    source: "المصدر",
    sourcePublic: "استمارة",
    sourceStaff: "تسجيل داخلي",
    pending: "في الانتظار",
    approved: "مقبول",
    rejected: "مرفوض",
    amendments: "تعديل الطرود",
    noAmendments: "لا توجد تعديلات",
    requestChange: "طلب تعديل",
    applyChange: "تطبيق التعديل",
    amendHint: "املأ الحقول التي تريد تغييرها فقط",
    applied: "مطبّق",
    destination: "الوجهة",
    remarks: "الملاحظات",
    internalRemarks: "ملاحظات داخلية",
    noRemarks: "لا توجد ملاحظات",
    addRemark: "أضف ملاحظة",
    pin: "تثبيت",
    unpin: "إلغاء التثبيت",
    resolveRemark: "معالجة",
    reopen: "إعادة فتح",
    openRemarks: "قيد المعالجة",
    resolvedRemarks: "تمت معالجتها",
    subject: "الموضوع",
    importShipments: "استيراد الطرود",
    templateDefault: "افتراضي",
    templateOverridden: "مُعدّل",
    templateRevert: "استعادة الافتراضي",
    smsSegments: "عدد الرسائل",
    zoneRadius: "نطاق السياج",
    active: "نشط",
    inactive: "غير نشط",
    importFile: "ملف CSV",
    importColumns: "الأعمدة المطلوبة: recipientName, recipientPhone, address — واختياريًا city, codAmount, weightGrams, parcelCount, reference",
    importDelimiter: "الفاصل",
    importDelimiterHint: "تستعمل بعض ملفات إكسل الفرنسية الفاصلة المنقوطة",
    importRowsReady: "صفوف جاهزة",
    importSucceeded: "تم إنشاء الطرود",
    importLine: "السطر",
    importEmpty: "الملف لا يحتوي على صفوف",
    importTooMany: "الحد الأقصى 100 صف لكل ملف",
    importMissingColumns: "أعمدة ناقصة",
    importRowErrors: "صحّح الأسطر التالية ثم أعد المحاولة — لم يتم استيراد أي صف",
    importPartial: "تم استيراد بعض الصفوف فقط",
    import: "استيراد الطرود",
    importPickMerchant: "اختر التاجر أولًا — الملف لا يحتوي على عمود التاجر.",
    print: "طباعة",
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
    audit: "Journal d’audit",
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
    mfaEnrolManual: "Ou saisissez cette clé manuellement :",

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
    invoices: "Factures",
    invoice: "Facture",
    creditNote: "Avoir",
    newInvoice: "Nouvelle facture",
    billingSettings: "Paramètres de facturation",
    invoiceNumber: "N° de facture",
    period: "Période",
    issueDate: "Date d'émission",
    dueDate: "Échéance",
    subtotalHt: "Total HT",
    vat: "TVA",
    stampDuty: "Timbre fiscal",
    totalTtc: "Total TTC",
    description: "Désignation",
    quantity: "Qté",
    unitPrice: "P.U. HT",
    amount: "Montant",
    addLine: "Ajouter une ligne",
    issueInvoice: "Émettre la facture",
    markPaid: "Marquer payée",
    cancelDraft: "Annuler le brouillon",
    createCreditNote: "Créer un avoir",
    printInvoice: "Imprimer",
    reason: "Motif",
    vatRate: "Taux de TVA (%)",
    paymentTerms: "Délai de paiement (jours)",
    legalName: "Raison sociale",
    taxIdentifier: "Matricule fiscal",
    legalAddress: "Adresse légale",
    issueWarning: "L'émission est définitive : elle consomme un numéro non réutilisable et fige la facture.",
    correctsInvoice: "Annule et remplace la facture",
    invoiceActionFailed: "L'opération n'a pas pu aboutir.",
    pickupNotClaimable: "Plus disponible",
    assignedToYou: "Qui vous est attribué",
    pickupAddress: "Adresse de ramassage",
    pickupAddressHint: "Sans elle, aucun ramassage ne peut être demandé pour ce commerçant",
    city: "Ville",
    phoneHint: "24 201 314 ou +216 24 201 314",
    addressOnFile: "Une adresse de ramassage est enregistrée. Saisissez-en une nouvelle pour la remplacer.",
    addressMissing: "Aucune adresse de ramassage — aucun ramassage ne peut être demandé.",
    errorCodeTaken: "Ce code commerçant est déjà utilisé. Choisissez-en un autre.",
    errorEmailTaken: "Cette adresse e-mail est déjà utilisée dans cette société.",
    errorNotFound: "Introuvable, ou hors de votre portefeuille.",
    errorForbidden: "Vous n avez pas le droit d effectuer cette action.",
    errorValidation: "Vérifiez les champs signalés.",
    errorRequired: "Ce champ est obligatoire",
    errorPhone: "Numéro de téléphone invalide",
    errorFormat: "Format invalide",
    errorWindowOrder: "La fin doit être après le début",
    requestPickup: "Demander un ramassage",
    acceptPickup: "Accepter",
    pickupWindowFrom: "De",
    pickupWindowTo: "À",
    notes: "Notes",
    pickupCreated: "Demande de ramassage créée. Acceptez-la puis prenez-la en charge.",
    documents: "Documents",
    deliveryNote: "Bon de livraison",
    consignmentNote: "Bon d’envoi",
    returnNote: "Bon de retour",
    smsTemplates: "Modèles SMS",
    zones: "Zones",
    cities: "Villes",
    governorate: "Gouvernorat",
    postalCode: "Code postal",
    deliveryFee: "Tarif livraison",
    returnFee: "Tarif retour",
    deliveryDelay: "Délai",
    aliasesLabel: "Autres appellations",
    aliasesHint: "Une par ligne",
    nameArabic: "Nom en arabe",
    addCity: "Ajouter une ville",
    retire: "Désactiver",
    restore: "Réactiver",
    searchCity: "Rechercher une ville",
    unservedCities: "Villes non desservies",
    loadMore: "Voir plus",
    applications: "Nouveaux clients",
    approveApplication: "Accepter",
    rejectApplication: "Refuser",
    logLead: "Enregistrer un prospect",
    expectedVolume: "Volume estimé",
    source: "Origine",
    sourcePublic: "Formulaire",
    sourceStaff: "Saisie interne",
    pending: "En attente",
    approved: "Acceptés",
    rejected: "Refusés",
    amendments: "Modification colis",
    noAmendments: "Aucune modification",
    requestChange: "Demander une modification",
    applyChange: "Appliquer la modification",
    amendHint: "Remplissez uniquement ce qui doit changer",
    applied: "Appliquée",
    destination: "Destination",
    remarks: "Remarques",
    internalRemarks: "Remarques internes",
    noRemarks: "Aucune remarque",
    addRemark: "Ajouter une remarque",
    pin: "Épingler",
    unpin: "Détacher",
    resolveRemark: "Traiter",
    reopen: "Rouvrir",
    openRemarks: "À traiter",
    resolvedRemarks: "Traitées",
    subject: "Objet",
    importShipments: "Import colis",
    templateDefault: "Par défaut",
    templateOverridden: "Personnalisé",
    templateRevert: "Rétablir le défaut",
    smsSegments: "Segments SMS",
    zoneRadius: "Rayon geofence",
    active: "Actif",
    inactive: "Inactif",
    importFile: "Fichier CSV",
    importColumns: "Colonnes requises : recipientName, recipientPhone, address — facultatives : city, codAmount, weightGrams, parcelCount, reference",
    importDelimiter: "Séparateur",
    importDelimiterHint: "Excel en français exporte souvent avec des points-virgules",
    importRowsReady: "Lignes prêtes",
    importSucceeded: "Colis créés",
    importLine: "Ligne",
    importEmpty: "Le fichier ne contient aucune ligne",
    importTooMany: "100 lignes maximum par fichier",
    importMissingColumns: "Colonnes manquantes",
    importRowErrors: "Corrigez les lignes ci-dessous puis réessayez — aucune ligne n a été importée",
    importPartial: "Certaines lignes seulement ont été importées",
    import: "Import colis",
    importPickMerchant: "Choisissez d abord le commerçant — le fichier ne contient pas de colonne commerçant.",
    print: "Imprimer",
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
    mfaEnrolManual: "Or enter this key manually:",

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
    invoices: "Invoices",
    invoice: "Invoice",
    creditNote: "Credit note",
    newInvoice: "New invoice",
    billingSettings: "Billing settings",
    invoiceNumber: "Invoice no.",
    period: "Period",
    issueDate: "Issue date",
    dueDate: "Due date",
    subtotalHt: "Subtotal",
    vat: "VAT",
    stampDuty: "Stamp duty",
    totalTtc: "Total",
    description: "Description",
    quantity: "Qty",
    unitPrice: "Unit price",
    amount: "Amount",
    addLine: "Add line",
    issueInvoice: "Issue invoice",
    markPaid: "Mark paid",
    cancelDraft: "Cancel draft",
    createCreditNote: "Create credit note",
    printInvoice: "Print",
    reason: "Reason",
    vatRate: "VAT rate (%)",
    paymentTerms: "Payment terms (days)",
    legalName: "Legal name",
    taxIdentifier: "Tax ID",
    legalAddress: "Legal address",
    issueWarning: "Issuing is final: it consumes a number that cannot be reused and freezes the invoice.",
    correctsInvoice: "Cancels and replaces invoice",
    invoiceActionFailed: "The operation could not be completed.",
    pickupNotClaimable: "No longer available",
    assignedToYou: "Assigned to you",
    pickupAddress: "Pickup address",
    pickupAddressHint: "Without it, no pickup can be requested for this merchant",
    city: "City",
    phoneHint: "24 201 314 or +216 24 201 314",
    addressOnFile: "A pickup address is on file. Enter a new one to replace it.",
    addressMissing: "No pickup address — no pickup can be requested for this merchant.",
    errorCodeTaken: "That merchant code is already in use. Choose another.",
    errorEmailTaken: "That email address is already used in this company.",
    errorNotFound: "Not found, or outside your portfolio.",
    errorForbidden: "You do not have permission for this action.",
    errorValidation: "Check the highlighted fields.",
    errorRequired: "This field is required",
    errorPhone: "Invalid phone number",
    errorFormat: "Invalid format",
    errorWindowOrder: "The end must be after the start",
    requestPickup: "Request a pickup",
    acceptPickup: "Accept",
    pickupWindowFrom: "From",
    pickupWindowTo: "To",
    notes: "Notes",
    pickupCreated: "Pickup request created. Accept it, then claim it.",
    documents: "Documents",
    deliveryNote: "Delivery note",
    consignmentNote: "Consignment note",
    returnNote: "Return note",
    smsTemplates: "SMS templates",
    zones: "Zones",
    cities: "Cities",
    governorate: "Governorate",
    postalCode: "Postal code",
    deliveryFee: "Delivery fee",
    returnFee: "Return fee",
    deliveryDelay: "Lead time",
    aliasesLabel: "Also known as",
    aliasesHint: "One per line",
    nameArabic: "Arabic name",
    addCity: "Add a city",
    retire: "Retire",
    restore: "Restore",
    searchCity: "Search a city",
    unservedCities: "Cities not served",
    loadMore: "Load more",
    applications: "New clients",
    approveApplication: "Approve",
    rejectApplication: "Reject",
    logLead: "Log a lead",
    expectedVolume: "Expected volume",
    source: "Source",
    sourcePublic: "Form",
    sourceStaff: "Logged by staff",
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
    amendments: "Parcel changes",
    noAmendments: "No changes requested",
    requestChange: "Request a change",
    applyChange: "Apply the change",
    amendHint: "Fill in only what should change",
    applied: "Applied",
    destination: "Destination",
    remarks: "Remarks",
    internalRemarks: "Internal remarks",
    noRemarks: "No remarks",
    addRemark: "Add a remark",
    pin: "Pin",
    unpin: "Unpin",
    resolveRemark: "Resolve",
    reopen: "Reopen",
    openRemarks: "Open",
    resolvedRemarks: "Resolved",
    subject: "Subject",
    importShipments: "Import shipments",
    templateDefault: "Default",
    templateOverridden: "Customised",
    templateRevert: "Revert to default",
    smsSegments: "SMS segments",
    zoneRadius: "Geofence radius",
    active: "Active",
    inactive: "Inactive",
    importFile: "CSV file",
    importColumns: "Required columns: recipientName, recipientPhone, address — optional: city, codAmount, weightGrams, parcelCount, reference",
    importDelimiter: "Delimiter",
    importDelimiterHint: "French Excel often exports with semicolons",
    importRowsReady: "Rows ready",
    importSucceeded: "Shipments created",
    importLine: "Line",
    importEmpty: "The file contains no rows",
    importTooMany: "100 rows maximum per file",
    importMissingColumns: "Missing columns",
    importRowErrors: "Fix the lines below and try again — nothing was imported",
    importPartial: "Only some rows were imported",
    import: "Import shipments",
    importPickMerchant: "Pick the merchant first — the file carries no merchant column.",
    print: "Print",
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
