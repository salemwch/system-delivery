import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { fetchDrivers, fetchVehicles } from "@/lib/queries";

export default async function FleetPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];

  const [drivers, vehicles] = await Promise.all([fetchDrivers(), fetchVehicles()]);

  return (
    <div className="space-y-8">
      <PageHeader title={messages.fleet} />

      <div>
        <h2 className="mb-3 text-lg font-semibold">
          {locale === "ar" ? "السائقون" : locale === "fr" ? "Chauffeurs" : "Drivers"}
          <span className="ms-2 text-sm font-normal text-slate-500">({drivers.data.length})</span>
        </h2>
        <DataTable
          headers={[
            locale === "ar" ? "الاسم" : locale === "fr" ? "Nom" : "Name",
            locale === "ar" ? "الهاتف" : locale === "fr" ? "Téléphone" : "Phone",
            messages.status,
          ]}
        >
          {drivers.data.map((d) => (
            <tr key={d.id} className="hover:bg-slate-50">
              <td className="px-4 py-3 text-sm font-medium">{d.name}</td>
              <td className="px-4 py-3 text-sm ltr-isolate">{d.phone}</td>
              <td className="px-4 py-3">
                <StatusBadge status={d.status} locale={locale} />
              </td>
            </tr>
          ))}
        </DataTable>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">
          {locale === "ar" ? "المركبات" : locale === "fr" ? "Véhicules" : "Vehicles"}
          <span className="ms-2 text-sm font-normal text-slate-500">({vehicles.data.length})</span>
        </h2>
        <DataTable
          headers={[
            locale === "ar" ? "اللوحة" : locale === "fr" ? "Plaque" : "Plate",
            locale === "ar" ? "النوع" : locale === "fr" ? "Type" : "Type",
            messages.status,
          ]}
        >
          {vehicles.data.map((v) => (
            <tr key={v.id} className="hover:bg-slate-50">
              <td className="px-4 py-3 text-sm font-medium ltr-isolate">{v.plateNumber}</td>
              <td className="px-4 py-3 text-sm">{v.type}</td>
              <td className="px-4 py-3">
                <StatusBadge status={v.status} locale={locale} />
              </td>
            </tr>
          ))}
        </DataTable>
      </div>
    </div>
  );
}
