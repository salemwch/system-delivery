import Link from "next/link";

import { STATUS_LABELS } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * The portal's visual primitives.
 *
 * Deliberately few and plain. A merchant opens this to answer three questions —
 * where is my parcel, how much am I owed, how do I send another — and every
 * decoration between them and those answers is a cost.
 */

/**
 * A status badge.
 *
 * ⚠️ Icon AND text, never colour alone (docs/08 §10). Red/green is the primary
 * signal in logistics and colour-blind merchants exist; the icon carries the
 * same meaning for a monochrome screen or a printout.
 */
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
  ASSIGNED: { icon: "◔", className: "bg-slate-100 text-slate-700" },
  PICKED_UP: { icon: "◑", className: "bg-blue-50 text-blue-800" },
  AT_HUB: { icon: "▣", className: "bg-blue-50 text-blue-800" },
  IN_TRANSIT: { icon: "→", className: "bg-blue-50 text-blue-800" },
  OUT_FOR_DELIVERY: { icon: "🚚", className: "bg-indigo-50 text-indigo-800" },
  DELIVERED: { icon: "✓", className: "bg-emerald-50 text-emerald-800" },
  ATTEMPT_FAILED: { icon: "!", className: "bg-amber-50 text-amber-900" },
  RETURN_PENDING: { icon: "↩", className: "bg-amber-50 text-amber-900" },
  RETURNED: { icon: "↩", className: "bg-slate-100 text-slate-700" },
  CANCELLED: { icon: "✕", className: "bg-slate-100 text-slate-500" },
};

/** A headline number. The dashboard is four of these and nothing else. */
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

/** A labelled field. Errors sit beside the input, never in a banner far away. */
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
        // `role="alert"` so a screen reader announces it the moment it appears,
        // rather than only when the user happens to navigate back to the field.
        <p id={errorId} role="alert" className="mt-1 text-sm font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

/** Shared input styling. `min-h-11` keeps the touch target at ~44 px (WCAG 2.2). */
export const INPUT_CLASS =
  "block w-full min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-2 " +
  "text-base placeholder:text-slate-400 focus:border-brand focus:outline-none " +
  "focus:ring-2 focus:ring-brand/30";

export const BUTTON_CLASS =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2 " +
  "text-sm font-semibold text-white transition hover:bg-brand-dark " +
  "disabled:cursor-not-allowed disabled:opacity-60";

export const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 " +
  "bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50";

/**
 * An empty state that tells the merchant what to DO next.
 *
 * "No parcels found" alone is a dead end; the action is what makes it useful.
 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: React.ReactNode | undefined;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
      <p className="text-base font-semibold text-slate-800">{title}</p>
      <p className="mt-1 text-sm text-slate-600">{hint}</p>
      {action === undefined ? null : <div className="mt-4">{action}</div>}
    </div>
  );
}
