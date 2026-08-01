import { CreateShipmentForm } from "@/components/create-shipment-form";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { fetchAddressBook, fetchBootstrap } from "@/lib/queries";

/**
 * Create a parcel.
 *
 * The address book is fetched here, on the server, so the form arrives ready to
 * autofill — a merchant sending to the same shop every week taps once instead of
 * retyping a name, a phone number and an address.
 */
export default async function NewShipmentPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];

  // Together: independent reads, and the form cannot render until both land.
  const [config, addressBook] = await Promise.all([
    fetchBootstrap(),
    // A merchant with no history yet is the normal first-run case, not an error.
    fetchAddressBook().catch(() => []),
  ]);

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">{messages.newShipment}</h1>
      <CreateShipmentForm
        locale={locale}
        currencyCode={config.currency.code}
        currencyExponent={config.currency.exponent}
        addressBook={addressBook}
      />
    </div>
  );
}
