// Phase 6 severity sweep, Round A2 — lifecycle MEDIUMs that need no migration:
// LIFE-15 (canonical source_document), LIFE-9 (required fields on in-app
// tickets), LIFE-8 (honest markup sharing), LIFE-10 (register links + last
// field-verified), LIFE-11 step 1 (preset issue purpose), LIFE-12 (review
// requirement on the ticket), LIFE-14 (resume, never re-create), LIFE-6's
// holdId half.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildSourceDocumentRef, parseSourceDocument, unitOfDocumentMetadata } from "@/lib/sourceDocRef";

const src = (p: string) => readFileSync(process.cwd() + "/" + p, "utf8");

describe("LIFE-15 — one canonical source_document shape, tolerant reader", () => {
  it("the builder writes canonical keys with null (never \"\") and no path; the parser reads it back exactly", () => {
    const ref = buildSourceDocumentRef({ id: "d1", documentNumber: " P-101 ", title: "", rev: null });
    // drafting-flow DF-P2 (HAND-7): the canonical shape gains version_id —
    // null when unknown, as every other unknown field is.
    expect(ref).toEqual({ id: "d1", document_number: "P-101", title: null, rev: null, version_id: null });
    expect(Object.keys(ref!)).toEqual(["id", "document_number", "title", "rev", "version_id"]);
    expect(parseSourceDocument({ source_document: ref })).toEqual({ id: "d1", documentNumber: "P-101", title: null, rev: null, path: null, versionId: null });
  });
  it("no id → no reference (a producer cannot point at nothing)", () => {
    expect(buildSourceDocumentRef({ id: "", documentNumber: "P-1" })).toBeNull();
    expect(buildSourceDocumentRef({ id: null })).toBeNull();
  });
  it("historical shapes still parse (CheckInPanel nulls, requests/new empties, transitionIn `number`)", () => {
    expect(parseSourceDocument({ source_document: { id: "a", document_number: "N", title: "T", rev: "B", path: null } })?.documentNumber).toBe("N");
    expect(parseSourceDocument({ source_document: { id: "a", document_number: "", title: "", rev: "", path: "" } })?.documentNumber).toBeNull();
    expect(parseSourceDocument({ source_document: { id: "a", number: "N2", title: "T" } })?.documentNumber).toBe("N2");
  });
  it("all three producers and the strict intake reader go through the helper", () => {
    // DF-P2: the three producers describe their source document in the
    // create contract; /api/tickets/create is the one writer, through the helper.
    const route = src("app/api/tickets/create/route.ts");
    expect(route).toMatch(/const ref = buildSourceDocumentRef\(\{/);
    expect(route).toContain("if (primary) metadata.source_document = primary;");
    expect(src("components/documents/CheckInPanel.tsx")).toMatch(/id: doc\.id!, documentNumber: doc\.documentNumber \?\? null, title: doc\.title \?\? null, rev: doc\.rev \?\? null,/);
    expect(src("app/(protected)/requests/new/page.tsx")).toMatch(/sourceDocuments\.push\(\{ id: srcDocId, documentNumber: srcDocNum \|\| null, title: sourceDocTitle \|\| null, rev: sourceDocRev \|\| null, versionId: null \}\);/);
    expect(src("lib/transitionIn.ts")).toMatch(/sourceDocuments: \[\{ id: candidate\.docId, documentNumber: candidate\.number, title: candidate\.title, rev: candidate\.rev, versionId: null \}\]/);
    for (const f of ["components/documents/CheckInPanel.tsx", "app/(protected)/requests/new/page.tsx", "lib/transitionIn.ts"]) {
      expect(src(f), f).not.toMatch(/supabase\s*\.from\(["']tickets["']\)\s*\.insert\(/);
    }
    const intake = src("app/api/intake/resolve/route.ts");
    expect(intake).toMatch(/parseSourceDocument\(/);
    expect(intake).not.toMatch(/meta\.source_document\?\.number/);
  });
});

describe("LIFE-9 — in-app tickets carry the request form's required fields", () => {
  it("unitOfDocumentMetadata reads the first unit/area-named custom value", () => {
    expect(unitOfDocumentMetadata({ "Sheet": "3", "Unit": "U-200" })).toBe("U-200");
    expect(unitOfDocumentMetadata({ "Process Area": "A1" })).toBe("A1");
    expect(unitOfDocumentMetadata({ "Unit": "" })).toBeNull();
    expect(unitOfDocumentMetadata(null)).toBeNull();
  });
  it("the check-in producer writes unit; the collision producer writes unit, target date and watcher", () => {
    // DF-P2: one writer for every door — /api/tickets/create derives the unit
    // from the source document's metadata when none is given, sets the SLA
    // clock and enrols the requester as a watcher, the same for all three
    // (driven end to end in lib/__tests__/ticketCreateRoute.test.ts).
    const route = src("app/api/tickets/create/route.ts");
    expect(route).toMatch(/unitOfDocumentMetadata\(doc\.metadata\)/);
    expect(route).toContain("target_completion_at: input.targetCompletionAt ?? defaultSlaTargetDate(input.requestType),");
    expect(route).toContain("watchers: [caller.id],");
    expect(src("components/documents/CheckInPanel.tsx")).toMatch(/unit: null,/);
    expect(src("lib/transitionIn.ts")).toMatch(/requestType: "Revision",[\s\S]*?unit: null,/);
  });
});

describe("LIFE-8 — sharing markups claims only what the system can back", () => {
  it("resolveMarkupRequest is a checked write and posts the markup_ref the thread renders on share", () => {
    const m = src("lib/markupRequests.ts");
    expect(m).toMatch(/\.select\("document_id"\)\s*\n\s*\.maybeSingle\(\);/);
    expect(m).toMatch(/if \(!updated\) throw new Error\(/);
    expect(m).toMatch(/if \(input\.status === "shared" && [\s\S]*?postMarkupRef\(\{/);
    expect(src("app/(protected)/inbox/page.tsx")).not.toMatch(/The requester can see your markups are available\./);
  });
});

describe("LIFE-10 — the register is read: ticket links, hold chip, last field-verified", () => {
  const h = src("components/documents/CheckoutHistoryPanel.tsx");
  it("history rows carry outcome_ref and link to the ticket / show the hold", () => {
    expect(h).toMatch(/outcomeRef: \(r\.outcome_ref as EpisodeSessionRow\["outcomeRef"\]\) \?\? null,/);
    expect(h).toMatch(/href=\{`\/requests\/\$\{s\.outcomeRef\.ticketId\}`\}/);
    expect(h).toMatch(/s\.outcomeRef\?\.holdId && <span[^>]*> · hold placed<\/span>/);
  });
  it("the document shows when it was last field-verified, against which rev, and whether a discrepancy superseded it", () => {
    expect(h).toMatch(/\.in\("outcome", \["field_verified", "discrepancy"\]\)/);
    expect(h).toMatch(/Last field-verified/);
    expect(h).toMatch(/superseded by a field discrepancy/);
  });
});

describe("LIFE-11 step 1 — a launcher can preset the issue purpose, visibly and overridably", () => {
  it("RevUpModal accepts presetIssueType, applies it after the remembered value, and says so beside the field", () => {
    const r = src("components/documents/RevUpModal.tsx");
    expect(r).toMatch(/presetIssueType\?: DocumentVersion\["issueType"\];/);
    expect(r.indexOf("if (remembered?.issueType) setIssueType(remembered.issueType);")).toBeLessThan(r.indexOf("if (presetIssueType) setIssueType(presetIssueType);"));
    expect(r).toMatch(/presetIssueType && issueType === presetIssueType && \(/);
    expect(r).toMatch(/Defaulted to \$\{presetIssueType\} by the launcher — change it if that's wrong\./);
  });
});

describe("LIFE-12 — the ticket shows its source document's review requirement", () => {
  it("the source card loads the effective review control and says a ticket approval does not satisfy it", () => {
    const p = src("app/(protected)/requests/[id]/page.tsx");
    expect(p).toMatch(/effectiveReviewControlForDocument\(\{ collectionId: doc\.collectionId, libraryId: doc\.libraryId \}\)/);
    expect(p).toMatch(/approving this ticket does not satisfy it\./);
    expect(p).toMatch(/approving this ticket does not satisfy a document sign-off\./);
    // No path wires a ticket action to a review sign-off.
    expect(p).not.toMatch(/recordReviewSignoff\(/);
  });
});

describe("LIFE-14 — resume, never re-create; the sweep never clobbers a verdict", () => {
  it("CheckInPanel resumes the ticket keyed on metadata.checkin.episodeId before creating one", () => {
    // drafting-flow LEAK-6 (DF-P2): the lookup's error is read and the commit
    // awaits it (lib/ticketCreateClient.ts resumeCheckinTicket); the create
    // route resumes by the same key server-side.
    const c = src("components/documents/CheckInPanel.tsx");
    expect(c).toMatch(/\.eq\("metadata->checkin->>episodeId", episodeId\)/);
    expect(c).toMatch(/const ticket = done\.ticket \?\? \(await resumedTicket\(\)\) \?\? await createDraftingTicket\(selected\);/);
    expect(src("app/api/tickets/create/route.ts")).toMatch(/\.eq\("metadata->checkin->>episodeId", input\.origin\.episodeId\)/);
  });
  it("the 24h sweep only writes auto_released over a NULL outcome", () => {
    const p = src("lib/projects.ts");
    expect(p).toMatch(/\.update\(\{ \.\.\.basePayload, outcome: "auto_released" \}\)[\s\S]*?\.eq\("status", "active"\)[\s\S]*?\.is\("outcome", null\);/);
  });
});

describe("LIFE-6 (holdId half) — the register entry links the hold the check-in placed", () => {
  it("openHold's id is kept and written into outcome_ref.holdId; a retry never re-opens the hold", () => {
    const c = src("components/documents/CheckInPanel.tsx");
    expect(c).toMatch(/if \(alsoHold && selected\.allowHoldOffer && !done\.hold\) \{/);
    expect(c).toMatch(/if \(hold\.id\) done\.hold = \{ id: hold\.id \};/);
    expect(c).toMatch(/\.\.\.\(done\.hold \? \{ holdId: done\.hold\.id \} : \{\}\)/);
  });
});
