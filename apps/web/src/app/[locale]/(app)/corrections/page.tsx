import Link from "next/link";
import { notFound } from "next/navigation";

import { CorrectionDecision } from "@/components/correction-decision";
import { DataTable, PageHeader } from "@/components/ui";
import { timezone } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { fetchCorrections } from "@/lib/queries";
import { hasPermission, requireSession } from "@/lib/session";

const TABS = ["PENDING_REVIEW", "APPROVED", "REJECTED", "SUPERSEDED", "APPLIED"] as const;

/**
 * Corrections GPS — the dispatcher's queue of driver pin moves over 2 km
 * (docs/01-mvp-scope.md 2.10; docs/03 `CorrectAddressGeocode`).
 *
 * Oldest first, because a held correction is an address still routed to the
 * old pin. Each row links both pins to the map so the dispatcher can see what
 * two kilometres means here (a different neighbourhood, or the same building
 * across a boulevard) before deciding. The other tabs are the record.
 */
export default async function CorrectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ cursor?: string; status?: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const tz = timezone();
  const query = await searchParams;

  const session = await requireSession(locale);
  if (!hasPermission(session, P.ADDRESS_REVIEW)) {
    notFound();
  }

  const status = TABS.find((tab) => tab === query.status) ?? "PENDING_REVIEW";
  const result = await fetchCorrections(query.cursor, status);
  const base = `/${locale}/corrections`;

  return (
    <div className="space-y-4">
      <PageHeader title={messages.corrections} />

      <div className="flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <Link
            key={tab}
            href={tab === "PENDING_REVIEW" ? base : `${base}?status=${tab}`}
            aria-current={tab === status ? "page" : undefined}
            className={
              tab === status
                ? "rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-white"
                : "rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            }
          >
            {statusLabel(tab, locale)}
          </Link>
        ))}
      </div>

      {result.data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
          {messages.noCorrections}
        </p>
      ) : (
        <DataTable
          headers={[
            messages.city,
            messages.correctionPins,
            messages.correctionMoved,
            messages.observedAt,
            status === "PENDING_REVIEW" ? "" : messages.status,
          ]}
        >
          {result.data.map((correction) => (
            <tr key={correction.id} className="align-top hover:bg-slate-50">
              <td className="max-w-xs px-4 py-3 text-sm text-slate-800">
                <p>{correction.address?.city ?? "—"}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {correction.address?.rawInput ?? "—"}
                </p>
                {correction.accessNotes === null ? null : (
                  <p className="mt-1 text-xs text-slate-600">
                    <span className="font-medium">{messages.accessNotes}:</span>{" "}
                    {correction.accessNotes}
                  </p>
                )}
              </td>
              <td className="px-4 py-3 text-xs">
                <div className="flex flex-col gap-1">
                  {correction.from === null ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <MapLink point={correction.from} />
                  )}
                  <MapLink point={correction.to} />
                </div>
              </td>
              <td className="px-4 py-3 text-sm tabular-nums text-slate-800">
                <span className="ltr-isolate">{formatDistance(correction.distanceMovedM)}</span>
                {correction.accuracyM === null ? null : (
                  <p className="text-xs text-slate-500">
                    <span className="ltr-isolate">±{correction.accuracyM} m</span>
                  </p>
                )}
              </td>
              <td className="px-4 py-3 text-sm text-slate-500">
                {formatDateTime(correction.occurredAt, locale, tz)}
              </td>
              <td className="px-4 py-3">
                {status === "PENDING_REVIEW" ? (
                  <CorrectionDecision correctionId={correction.id} locale={locale} />
                ) : (
                  <div className="text-xs">
                    <span className="font-medium text-slate-800">
                      {statusLabel(correction.status, locale)}
                    </span>
                    {correction.reviewNote === null ? null : (
                      <p className="mt-0.5 max-w-xs text-slate-500">{correction.reviewNote}</p>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      )}

      {result.cursor === null ? null : (
        <div className="flex justify-center">
          <Link
            href={`${base}?status=${status}&cursor=${encodeURIComponent(result.cursor)}`}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
          >
            {messages.loadMore}
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * A pin, opened on OpenStreetMap in a new tab. A link, not an embedded map:
 * nothing is loaded from a third party until the dispatcher asks for it, so
 * the CSP stays `'self'` and no recipient location leaves the page uninvited.
 */
function MapLink({ point }: { point: { readonly lat: number; readonly lng: number } }) {
  const lat = point.lat.toFixed(6);
  const lng = point.lng.toFixed(6);
  return (
    <a
      href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`}
      target="_blank"
      rel="noopener noreferrer"
      className="ltr-isolate font-mono text-brand hover:underline"
    >
      {lat}, {lng}
    </a>
  );
}

function formatDistance(metres: number | null): string {
  if (metres === null) {
    return "—";
  }
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${String(metres)} m`;
}

function statusLabel(status: string, locale: Locale): string {
  const messages = MESSAGES[locale];
  switch (status) {
    case "APPROVED":
      return messages.approved;
    case "REJECTED":
      return messages.rejected;
    case "SUPERSEDED":
      return messages.superseded;
    case "APPLIED":
      return messages.applied;
    default:
      return messages.pending;
  }
}
