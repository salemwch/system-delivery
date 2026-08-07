import { StatCard } from "@/components/ui";
import { formatMoney, formatRate } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { hasPermission, readSession } from "@/lib/session";
import { P } from "@/lib/permissions";
import { fetchDashboard } from "@/lib/queries";
import type { DashboardStats } from "@/lib/queries";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const session = await readSession();

  const stats = await fetchDashboard();

  const canReadCod = session !== null && hasPermission(session, P.COD_READ_AMOUNT);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">{messages.dashboard}</h1>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label={locale === "ar" ? "طرود اليوم" : locale === "fr" ? "Envois aujourd'hui" : "Shipments today"}
          value={String(stats.todayCreated)}
        />
        <StatCard
          label={locale === "ar" ? "تم التسليم" : locale === "fr" ? "Livrés" : "Delivered"}
          value={String(stats.todayDelivered)}
          tone="plain"
        />
        <StatCard
          label={locale === "ar" ? "فشل" : locale === "fr" ? "Échoués" : "Failed"}
          value={String(stats.todayFailed)}
          tone={stats.todayFailed > 0 ? "attention" : "plain"}
        />
        <StatCard
          label={locale === "ar" ? "معدل التسليم" : locale === "fr" ? "Taux de livraison" : "Delivery rate"}
          value={formatRate(stats.deliveryRate, locale)}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label={locale === "ar" ? "قيد النقل" : locale === "fr" ? "En transit" : "In transit"}
          value={String(countOf(stats, "IN_TRANSIT"))}
        />
        <StatCard
          label={locale === "ar" ? "خارج للتسليم" : locale === "fr" ? "En livraison" : "Out for delivery"}
          value={String(countOf(stats, "OUT_FOR_DELIVERY"))}
        />
        <StatCard
          label={locale === "ar" ? "إجمالي الطرود" : locale === "fr" ? "Total des colis" : "Total shipments"}
          value={String(stats.totalShipments)}
        />
        {canReadCod ? (
          <StatCard
            label={locale === "ar" ? "COD معلق" : locale === "fr" ? "COD en attente" : "Pending COD"}
            value={formatMoney(BigInt(stats.codPendingMinor), stats.currencyExponent, locale)}
            tone="money"
          />
        ) : (
          <StatCard
            label={locale === "ar" ? "COD معلق" : locale === "fr" ? "COD en attente" : "Pending COD"}
            value="—"
          />
        )}
      </div>
    </div>
  );
}

/**
 * How many shipments sit in one status.
 *
 * The dashboard returns `byStatus` as a list, not a field per status, so
 * "in transit" is a lookup. Absent means zero — a status with no shipments is
 * simply not in the array.
 */
function countOf(stats: DashboardStats, status: string): number {
  return stats.byStatus.find((row) => row.status === status)?.count ?? 0;
}
