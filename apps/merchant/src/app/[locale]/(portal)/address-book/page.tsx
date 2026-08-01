import Link from "next/link";

import { BUTTON_CLASS, EmptyState } from "@/components/ui";
import { timezone } from "@/lib/config";
import { formatDate } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { fetchAddressBook } from "@/lib/queries";

/**
 * The merchant's own recipients.
 *
 * ⚠️ Projected from THEIR OWN shipments, never from the tenant's `recipients`
 * table. That table is deliberately tenant-scoped and shared across every
 * merchant on the platform — one row per person, so the repeat-refuser
 * block-list and address quality accumulate — which means exposing it here would
 * hand a merchant their competitors' customer list (RM-R1, migration 0021).
 *
 * A merchant therefore holds no `recipient:*` permission at all, and this page
 * reads `/v1/address-book`, which is already narrowed by RLS.
 */
export default async function AddressBookPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const tz = timezone();

  const entries = await fetchAddressBook().catch(() => []);

  if (entries.length === 0) {
    return (
      <EmptyState
        title={messages.addressBookEmpty}
        hint={messages.addressBookHint}
        action={
          <Link href={`/${locale}/shipments/new`} className={BUTTON_CLASS}>
            {messages.newShipment}
          </Link>
        }
      />
    );
  }

  return (
    <ul className="space-y-2">
      {entries.map((entry) => (
        <li
          key={`${entry.recipientPhone}-${entry.addressId}`}
          className="rounded-xl border border-slate-200 bg-white p-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{entry.recipientName}</p>
              <p className="ltr-isolate truncate text-xs text-slate-500">
                {entry.recipientPhone}
              </p>
              <p className="mt-1 truncate text-xs text-slate-600">{entry.rawInput}</p>
            </div>
            <div className="shrink-0 text-end">
              <p className="text-xs text-slate-500">
                {entry.shipmentCount} {messages.deliveries}
              </p>
              <p className="text-xs text-slate-400">
                {formatDate(entry.lastUsedAt, locale, tz)}
              </p>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
