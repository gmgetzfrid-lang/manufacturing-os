// lib/emailUrl.ts
//
// Links inside emails must be full addresses: "/requests/123" means nothing
// in a mail app. In-app links stay relative; emails get the site in front.
// Order: the configured site (NEXT_PUBLIC_SITE_URL), then the production
// domain Vercel gives server code, then the page's own origin in a browser.

export function emailUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const site = (process.env.NEXT_PUBLIC_SITE_URL || "").trim().replace(/\/+$/, "");
  const prod = (process.env.VERCEL_PROJECT_PRODUCTION_URL || "").trim();
  const origin = site || (prod ? `https://${prod.replace(/^https?:\/\//, "").replace(/\/+$/, "")}` : "")
    || (typeof window !== "undefined" ? window.location.origin : "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return origin ? origin + p : p;
}
