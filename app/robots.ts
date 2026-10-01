import type { MetadataRoute } from "next";

// VFY-13: the unauthenticated scan surfaces and the short link are never
// crawled. Each verify page also carries robots noindex/nofollow in its
// segment layout (app/verify*/layout.tsx), and the four verify APIs answer
// Cache-Control: no-store. No sitemap exists; none may list these paths
// (lib/__tests__/verifyDoor.test.ts).
const VERIFY_DISALLOWED_PATHS = ["/verify/", "/verify-hold/", "/verify-package/", "/verify-ticket/", "/d/", "/api/verify"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: VERIFY_DISALLOWED_PATHS }],
  };
}
