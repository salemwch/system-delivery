# Driver app: background-location field test

> The decision gate of [technology-decisions §5.3](./technology-decisions.md#53-the-background-location-risk--stated-plainly): React Native + Expo carries the driver app **only if** these criteria pass on real phones. Run it before any further mobile work. **Status:** app built (`apps/driver`, 2026-10-19); field test **not yet run**.

## 0. Free local test first (your PC + a phone on USB)

No hosting, no domain, no SMS provider, no cost: the API runs on the PC, the phone reaches it over USB, and sign-in codes are read from the API log. This proves the app works before any money is spent; the field test proper (§1–§5) needs the phone away from the PC, which needs a public HTTPS API ([staging-deployment.md](./staging-deployment.md)).

> Why not Render's free tier: its TimescaleDB lacks the community features migration 0018 uses (`add_retention_policy`), so the schema cannot be created there; free databases are deleted after 30 days; free web services sleep after 15 minutes; there is no free background worker (render.com/docs, checked 2026-10-19).

1. `pnpm dev:infra`, `pnpm --filter @delivery/api build`, `pnpm --filter @delivery/api db:migrate`, then `pnpm db:seed` once.
2. In the root `.env`: `DEV_LOG_SMS_BODIES=true` (development only; the API refuses to start with it under `NODE_ENV=production`).
3. `pnpm --filter @delivery/api dev:field-day` — creates the test driver (`+21620000099`), a van and today's published route.
4. Start the API: `cd apps/api && node --env-file=../../.env dist/main.js`.
5. Phone on USB with USB debugging on: `adb reverse tcp:3000 tcp:3000` and `adb reverse tcp:8081 tcp:8081`. `apps/driver/.env.local` holds `EXPO_PUBLIC_API_URL=http://localhost:3000` (copy `.env.example`).
6. Build and install once: `cd apps/driver && npx expo prebuild --platform android`, then `cd android && ANDROID_SERIAL=<serial from adb devices> ./gradlew :app:installDebug`. (`expo run:android` works too when only one device is attached; a third-party emulator on `emulator-5554` makes its device picker fail.)
7. Start Metro: `cd apps/driver && npx expo start --dev-client --port 8081`, open the app on the phone.
8. Sign in: courier code `fast-delivery`, phone `20000099`; the code is the last `DEV ONLY (DEV_LOG_SMS_BODIES)` line in the API log. Accept the disclosure, choose **Allow all the time**, then **Start shift**.

Unplugged, the phone loses `localhost`: for a walk or a drive, use a free HTTPS tunnel to the PC (`cloudflared tunnel --url http://localhost:3000`) and a release build with that URL, or wait for staging.

## 1. Pass / fail criteria

| # | Criterion | Target | How it is measured (§4) |
|---|---|---|---|
| C1 | Battery drain during an active shift | **< 6 %/hour** | `battery_pct` over the shift, phone not charged |
| C2 | Location delivered over an 8-hour shift | **> 95 %** of shift minutes covered | minutes with ≥ 1 position ÷ shift minutes |
| C3 | Recovery after force-stop | tracking resumes, nothing captured is lost | §3.3 |
| C4 | Recovery after reboot | tracking resumes, nothing captured is lost | §3.3 |

A minute is the unit for C2 because even the sparsest sampling profile (STATIONARY, `src/core/sampling.ts`) takes a fix every 60 s: a covered minute proves the whole chain (fix → encrypted queue → batch → `POST /v1/telemetry` → hypertable).

**Any criterion failing on any handset in the matrix fails the gate.** The fallback is the documented one: a native Kotlin location service behind the same `src/platform/device.ts` seam (§5.3, mitigation 3), not a rewrite.

## 2. Device matrix

At least one phone in each row, for at least **five working days** each (§5.3 asks for one week):

| Class | Why | Examples |
|---|---|---|
| Low-end Android, 2–3 GB RAM | What many drivers carry; the OS kills background work first | Samsung Galaxy A0x, Tecno, Infinix |
| Aggressive OEM battery manager | Notorious for killing foreground services | Xiaomi / Redmi (MIUI/HyperOS), Huawei, Oppo / Realme |
| Clean Android, recent | The baseline | Pixel, Samsung A5x |

Record for each phone: model, Android version, OEM skin version, RAM, battery health.

## 3. Procedure

### 3.1 Setup (once)

1. Set `EXPO_PUBLIC_API_URL` (https) in the **preview** EAS environment, then build: `eas build --profile field-test --platform android` from `apps/driver`.
2. In the staging tenant: a driver record per tester with their phone number, an ACTIVE vehicle each, and a route published to each driver for the day (the app starts the shift on the route's vehicle).
3. Install the APK, sign in with the courier code and phone, accept the disclosure, grant **"Allow all the time"**.
4. On aggressive-OEM phones, the diagnostics card shows "battery optimisation is on": tap **Turn off optimisation**, and also enable OEM "autostart" where the skin has it. Note whether the driver could do this unaided.

### 3.2 Daily run

1. Battery charged to ≥ 90 %, unplugged. Note the time and percentage.
2. **Start shift** in the app. Then use the phone normally; the app does not need to stay open.
3. Work the shift. Do not charge for the measured window (if the phone must charge, note when; that window is excluded).
4. **End shift** at the end. Note the time and percentage. Read out the diagnostics card (queued, last fix, last upload, mocked dropped).

### 3.3 Recovery checks (once per phone, mid-shift)

- **Force-stop**: Settings → Apps → Delivery Driver → Force stop. Wait 10 min. Open the app. Expected: tracking resumes on open, and the points captured before the stop arrive (no gap before the stop).
- **Reboot**: restart the phone with a shift open. Expected: same as above.

⚠️ Known limit to measure, not assume: Android does not restart a force-stopped app's services by itself, so tracking resumes **when the driver opens the app**, not before. Record the gap. If it is unacceptable, this is the case for a native `BOOT_COMPLETED` receiver (the §5.3 fallback).

## 4. Measurement (staging database, read-only)

Replace `:driver`, `:from`, `:to` with the driver id and the shift window.

```sql
-- C2: minute coverage over the shift window.
SELECT count(DISTINCT date_trunc('minute', time))::float
       / greatest(1, extract(epoch FROM (:to::timestamptz - :from::timestamptz)) / 60) AS coverage
  FROM driver_positions
 WHERE driver_id = :driver AND time BETWEEN :from AND :to;

-- C2 detail: gaps over 3 minutes (where the phone went quiet).
SELECT time AS resumed_at, time - lag(time) OVER (ORDER BY time) AS gap
  FROM driver_positions
 WHERE driver_id = :driver AND time BETWEEN :from AND :to
 ORDER BY gap DESC NULLS LAST
 LIMIT 20;

-- C1: battery drain per hour (exclude any charging window noted in §3.2).
SELECT (max(battery_pct) - min(battery_pct))::float
       / greatest(0.25, extract(epoch FROM (max(time) - min(time))) / 3600) AS pct_per_hour
  FROM driver_positions
 WHERE driver_id = :driver AND time BETWEEN :from AND :to AND battery_pct IS NOT NULL;
```

## 5. Report

One row per phone per day: model · OEM skin · C1 %/h · C2 coverage · largest gap · C3 · C4 · notes (what the driver had to change in settings). The gate passes when every row passes C1–C4.
