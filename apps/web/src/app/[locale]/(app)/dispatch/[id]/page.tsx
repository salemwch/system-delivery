import Link from "next/link";

import { StatusBadge } from "@/components/ui";
import { timezone } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import { toLocale } from "@/lib/i18n";
import { apiFetch } from "@/lib/api";

interface RouteDetail {
  readonly id: string;
  readonly status: string;
  readonly driverId: string | null;
  readonly driverName: string | null;
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly stops: readonly RouteStop[];
}

interface RouteStop {
  readonly id: string;
  readonly sequence: number;
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly recipientName: string;
  readonly address: string;
  readonly status: string;
}

export default async function RouteDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: raw, id } = await params;
  const locale = toLocale(raw);
  const tz = timezone();

  const route = await apiFetch<RouteDetail>(`/v1/routes/${encodeURIComponent(id)}`);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link
          href={`/${locale}/dispatch`}
          className="text-sm text-brand hover:underline"
        >
          {locale === "ar" ? "← التوزيع" : locale === "fr" ? "← Dispatch" : "← Dispatch"}
        </Link>
      </div>

      <div className="flex items-center gap-4">
        <h1 className="font-mono text-xl font-bold ltr-isolate">{route.id.slice(0, 8)}</h1>
        <StatusBadge status={route.status} locale={locale} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={locale === "ar" ? "التفاصيل" : locale === "fr" ? "Détails" : "Details"}>
          <InfoRow
            label={locale === "ar" ? "السائق" : locale === "fr" ? "Chauffeur" : "Driver"}
            value={route.driverName ?? "—"}
          />
          <InfoRow
            label={locale === "ar" ? "المسافة" : locale === "fr" ? "Distance" : "Distance"}
            value={route.distanceMeters > 0 ? `${(route.distanceMeters / 1000).toFixed(1)} km` : "—"}
            ltr
          />
          <InfoRow
            label={locale === "ar" ? "التاريخ" : locale === "fr" ? "Date" : "Created"}
            value={formatDateTime(route.createdAt, locale, tz)}
          />
          {route.startedAt !== null ? (
            <InfoRow
              label={locale === "ar" ? "البداية" : locale === "fr" ? "Départ" : "Started"}
              value={formatDateTime(route.startedAt, locale, tz)}
            />
          ) : null}
          {route.completedAt !== null ? (
            <InfoRow
              label={locale === "ar" ? "النهاية" : locale === "fr" ? "Fin" : "Completed"}
              value={formatDateTime(route.completedAt, locale, tz)}
            />
          ) : null}
        </Section>
      </div>

      <Section title={locale === "ar" ? "التوقفات" : locale === "fr" ? "Arrêts" : "Stops"}>
        <div className="divide-y divide-slate-100">
          {route.stops.map((stop) => (
            <div key={stop.id} className="flex items-center gap-4 py-3">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand/10 text-xs font-bold text-brand">
                {stop.sequence}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/${locale}/shipments/${stop.shipmentId}`}
                    className="ltr-isolate font-mono text-sm text-brand hover:underline"
                  >
                    {stop.trackingNumber}
                  </Link>
                  <StatusBadge status={stop.status} locale={locale} />
                </div>
                <p className="mt-0.5 truncate text-sm text-slate-500">{stop.recipientName} — {stop.address}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-500 uppercase tracking-wider">{title}</h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function InfoRow({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={`font-medium text-slate-900 ${ltr === true ? "ltr-isolate" : ""}`}>{value}</span>
    </div>
  );
}
