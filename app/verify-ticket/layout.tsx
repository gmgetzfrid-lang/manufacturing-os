import type { ReactNode } from "react";
import type { Metadata } from "next";

// VFY-13: a public scan-landing page is reachable by URL alone, so it must
// never be indexed — a leaked verify link (an email thread, a QR-decoder site,
// a forum post) would otherwise surface a drawing number, title and revision
// in search results under the plant's own domain. app/robots.ts disallows the
// same paths; this tag covers a crawler that reaches the page anyway.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function VerifySegmentLayout({ children }: { children: ReactNode }) {
  return children;
}
