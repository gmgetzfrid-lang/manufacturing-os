// lib/publicOrigin.ts
//
// The origin used in URLs that leave the app — QR codes on printed copies,
// labels, hold cards, travelers, pack covers.
//
// Why this exists: those URLs get scanned by phones in the field, often
// with no session and sometimes by people with no account at all. They must
// point at the PUBLIC production domain. `window.location.origin` is wrong
// whenever the person generating the print is on a preview/branch deploy —
// Vercel gates those behind its own login, so the scan dead-ends on a
// Vercel auth screen instead of the verify page.
//
// Set NEXT_PUBLIC_SITE_URL to the canonical production URL (e.g.
// https://app.yourrefinery.com) in every environment — then every print,
// from any deploy, verifies against production.
//
// The contract (PHYS-11 / XEDGE-5 / TRX-14), in order:
//   1. NEXT_PUBLIC_SITE_URL — the configured origin.
//   2. Vercel's PRODUCTION domain — VERCEL_PROJECT_PRODUCTION_URL on the
//      server (always set on Vercel, previews included), its NEXT_PUBLIC_
//      twin in the browser. Never VERCEL_URL: that is the deployment's own
//      host, which on a preview is exactly the gated hostname this file
//      exists to keep off paper.
//   3. In a browser only, the page's own origin — unless that is a Vercel
//      deployment host (*.vercel.app), which may be a gated preview.
//   4. "" — no origin. Every caller treats it as "no link": a stamp drops
//      the verify QR and the instruction to scan it (lib/stamping.ts warns),
//      the transmittal portal refuses to email or print a hostless link.

/** NEXT_PUBLIC_SITE_URL as configured (trimmed, no trailing slash). */
function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || "").trim().replace(/\/+$/, "");
}

/** Vercel's production domain for this project — a bare hostname, so it is
 *  given the https scheme. Set on every Vercel deployment, previews
 *  included; the NEXT_PUBLIC_ twin is what a browser bundle can read. */
function vercelProductionOrigin(): string {
  const host = (
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL ||
    ""
  ).trim().replace(/\/+$/, "");
  if (!host) return "";
  return /^https?:\/\//i.test(host) ? host : `https://${host}`;
}

/** A Vercel deployment hostname — possibly a preview behind Vercel's login. */
export function isVercelDeploymentHost(hostname: string): boolean {
  return /(^|\.)vercel\.app$/i.test(hostname.trim());
}

/** The deployment's CONFIGURED public origin — NEXT_PUBLIC_SITE_URL, else
 *  Vercel's production domain — and "" when there is none. Never the page's
 *  own host: for a link handed to an outside party, where the server and the
 *  browser must build the same URL (the transmittal portal). */
export function configuredPublicOrigin(): string {
  return siteUrl() || vercelProductionOrigin();
}

export function publicOrigin(): string {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  if (typeof window !== "undefined") {
    const loc = window.location;
    if (loc?.origin && !isVercelDeploymentHost(loc.hostname ?? "")) return loc.origin;
  }
  return "";
}
