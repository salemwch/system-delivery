import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { timezone } from "@/lib/config";
import { fetchUsers } from "@/lib/queries";

export default async function UsersPage({
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

  const result = await fetchUsers(query.cursor);

  return (
    <div className="space-y-4">
      <PageHeader title={messages.users} />

      <DataTable
        headers={[
          locale === "ar" ? "الاسم" : locale === "fr" ? "Nom" : "Name",
          locale === "ar" ? "البريد" : locale === "fr" ? "Email" : "Email",
          locale === "ar" ? "الأدوار" : locale === "fr" ? "Rôles" : "Roles",
          messages.status,
          locale === "ar" ? "التاريخ" : locale === "fr" ? "Date" : "Date",
        ]}
      >
        {result.data.map((u) => (
          <tr key={u.id} className="hover:bg-slate-50">
            <td className="px-4 py-3 text-sm font-medium">{u.name}</td>
            <td className="px-4 py-3 text-sm ltr-isolate">{u.email}</td>
            <td className="px-4 py-3 text-sm">
              <div className="flex flex-wrap gap-1">
                {u.roles.map((role) => (
                  <span
                    key={role}
                    className="inline-block rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
                  >
                    {role}
                  </span>
                ))}
              </div>
            </td>
            <td className="px-4 py-3">
              <StatusBadge status={u.status} locale={locale} />
            </td>
            <td className="px-4 py-3 text-sm text-slate-500">
              {formatDateTime(u.createdAt, locale, tz)}
            </td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
