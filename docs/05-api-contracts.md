# API Contracts

> Concrete request/response shapes for every MVP endpoint. **Frozen before controllers are written**, so frontend and backend can proceed independently.
> Conventions and rationale: [api-strategy.md](./api-strategy.md) · Entities: [02-domain-model.md](./02-domain-model.md) · Events emitted: [03-event-storming.md](./03-event-storming.md)
> **Status:** DRAFT — awaiting approval.
> **Date:** 2026-07-22

---

## 1. Baseline

| | |
|---|---|
| **Base URL** | `https://api.<domain>/v1` |
| **Content type** | `application/json; charset=utf-8` |
| **Auth** | `Authorization: Bearer <JWT>` — except `/track/*` (token in path) and `/auth/*` |
| **Tenant** | Resolved **from the token claim only**. A client-supplied `X-Tenant-Id` header is rejected |
| **Idempotency** | `Idempotency-Key: <UUIDv7>` **required on every** `POST`/`PATCH`/`DELETE` |
| **Locale** | `Accept-Language: ar \| fr \| en` — drives error messages and notification language |
| **Correlation** | `X-Request-Id` echoed in responses and logs; generated if absent |

### 1.1 Standard error shape (RFC 9457)

```json
{
  "type": "https://api.example.com/problems/shipment-invalid-transition",
  "title": "Invalid status transition",
  "status": 409,
  "detail": "Cannot transition shipment from 'DELIVERED' to 'OUT_FOR_DELIVERY'.",
  "instance": "/v1/shipments/018f7b22-.../deliver",
  "code": "SHIPMENT_INVALID_TRANSITION",
  "requestId": "018f7c00-...",
  "errors": [
    { "field": "pod.recipientName", "code": "REQUIRED", "detail": "Required when podType is SIGNATURE." }
  ]
}
```

Clients branch on `code`, **never** on `detail` text (which is localised).

### 1.2 Error code registry (MVP)

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Schema violation; see `errors[]` |
| `UNAUTHENTICATED` | 401 | Missing/invalid/expired token |
| `FORBIDDEN` | 403 | Authenticated but lacks permission |
| `FEATURE_NOT_ENTITLED` | 403 | Tenant does not have this `TenantFeature` |
| `TENANT_SUSPENDED` | 403 | Tenant is suspended; writes blocked |
| `NOT_FOUND` | 404 | Not found **or not visible to this tenant** (deliberately indistinguishable) |
| `SHIPMENT_INVALID_TRANSITION` | 409 | State machine rejection |
| `DRIVER_SHIFT_ALREADY_OPEN` | 409 | One open shift per driver |
| `VEHICLE_IN_USE` | 409 | Vehicle already in an open shift |
| `ROUTE_NOT_DRAFT` | 409 | Mutation attempted on a published route |
| `MANIFEST_SEALED` | 409 | Contents immutable |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same key, different body |
| `POD_REQUIRED` | 422 | Delivery attempted without proof |
| `COD_AMOUNT_MISMATCH` | 422 | Collected ≠ expected without an allowed reason |
| `VARIANCE_REASON_REQUIRED` | 422 | Remittance variance without explanation |
| `CAPACITY_EXCEEDED` | 422 | Vehicle capacity violated |
| `GEOCODE_CONFIDENCE_TOO_LOW` | 422 | Address unusable for auto-dispatch |
| `RATE_LIMITED` | 429 | With `Retry-After` |

### 1.3 Money representation — on every money field, everywhere

```json
{ "amountMinor": 12500, "currency": "TND", "currencyExponent": 3 }
```

**`currencyExponent` is always present on the wire.** `12500` with exponent `3` is **12.500 TND**. A client assuming 2 decimals renders 125.00 TND — a 10× display error, and 1,000× against a 2-decimal currency. Making the exponent explicit means no client can get this wrong silently.

### 1.4 Pagination

```
GET /v1/shipments?limit=50&cursor=eyJpZCI6...
```
```json
{ "data": [ ... ], "page": { "nextCursor": "eyJpZCI6...", "hasMore": true } }
```
`limit` defaults to 50, caps at 200. **No unbounded list endpoint exists.**

---

## 2. Authentication

### `POST /v1/auth/login` — web users

**Request**
```json
{ "email": "dispatcher@courier.tn", "password": "••••••••", "tenantSlug": "courier-tn" }
```

**Response `200`**
```json
{
  "accessToken": "eyJhbGci...",
  "expiresIn": 600,
  "user": {
    "id": "018f7a11-...",
    "fullName": "Amina Ben Salah",
    "email": "dispatcher@courier.tn",
    "locale": "fr",
    "roles": ["DISPATCHER"],
    "permissions": ["shipment:read", "shipment:assign", "route:publish"],
    "hubScope": ["018f7b00-..."]
  },
  "tenant": {
    "id": "018f7a00-...",
    "name": "Courier TN",
    "defaultCurrency": "TND",
    "currencyExponent": 3,
    "defaultTimezone": "Africa/Tunis",
    "supportedLocales": ["ar", "fr", "en"],
    "features": {
      "COD_ENABLED": true,
      "MULTI_HUB_ENABLED": true,
      "SMS_ENABLED": true,
      "TRACKING_PAGE_ENABLED": true,
      "ROUTE_OPTIMIZATION_ENABLED": true,
      "POD_PHOTO_REQUIRED": false
    }
  }
}
```

