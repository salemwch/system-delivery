import Link from "next/link";
import { notFound } from "next/navigation";

import { CityForm } from "@/components/city-form";
import { CityToggle } from "@/components/city-toggle";
import { DataTable, PageHeader } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { fetchCities } from "@/lib/queries";
import { hasPermission, requireSession } from "@/lib/session";

/**
 * Villes — the coverage list and its tariff.
 *
 * A price list, and treated as one: the fees are audited on the API, retiring a
 * city never deletes it, and the code is fixed once created because it is
 * printed on manifests.
 *
 * `edit=<id>` opens an existing city in the form above the table instead of a
 * separate route. The list is the context an operator needs while editing a
 * tariff — "is Sfax more expensive than Sousse?" — and a detail page would hide
 * exactly that.
 */
export default async function CitiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ cursor?: string; q?: string; edit?: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const query = await searchParams;

  const session = await requireSession(locale);
  if (!hasPermission(session, P.FEATURE_MANAGE)) {
    notFound();
  }

  const result = await fetchCities(
    query.cursor,
    query.q === undefined || query.q === "" ? {} : { search: query.q },
  );

  const editing = query.edit === undefined ? null : (result.data.find((c) => c.id === query.edit) ?? null);

  // The currency of the list, so the form quotes in the same one the table
  // shows. A tenant billing in two currencies would need a select here; until
  // one does, the first row's currency is the tenant's currency.
  const first = result.data[0];
  const currency = editing?.currency ?? first?.currency ?? "TND";
  const exponent = editing?.currencyExponent ?? first?.currencyExponent ?? 3;

  const base = `/${locale}/settings/cities`;

  return (
    <div className="space-y-6">
      <Link href={`/${locale}/settings`} className="text-sm text-brand hover:underline">
        ← {messages.settings}
      </Link>

      <PageHeader title={messages.cities} />

      <CityForm
        key={editing?.id ?? "new"}
        locale={locale}
        currency={currency}
        exponent={exponent}
        city={
          editing === null
            ? null
            : {
                id: editing.id,
                code: editing.code,
                name: editing.name,
                nameAr: editing.nameAr,
                governorate: editing.governorate,
                postalCode: editing.postalCode,
                deliveryFee: decimalOf(editing.deliveryFeeMinor, editing.currencyExponent),
                returnFee: decimalOf(editing.returnFeeMinor, editing.currencyExponent),
                deliveryDelayDays: editing.deliveryDelayDays,
                aliases: editing.aliases,
              }
        }
      />

      {editing === null ? null : (
        <Link href={base} className="text-sm text-brand hover:underline">
          {messages.addCity}
        </Link>
      )}

      {/* A plain GET form: search belongs in the URL so a filtered list is a
          link an operator can bookmark and share. */}
      <form action={base} method="get" className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query.q ?? ""}
          placeholder={messages.searchCity}
          aria-label={messages.searchCity}
          className="min-h-9 w-full max-w-xs rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          className="rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
        >
          {messages.search}
        </button>
      </form>

      <DataTable
        headers={[
          messages.reference,
          messages.city,
          messages.governorate,
          messages.deliveryFee,
          messages.returnFee,
          messages.deliveryDelay,
          messages.status,
          "",
        ]}
      >
        {result.data.map((city) => (
          <tr key={city.id} className="hover:bg-slate-50">
            <td className="px-4 py-3">
              <Link
                href={`${base}?edit=${encodeURIComponent(city.id)}`}
                className="ltr-isolate font-mono text-sm text-brand hover:underline"
              >
                {city.code}
              </Link>
            </td>
            <td className="px-4 py-3 text-sm font-medium">
              {city.name}
              {city.nameAr === null ? null : (
                <span className="ms-2 text-xs text-slate-500" dir="rtl">
                  {city.nameAr}
                </span>
              )}
            </td>
            <td className="px-4 py-3 text-sm text-slate-600">{city.governorate}</td>
            <td className="px-4 py-3 text-end text-sm tabular-nums ltr-isolate">
              {formatMoney(BigInt(city.deliveryFeeMinor), city.currencyExponent, locale)}
            </td>
            <td className="px-4 py-3 text-end text-sm tabular-nums ltr-isolate text-slate-600">
              {formatMoney(BigInt(city.returnFeeMinor), city.currencyExponent, locale)}
            </td>
            <td className="px-4 py-3 text-end text-sm tabular-nums ltr-isolate text-slate-600">
              {city.deliveryDelayDays}
            </td>
            <td className="px-4 py-3 text-sm">
              {city.active ? (
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">
                  {messages.active}
                </span>
              ) : (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
                  {messages.inactive}
                </span>
              )}
            </td>
            <td className="px-4 py-3">
              <CityToggle cityId={city.id} active={city.active} locale={locale} />
            </td>
          </tr>
        ))}
      </DataTable>

      {result.cursor === null ? null : (
        <div className="flex justify-center">
          <Link
            href={`${base}?cursor=${encodeURIComponent(result.cursor)}${query.q === undefined ? "" : `&q=${encodeURIComponent(query.q)}`}`}
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
 * Minor units → the decimal string the form edits.
 *
 * String arithmetic, the inverse of `toMinorUnits`, and for the same reason:
 * `Number(minor) / 1000` reintroduces the float this codebase spends its effort
 * keeping out of money.
 */
function decimalOf(minor: string, exponent: number): string {
  if (exponent <= 0) {
    return minor;
  }
  const negative = minor.startsWith("-");
  const digits = (negative ? minor.slice(1) : minor).padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
