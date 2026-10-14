// intelligence Round G, package I-12 DOCUMENT ACL BOUNDARY — the third
// review's fixes that are pure (no service-role stand-in):
//
//   VFY-7 (chooser)  number uniqueness binds ACTIVE documents only, so a
//            superseded, void or archived row can share the current one's
//            number; the chooser listed number, title and library only, so a
//            short link that used to deep-link offered two identical rows.
//            Both short-link reads now select status, rev and archived_at;
//            lib/docNumberMatch returns the documents in force first and
//            says each row's revision, status and "archived"
//            (shortLinkMatchState / isCurrentMatch). Which one opens is still
//            the reader's choice whenever two or more match (done-when 3).
//
// The other third-review fixes are pinned where their stand-ins live:
// lib/__tests__/intelRoundGDocAcl.test.ts (KACL-12's documents-row read,
// DACL-9's withheld grant half, KACL-10's keyset held-back read),
// lib/__tests__/shareRoutes.test.ts (the share door over the real
// shareAuthority), lib/__tests__/intelRoundGNodeVisibleDeny.test.ts
// (20261212's write-refusal header, inventory rows and paste order).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shortLinkExactMatches, shortLinkMatchState, isCurrentMatch } from "@/lib/docNumberMatch";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("VFY-7 (third review fix) — the chooser tells a superseded or archived document from the current one", () => {
  type R = { id: string; document_number: string | null; title?: string; rev?: string | null; status?: string | null; archived_at?: string | null };
  const superseded: R = { id: "d-old", document_number: "P-101", title: "Pump layout", rev: "A", status: "Superseded", archived_at: null };
  const current: R = { id: "d-cur", document_number: "P-101", title: "Pump layout", rev: "B", status: "Issued", archived_at: null };
  const archived: R = { id: "d-arc", document_number: "P101", title: "Pump layout", rev: "C", status: "Issued", archived_at: "2026-09-01T00:00:00Z" };

  it("reproduction → fix: two 'P-101 Pump layout' rows — one superseded — come back current first, and each row says its revision and status, so they no longer look the same", async () => {
    const hits = await shortLinkExactMatches<R>("P-101", { search: async () => [superseded, current], normalized: async () => [superseded, current, archived] });
    expect(hits.map((h) => h.id)).toEqual(["d-cur", "d-old", "d-arc"]);
    expect(hits.map((h) => shortLinkMatchState(h))).toEqual(["Rev B · Issued", "Rev A · Superseded", "Rev C · Issued · archived"]);
    expect(hits.map((h) => isCurrentMatch(h))).toEqual([true, false, false]);
    // still a chooser whenever two or more match — never a silent pick (done-when 3)
    expect(hits.length).toBeGreaterThan(1);
  });

  it("the not-current statuses are the shared set (lib/aiBoundary NOT_CURRENT_STATUSES), never an inline list; a row with no state shows nothing", () => {
    for (const s of NOT_CURRENT_STATUSES) expect(isCurrentMatch({ status: s })).toBe(false);
    expect(isCurrentMatch({ status: "Issued" })).toBe(true);
    expect(isCurrentMatch({ status: null })).toBe(true);
    expect(shortLinkMatchState({})).toBe("");
    expect(shortLinkMatchState({ rev: "  ", status: "Draft" })).toBe("Draft");
    const lib = src("lib/docNumberMatch.ts");
    expect(lib).toMatch(/import \{ NOT_CURRENT_STATUSES \} from "@\/lib\/aiBoundary";/);
    expect(lib).not.toMatch(/"Superseded"|"Void"/);
  });

  it("a single match still deep-links, whatever its state (the order never drops a row)", async () => {
    expect(await shortLinkExactMatches<R>("P-101", { search: async () => [superseded], normalized: async () => [] })).toEqual([superseded]);
  });

  it("the page: both reads carry status, rev and archived_at (searchDocuments selects *), and the chooser renders the state beside each row", () => {
    const home = src("app/(protected)/documents/page.tsx");
    expect(home).toMatch(/\.select\("id, library_id, document_number, title, rev, status, archived_at, updated_at"\)\s*\n\s*\.eq\("org_id", activeOrgId\)\s*\n\s*\.regexIMatch\("document_number", pattern\)/);
    expect(home).toMatch(/import \{ shortLinkExactMatches, shortLinkMatchState, isCurrentMatch \} from "@\/lib\/docNumberMatch";/);
    expect(home).toMatch(/data-short-link-state=\{isCurrentMatch\(r\) \? "current" : "not-current"\}/);
    expect(home).toMatch(/\{shortLinkMatchState\(r\)\}/);
    expect(src("lib/search.ts")).toMatch(/\.from\("documents"\)\s*\n\s*\.select\("\*"\)/);
  });
});
