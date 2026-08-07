import Link from "next/link";

import { AccountManagerForm } from "@/components/account-manager-form";
import type { CommercialOption } from "@/components/account-manager-form";
import { PickupAddressForm } from "@/components/pickup-address-form";
import { PortalLoginForm } from "@/components/portal-login-form";
import { RequestPickupForm } from "@/components/request-pickup-form";
import { timezone } from "@/lib/config";
import { nextWorkingWindow } from "@/lib/pickup-window";
import { PageHeader, StatCard, StatusBadge } from "@/components/ui";
import { formatMoney, formatRate } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { hasPermission, requireSession } from "@/lib/session";
import { fetchCommercials, fetchMerchant, fetchMerchantStats } from "@/lib/queries";
import type { MerchantDetail, MerchantStats } from "@/lib/queries";

/**
 * One *expéditeur*: who they are, how their parcels are doing, and the two
 * actions that finish an onboarding — their portal login, and (for an OWNER)
 * which commercial owns the account.
 *
 * A commercial reaching a merchant outside their portfolio gets a 404 from the
 * API, because RLS never returns the row (invariant I25). Nothing on this page
 * needs to know that.
 */
export default async function MerchantDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { locale: raw, id } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const query = await searchParams;

  const session = await requireSession(locale);
  const canAssign = hasPermission(session, P.MERCHANT_ASSIGN_MANAGER);

  const [merchant, stats, commercials] = await Promise.all([
    fetchMerchant(id),
    fetchMerchantStats(id),
    // Only an OWNER can reassign, so only an OWNER pays for the user lookup.
    canAssign ? fetchCommercials() : Promise.resolve({ data: [], cursor: null }),
  ]);

  const defaultWindow = nextWorkingWindow(timezone());

  const options: CommercialOption[] = commercials.data.map((c) => ({
    id: c.id,
    label: c.name === "" ? c.email : `${c.name} (${c.email})`,
  }));

  return (
    <div className="space-y-6">
      <Link href={`/${locale}/merchants`} className="text-sm text-brand hover:underline">
        ← {messages.merchants}
      </Link>

      {query.created === "1" ? (
        <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900">
          {messages.newMerchant} — {merchant.name}
        </p>
      ) : null}

      <PageHeader title={merchant.name}>
        <StatusBadge status={merchant.status} locale={locale} />
      </PageHeader>

      <Identity merchant={merchant} locale={locale} />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{messages.performance}</h2>
        <Performance stats={stats} locale={locale} />
      </section>

      {/*
        Only offered when an address exists — the command requires one, so a
        form that could only fail is worse than no form. When it is missing the
        pickup-address section below says so explicitly.
      */}
      {hasPermission(session, P.PICKUP_CREATE) && merchant.defaultPickupAddressId !== null ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{messages.requestPickup}</h2>
          <RequestPickupForm
            merchantId={merchant.id}
            pickupAddressId={merchant.defaultPickupAddressId}
            contactName={merchant.contactName ?? merchant.name}
            contactPhone={merchant.contactPhone ?? ""}
            defaultFrom={defaultWindow.from}
            defaultTo={defaultWindow.to}
            locale={locale}
          />
        </section>
      ) : null}

      {hasPermission(session, P.MERCHANT_UPDATE) ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{messages.pickupAddress}</h2>
          <PickupAddressForm
            merchantId={merchant.id}
            hasAddress={merchant.defaultPickupAddressId !== null}
            locale={locale}
          />
        </section>
      ) : null}

      {hasPermission(session, P.MERCHANT_ONBOARD) ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{messages.portalLogin}</h2>
          <PortalLoginForm merchantId={merchant.id} locale={locale} />
        </section>
      ) : null}

      {canAssign ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{messages.accountManager}</h2>
          <AccountManagerForm
            merchantId={merchant.id}
            current={merchant.accountManagerId}
            commercials={options}
            locale={locale}
          />
        </section>
      ) : null}
    </div>
  );
}

function Identity({ merchant, locale }: { merchant: MerchantDetail; locale: Locale }) {
  const messages = MESSAGES[locale];
  const rows: readonly { readonly label: string; readonly value: string }[] = [
    { label: messages.merchantCode, value: merchant.code ?? "—" },
    { label: messages.contactName, value: merchant.contactName ?? "—" },
    { label: messages.contactPhone, value: merchant.contactPhone ?? "—" },
    { label: messages.contactEmail, value: merchant.contactEmail ?? "—" },
    {
      label: messages.accountManager,
      value: merchant.accountManagerId === null ? messages.houseManaged : merchant.accountManagerId,
    },
  ];

  return (
    <dl className="grid gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((row) => (
        <div key={row.label}>
          <dt className="text-xs font-medium text-slate-500 uppercase tracking-wider">
            {row.label}
          </dt>
          <dd className="mt-1 ltr-isolate text-sm text-slate-900">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Performance({ stats, locale }: { stats: MerchantStats; locale: Locale }) {
  const messages = MESSAGES[locale];
  // The API returns COD in minor units as a decimal STRING — a bigint that
  // would lose precision as a JavaScript number. Parsed as BigInt, never Number.
  const collected = BigInt(stats.deliveredCodMinor);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={messages.totalShipments} value={String(stats.totalShipments)} />
        <StatCard label={messages.deliveryRate} value={formatRate(stats.deliveryRate, locale)} />
        <StatCard
          label={messages.codCollected}
          value={`${formatMoney(collected, stats.currencyExponent, locale)} ${stats.currency}`}
          tone="money"
        />
        <StatCard
          label={messages.avgAttempts}
          value={stats.avgAttemptsPerDelivery.toFixed(2)}
        />
      </div>

      {stats.byStatus.length === 0 ? null : (
        <ul className="flex flex-wrap gap-2">
          {stats.byStatus.map((s) => (
            <li key={s.status} className="flex items-center gap-2">
              <StatusBadge status={s.status} locale={locale} />
              <span className="text-sm tabular-nums text-slate-600">{s.count}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
