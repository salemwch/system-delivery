import type { TrackingFailure, TrackingView } from "./api";
import { formatDateTime, formatMoney, formatWindow } from "./format";
import { LOCALES, MESSAGES, TIMELINE_LABELS, directionOf } from "./i18n";
import type { Locale } from "./i18n";

/**
 * The tracking page as HTML.
 *
 * ⚠️ NOT a React component, and that is the whole point. This page has zero
 * interactivity — the language switcher is three links — yet as a React page it
 * shipped **136 KB of gzipped JavaScript** purely to hydrate markup that never
 * changes. The budget in docs/08 §9 is <100 KB, and it is strict for a reason:
 * the page loads once, on whatever phone and connection a recipient happens to
 * have, over Tunisian mobile data.
 *
 * Rendered from a Next Route Handler instead, the page ships **no JavaScript at
 * all**. Next still provides routing, the security headers and the deployment;
 * React is simply not involved in a document that has nothing to hydrate.
 *
 * Same approach as the delivery documents in `shipment/domain/document.ts`, for
 * the same reason: server-rendered HTML is the correct medium for a document.
 *
 * Pure — no I/O, no framework. Everything it needs is passed in.
 */

/**
 * Escapes text for HTML.
 *
 * ⚠️ EVERY interpolated value goes through this. A courier name and a recipient
 * name are operator- and merchant-supplied free text; unescaped, a name
 * containing `<script>` executes in the browser of whoever opens the link.
 * `&` first, or the other replacements get double-escaped.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/**
 * The stylesheet, inlined.
 *
 * Inline rather than a linked file because a separate stylesheet is a second
 * round-trip before the page can paint — on 3G that is most of the LCP budget.
 * At ~2 KB it is far cheaper embedded.
 *
 * ⚠️ LOGICAL PROPERTIES ONLY (`margin-inline`, `text-align: start`). The one
 * stylesheet has to mirror for Arabic, and a directional property is how a page
 * ends up with its padding on the wrong side in RTL — visible to half this
 * market and invisible to whoever wrote it.
 */
const STYLES = `
*{box-sizing:border-box}
body{margin:0;background:#f8fafc;color:#0f172a;
  font-family:system-ui,-apple-system,"Segoe UI","Noto Sans Arabic",Roboto,sans-serif;
  font-size:16px;line-height:1.5}
main{max-width:28rem;margin-inline:auto;padding:1.5rem 1rem;min-height:100dvh;
  display:flex;flex-direction:column}
header{border-block-end:1px solid #e2e8f0;padding-block-end:.75rem}
.courier{font-size:1.125rem;font-weight:700}
.content{flex:1}
/* A tracking number and an E.164 phone stay LTR inside an Arabic page —
   mirrored, they get read back to a call centre wrong. */
.ltr{direction:ltr;unicode-bidi:isolate}
.tracking{font-family:ui-monospace,Consolas,monospace;font-size:.875rem;
  color:#64748b;margin-block-start:1rem}
.status{font-size:1.5rem;font-weight:700;margin-block-start:1rem;
  display:flex;align-items:center;gap:.5rem}
h2{font-size:.875rem;font-weight:500;color:#475569;margin-block:1.5rem .25rem}
.window{border:1px solid #e2e8f0;background:#fff;border-radius:.5rem;
  padding:.75rem 1rem;font-size:1.25rem;font-weight:600;margin:0}
ol{list-style:none;padding:0;margin:0}
li{display:flex;gap:.75rem;margin-block-end:1rem}
.dot{inline-size:.75rem;block-size:.75rem;border-radius:9999px;flex:none;
  margin-block-start:.3rem;background:#2563eb}
.dot.pending{background:#fff;border:2px solid #2563eb}
.step{font-size:.875rem;font-weight:500;margin:0}
.when{font-size:.75rem;color:#64748b;margin:0}
section.details{border-block-start:1px solid #e2e8f0;margin-block-start:2rem;
  padding-block-start:1rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.5rem 1rem;margin:0;
  font-size:.875rem}
dt{color:#475569}
dd{margin:0;font-weight:500}
.cod{font-size:1.05rem;font-weight:700}
.notice{margin-block-start:1rem;border:1px solid #fcd34d;background:#fffbeb;
  color:#78350f;border-radius:.5rem;padding:.75rem 1rem;font-size:.875rem;
  font-weight:500}
footer{border-block-start:1px solid #e2e8f0;margin-block-start:2rem;
  padding-block-start:1rem}
.help{font-size:.875rem;color:#475569;margin-block-end:1rem}
.help a{color:#2563eb;font-weight:500}
nav{display:flex;gap:.5rem}
nav a{border-radius:.375rem;padding:.5rem .75rem;font-size:.875rem;
  text-decoration:none;border:1px solid #cbd5e1;color:#334155;
  /* ≥44px touch target (WCAG 2.2) — tapped on a phone, outdoors. */
  min-inline-size:2.75rem;min-block-size:2.75rem;
  display:inline-flex;align-items:center;justify-content:center}
nav a[aria-current]{background:#2563eb;border-color:#2563eb;color:#fff;
  font-weight:600}
.fail{justify-content:center;text-align:center}
.fail .icon{font-size:3rem}
.fail h1{font-size:1.25rem;margin-block:1rem .5rem}
.fail p{font-size:.875rem;color:#475569;margin:0}
`.trim();