Refresh token is set as an `HttpOnly; Secure; SameSite=Strict` cookie — never in the body.

**Notes.** **The `features` map is returned at login** so the UI can render the correct application from the first paint, with no flash of unavailable features. It is a *hint*, not the security boundary — the API guard is.

**Errors.** `401 UNAUTHENTICATED` (uniform response and timing for wrong email vs wrong password) · `403 TENANT_SUSPENDED` · `429 RATE_LIMITED`

---

### `POST /v1/auth/driver/otp/request` · `POST /v1/auth/driver/otp/verify`

**Request (request)**
```json
{ "phone": "+21698123456", "tenantSlug": "courier-tn" }
```
**Response `202`** — `{ "expiresIn": 300, "resendAfter": 60 }`. Returns `202` whether or not the phone exists, to avoid a driver-enumeration oracle.

**Request (verify)**
```json
{ "phone": "+21698123456", "tenantSlug": "courier-tn", "code": "483920", "deviceId": "a3f2...", "appVersion": "1.4.2" }
```
**Response `200`**
```json
{
  "accessToken": "eyJhbGci...",
  "expiresIn": 3600,
  "refreshToken": "rt_...",
  "driver": {
    "id": "018f7a99-...", "fullName": "Karim Trabelsi", "employeeCode": "DRV-042",
    "locale": "ar", "homeHubId": "018f7b00-...", "defaultVehicleId": "018f7c11-..."
  },
  "features": { "COD_ENABLED": true, "POD_PHOTO_REQUIRED": false, "GEOFENCE_ARRIVAL_ENABLED": true }
}
```

**Notes.** Driver access tokens live **1 hour** (not 10 minutes) to survive poor connectivity; `refreshToken` is bound to `deviceId` and server-revocable.

---

## 3. Shipments

### `POST /v1/shipments`

**Auth.** `shipment:create` — Dispatcher, Owner, API client.

**Request**
```json
{
  "externalReference": "ORD-2026-8891",
  "merchantId": "018f7d00-...",
  "serviceLevel": "STANDARD",
  "sender":    { "name": "Boutique Farah", "phone": "+21671234567" },
  "recipient": { "name": "Sonia Gharbi", "phone": "+21620987654", "phoneAlt": "+21698111222" },
  "originAddress":      { "addressId": "018f7e00-..." },
  "destinationAddress": {
    "line1": "Rue de la Liberté, Immeuble Yasmine, Apt 4B",
    "city": "Ariana", "postalCode": "2080", "countryCode": "TN",
    "accessNotes": "Derrière la pharmacie, 2ème étage, sonner 2 fois"
  },
  "promisedFrom": "2026-07-23T08:00:00Z",
  "promisedTo":   "2026-07-23T17:00:00Z",
  "parcelCount": 1,
  "weightGrams": 1200,
  "codAmountMinor": 12500,
  "currency": "TND",
  "requiredSkills": [],
  "customFields": { "giftWrap": true }
}
```

**Response `201`**
```json
{
  "id": "018f7b22-...",
  "trackingNumber": "CTN-8K3M-92XQ",
  "status": "CREATED",
  "codStatus": "PENDING",
  "codAmountMinor": 12500, "currency": "TND", "currencyExponent": 3,
  "destinationAddress": {
    "id": "018f7e11-...",
    "normalisedLine1": "Rue de la Liberté, Immeuble Yasmine, Apt 4B",
    "city": "Ariana", "postalCode": "2080", "countryCode": "TN",
    "location": { "lat": 36.8625, "lon": 10.1956 },
    "geocodeConfidence": 0.72,
    "geocodeSource": "mapbox",
    "timezone": "Africa/Tunis",
    "requiresReview": true
  },
  "legs": [ { "id": "018f7b23-...", "legNumber": 1, "type": "LAST_MILE", "status": "PLANNED" } ],
  "trackingUrl": "https://track.<domain>/courier-tn/CTN-8K3M-92XQ",
  "createdAt": "2026-07-22T09:14:03.221Z"
}
```

**Notes.**
- `destinationAddress` accepts **either** `addressId` **or** an inline address to resolve.
- **`requiresReview: true`** is returned when `geocodeConfidence` is below the tenant threshold. The shipment is created but **blocked from auto-dispatch** — this is the MENA address-quality control surfacing in the API, not hidden in a background job.
- `codAmountMinor` is rejected if `COD_ENABLED` is off for the tenant.

**Emits.** `shipment.created`

