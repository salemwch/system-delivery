import Link from "next/link";
import { notFound } from "next/navigation";

import { DataTable, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { timezone } from "@/lib/config";
import { P } from "@/lib/permissions";
import { hasPermission, requireSession } from "@/lib/session";
import { fetchZones } from "@/lib/queries";

/**
 * Delivery territories.
 *
 * Read-only for now, and deliberately so: a zone is defined by a GeoJSON
 * polygon, and the honest way to edit one is by drawing it on a map. A textarea
 * of raw coordinates is not an editor — it is a way to corrupt a boundary and
 * find out when parcels stop being assigned. Creating and editing zones stays
 * with `POST/PATCH /v1/zones` until there is a map.
 *
 * The centroid is shown instead of the polygon, which is what a human can
 * actually check at a glance.
 */
export default async function ZonesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const tz = timezone();
  const query = await searchParams;

  const session = await requireSession(locale);
  if (!hasPermission(session, P.FEATURE_MANAGE)) {
    notFound();
  }

  const result = await fetchZones(query.cursor);

  return (
    <div className="space-y-4">
      <Link href={`/${locale}/settings`} className="text-sm text-brand hover:underline">
        ← {messages.settings}
      </Link>

      <PageHeader title={messages.zones} />

      <DataTable
        headers={[
          messages.reference,
          locale === "ar" ? "الاسم" : locale === "fr" ? "Nom" : "Name",
          messages.zoneRadius,
          locale === "ar" ? "المركز" : locale === "fr" ? "Centre" : "Centre",
          messages.status,
          locale === "ar" ? "التاريخ" : locale === "fr" ? "Date" : "Created",
        ]}
      >
        {result.data.map((zone) => (
          <tr key={zone.id} className="hover:bg-slate-50">
            <td className="px-4 py-3">
              <span className="ltr-isolate font-mono text-sm">{zone.code}</span>
            </td>
            <td className="px-4 py-3 text-sm font-medium">{zone.name}</td>
            <td className="px-4 py-3 text-sm tabular-nums ltr-isolate">
              {zone.defaultGeofenceRadiusM} m
            </td>
            <td className="px-4 py-3 text-sm tabular-nums ltr-isolate text-slate-500">
              {zone.centroidLat.toFixed(4)}, {zone.centroidLng.toFixed(4)}
            </td>
            <td className="px-4 py-3 text-sm">
              {zone.active ? (
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">
                  {messages.active}
                </span>
              ) : (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
                  {messages.inactive}
                </span>
              )}
            </td>
            <td className="px-4 py-3 text-sm text-slate-500">
              {formatDateTime(zone.createdAt, locale, tz)}
            </td>
          </tr>
        ))}
      </DataTable>

      {result.cursor !== null ? (
        <div className="flex justify-center">
          <Link
            href={`/${locale}/settings/zones?cursor=${encodeURIComponent(result.cursor)}`}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
          >
            {locale === "ar" ? "المزيد" : locale === "fr" ? "Voir plus" : "Load more"}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
