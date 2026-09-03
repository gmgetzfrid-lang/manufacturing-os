// Phase 6 severity sweep — lifecycle findings (LIFE-3 slice, LIFE-4, LIFE-7).
//
// The consumers here are client components / IndexedDB helpers, so the
// behaviour is pinned at the source and the one pure function is unit-tested.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { categoryToEventType } from "@/lib/notify/dispatch";

const src = (p: string) => readFileSync(process.cwd() + "/" + p, "utf8");

describe("LIFE-7 — the PSM undocumented-change alert is a safety message", () => {
  it("the safety category maps to an event type no preference toggle gates", () => {
    // shouldSendForEvent (lib/notifications.ts) switches on a closed list of
    // preference-gated event types and returns true for anything else.
    const gated = src("lib/notifications.ts").match(/case "([a-z_]+)":\s*(?:case "[a-z_]+":\s*)*return prefs\./g) ?? [];
    const gatedTypes = gated.flatMap((c) => [...c.matchAll(/case "([a-z_]+)"/g)].map((m) => m[1]));
    expect(gatedTypes).toContain("assignment");
    expect(gatedTypes).not.toContain(categoryToEventType("safety"));
    expect(gatedTypes).not.toContain(categoryToEventType("recall"));
    expect(categoryToEventType("assignment")).toBe("assignment");
  });

  it("CheckInPanel escalates through emit() on the safety category, and an empty roster is visible + audited", () => {
    const s = src("components/documents/CheckInPanel.tsx");
    const blk = s.slice(s.indexOf("if (undocumented) {"), s.indexOf("return { id: row.id as string, number: ticketNumber };"));
    expect(blk).toMatch(/category: "safety"/);
    expect(blk).toMatch(/resource: \{ type: "ticket", id: row\.id as string \}/);
    expect(blk).not.toMatch(/notifyMany\(/);
    expect(blk).toMatch(/PSM alert has no recipient/);
    expect(blk).toMatch(/action: "PSM_ALERT_UNROUTED"/);
  });
});

describe("LIFE-4 — the book-viewer hand-off keeps the source-document link", () => {
  const s = src("app/(protected)/requests/new/page.tsx");
  it("the stashed docId reaches metadata.source_document, the history entry and the chip", () => {
    expect(s).toMatch(/const srcDocId = sourceDocId \|\| stashedDoc\?\.id \|\| '';/);
    expect(s).toMatch(/if \(withDoc\?\.docId\) setStashedDoc\(\{ id: withDoc\.docId, number: withDoc\.docNumber \?\? '' \}\);/);
    expect(s).toMatch(/metadata\.source_document = buildSourceDocumentRef\(\{ id: srcDocId, documentNumber: srcDocNum, title: sourceDocTitle, rev: sourceDocRev \}\);/);
    expect(s).toMatch(/\{\(srcDocId \|\| sourceFileUrl\) && \(/);
    expect(s).not.toMatch(/if \(sourceDocId\) \{\s*\n\s*metadata\.source_document/);
  });
});

describe("LIFE-3 (refresh slice) — the hand-off stash survives until submit", () => {
  it("draftHandoff reads without deleting and discards on demand; the form discards after the insert succeeds", () => {
    const h = src("lib/draftHandoff.ts");
    expect(h).toMatch(/export async function readDraft/);
    expect(h).toMatch(/export async function discardDraft/);
    expect(h).not.toMatch(/export async function takeDraft/);
    const rd = h.slice(h.indexOf("export async function readDraft"), h.indexOf("export async function discardDraft"));
    expect(rd).toMatch(/db\.transaction\(STORE, "readonly"\)/);
    expect(rd).not.toMatch(/\.delete\(/);
    const s = src("app/(protected)/requests/new/page.tsx");
    expect(s).toMatch(/readDraft\(draftKey\)/);
    expect(s.indexOf("if (insertError) throw insertError;")).toBeLessThan(s.indexOf("void discardDraft(draftKey)"));
    // Re-running the effect (StrictMode) must not attach the same file twice.
    expect(s).toMatch(/fs\.filter\(\(f\) => !have\.has\(f\.name\)\)/);
  });
});
