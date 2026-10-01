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
//      server (a Vercel system variable, previews included, while the
//      project exposes its system environment variables — the default), its
//      NEXT_PUBLIC_ twin in the browser. Never VERCEL_URL: that is the
//      deployment's own host, which on a preview is exactly the gated
//      hostname this file exists to keep off paper.
//   3. In a browser only, the page's own origin. On a Vercel deployment with
//      system-env exposure on, step 2 has already answered with production;
//      only a deployment with exposure off AND nothing configured reaches
//      this step from a preview host, and its QRs then carry that host.
//      Trusting the page here keeps every browser caller on an absolute URL:
//      several (lib/physicalBridge.ts, ShareLinkModal, RelatedPanel) build
//      `${publicOrigin()}/…` without a "" check.
//   4. "" — no origin. Reached only on a SERVER with nothing configured. The
//      server routes that build outbound links treat it as "no link": the
//      share and transmittal stamps drop the verify QR and the instruction
//      to scan it (lib/stamping.ts warns); the transmittal email refuses.
//
// A link handed to an OUTSIDE party with no account (the transmittal portal)
// uses recipientOrigin(): steps 1–2, then the page's own origin only on a
// host that party can open — never a Vercel deployment host (*.vercel.app, a
// preview behind Vercel's login) or a loopback address — else "", which its
// callers check and report.

/** NEXT_PUBLIC_SITE_URL as configured (trimmed, no trailing slash). */
function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || "").trim().replace(/\/+$/, "");
}

/** Vercel's production domain for this project — a bare hostname, so it is
 *  given the https scheme. A Vercel system variable, set on previews too
 *  while the project exposes its system environment variables (the
 *  default); the NEXT_PUBLIC_ twin is what a browser bundle can read. */
function vercelProductionOrigin(): string {
  const host = (
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL ||
    ""
  ).trim().replace(/\/+$/, "");
  if (!host) return "";
  return /^https?:\/\//i.test(host) ? host : `https://${host}`;
}

/** The deployment's CONFIGURED public origin — NEXT_PUBLIC_SITE_URL, else
 *  Vercel's production domain — and "" when there is none. Never the page's
 *  own host. The server and the browser agree on it when NEXT_PUBLIC_SITE_URL
 *  is set or Vercel exposes the production domain's NEXT_PUBLIC_ twin; with
 *  exposure off the browser gets "" (and so does the server, unless it still
 *  receives VERCEL_PROJECT_PRODUCTION_URL). */
export function configuredPublicOrigin(): string {
  return siteUrl() || vercelProductionOrigin();
}

export function publicOrigin(): string {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "";
}

/** A host an outside recipient cannot open, or cannot be shown to open: a
 *  Vercel deployment host (*.vercel.app — a preview sits behind Vercel's
 *  login, and a production alias on vercel.app cannot be told apart from a
 *  preview by its name, so it is refused too), a loopback address, or no
 *  host at all. */
export function isUnreachableRecipientHost(hostname: string): boolean {
  const h = (hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "" ||
    /(^|\.)vercel\.app$/.test(h) ||
    h === "localhost" || h.endsWith(".localhost") ||
    /^127\./.test(h) || h === "::1" || h === "0.0.0.0"
  );
}

/** The origin for a link handed to an OUTSIDE party (the transmittal portal):
 *  the configured origin; else, in a browser, the page's own origin when its
 *  host is one that party can open — a self-hosted deployment's own address —
 *  and not a Vercel deployment host or loopback; else "". On a server it is
 *  configuredPublicOrigin(). Callers treat "" as "no link" and say so. */
export function recipientOrigin(): string {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  if (typeof window === "undefined" || !window.location?.origin) return "";
  let host = "";
  try { host = new URL(window.location.origin).hostname; } catch { host = ""; }
  return isUnreachableRecipientHost(host) ? "" : window.location.origin;
}
