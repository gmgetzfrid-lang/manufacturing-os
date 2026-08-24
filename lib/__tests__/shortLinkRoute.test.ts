// /d/[number] short-link route (EGRESS-2).
//
// The route must disclose NOTHING about whether a document number exists: it
// performs no database lookup and always redirects to the protected documents
// page, which resolves the number client-side under the caller's own RLS. This
// pins Done-when 1 — an unauthenticated GET can never learn a document's
// existence, id, or library from the route's response.

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/d/[number]/route";

async function resolve(number: string): Promise<string> {
  const req = new NextRequest(`https://app.example.com/d/${number}`);
  const res = await GET(req, { params: Promise.resolve({ number }) });
  return res.headers.get("location") ?? "";
}

describe("/d/[number] short link", () => {
  it("always redirects to /documents — never to a document deep link", async () => {
    for (const n of ["2002-D-10001", "01", "P-200-301", "%2e%2e", "a".repeat(60)]) {
      const loc = await resolve(n);
      expect(loc.startsWith("https://app.example.com/documents")).toBe(true);
      // The disclosure the old route leaked was a `/documents/{libraryId}?doc={id}`
      // deep link. This route can never emit one — it does no lookup.
      expect(loc).not.toMatch(/\/documents\/[^?]+\?doc=/);
    }
  });

  it("forwards an in-bounds number as ?d= for client-side resolution", async () => {
    const loc = await resolve("2002-D-10001");
    expect(loc).toContain("/documents?d=2002-D-10001");
  });

  it("drops an out-of-bounds probe rather than forwarding it", async () => {
    // 1 char normalizes below the floor; nothing to resolve, no ?d=.
    const loc = await resolve("x");
    expect(loc).toBe("https://app.example.com/documents");
  });

  it("holds no service-role client — the route source imports no admin client", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "app/d/[number]/route.ts"), "utf8");
    expect(src).not.toContain("supabaseAdmin");
    expect(src).not.toMatch(/\.from\(["']documents["']\)/);
  });
});
