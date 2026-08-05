import Link from "next/link";

import { STATUS_LABELS } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

export function StatusBadge({ status, locale }: { status: string; locale: Locale }) {
  const label = STATUS_LABELS[locale][status] ?? status;
  const { icon, className } = STATUS_STYLE[status] ?? {
    icon: "•",
    className: "bg-slate-100 text-slate-700",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${className}`}
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </span>
  );
}

const STATUS_STYLE: Readonly<Record<string, { icon: string; className: string }>> = {
  CREATED: { icon: "○", className: "bg-slate-100 text-slate-700" },
  PICKUP_ASSIGNED: { icon: "◔", className: "bg-slate-100 text-slate-700" },
  PICKED_UP: { icon: "◑", className: "bg-blue-50 text-blue-800" },
  AT_HUB: { icon: "▣", className: "bg-blue-50 text-blue-800" },
  IN_TRANSIT: { icon: "→", className: "bg-blue-50 text-blue-800" },
  OUT_FOR_DELIVERY: { icon: "🚚", className: "bg-indigo-50 text-indigo-800" },
  DELIVERED: { icon: "✓", className: "bg-emerald-50 text-emerald-800" },
  FAILED_ATTEMPT: { icon: "!", className: "bg-amber-50 text-amber-900" },
  RETURN_PENDING: { icon: "↩", className: "bg-amber-50 text-amber-900" },
  RETURNED: { icon: "↩", className: "bg-slate-100 text-slate-700" },
  CANCELLED: { icon: "✕", className: "bg-slate-100 text-slate-500" },
};

export function StatCard({
  label,
  value,
  hint,
  href,
  tone = "plain",
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  href?: string | undefined;
  tone?: "plain" | "attention" | "money";
}) {
  const toneClass =
    tone === "attention"
      ? "border-amber-300 bg-amber-50"
      : tone === "money"
        ? "border-brand/30 bg-brand-soft"
        : "border-slate-200 bg-white";

  const inner = (
    <>
      <p className="text-sm text-slate-600">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {hint === undefined ? null : <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </>
  );

  const className = `block rounded-xl border p-4 ${toneClass}`;
  return href === undefined ? (
    <div className={className}>{inner}</div>
  ) : (
    <Link href={href} className={`${className} transition hover:border-brand`}>
      {inner}
    </Link>
  );
}

export function Field({
  label,
  name,
  hint,
  error,
  children,
}: {
  label: string;
  name: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  const hintId = hint === undefined ? undefined : `${name}-hint`;
  const errorId = error === undefined ? undefined : `${name}-error`;
  return (
    <div>
      <label htmlFor={name} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      {hint === undefined ? null : (
        <p id={hintId} className="mt-0.5 text-xs text-slate-500">
          {hint}
        </p>
      )}
      <div className="mt-1.5">{children}</div>
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="mt-1 text-sm font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export const INPUT_CLASS =
  "block w-full min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-2 " +
  "text-base placeholder:text-slate-400 focus:border-brand focus:outline-none " +
  "focus:ring-2 focus:ring-brand/30";

export const BUTTON_CLASS =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2 " +
  "text-sm font-semibold text-white transition hover:bg-brand-dark " +
  "disabled:cursor-not-allowed disabled:opacity-60";


export function PageHeader({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h1 className="text-xl font-bold text-slate-900">{title}</h1>
      {children}
    </div>
  );
}

export function DataTable({
  headers,
  children,
}: {
  headers: readonly string[];
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-start text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            {headers.map((h) => (
              <th key={h} className="px-4 py-3 text-start text-xs font-semibold text-slate-600 uppercase tracking-wider">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}
