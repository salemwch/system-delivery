import { describe, expect, it } from "vitest";

import type { TrackingView } from "../src/lib/api";
import { escapeHtml, renderFailurePage, renderTrackingPage } from "../src/lib/render";

/**
 * The rendered page.
 *
 * ⚠️ This is the most exposed surface in the system (docs/07 §2.2): anyone
 * holding the link sees it, and it is built by string concatenation. So the
 * escaping is not a detail — it is the only thing between a merchant-typed name
 * and script execution in a recipient's browser.
 */
const view: TrackingView = {
  courierName: "Rapide Express",
  trackingNumber: "CTN-8K3M-92XQ",
  status: "OUT_FOR_DELIVERY",
  statusLabel: { ar: "قيد التوصيل", fr: "En cours de livraison", en: "Out for delivery" },
  recipientFirstName: "Sonia",
  codAmountMinor: 12_500,
  currency: "TND",
  currencyExponent: 3,
  promisedFrom: "2026-07-30T13:10:00Z",
  promisedTo: "2026-07-30T13:40:00Z",
  timeline: [
    { type: "CREATED", occurredAt: "2026-07-30T08:14:00Z" },
    { type: "PICKED_UP", occurredAt: "2026-07-30T09:31:00Z" },
    { type: "OUT_FOR_DELIVERY", occurredAt: "2026-07-30T12:05:00Z" },
  ],
  createdAt: "2026-07-30T08:14:00Z",
};

function render(overrides: Partial<TrackingView> = {}, locale: "ar" | "fr" | "en" = "fr"): string {
  return renderTrackingPage({
    view: { ...view, ...overrides },
    locale,
    tenantSlug: "rapide",
    trackingNumber: "CTN-8K3M-92XQ",
    token: "tok",
    timezone: "Africa/Tunis",
    supportPhone: "+21671000000",
  });
}

describe("escaping", () => {
  it("escapes ampersands FIRST so nothing is double-escaped", () => {
    // "&lt;" must not become "&amp;lt;" — the classic ordering bug, which shows
    // up as literal entity text on the page.
    expect(escapeHtml('Ben Ali & Co <"x">')).toBe("Ben Ali &amp; Co &lt;&quot;x&quot;&gt;");
  });

  it("neutralises a script tag in a merchant-supplied name", () => {
    const html = render({ courierName: '<script>alert("x")</script>' });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("neutralises a script tag in a recipient name", () => {
    const html = render({ recipientFirstName: '<img src=x onerror="alert(1)">' });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("escapes the token in the language links", () => {
    // The token comes from the URL. Unescaped, a crafted one would break out of
    // the href attribute.
    const html = renderTrackingPage({
      view,
      locale: "fr",
      tenantSlug: "rapide",
      trackingNumber: "CTN-1",
      token: '"><script>alert(1)</script>',
      timezone: "Africa/Tunis",
      supportPhone: "",
    });
    expect(html).not.toContain("<script>alert");
  });
});

describe("privacy", () => {
  it("renders the first name and NOTHING else identifying", () => {
    const html = render();
    expect(html).toContain("Sonia");
    // Anyone with the link sees this page. The endpoint never returns these, and
    // this asserts the page cannot start showing them by accident.
    expect(html).not.toContain("Ben Amor");
    expect(html).not.toContain("+21620000002");
  });

  it("tells search engines not to index it", () => {
    // A tracking URL carries a token; an indexed page publishes it.
    expect(render()).toContain('name="robots" content="noindex,nofollow,noarchive"');
  });
});

describe("money", () => {
  it("prints TND at three decimal places", () => {
    // ⚠️ The last screen a recipient reads before handing over cash.
    const html = render();
    expect(html).toContain("12,500");
    expect(html).not.toContain("125,00 ");
  });

  it("shows the exact-amount notice only when there is COD to collect", () => {
    expect(render()).toContain("Préparez le montant exact");
    expect(render({ codAmountMinor: 0 })).not.toContain("Préparez le montant exact");
  });
});

describe("localisation", () => {
  it("marks an Arabic page RTL at the document root", () => {
    const html = render({}, "ar");
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain("قيد التوصيل");
  });

  it("keeps LTR isolation for the tracking number and phone", () => {
    // Mirrored inside an RTL page, they get read back to a call centre wrong.
    const html = render({}, "ar");
    expect(html).toContain("unicode-bidi:isolate");
    expect(html).toContain('class="tracking ltr"');
  });

  it("marks the current language and links the other two", () => {
    const html = render({}, "fr");
    expect(html).toContain('hreflang="fr" aria-current="true"');
    expect(html).toContain('hreflang="ar"');
    expect(html).toContain('hreflang="en"');
  });
});

describe("page weight", () => {
  it("ships NO JavaScript and no external subresource", () => {
    const html = render();
    // ⚠️ The whole reason this is a route handler rather than a React page. As a
    // server component the same output dragged 136 KB of gzipped client runtime
    // behind it, to hydrate a document with nothing to hydrate.
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<link[^>]*href=/u);
    expect(html).not.toContain("http://");
  });

  it("stays small enough for one round trip on 3G", () => {
    // The whole page, CSS included. The budget is LCP <2.5 s on 3G (docs/08 §9).
    expect(render().length).toBeLessThan(12_000);
  });
});

describe("failure pages", () => {
  it("tells an expired link apart from an unknown one", () => {
    // They need different advice: "ask your sender for a new link" versus
    // "check the SMS". Collapsing them sends people to the wrong remedy.
    expect(renderFailurePage("fr", "expired")).toContain("Lien expiré");
    expect(renderFailurePage("fr", "not-found")).toContain("Colis introuvable");
  });

  it("renders a failure in the requested language, RTL included", () => {
    const html = renderFailurePage("ar", "expired");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("انتهت صلاحية الرابط");
  });
});
