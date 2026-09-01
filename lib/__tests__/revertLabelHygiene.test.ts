// REV-3 / REV-4 — the controlled revision identifier stays human.
//
//   · REV-3: a revert used to write `<label>-revert-<epoch-millis>` into
//     documents.rev — a machine string on every print footer, filename,
//     register row and title-block comparison. A revert now advances the
//     document's own revision scheme like any other publish; the revert
//     itself is recorded by reverted_from_version_id and the change log.
//   · REV-4: the viewer badge must describe the bytes ON SCREEN — an old
//     revision opened from Version History is never "Controlled".

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/holds", () => ({ listActiveHoldsForDocument: vi.fn() }));

import { suggestNextRevisionLabel } from "@/lib/revisions";
import { viewerStatusBadge } from "@/lib/downloads";

describe("revert label follows the library's revision scheme (REV-3)", () => {
  it("advances numeric, prefixed-numeric and alpha schemes", () => {
    expect(suggestNextRevisionLabel("3")).toBe("4");
    expect(suggestNextRevisionLabel("R3")).toBe("R4");
    expect(suggestNextRevisionLabel("Rev 9")).toBe("Rev 10");
    expect(suggestNextRevisionLabel("C")).toBe("D");
    expect(suggestNextRevisionLabel(null)).toBe("0");
  });

  it("revertToVersion derives the label from the scheme, never a machine string", () => {
    const src = readFileSync(join(process.cwd(), "lib", "revisions.ts"), "utf8");
    // The construction site is gone…
    expect(src).not.toMatch(/-revert-\$\{/);
    // …the label advances the document's scheme…
    expect(src).toMatch(/const revertedLabel = suggestNextRevisionLabel\(baseRev\)/);
    // …and a legacy machine-string current rev is stripped back first.
    expect(src).toMatch(/\.replace\(\/-revert-\\d\+\$\/, ""\)/);
  });

  it("a legacy machine-string rev strips back to its base before advancing", () => {
    const strip = (rev: string) => rev.replace(/-revert-\d+$/, "");
    expect(suggestNextRevisionLabel(strip("3-revert-1755823041992"))).toBe("4");
  });
});

describe("viewer badge describes the bytes on screen (REV-4)", () => {
  it("a non-current version reads caution, never Controlled — whatever the doc status", () => {
    const vb = viewerStatusBadge({ status: "Issued", rev: "5" }, false);
    expect(vb.tone).toBe("caution");
    expect(vb.label).toBe("Old revision — not current");
  });

  it("the live current version of an issued doc still reads Controlled", () => {
    const vb = viewerStatusBadge({ status: "Issued", rev: "5" }, true);
    expect(vb.tone).toBe("controlled");
    expect(vb.label).toBe("Controlled · Rev 5");
  });

  it("FullScreenViewer actually passes its served-version currency to the badge", () => {
    const src = readFileSync(
      join(process.cwd(), "components", "viewers", "FullScreenViewer.tsx"), "utf8");
    expect(src).toMatch(/viewerStatusBadge\(\{[^}]*\}, viewingIsCurrent\)/);
  });
});
