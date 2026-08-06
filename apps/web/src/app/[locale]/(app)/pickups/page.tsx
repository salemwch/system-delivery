import Link from "next/link";

import { ClaimPickupButton } from "@/components/claim-pickup-button";
import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { timezone } from "@/lib/config";
import { P } from "@/lib/permissions";
import { hasPermission, requireSession } from "@/lib/session";
import { fetchPickups } from "@/lib/queries";

/**
 * Collection runs.
 *
 * A COMMERCIAL sees only their own portfolio's runs — RLS narrows
 * `pickup_requests` by `merchants.account_manager_id` (invariant I25), so this
 * page carries no portfolio filter of its own.
 *
 * The Claim column appears only for a caller holding `pickup:claim`, and only
 * on ACCEPTED rows: `ACCEPTED → ASSIGNED` is the sole transition into an
 * assigned run, so a button on any other status would be an offer the API
 * would refuse.
 */
export default async function PickupsPage({
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

  const [session, result] = await Promise.all([
    requireSession(locale),
    fetchPickups(query.cursor),
  ]);
  const canClaim = hasPermission(session, P.PICKUP_CLAIM);

  return (
    <div className="space-y-4">
      <PageHeader title={messages.pickups} />

      <DataTable
        headers={[
          messages.reference,
          messages.contact,
          messages.status,
          messages.parcels,
          messages.pickupWindow,
          ...(canClaim ? [messages.actions] : []),
        ]}
      >
        {result.data.map((p) => (
          <tr key={p.id} className="hover:bg-slate-50">
            <td className="px-4 py-3">
              <span className="ltr-isolate font-mono text-sm">{p.code}</span>
            </td>
            <td className="px-4 py-3 text-sm">
              <span className="font-medium">{p.contactName}</span>
              <span className="ms-2 ltr-isolate text-slate-500">{p.contactPhone}</span>
            </td>
            <td className="px-4 py-3">
              <StatusBadge status={p.status} locale={locale} />
            </td>
            <td className="px-4 py-3 text-sm tabular-nums">
              {/* Estimated until the run is scanned, then what was actually
                  collected — the variance is the whole point of the column. */}
              {p.actualParcelCount ?? p.estimatedParcelCount}
            </td>
            <td className="px-4 py-3 text-sm text-slate-500">
              {formatDateTime(p.requestedWindowFrom, locale, tz)}
            </td>
            {canClaim ? (
              <td className="px-4 py-3">
                <ClaimCell
                  pickupId={p.id}
                  status={p.status}
                  assignedTo={p.assignedDriverId}
                  currentUserId={session.userId}
                  locale={locale}
                />
              </td>
            ) : null}
          </tr>
        ))}
      </DataTable>

      {result.cursor !== null ? (
        <div className="flex justify-center">
          <Link
            href={`/${locale}/pickups?cursor=${encodeURIComponent(result.cursor)}`}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
          >
            {locale === "ar" ? "المزيد" : locale === "fr" ? "Voir plus" : "Load more"}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One of three things: the claim button, a note that it is already yours, or
 * nothing at all.
 *
 * Kept out of the row body so the three cases are visible together — the
 * failure mode this guards against is offering "claim" on a run somebody else
 * is already driving to.
 */
function ClaimCell({
  pickupId,
  status,
  assignedTo,
  currentUserId,
  locale,
}: {
  pickupId: string;
  status: string;
  assignedTo: string | null;
  currentUserId: string;
  locale: ReturnType<typeof toLocale>;
}) {
  if (status === "ACCEPTED") {
    return <ClaimPickupButton pickupId={pickupId} locale={locale} />;
  }
  if (assignedTo === currentUserId) {
    return (
      <span className="text-xs font-medium text-emerald-700">
        {MESSAGES[locale].assignedToYou}
      </span>
    );
  }
  return <span className="text-slate-400">—</span>;
}