**Errors.** `422 VALIDATION_FAILED` (missing `recipient.phone` — mandatory, see [02-domain-model §3.6 rule 4](./02-domain-model.md#36-shipment)) · `422 GEOCODE_CONFIDENCE_TOO_LOW` (below hard floor) · `403 FEATURE_NOT_ENTITLED` (COD on a non-COD tenant) · `409` duplicate `externalReference`

---

### `GET /v1/shipments/{id}`

**Response `200`**
```json
{
  "id": "018f7b22-...",
  "trackingNumber": "CTN-8K3M-92XQ",
  "status": "OUT_FOR_DELIVERY",
  "serviceLevel": "STANDARD",
  "merchant": { "id": "018f7d00-...", "name": "Boutique Farah" },
  "recipient": { "name": "Sonia Gharbi", "phone": "+21620987654" },
  "destinationAddress": { "id": "018f7e11-...", "line1": "...", "city": "Ariana",
                          "location": { "lat": 36.8625, "lon": 10.1956 }, "accessNotes": "..." },
  "promisedFrom": "2026-07-23T08:00:00Z",
  "promisedTo": "2026-07-23T17:00:00Z",
  "etaAt": "2026-07-23T14:22:00Z",
  "codAmountMinor": 12500, "currency": "TND", "currencyExponent": 3, "codStatus": "PENDING",
  "attemptCount": 0, "maxAttempts": 3,
  "currentCustody": { "type": "DRIVER", "id": "018f7a99-...", "name": "Karim Trabelsi" },
  "legs": [ { "id": "018f7b23-...", "legNumber": 1, "type": "LAST_MILE", "status": "IN_PROGRESS",
              "routeStopId": "018f7f00-..." } ],
  "assignment": { "routeId": "018f7f10-...", "driverId": "018f7a99-...", "sequence": 7 }
}
```

**Notes.** `codAmountMinor` is **omitted entirely** for roles without `cod:read` (Dispatcher) — field-level authorization, not merely hidden in the UI.

---

### `GET /v1/shipments` — the dispatcher list

```
GET /v1/shipments
  ?status=CREATED,ASSIGNED
  &promisedTo[lte]=2026-07-23T23:59:59Z
  &hubId=018f7b00-...
  &requiresReview=true
  &sort=-promisedTo
  &fields=id,trackingNumber,status,recipient,destinationAddress,etaAt
  &limit=50
```

**Response `200`** — `{ "data": [ ...shipment summaries... ], "page": { "nextCursor": "...", "hasMore": true } }`

Filterable/sortable fields are **allow-listed per resource** — an open filter surface is both a performance risk (unindexed sorts) and an information-disclosure risk.

---

### `GET /v1/shipments/{id}/events` — the custody log

**Response `200`**
```json
{
  "data": [
    { "sequence": 1, "type": "CREATED", "occurredAt": "2026-07-22T09:14:03Z",
      "recordedAt": "2026-07-22T09:14:03Z",
      "actor": { "type": "API_CLIENT", "id": "018f7d00-..." }, "location": null },
    { "sequence": 2, "type": "ASSIGNED", "occurredAt": "2026-07-23T07:02:11Z",
      "recordedAt": "2026-07-23T07:02:11Z",
      "actor": { "type": "DISPATCHER", "id": "018f7a11-...", "name": "Amina Ben Salah" },
      "context": { "routeId": "018f7f10-...", "driverId": "018f7a99-..." } },
    { "sequence": 3, "type": "PICKED_UP", "occurredAt": "2026-07-23T08:31:47Z",
      "recordedAt": "2026-07-23T09:04:12Z",
      "actor": { "type": "DRIVER", "id": "018f7a99-...", "name": "Karim Trabelsi" },
      "location": { "lat": 36.8008, "lon": 10.1817, "accuracyM": 12.4 } }
  ]
}
```

**Notes.** Sequence 3 shows `recordedAt` **33 minutes after** `occurredAt` — an offline capture synced later. This is normal, not an error. **SLA is always measured on `occurredAt`.**

---

### `POST /v1/shipments/{id}/assign`

**Auth.** `shipment:assign` — Dispatcher, Owner.

**Request**
```json
{ "routeId": "018f7f10-...", "legId": "018f7b23-...", "position": 7 }
```

**Response `200`**
```json
{
  "shipmentId": "018f7b22-...", "status": "ASSIGNED",
  "assignment": {
    "routeId": "018f7f10-...", "routeStopId": "018f7f00-...",
    "driverId": "018f7a99-...", "driverName": "Karim Trabelsi",
    "vehicleId": "018f7c11-...", "sequence": 7,
    "plannedArrivalAt": "2026-07-23T14:15:00Z", "etaAt": "2026-07-23T14:22:00Z"
  }
}
```

**Emits.** `shipment.assigned`
**Errors.** `409 ROUTE_NOT_DRAFT` · `422 CAPACITY_EXCEEDED` · `422 GEOCODE_CONFIDENCE_TOO_LOW` · `403 FORBIDDEN` (driver lacks required skill)

---

### `POST /v1/shipments/{id}/deliver` ⭐

**Auth.** Driver only, and only for a shipment on their own active route.

**Request**
```json
{
  "attemptId": "018f8a00-...",
  "occurredAt": "2026-07-23T14:02:11.412Z",
  "location": { "lat": 36.8624, "lon": 10.1957, "accuracyM": 8.2 },
  "pod": {
    "type": "SIGNATURE",
    "recipientName": "Sonia Gharbi",
    "recipientRelationship": "SELF",
    "signatureObjectKey": "tenant/018f7a00/pod/018f8a00/sig.png",
    "photoObjectKeys": [],
    "contentHashes": ["sha256:9f2c..."]
  },
  "cod": { "collected": true, "amountMinor": 12500, "currency": "TND", "method": "CASH" },
  "deviceMetadata": { "model": "Redmi Note 12", "os": "Android 14", "appVersion": "1.4.2", "mockLocation": false }
}
```

**Response `200`**
```json
{
  "shipmentId": "018f7b22-...",
  "status": "DELIVERED",
  "codStatus": "COLLECTED",
  "deliveredAt": "2026-07-23T14:02:11.412Z",
  "recordedAt": "2026-07-23T14:47:03.980Z",
  "wasOnTime": true,
  "podId": "018f8b00-...",
  "distanceFromDestinationM": 14,
  "driverCashBalance": { "amountMinor": 87500, "currency": "TND", "currencyExponent": 3 }
}
```

**Notes.**
- **`Idempotency-Key` is critical here.** The driver app is offline-first and will retry. A replay returns this exact response with `Idempotency-Replayed: true` and creates nothing.
- **`occurredAt` comes from the device**; the server records its own receipt time. Both are stored.
- **`driverCashBalance` is returned** so the app can show a running cash total without a second call — a driver needs to know what they are carrying.
- Media is uploaded separately via pre-signed URLs (§8) **before** this call; only object keys travel here. The delivery does not wait on a photo upload.

**Emits (one transaction).** `delivery.attempted` → `pod.captured` → `shipment.delivered` → `cod.collected`

**Errors.** `409 SHIPMENT_INVALID_TRANSITION` (already delivered/returned) · `422 POD_REQUIRED` · `422 COD_AMOUNT_MISMATCH` · `403 FORBIDDEN` (not this driver's shipment)

---

### `POST /v1/shipments/{id}/fail`

**Request**
```json
{
  "attemptId": "018f8a01-...",
  "occurredAt": "2026-07-23T15:20:00Z",
  "reasonCode": "CUSTOMER_UNAVAILABLE",
  "reasonNotes": "Appelé 2 fois, pas de réponse",
  "location": { "lat": 36.8626, "lon": 10.1955, "accuracyM": 11.0 },
  "dwellTimeSeconds": 214,
  "photoObjectKeys": ["tenant/018f7a00/attempt/018f8a01/door.jpg"]
}
```

**Response `200`**
```json
{
  "shipmentId": "018f7b22-...", "status": "ATTEMPT_FAILED",
  "attemptNumber": 1, "attemptsRemaining": 2,
  "nextAttemptAt": "2026-07-24T08:00:00Z",
  "willReturn": false
}
```

**Notes.** `reasonCode` must come from the tenant's taxonomy (`GET /v1/config/failure-reasons`) — free text cannot drive automation. `dwellTimeSeconds` feeds the `NO_ATTEMPT_TRACE` fraud rule.

**Emits.** `delivery.attempted`, `delivery.failed`, and `shipment.return_initiated` when the attempt is not re-attemptable — which is decided by the REASON first and only then by the attempt count. A `CUSTOMER_REFUSED` returns on attempt 1; `CUSTOMER_UNAVAILABLE` returns when the cap is reached. Either way the RETURN leg is planned in the same transaction.

---

### `POST /v1/shipments/{id}/return` · `POST /v1/shipments/{id}/return/complete`

The two halves of the RTO lifecycle (01-mvp-scope §4.2 #2.8).

`return` takes `{ "reason": "...", "returnToAddressId"?, "returnHubId"? }` → `200` with status `RETURN_PENDING`. It plans the RETURN leg (domain §3.7 rule 6) and clears `nextAttemptAt`. A dispatcher decides this when the automatic policy has not already.

`return/complete` records the parcel physically back with the merchant:

```json
{ "receivedByName": "Ines (Boutique)", "driverId": "018f7c33-...", "occurredAt": "2026-07-25T09:12:00Z" }
```

→ `200` with status `RETURNED`. Permission is **`shipment:deliver`**, not `shipment:update`: handing a parcel back is a custody transfer performed by the driver who carried it, and asserting that a parcel arrived somewhere is not an edit.

**Notes.** Completing the return sets `codStatus` to `CANCELLED` — the cash was never collected and never will be, so leaving it `PENDING` would over-report cash-in-field forever (domain §5.2). `receivedByName` is optional because a return handed back at a hub counter often has no signature, but it is the only record when a merchant later disputes that the parcel came back.

**Emits.** `shipment.return_initiated`, then `shipment.returned` (carrying `codCollected: false` for the merchant SMS).

**Errors.** `409 SHIPMENT_INVALID_TRANSITION` — only `RETURN_PENDING` may be completed, so a parcel still `OUT_FOR_DELIVERY` cannot be declared returned.

---

### `GET /v1/shipments/{id}/documents/{documentType}`

Printable paperwork (01-mvp-scope §4.2 #2.14). `documentType` is
`bon-de-livraison`, `bon-d-envoi` or `bon-de-retour`; `?locale=ar|fr|en` defaults
to the tenant's own language, then French.

**Response `200 text/html`** — a complete, self-contained A5 page, `cache-control:
no-store`.

**⚠️ HTML, not PDF, and deliberately.** Arabic requires bidirectional layout and
contextual glyph shaping; browsers do both natively and Node PDF libraries do
neither, so a generated PDF renders Arabic as disconnected letters in
left-to-right order. The browser's own Print-to-PDF produces a correct PDF from
this page. Nothing is fetched at render time — CSS and the QR SVG are inline, so a
warehouse PC on a bad connection prints the same document as anyone else.

The COD amount is formatted through the currency's real ISO 4217 exponent.
**TND has three decimal places**, so this prints `45.500`, never `45.50`.

**Permission.** `shipment:label` — the same authority as printing the parcel
label, and RLS plus the merchant scope apply, so a merchant cannot fetch a rival's
document.

**Errors.** `404` for an unknown document type · `422 DOCUMENT_NOT_APPLICABLE` for
a return note on a parcel that is not `RETURN_PENDING` or `RETURNED` — that
document would otherwise be signed as proof a merchant took back a parcel still
out for delivery.

---

### `POST /v1/shipments/{id}/cancel` · `POST /v1/shipments/bulk`

`cancel` takes `{ "reason": "MERCHANT_REQUEST", "notes": "..." }` → `200` with new status. Requires `OWNER` if already in custody.

`bulk` accepts a CSV/XLSX upload (multipart) → `202`:
```json
{ "jobId": "018f9000-...", "statusUrl": "/v1/jobs/018f9000-...", "rowCount": 340 }
```
Polling the job returns per-row results with **actionable rejections** — `"Row 47: address could not be geocoded with sufficient confidence"`, not `"validation error"`.

---

## 4. Routes & Dispatch

### `POST /v1/routes`
```json
{ "plannedDate": "2026-07-23", "driverId": "018f7a99-...", "vehicleId": "018f7c11-...", "startHubId": "018f7b00-..." }
```
→ `201` `{ "id": "018f7f10-...", "code": "R-20260723-014", "status": "DRAFT", "stopCount": 0 }`

### `POST /v1/routes/{id}/stops`
```json
{ "legIds": ["018f7b23-...", "018f7b24-..."] }
```
→ `200` with the updated stop list and running capacity utilisation.

### `POST /v1/routes/{id}/optimize`

→ `202` `{ "jobId": "018f9100-...", "statusUrl": "/v1/jobs/018f9100-..." }`

Job result:
```json
{
  "status": "succeeded",
  "result": {
    "routeId": "018f7f10-...", "stopCount": 38,
    "plannedDistanceM": 74200, "plannedDurationS": 21840,
    "solver": "OSRM_NN_2OPT", "solveDurationMs": 412, "usedFallback": false,
    "sequence": [ { "routeStopId": "018f7f00-...", "sequence": 1, "plannedArrivalAt": "2026-07-23T08:20:00Z" } ]
  }
}
```

**Notes.** **`usedFallback` is surfaced deliberately.** A rising fallback rate means route quality is silently degrading — invisible in ordinary metrics. Gated by `ROUTE_OPTIMIZATION_ENABLED`; when off, stops keep their manual order.

**Emits.** `route.optimized`

### `POST /v1/routes/{id}/publish`

→ `200`
```json
{
  "routeId": "018f7f10-...", "status": "PUBLISHED",
  "driverId": "018f7a99-...", "stopCount": 38, "shipmentCount": 41,
  "codShipmentCount": 27,
  "totalCodAmountMinor": 486500, "currency": "TND", "currencyExponent": 3,
  "publishedAt": "2026-07-23T07:02:11Z"
}
```

**Notes.** `totalCodAmountMinor` tells the driver upfront how much cash they will carry — a genuine safety and planning concern, not a nicety.

**Emits.** `route.published`
**Errors.** `422` no driver / no vehicle · `409` driver already has an `IN_PROGRESS` route

### `GET /v1/routes/{id}/manifest` — the driver's day

```json
{
  "routeId": "018f7f10-...", "code": "R-20260723-014", "status": "IN_PROGRESS",
  "driver": { "id": "018f7a99-...", "fullName": "Karim Trabelsi" },
  "vehicle": { "id": "018f7c11-...", "plateNumber": "123 TU 4567" },
  "summary": { "stopsTotal": 38, "stopsCompleted": 6, "codExpectedMinor": 486500, "codCollectedMinor": 87500 },
  "stops": [
    {
      "id": "018f7f00-...", "sequence": 7, "type": "DELIVERY", "status": "PENDING",
      "location": { "lat": 36.8625, "lon": 10.1956 },
      "address": { "line1": "Rue de la Liberté, Immeuble Yasmine, Apt 4B", "city": "Ariana",
                   "accessNotes": "Derrière la pharmacie, 2ème étage, sonner 2 fois" },
      "plannedArrivalAt": "2026-07-23T14:15:00Z",
      "shipments": [
        { "id": "018f7b22-...", "trackingNumber": "CTN-8K3M-92XQ",
          "recipientName": "Sonia Gharbi", "recipientPhone": "+21620987654",
          "parcelCount": 1, "codAmountMinor": 12500, "currency": "TND", "currencyExponent": 3,
          "requiredPodTypes": ["SIGNATURE"] }
      ]
    }
  ]
}
```

**Notes.** This is the **single payload the driver app caches for offline operation**. It deliberately includes `recipientPhone` and `accessNotes` — without them the driver cannot complete a Tunisian delivery when offline.

---

## 5. Driver Operations

### `POST /v1/drivers/me/shifts` · `POST /v1/drivers/me/shifts/{id}/end`

Start request: `{ "vehicleId": "018f7c11-...", "hubId": "018f7b00-...", "location": {...} }` → `201`
```json
{ "shiftId": "018f8000-...", "startedAt": "2026-07-23T07:30:00Z",
  "telemetryEnabled": true, "telemetryConfig": { "movingIntervalS": 5, "idleIntervalS": 30, "batchIntervalS": 20, "distanceFilterM": 20 } }
```

End response includes an outstanding-cash prompt:
```json
{ "shiftId": "018f8000-...", "endedAt": "2026-07-23T18:05:00Z", "telemetryEnabled": false,
  "outstandingCash": { "amountMinor": 486500, "currency": "TND", "currencyExponent": 3, "remittanceRequired": true } }
```

**Notes.** ⚠️ **`telemetryEnabled: false` is a privacy control.** The server rejects telemetry outside an open shift regardless of what the app sends. `telemetryConfig` is server-driven so sampling can be tuned per tenant without an app release.

**Emits.** `driver.shift_started` / `driver.shift_ended`

### `POST /v1/telemetry` — GPS batch

```json
{
  "shiftId": "018f8000-...",
  "batchId": "018f8100-...",
  "positions": [
    { "t": "2026-07-23T14:01:51Z", "lat": 36.8620, "lon": 10.1950, "acc": 9.1, "spd": 6.2, "hdg": 145, "bat": 74, "mov": true },
    { "t": "2026-07-23T14:01:56Z", "lat": 36.8622, "lon": 10.1953, "acc": 8.4, "spd": 5.1, "hdg": 148, "bat": 74, "mov": true }
  ]
}
```

**Response `202`** — `{ "accepted": 2, "rejected": 0, "serverTime": "2026-07-23T14:02:03Z" }`

**Notes.**
- **Deliberately terse field names.** At ~10,000 positions/sec this payload is the highest-volume request in the system; `lat` vs `latitude` matters at that rate.
- Rejected outside an open shift, and when accuracy exceeds the threshold.
- **This endpoint is versioned and transport-agnostic on purpose** — it is the first thing extracted to Go, and later moved to MQTT, behind an unchanged contract ([ADR-005](./01-mvp-scope.md#3-adr-005--mvp-deployment-topology)).
- **Emits no business event.** Only geofence transitions cross into the business plane.

### `POST /v1/drivers/me/sync` — offline reconciliation

```json
{
  "deviceId": "a3f2...",
  "lastSyncAt": "2026-07-23T13:40:00Z",
  "pendingEvents": [
    { "idempotencyKey": "018f8c00-...", "type": "DELIVERED", "shipmentId": "018f7b22-...", "payload": { } },
    { "idempotencyKey": "018f8c01-...", "type": "FAILED",    "shipmentId": "018f7b25-...", "payload": { } }
  ]
}
```

**Response `200`**
```json
{
  "results": [
    { "idempotencyKey": "018f8c00-...", "status": "ACCEPTED", "shipmentId": "018f7b22-..." },
    { "idempotencyKey": "018f8c01-...", "status": "REJECTED", "code": "SHIPMENT_INVALID_TRANSITION",
      "detail": "Shipment was cancelled by dispatcher at 14:10.", "action": "DISCARD_AND_REFRESH" }
  ],
  "routeUpdates": [ { "routeId": "018f7f10-...", "version": 4, "changedStopIds": ["018f7f0a-..."] } ],
  "featureUpdates": { "POD_PHOTO_REQUIRED": true },
  "serverTime": "2026-07-23T14:02:03Z"
}
```

**Notes.** **Per-item results, never all-or-nothing.** One rejected event must not block the other nineteen. `action` tells the app exactly what to do — `DISCARD_AND_REFRESH`, `RETRY_LATER`, or `ESCALATE_TO_DISPATCHER` — instead of leaving it to guess. This is where offline-first is either real or theatre.

---

## 6. Hub & Custody

### `POST /v1/manifests` · `/items` · `/seal` · `/receive-scan` · `/finalise`

Seal → `200` `{ "id": "...", "code": "MF-TUN01-0231", "status": "SEALED", "itemCount": 128, "sealedAt": "..." }`

Receive scan (one call per physical scan):
```json
{ "barcode": "CTN-8K3M-92XQ" }
```
→ `200` `{ "matched": true, "shipmentId": "018f7b22-...", "scannedCount": 41, "expectedCount": 128 }`

Finalise → `200`
```json
{
  "manifestId": "018fa000-...", "status": "RECEIVED",
  "expectedCount": 128, "scannedCount": 126,
  "missingShipmentIds": ["018f7b90-...", "018f7b91-..."],
  "unexpectedShipmentIds": [],
  "discrepancyCount": 2,
  "requiresResolution": true
}
```

**Notes.** Receipt is a **physical scan loop, not a bulk-confirm button**. `requiresResolution: true` blocks `RECONCILED` until every discrepancy has a reason and an owner. 🟥 Hotspot H2 (accountability) is unresolved.

**Emits.** `manifest.sealed` / `.received` / `.discrepancy_raised`

---

## 7. Finance

### `GET /v1/finance/drivers/{id}/cash`
```json
{
  "driverId": "018f7a99-...",
  "balance": { "amountMinor": 486500, "currency": "TND", "currencyExponent": 3 },
  "unremittedCollections": [
    { "shipmentId": "018f7b22-...", "trackingNumber": "CTN-8K3M-92XQ",
      "amountMinor": 12500, "collectedAt": "2026-07-23T14:02:11Z" }
  ],
  "oldestCollectionAt": "2026-07-23T09:12:00Z",
  "remittanceOverdue": false
}
```

### `POST /v1/finance/remittances`
```json
{ "driverId": "018f7a99-...", "hubId": "018f7b00-...", "declaredAmountMinor": 486500, "currency": "TND" }
```
→ `201`
```json
{ "id": "018fb000-...", "code": "RMT-20260723-0044", "status": "SUBMITTED",
  "expectedAmountMinor": 486500, "declaredAmountMinor": 486500,
  "currency": "TND", "currencyExponent": 3, "shipmentCount": 27 }
```

### `POST /v1/finance/remittances/{id}/confirm`

**Auth.** Hub Operator, Finance, Owner — **not** the submitting driver.

```json
{ "countedAmountMinor": 486000, "varianceReason": "SHORT_500_MILLIMES_DRIVER_ACKNOWLEDGED", "notes": "Driver to repay next shift" }
```
→ `200`
```json
{
  "id": "018fb000-...", "status": "CONFIRMED",
  "expectedAmountMinor": 486500,
  "declaredAmountMinor": 486500,
  "countedAmountMinor": 486000,
  "varianceMinor": -500,
  "varianceDirection": "SHORTAGE",
  "currency": "TND", "currencyExponent": 3,
  "ledgerTransactionId": "018fb100-...",
  "driverBalanceAfter": { "amountMinor": 500, "currency": "TND", "currencyExponent": 3 },
  "fraudFlagRaised": true
}
```

**Notes.** **All three amounts appear in the response.** `-500` minor units on a 3-decimal currency is **0.500 TND**, not 5.00. `driverBalanceAfter` is `500` because the shortfall remains the driver's liability until repaid or written off — the ledger never silently absorbs a discrepancy.

**Emits.** `cod.cash_remitted`, `cod.variance_detected`
**Errors.** `422 VARIANCE_REASON_REQUIRED`

### `GET /v1/finance/cash-in-field`
```json
{
  "total": { "amountMinor": 4820000, "currency": "TND", "currencyExponent": 3 },
  "byDriver": [ { "driverId": "018f7a99-...", "fullName": "Karim Trabelsi",
                  "amountMinor": 486500, "oldestCollectionAt": "2026-07-23T09:12:00Z", "overdue": false } ],
  "asOf": "2026-07-23T18:30:00Z"
}
```
**Notes.** Read **synchronously from the ledger**, never from an eventually-consistent projection. This is money.

### `POST /v1/finance/settlements` · `/approve` · `/mark-paid`

Approve is rejected with `403 FORBIDDEN` when the approver created the draft — separation of duties, enforced in the domain service, not the controller.

---

## 8. Media Upload

### `POST /v1/media/presign`
```json
{ "purpose": "POD_PHOTO", "shipmentId": "018f7b22-...", "contentType": "image/jpeg", "sizeBytes": 184320 }
```
→ `200`
```json
{ "objectKey": "tenant/018f7a00/pod/018f8a00/photo-1.jpg",
  "uploadUrl": "https://storage.../presigned...", "expiresIn": 900,
  "requiredHeaders": { "Content-Type": "image/jpeg" } }
```

**Notes.** Direct-to-storage upload. The API never proxies binaries. Keys are **tenant-prefixed** and the presigned URL is scoped to that prefix. Content type is allow-listed and magic-bytes verified server-side after upload.

---

## 9. Public Tracking (unauthenticated)

### `GET /v1/track/{tenantSlug}/{trackingNumber}?token=...`

```json
{
  "trackingNumber": "CTN-8K3M-92XQ",
  "status": "OUT_FOR_DELIVERY",
  "statusLabel": { "ar": "قيد التوصيل", "fr": "En cours de livraison", "en": "Out for delivery" },
  "recipientFirstName": "Sonia",
  "destinationCity": "Ariana",
  "destinationMasked": "Rue de la Liberté, Imm. Y••••••, Apt ••",
  "etaFrom": "2026-07-23T14:10:00Z",
  "etaTo": "2026-07-23T14:40:00Z",
  "timeline": [
    { "type": "CREATED",          "occurredAt": "2026-07-22T09:14:03Z", "location": "Tunis" },
    { "type": "PICKED_UP",        "occurredAt": "2026-07-23T08:31:47Z", "location": "Tunis" },
    { "type": "OUT_FOR_DELIVERY", "occurredAt": "2026-07-23T13:05:00Z", "location": "Ariana" }
  ],
  "codAmountMinor": 12500, "currency": "TND", "currencyExponent": 3,
  "carrier": { "name": "Courier TN", "supportPhone": "+21671000000" },
  "canReschedule": false
}
```

**Notes — this is the most exposed endpoint in the system:**
- **Minimal PII by design.** First name only, masked address, **no phone number**, no other shipments, no driver identity.
- Token is unguessable, HMAC-verified, expiring, and scoped to **one** shipment.
- `statusLabel` is pre-localised into all three languages so the page renders correctly with no client-side dictionary.
- **Live driver position is not exposed at MVP** — it reveals a courier's whereabouts to anyone holding a link.
- Rate-limited harder than any authenticated endpoint. Gated by `TRACKING_PAGE_ENABLED`.

---

## 10. WebSocket (dispatcher)

**`wss://api.<domain>/v1/realtime`** — JWT in handshake, re-validated on refresh.

**Client → server**
```json
{ "op": "subscribe", "channels": ["drivers:viewport"], "viewport": { "bbox": [10.10, 36.79, 10.28, 36.90] } }
{ "op": "subscribe", "channels": ["route:018f7f10-...", "shipment:018f7b22-..."] }
```

**Server → client**
```json
{ "op": "positions", "ts": "2026-07-23T14:02:03Z",
  "drivers": [ { "id": "018f7a99-...", "lat": 36.8622, "lon": 10.1953, "hdg": 148, "spd": 5.1, "bat": 74 } ] }

{ "op": "shipment_updated", "shipment": { "id": "018f7b22-...", "status": "DELIVERED", "etaAt": null } }

{ "op": "alert", "severity": "warning", "code": "DRIVER_OFFLINE",
  "driverId": "018f7a99-...", "lastSeenAt": "2026-07-23T13:42:00Z", "stopsRemaining": 14 }
```

**Rules.** One coalesced `positions` frame per second per client (never one per driver) · viewport-scoped · server verifies tenant ownership of every subscription · under backpressure, drop superseded `positions` frames but **never** `shipment_updated` or `alert`.

---

## 11. Config (drives UI without a release)

### `GET /v1/config/bootstrap`
```json
{
  "features": { "COD_ENABLED": true, "SMS_ENABLED": true, "POD_PHOTO_REQUIRED": false },
  "failureReasons": [
    { "code": "CUSTOMER_UNAVAILABLE", "labels": { "ar": "العميل غير متوفر", "fr": "Client absent", "en": "Customer unavailable" }, "allowsReattempt": true },
    { "code": "INSUFFICIENT_CASH",    "labels": { "ar": "نقص في السيولة",   "fr": "Fonds insuffisants", "en": "Insufficient cash" }, "allowsReattempt": true },
    { "code": "CUSTOMER_REFUSED",     "labels": { "ar": "رفض العميل",       "fr": "Refus du client",    "en": "Customer refused" }, "allowsReattempt": false }
  ],
  "podTypes": ["SIGNATURE", "PHOTO", "OTP"],
  "currency": { "code": "TND", "exponent": 3, "symbol": "د.ت" },
  "timezone": "Africa/Tunis",
  "locales": ["ar", "fr", "en"],
  "weekendDays": [6, 7]
}
```

**Notes.** One call at app start supplies everything needed to render correctly. **Failure reasons are tenant-configured data, not a hardcoded enum** — a new reason code is a config change, not a release. `allowsReattempt` drives the app's flow directly.

---

## 12. Contract Governance

| Practice | Rule |
|---|---|
| Source of truth | OpenAPI 3.1 **generated from Zod schemas** — spec cannot drift from implementation |
| Breaking-change gate | Automated spec diff in CI; breaking change without a version bump fails the build |
| Client types | TypeScript types generated from the spec, shared by dispatcher, admin, tracking page, and driver app |
| Sandbox | Seeded demo tenant with simulated driver movement |
| Field-level authz | Response shaping by role is part of the contract (see COD omission in §3), not an afterthought |

---

## 13. Open Items

| # | Item | Blocked on |
|---|---|---|
| AC1 | Confirm whether the tracking page should expose live driver position (privacy vs. customer expectation) | Product + H4 |
| AC2 | Confirm failure-reason taxonomy with a real Tunisian courier | MVP-O4 / DM5 |
| AC3 | Decide whether partial COD collection needs an API shape | H3 / DM3 |
| AC4 | Confirm driver token TTL of 1 hour against real connectivity in rural governorates | Field test |
