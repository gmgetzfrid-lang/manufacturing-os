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

export function publicOrigin(): string {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}
