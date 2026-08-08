import Link from "next/link";
import { notFound } from "next/navigation";

import { NoteQueueRow } from "@/components/note-queue-row";
import { DataTable, PageHeader } from "@/components/ui";
import { timezone } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { fetchNotes } from "@/lib/queries";
import { hasPermission, requireSession } from "@/lib/session";

/**
 * Remarques — the open queue.
 *
 * The whole point of this page is that it is a WORK LIST, not an archive:
 * unresolved remarks, newest first, each with the button that clears it. The
 * resolved tab exists so a supervisor can check what was done, and is never the
 * default — a queue that shows everything ever written is not a queue.
 */
export default async function NotesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ cursor?: string; resolved?: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const tz = timezone();
  const query = await searchParams;

  const session = await requireSession(locale);
  if (!hasPermission(session, P.NOTE_READ)) {
    notFound();
  }
  const canWrite = hasPermission(session, P.NOTE_MANAGE);

  const resolved = query.resolved === "true";
  const result = await fetchNotes(query.cursor, { resolved: String(resolved) });

  const base = `/${locale}/remarks`;
  const tabs = [
    { label: messages.openRemarks, href: base, active: !resolved },
    { label: messages.resolvedRemarks, href: `${base}?resolved=true`, active: resolved },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={messages.remarks} />

      <div className="flex gap-2">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={tab.active ? "page" : undefined}
            className={
              tab.active
                ? "rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-white"
                : "rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            }
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <DataTable
        headers={[
          messages.subject,
          messages.internalRemarks,
          locale === "ar" ? "الكاتب" : locale === "fr" ? "Auteur" : "Author",
          locale === "ar" ? "التاريخ" : locale === "fr" ? "Date" : "Date",
          "",
        ]}
      >
        {result.data.map((note) => (
          <NoteQueueRow
            key={note.id}
            locale={locale}
            note={note}
            href={subjectHref(locale, note.subjectType, note.subjectId)}
            writtenAt={formatDateTime(note.createdAt, locale, tz)}
            canWrite={canWrite}
          />
        ))}
      </DataTable>

      {result.cursor === null ? null : (
        <div className="flex justify-center">
          <Link
            href={`${base}?cursor=${encodeURIComponent(result.cursor)}${resolved ? "&resolved=true" : ""}`}
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
 * Where the remark's subject lives.
 *
 * A driver has no detail route yet, so those rows link to the fleet list rather
 * than to a 404. Worth doing here rather than hiding the link: a remark whose
 * subject is unreachable is still a remark somebody has to act on.
 */
function subjectHref(locale: string, subjectType: string, subjectId: string): string {
  switch (subjectType) {
    case "SHIPMENT":
      return `/${locale}/shipments/${subjectId}`;
    case "MERCHANT":
      return `/${locale}/merchants/${subjectId}`;
    default:
      return `/${locale}/fleet`;
  }
}