interface RenderInput {
  readonly view: TrackingView;
  readonly locale: Locale;
  readonly tenantSlug: string;
  readonly trackingNumber: string;
  readonly token: string;
  readonly timezone: string;
  readonly supportPhone: string;
}

export function renderTrackingPage(input: RenderInput): string {
  const { view, locale, timezone } = input;
  const messages = MESSAGES[locale];
  const e = escapeHtml;
  const status = view.statusLabel[locale] ?? view.status;
  const window = formatWindow(view.promisedFrom, view.promisedTo, locale, timezone);
  const hasCod = view.codAmountMinor > 0;

  const body = `
  ${view.courierName === "" ? "" : `<header><p class="courier">${e(view.courierName)}</p></header>`}
  <div class="content">
    <p class="tracking ltr">${e(view.trackingNumber)}</p>
    <!-- Status as TEXT, never colour alone (docs/08 §10): colour-blind
         recipients exist. The icon is decorative. -->
    <p class="status"><span aria-hidden="true">📦</span>${e(status)}</p>
    ${
      window === null
        ? ""
        : `<h2>${e(messages.estimatedArrival)}</h2>
    <p class="window ltr">${e(window)}</p>`
    }
    ${renderTimeline(view, locale, timezone)}
    <section class="details">
      <dl>
        <dt>${e(messages.recipient)}</dt>
        <dd>${e(view.recipientFirstName)}</dd>
        ${
          hasCod
            ? `<dt>${e(messages.toPay)}</dt>
        <dd class="cod"><span class="ltr">${e(
          formatMoney(view.codAmountMinor, view.currencyExponent, locale),
        )} ${e(view.currency)}</span> 💵 ${e(messages.cash)}</dd>`
            : ""
        }
      </dl>
    </section>
    ${
      hasCod
        ? // A small COD-market touch that measurably reduces INSUFFICIENT_CASH
          // failures (docs/08 §7) — the driver rarely carries change.
          `<p class="notice">⚠ ${e(messages.prepareExactAmount)}</p>`
        : ""
    }
  </div>
  ${renderFooter(input)}`;

  return document(locale, messages.title, body);
}

function renderTimeline(view: TrackingView, locale: Locale, timezone: string): string {
  if (view.timeline.length === 0) {
    return "";
  }
  const e = escapeHtml;
  const labels = TIMELINE_LABELS[locale];
  const last = view.timeline.length - 1;

  const items = view.timeline
    .map((entry, index) => {
      const done = index < last || view.status === "DELIVERED";
      return `<li><span class="dot${done ? "" : " pending"}" aria-hidden="true"></span>
      <div><p class="step">${e(labels[entry.type] ?? entry.type)}</p>
      <p class="when ltr">${e(formatDateTime(entry.occurredAt, locale, timezone))}</p></div></li>`;
    })
    .join("");

  return `<section class="details"><h2>${e(MESSAGES[locale].history)}</h2><ol>${items}</ol></section>`;
}

function renderFooter(input: RenderInput): string {
  const { locale, tenantSlug, trackingNumber, token, supportPhone } = input;
  const e = escapeHtml;
  const messages = MESSAGES[locale];

  // Three ordinary links, visible rather than buried (docs/08 §7): the recipient
  // arrives from an SMS and their language is unknown. No JavaScript.
  const links = LOCALES.map((candidate) => {
    const href =
      `/${candidate}/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(trackingNumber)}` +
      `?token=${encodeURIComponent(token)}`;
    const current = candidate === locale ? ' aria-current="true"' : "";
    return `<a href="${e(href)}" hreflang="${candidate}"${current}>${candidate.toUpperCase()}</a>`;
  }).join("");

  const help =
    supportPhone === ""
      ? ""
      : `<p class="help">${e(messages.needHelp)} <a class="ltr" href="tel:${e(
          supportPhone,
        )}">${e(supportPhone)}</a></p>`;

  return `<footer>${help}<nav aria-label="${e(messages.language)}">${links}</nav></footer>`;
}

/** The failure pages — told apart because they need different advice. */
export function renderFailurePage(locale: Locale, failure: TrackingFailure): string {
  const e = escapeHtml;
  const messages = MESSAGES[locale];
  const { title, detail } =
    failure === "expired"
      ? { title: messages.linkExpired, detail: messages.linkExpiredDetail }
      : { title: messages.notFound, detail: messages.notFoundDetail };

  return document(
    locale,
    title,
    `<div class="content fail" style="display:flex;flex-direction:column;justify-content:center">
    <p class="icon" aria-hidden="true">📭</p>
    <h1>${e(title)}</h1>
    <p>${e(detail)}</p>
  </div>`,
  );
}

/** The document shell. `lang` and `dir` on `<html>` are what make RTL work. */
function document(locale: Locale, title: string, body: string): string {
  return `<!doctype html>
<html lang="${locale}" dir="${directionOf(locale)}">
<head>
<meta charset="utf-8">
<!-- Zoom is never disabled: read on a phone, outdoors, by people of every age. -->
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- ⚠️ A tracking URL carries a token granting access to a real person's parcel.
     A search engine that indexes one publishes it. -->
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}
