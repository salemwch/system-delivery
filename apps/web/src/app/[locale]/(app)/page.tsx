import { StatCard } from "@/components/ui";
import { formatMoney, formatRate } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { hasPermission, readSession } from "@/lib/session";
import { P } from "@/lib/permissions";
import { fetchDashboard } from "@/lib/queries";

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
          value={String(stats.shipmentsToday)}
        />
        <StatCard
          label={locale === "ar" ? "تم التسليم" : locale === "fr" ? "Livrés" : "Delivered"}
          value={String(stats.deliveredToday)}
          tone="plain"
        />
        <StatCard
          label={locale === "ar" ? "فشل" : locale === "fr" ? "Échoués" : "Failed"}
          value={String(stats.failedToday)}
          tone={stats.failedToday > 0 ? "attention" : "plain"}
        />
        <StatCard
          label={locale === "ar" ? "معدل التسليم" : locale === "fr" ? "Taux de livraison" : "Delivery rate"}
          value={formatRate(stats.deliveryRate, locale)}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label={locale === "ar" ? "قيد النقل" : locale === "fr" ? "En transit" : "In transit"}
          value={String(stats.inTransit)}
        />
        <StatCard
          label={locale === "ar" ? "استلام معلق" : locale === "fr" ? "Ramassages en attente" : "Pending pickups"}
          value={String(stats.pendingPickups)}
          tone={stats.pendingPickups > 0 ? "attention" : "plain"}
        />
        <StatCard
          label={locale === "ar" ? "سائقين نشطين" : locale === "fr" ? "Chauffeurs actifs" : "Active drivers"}
          value={String(stats.activeDrivers)}
        />
        {canReadCod ? (
          <StatCard
            label={locale === "ar" ? "COD معلق" : locale === "fr" ? "COD en attente" : "Pending COD"}
            value={formatMoney(stats.codPendingMinor, stats.currencyExponent, locale)}
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
