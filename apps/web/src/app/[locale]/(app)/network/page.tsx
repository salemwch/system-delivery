import { DataTable, PageHeader } from "@/components/ui";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { fetchHubs } from "@/lib/queries";

export default async function NetworkPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];

  const result = await fetchHubs();

  return (
    <div className="space-y-4">
      <PageHeader title={messages.network} />

      <DataTable
        headers={[
          locale === "ar" ? "الاسم" : locale === "fr" ? "Nom" : "Name",
          locale === "ar" ? "النوع" : locale === "fr" ? "Type" : "Type",
          locale === "ar" ? "العنوان" : locale === "fr" ? "Adresse" : "Address",
        ]}
      >
        {result.data.map((h) => (
          <tr key={h.id} className="hover:bg-slate-50">
            <td className="px-4 py-3 text-sm font-medium">{h.name}</td>
            <td className="px-4 py-3 text-sm">{h.type}</td>
            <td className="px-4 py-3 text-sm">{h.address}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
