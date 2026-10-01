// lib/transitionIn.ts
//
// TRANSITION-IN — adopting an externally submitted drawing set into the
// controlled register. New units arrive as a pile of contractor drawings in
// the project's intake folder; before they become "our" documents they need
// an impact check against what already exists:
//
//   * equipment tags on the drawing that match the asset registry → tie-in
//     points (good — we link them so where-used sees the new sheet)
//   * an existing document with the SAME number → hard collision (two
//     sources of truth — must be resolved, never silently adopted)
//   * existing documents covering the same equipment → overlap (an existing
//     P&ID shows the tie-in; it likely needs a revision — drafting work)
//
// Clean documents can be adopted in bulk: moved into a real library/folder,
// optionally renumbered to org convention, matched equipment linked, the
// project association kept, and the whole thing audited as TRANSITION_IN.
// The provenance chain (external versions, submitting company) rides along
// untouched — adoption moves the document, it never rewrites history.

import { supabase } from "@/lib/supabase";
import { normalizeTag } from "@/lib/assets";
import { generateTicketNumber } from "@/lib/ticketNumber";
import { resolveTicketRecipients } from "@/lib/ticketRouting";
import { emit } from "@/lib/notify/dispatch";
import { buildSourceDocumentRef, unitOfDocumentMetadata } from "@/lib/sourceDocRef";
import { defaultSlaTargetDate } from "@/lib/notifications";
import { completeUniquenessKey, numberIsTheKey, uniquenessTuple } from "@/lib/intakeLinks";

/** Global variant of the entity-tag pattern (lib/notes.ts keeps the
 *  single-match one): FE-201, P-101A, PSV-1002 … The trailing lookahead
 *  rejects partial matches inside multi-segment drawing numbers
 *  ("D-25-1042" must NOT yield a phantom tag "D-25"). */
const TAG_SCAN_RE = /\b([A-Z]{1,4}-\d{2,5}[A-Z]?)\b(?!-\d)/g;

export interface TransitionCandidate {
  docId: string;
  label: string;
  number: string | null;
  title: string | null;
  rev: string | null;
  status: string | null;
  company: string | null;
  submittedAt: string | null;
  /** INTK-3 / SAF-11: the sheet has no approved revision yet — its
   *  submission is still in review (or was never decided). Shown, marked,
   *  and never adoptable until someone approves it. */
  awaitingReview?: boolean;
  /** The sheet has an open pending revision (`pending_version_id`). */
  pendingReview?: boolean;
  /** …and it names a RETIRED draft (`superseded_at` stamped, or
   *  review_state 'superseded' — what pending_on_retired_version_count()
   *  counts). The review queue lists in-review drafts only, so nobody can
   *  approve or reject it there: Document Control must clear the pointer or
   *  re-open the draft. */
  pendingRetired?: boolean;
  /** The sheet HAS an approved revision, but its newest proposal was
   *  rejected. The approved revision is what adoption moves; the refusal is
   *  shown as a note. */
  latestRejected?: boolean;
}

/** Why a sheet's collision check could not say "clean" (INTK-7). */
export type UnverifiableReason = "no_number" | "no_equipment" | "check_failed";

/** A live document already carrying the sheet's number. `libraryId` says
 *  where it lives: in a multi-sheet destination a same-numbered sibling in
 *  THAT library is expected, one anywhere else is a second source of truth
 *  (SAF-12 / INTK-3). */
export interface NumberCollider { id: string; label: string; rev: string | null; libraryId: string | null }

export interface TransitionImpact {
  /** Candidate equipment tags found on the document's number/title. */
  tags: string[];
  /** Tags that resolve to real assets in the registry (tie-in points). */
  matchedAssets: Array<{ id: string; tag: string }>;
  /** Existing non-superseded document with the same number — hard collision
   *  (the first of `numberCollisions`). */
  numberCollision: NumberCollider | null;
  /** Every live same-numbered document the scan read (bounded, id order) —
   *  the panel judges them against the destination it picks. */
  numberCollisions: NumberCollider[];
  /** Existing documents that reference the same equipment tags. */
  overlapDocs: Array<{ id: string; label: string; rev: string | null; sharedTags: string[] }>;
  /** INTK-7: what could NOT be checked. A sheet with no number was never
   *  compared with the register; one with no recognised equipment was never
   *  compared with the drawings covering it; a check that errored checked
   *  nothing. Any of these makes the sheet UNVERIFIABLE — never clean. */
  unverifiable: UnverifiableReason[];
  /** Checked, and nothing found: no number collision, no overlap, and every
   *  check ran. Only these may be bulk-adopted. */
  clean: boolean;
}

/** Pull candidate equipment tags out of a document's identity fields. */
export function extractCandidateTags(...texts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.toUpperCase().matchAll(TAG_SCAN_RE)) found.add(m[1]);
  }
  return [...found];
}

/** INTK-7: a contractor's drawing number as a LIKE pattern that matches only
 *  itself (case-insensitively). `%`, `_` and `\` are escaped; PostgREST's
 *  `*` wildcard alias cannot be escaped, so it becomes `_` — a broader
 *  pattern, never a narrower one — and the caller keeps only exact matches. */
export function likeExact(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, "_");
}

/** Case- and whitespace-insensitive number comparison (the key the partial
 *  unique index uses for the default tuple). */
export function sameNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (v: string | null | undefined) => String(v ?? "").trim().toLowerCase();
  return !!n(a) && n(a) === n(b);
}

const RETIRED = "(Archived,Superseded)";

/** Documents still sitting in the project's intake folder — the un-adopted
 *  set. Company comes from the latest external version. INTK-3 / SAF-11: a
 *  sheet that was NEVER approved and whose latest intake submission was
 *  REJECTED is not a candidate (the organisation refused it); one with no
 *  approved revision yet is listed, marked, and blocked from adoption. A
 *  sheet with an approved revision stays a candidate even when a later
 *  proposal was rejected — the approved revision is the controlled content,
 *  and the rejection is shown as a note. */
export async function listTransitionCandidates(
  orgId: string,
  intakeCollectionId: string,
): Promise<TransitionCandidate[]> {
  const { data: docs, error } = await supabase
    .from("documents")
    .select("id, document_number, title, name, rev, status, created_by_name, created_at, current_version_id, pending_version_id")
    .eq("org_id", orgId)
    .eq("collection_id", intakeCollectionId)
    .neq("status", "Superseded")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Couldn't list the intake sheets: ${error.message}`);
  const rows = ((docs ?? []) as Array<Record<string, unknown>>);
  const ids = rows.map((d) => String(d.id));
  // INTK-3 / INTK-4: an open pending revision that names a RETIRED draft is
  // not in the review queue — the panel must not send the operator there.
  const retiredPending = new Set<string>();
  const pendingIds = [...new Set(rows.map((d) => d.pending_version_id).filter((v) => v != null && v !== "").map(String))];
  if (pendingIds.length) {
    const { data: pv, error: pErr } = await supabase
      .from("document_versions").select("id, review_state, superseded_at").in("id", pendingIds);
    if (pErr) throw new Error(`Couldn't read the pending submissions: ${pErr.message}`);
    for (const v of ((pv ?? []) as Array<{ id: string; review_state: string | null; superseded_at: string | null }>)) {
      if (pendingDraftRetired(v)) retiredPending.add(String(v.id));
    }
  }
  // The latest intake submission per sheet (newest first).
  const latestState = new Map<string, string | null>();
  if (ids.length) {
    const { data: vers, error: vErr } = await supabase
      .from("document_versions")
      .select("record_id, review_state, created_at")
      .in("record_id", ids)
      .not("intake_link_id", "is", null)
      .order("created_at", { ascending: false });
    if (vErr) throw new Error(`Couldn't read the intake submissions: ${vErr.message}`);
    for (const v of ((vers ?? []) as Array<{ record_id: string; review_state: string | null }>)) {
      if (!latestState.has(String(v.record_id))) latestState.set(String(v.record_id), v.review_state ?? null);
    }
  }
  return rows
    .filter((d) => !(latestState.get(String(d.id)) === "rejected" && !d.current_version_id))
    .map((d) => ({
      docId: String(d.id),
      label: String(d.document_number || d.title || d.name || "Document"),
      number: (d.document_number as string | null) ?? null,
      title: ((d.title ?? d.name) as string | null) ?? null,
      rev: (d.rev as string | null) ?? null,
      status: (d.status as string | null) ?? null,
      company: ((d.created_by_name as string | null) ?? null)?.replace(/ \(intake\)$/, "") ?? null,
      submittedAt: (d.created_at as string | null) ?? null,
      awaitingReview: !d.current_version_id,
      pendingReview: !!d.pending_version_id,
      pendingRetired: !!d.pending_version_id && retiredPending.has(String(d.pending_version_id)),
      latestRejected: latestState.get(String(d.id)) === "rejected",
    }));
}

/** Pure: is this pending draft RETIRED — the state
 *  pending_on_retired_version_count() counts (superseded_at stamped, or
 *  review_state 'superseded')? */
export function pendingDraftRetired(v: { review_state?: string | null; superseded_at?: string | null } | null | undefined): boolean {
  return !!v && (v.superseded_at != null || v.review_state === "superseded");
}

/** The sentence a pending draft that is retired gets, wherever it is shown. */
export const RETIRED_PENDING_NOTE =
  "Its pending revision names a retired draft, which the review queue does not list — Document Control must clear the document's pending revision or re-open the draft (the maintenance cron counts it in pending_on_retired_version_count) before it can be adopted.";

/** Pure: what the panel tells the operator about a sheet that is not yet
 *  adoptable for review reasons — or null. A pending revision that names a
 *  RETIRED draft is never sent to the review queue (the queue never lists
 *  it). */
export function candidateReviewNote(c: Pick<TransitionCandidate, "awaitingReview" | "pendingReview" | "pendingRetired" | "rev">): string | null {
  if (!candidateInReview(c)) return null;
  if (c.pendingRetired) return RETIRED_PENDING_NOTE;
  const what = c.awaitingReview
    ? (c.pendingReview ? "This submission is still in review" : "This sheet has no approved revision yet")
    : `A newer submission for this sheet is still in review (Rev ${c.rev ?? "—"} is approved)`;
  return `${what} — approve or reject it in the review queue above before it can be adopted.`;
}

/** INTK-3 — a sheet with a submission still undecided: never approved, or
 *  approved with a NEWER submission in review (an open pending_version_id).
 *  adoptDocument refuses both, so the panel never counts such a sheet as
 *  clean, never bulk-adopts it and never offers its Adopt button. */
export function candidateInReview(c: Pick<TransitionCandidate, "awaitingReview" | "pendingReview">): boolean {
  return !!c.awaitingReview || !!c.pendingReview;
}

/** Impact scan for one intake document against the existing register.
 *  Read-only. A slice that errors is recorded as `check_failed` — an
 *  unread register is never "no collision". */
export async function scanTransitionImpact(
  orgId: string,
  candidate: TransitionCandidate,
  intakeCollectionId: string,
): Promise<TransitionImpact> {
  const out: TransitionImpact = {
    tags: extractCandidateTags(candidate.number, candidate.title),
    matchedAssets: [],
    numberCollision: null,
    numberCollisions: [],
    overlapDocs: [],
    unverifiable: [],
    clean: false,
  };
  const failed = () => { if (!out.unverifiable.includes("check_failed")) out.unverifiable.push("check_failed"); };

  // Registry tie-ins.
  try {
    if (out.tags.length) {
      const { data: assets, error } = await supabase
        .from("assets")
        .select("id, tag, tag_normalized")
        .eq("org_id", orgId)
        .eq("archived", false)
        .in("tag_normalized", out.tags.map((t) => normalizeTag(t)));
      if (error) failed();
      out.matchedAssets = (((assets ?? []) as Array<{ id: string; tag: string }>))
        .map((a) => ({ id: a.id, tag: a.tag }));
    }
  } catch { failed(); }
  if (out.matchedAssets.length === 0) out.unverifiable.push("no_equipment");

  // Hard number collision (INTK-7): every candidate with a number is
  // checked — exact (case-insensitive) match, live status filtered in the
  // database, a deterministic order, and a library-root document (no
  // folder) counted like any other.
  const number = (candidate.number ?? "").trim();
  if (!number) {
    out.unverifiable.push("no_number");
  } else {
    try {
      const { rows, failed: readFailed } = await liveNumberMatches(orgId, number, candidate.docId, intakeCollectionId);
      if (readFailed) failed();
      out.numberCollisions = rows;
      out.numberCollision = rows[0] ?? null;
    } catch { failed(); }
  }

  // Equipment overlap: existing sheets already linked to the same assets —
  // the drawings most likely to need a tie-in revision.
  try {
    if (out.matchedAssets.length) {
      const tagByAsset = new Map(out.matchedAssets.map((a) => [a.id, a.tag]));
      const { data: links, error } = await supabase
        .from("document_assets")
        .select("document_id, asset_id")
        .in("asset_id", out.matchedAssets.map((a) => a.id))
        .neq("document_id", candidate.docId)
        .limit(200);
      if (error) failed();
      const byDoc = new Map<string, Set<string>>();
      for (const l of ((links ?? []) as Array<{ document_id: string; asset_id: string }>)) {
        const set = byDoc.get(l.document_id) ?? new Set<string>();
        set.add(tagByAsset.get(l.asset_id) ?? "tag");
        byDoc.set(l.document_id, set);
      }
      if (byDoc.size) {
        const { data: docs, error: dErr } = await supabase
          .from("documents")
          .select("id, document_number, title, name, rev, status, collection_id")
          .in("id", [...byDoc.keys()].slice(0, 50));
        if (dErr) failed();
        out.overlapDocs = (((docs ?? []) as Array<Record<string, unknown>>))
          .filter((d) => d.status !== "Superseded" && d.status !== "Archived"
            && String(d.collection_id ?? "") !== intakeCollectionId)
          .map((d) => ({
            id: String(d.id),
            label: String(d.document_number || d.title || d.name || "Document"),
            rev: (d.rev as string | null) ?? null,
            sharedTags: [...(byDoc.get(String(d.id)) ?? [])],
          }));
      }
    }
  } catch { failed(); }

  out.clean = !out.numberCollision && out.overlapDocs.length === 0 && out.unverifiable.length === 0;
  return out;
}

/** Live documents carrying exactly `number` (case-insensitive), outside the
 *  intake folder and other than `docId` — with `outsideLibraryId`, only
 *  those that live in ANOTHER library (or in none). The status filter runs
 *  in the database, the order is deterministic, and only exact matches are
 *  kept. (Two `.or()` groups are two PostgREST `or` parameters, ANDed.) */
async function liveNumberMatches(
  orgId: string, number: string, docId: string, intakeCollectionId: string, outsideLibraryId?: string,
): Promise<{ rows: NumberCollider[]; failed: boolean }> {
  let q = supabase
    .from("documents")
    .select("id, document_number, title, name, rev, status, library_id")
    .eq("org_id", orgId)
    .ilike("document_number", likeExact(number))
    .neq("id", docId)
    .or(`collection_id.is.null,collection_id.neq.${intakeCollectionId}`);
  if (outsideLibraryId) q = q.or(`library_id.is.null,library_id.neq.${outsideLibraryId}`);
  const { data, error } = await q
    .not("status", "in", RETIRED)
    .order("id", { ascending: true })
    .limit(25);
  const rows = (((data ?? []) as Array<Record<string, unknown>>))
    .filter((d) => sameNumber(d.document_number as string | null, number))
    .map((d) => ({
      id: String(d.id),
      label: String(d.document_number || d.title || d.name || "Document"),
      rev: (d.rev as string | null) ?? null,
      libraryId: (d.library_id as string | null) ?? null,
    }));
  return { rows, failed: !!error };
}

/** SAF-12 / INTK-3 — the same-numbered document that blocks adopting this
 *  sheet into `destLibraryId`, or null. Where the number alone is the
 *  destination's key (the default tuple), ANY live same-numbered document
 *  blocks. In a multi-part destination (number + sheet …) a same-numbered
 *  sibling INSIDE that library is expected — the full key decides there —
 *  but one in another library (or in none) is still two sources of truth
 *  for one number, and blocks. With no destination picked yet the number
 *  rule applies. */
export function blockingNumberCollision(
  impact: Pick<TransitionImpact, "numberCollision" | "numberCollisions"> | null | undefined,
  destLibraryId: string | null,
  numberDecides: boolean,
): NumberCollider | null {
  if (!impact?.numberCollision) return null;
  if (numberDecides || !destLibraryId) return impact.numberCollision;
  const all = impact.numberCollisions?.length ? impact.numberCollisions : [impact.numberCollision];
  return all.find((c) => c.libraryId !== destLibraryId) ?? null;
}

export interface AdoptInput {
  orgId: string;
  projectId: string;
  docId: string;
  /** Destination in the controlled tree. */
  libraryId: string;
  collectionId: string | null;
  /** Renumber to org convention on the way in (optional). */
  newNumber: string | null;
  /** Registry assets to link (usually the scan's matchedAssets). */
  linkAssets: Array<{ id: string; tag: string }>;
  actorId: string;
  actorEmail: string | null;
}

/** Move one intake document into the controlled register. Provenance chain
 *  (external versions, company stamp) is untouched — only location, number,
 *  uniqueness key, equipment links, and the project association change.
 *
 *  INTK-3 / SAF-12: the impact is RE-CHECKED here, at the click, never
 *  trusted from the panel's page-load scan: a sheet still in review or never
 *  approved is refused, a never-approved rejected one is refused (an
 *  APPROVED sheet whose newer proposal was rejected is adopted at its
 *  approved revision), and a number that collides with a live document is
 *  refused unless the sheet is renumbered to a number that is itself clear
 *  — where the number identifies a document in the destination library. In
 *  a library whose tuple is more than the number (a multi-sheet set) the
 *  full key decides between sheets INSIDE that library, but a live
 *  same-numbered document in any OTHER library still refuses the adoption
 *  (blockingNumberCollision). INTK-5: the uniqueness key is computed for the
 *  destination library, so the database's unique index sees the adopted
 *  sheet — and its refusal reaches the operator as a sentence. A tuple part
 *  the sheet does not carry (an intake sheet has no sheet field) leaves the
 *  key NULL, and `note` tells the operator what to set. */
export async function adoptDocument(input: AdoptInput): Promise<{ ok: boolean; error?: string; note?: string }> {
  const nowIso = new Date().toISOString();
  const { data: before, error: readErr } = await supabase
    .from("documents")
    .select("id, document_number, title, name, rev, status, metadata, library_id, collection_id, current_version_id, pending_version_id")
    .eq("id", input.docId)
    .eq("org_id", input.orgId)
    .maybeSingle();
  if (readErr) return { ok: false, error: "Couldn't read the sheet — try again." };
  if (!before) return { ok: false, error: "Document not found." };
  const label = String(before.document_number || before.title || before.name || "This sheet");
  if (!before.current_version_id) {
    // Never approved: a rejected sheet is refused outright; anything else is
    // still awaiting a decision.
    const { data: latest, error: lErr } = await supabase
      .from("document_versions").select("review_state")
      .eq("record_id", input.docId).not("intake_link_id", "is", null)
      .order("created_at", { ascending: false }).limit(1);
    if (lErr) return { ok: false, error: "Couldn't read the sheet's review history — try again." };
    if ((((latest ?? []) as Array<{ review_state: string | null }>)[0]?.review_state) === "rejected") {
      return { ok: false, error: `${label}'s latest submission was rejected — it can't be adopted into the controlled register.` };
    }
    return { ok: false, error: `${label} is still awaiting review — approve or reject its submission on the Intake tab before adopting it.` };
  }
  if (before.pending_version_id) {
    // A pending revision naming a RETIRED draft is not on the Intake tab —
    // say what clears it. (An unreadable draft keeps the ordinary refusal.)
    const { data: pv } = await supabase
      .from("document_versions").select("review_state, superseded_at")
      .eq("id", String(before.pending_version_id)).maybeSingle();
    if (pendingDraftRetired(pv as { review_state: string | null; superseded_at: string | null } | null)) {
      return { ok: false, error: `${label}: ${RETIRED_PENDING_NOTE}` };
    }
    return { ok: false, error: `${label} is still awaiting review — approve or reject its submission on the Intake tab before adopting it.` };
  }

  // INTK-5: the destination library's key tuple — read first, because it
  // decides what a same-numbered document means.
  const { data: lib, error: libErr } = await supabase
    .from("libraries").select("uniqueness_keys").eq("id", input.libraryId).eq("org_id", input.orgId).maybeSingle();
  if (libErr || !lib) return { ok: false, error: "Couldn't read the destination library — try again." };
  const keys = ((lib as { uniqueness_keys?: string[] | null }).uniqueness_keys ?? null);
  const numberDecides = numberIsTheKey(keys);

  const newNumber = (input.newNumber ?? "").trim() || null;
  const effectiveNumber = newNumber ?? ((before.document_number as string | null) ?? null);
  const impact = await scanTransitionImpact(input.orgId, {
    docId: input.docId, label, number: effectiveNumber,
    title: ((before.title ?? before.name) as string | null) ?? null,
    rev: (before.rev as string | null) ?? null, status: (before.status as string | null) ?? null,
    company: null, submittedAt: null,
  }, String(before.collection_id ?? "") || "00000000-0000-0000-0000-000000000000");
  if (impact.unverifiable.includes("check_failed")) {
    return { ok: false, error: `Couldn't confirm ${effectiveNumber ?? label} is free in the register — try again.` };
  }
  // In a multi-part destination the org-wide scan's window can be filled by
  // same-numbered siblings INSIDE the destination, so a live document in
  // another library is looked for on its own — never missed behind them.
  let collider = blockingNumberCollision(impact, input.libraryId, numberDecides);
  if (!collider && !numberDecides && effectiveNumber?.trim()) {
    const outside = await liveNumberMatches(
      input.orgId, effectiveNumber.trim(), input.docId,
      String(before.collection_id ?? "") || "00000000-0000-0000-0000-000000000000", input.libraryId,
    );
    if (outside.failed) return { ok: false, error: `Couldn't confirm ${effectiveNumber} is free in the other libraries — try again.` };
    collider = outside.rows[0] ?? null;
  }
  if (collider) {
    const elsewhere = !numberDecides ? " in another library" : "";
    return {
      ok: false,
      error: newNumber
        ? `${newNumber} is already the number of ${collider.label} (Rev ${collider.rev ?? "—"})${elsewhere} — pick a number that isn't in use.`
        : `${label} collides with ${collider.label} (Rev ${collider.rev ?? "—"})${elsewhere} — renumber it to a number that isn't in use, or resolve which one is the source of truth first.`,
    };
  }

  // The key — only when the sheet carries every part of the tuple. A
  // partial key ('p-100::' for a sheet with no sheet value) would refuse
  // sheet 2 of a same-numbered set as a duplicate of sheet 1.
  const { key: uniquenessKey, missing } = completeUniquenessKey({
    documentNumber: effectiveNumber,
    title: ((before.title ?? null) as string | null),
    rev: (before.rev as string | null) ?? null,
    status: (before.status as string | null) ?? null,
    customFields: (before.metadata as Record<string, unknown> | null) ?? null,
  }, keys);
  const tupleText = uniquenessTuple(keys).map(keyPartName).join(" + ");
  if (!numberDecides && uniquenessKey) {
    // The full key decides in a multi-part library: a live document in the
    // destination already carrying it is the collision.
    const { data: same, error: sameErr } = await supabase
      .from("documents").select("id, document_number, title, name, rev")
      .eq("library_id", input.libraryId).eq("uniqueness_key", uniquenessKey)
      .neq("id", input.docId).not("status", "in", RETIRED).limit(1);
    if (sameErr) return { ok: false, error: `Couldn't confirm ${label} is free in the destination library — try again.` };
    const hit = ((same ?? []) as Array<Record<string, unknown>>)[0];
    if (hit) {
      return { ok: false, error: `${String(hit.document_number || hit.title || hit.name || "A document")} (Rev ${(hit.rev as string | null) ?? "—"}) already carries the same ${tupleText} in that library — change the sheet's ${tupleText} before adopting it.` };
    }
  }
  // (The default tuple's only possible gap is a sheet with no number, which
  // the scan already reported as unverifiable.)
  const note = !numberDecides && missing.length > 0
    ? `${label} was adopted without a uniqueness key: that library identifies a document by ${tupleText}, and the sheet carries no ${missing.map(keyPartName).join(" or ")}. Set it in the document's properties — the key is written when they are saved.`
    : undefined;

  const auditDetails: Record<string, unknown> = {
    projectId: input.projectId,
    linkedAssetTags: input.linkAssets.map((a) => a.tag),
    unverifiable: impact.unverifiable,
    ...(missing.length > 0 ? { uniquenessKeyNotSet: missing } : {}),
  };
  const refused = (error: { message?: string | null; code?: string | null }): { ok: false; error: string } => {
    const code = String(error.code ?? "");
    if (code === "23505") {
      return {
        ok: false,
        error: numberDecides
          ? `Another live document in that library already carries ${effectiveNumber ?? "this number"} — renumber the sheet before adopting it.`
          : `Another live document in that library already carries the same ${tupleText} — change the sheet's ${tupleText} before adopting it.`,
      };
    }
    if (/requires Admin or Document Control|needs Admin or Document Control/i.test(error.message ?? "") || code === "42501") {
      return { ok: false, error: "Adopting into the controlled register moves the document between folders, which needs Admin or Document Control." };
    }
    // INTK-16: the database's own refusal (the cross-library number rule, a
    // sheet still in review, a destination outside the org) is a sentence.
    if (code === "23514" && error.message) return { ok: false, error: error.message };
    return { ok: false, error: `Couldn't adopt ${label} — try again, or ask Document Control.` };
  };

  // INTK-16 (20261141): the move of an INTAKE-BORN sheet runs IN THE
  // DATABASE — adopt_intake_document re-checks the caller's tier, computes
  // the destination's uniqueness key and writes the move and its
  // TRANSITION_IN audit row, and trg_documents_intake_adoption_guard applies
  // the cross-library number rule (SAF-12) to it and to any direct update of
  // an intake sheet's library, folder or number (or its revival outside an
  // intake folder) — "intake-born" is the stored authored_by_link_id, which
  // no signed-in session can clear or stamp (trg_documents_authorship_fixed).
  // The checks above stay for the operator's sentences; the database is the
  // authority. A document in
  // the intake folder that the door did NOT create (a sheet filed there by
  // hand, an intake sheet older than 20261104's authorship backfill) is not
  // the function's — and not the guard's: it takes the direct update, as
  // before (the move guard and the unique index still bind). Before 20261141
  // the function does not exist and every move is the direct update.
  const born = await intakeBorn(input.docId, input.orgId);
  if (born === "unreadable") return { ok: false, error: "Couldn't read the sheet — try again." };
  let viaDatabase = false;
  if (born !== false) {
    const rpc = await supabase.rpc("adopt_intake_document", {
      p_doc: input.docId, p_library: input.libraryId, p_collection: input.collectionId,
      p_new_number: newNumber, p_details: auditDetails,
    });
    if (rpc.error && !missingAdoptFunction(rpc.error)) return refused(rpc.error);
    viaDatabase = !rpc.error;
  }
  if (!viaDatabase) {
    const patch: Record<string, unknown> = {
      library_id: input.libraryId,
      collection_id: input.collectionId,
      uniqueness_key: uniquenessKey,
      updated_at: nowIso,
    };
    if (newNumber) patch.document_number = newNumber;
    const { data: moved, error } = await supabase.from("documents").update(patch).eq("id", input.docId).select("id");
    if (error) return refused(error);
    if (!moved || (moved as unknown[]).length === 0) {
      return { ok: false, error: `${label} was not adopted — you may not have permission to move it. Ask Document Control.` };
    }
  }

  // Keep the project tracking the document after it leaves the intake folder.
  await supabase.from("project_documents")
    .upsert(
      { org_id: input.orgId, project_id: input.projectId, document_id: input.docId, source: "manual", last_seen_at: nowIso },
      { onConflict: "project_id,document_id", ignoreDuplicates: false },
    )
    .then(() => undefined, () => undefined);

  // Link matched equipment so where-used / impact sees the new sheet.
  if (input.linkAssets.length) {
    await supabase.from("document_assets")
      .upsert(
        input.linkAssets.map((a) => ({
          org_id: input.orgId, document_id: input.docId, asset_id: a.id,
          tag_text: a.tag, source: "manual",
        })),
        { onConflict: "document_id,asset_id", ignoreDuplicates: true },
      )
      .then(() => undefined, () => undefined);
  }

  // adopt_intake_document wrote the audit row with the move (the same
  // details, its before / after its own); the pre-20261141 path writes it here.
  if (!viaDatabase) {
    await supabase.from("audit_logs").insert({
      action: "TRANSITION_IN",
      resource_type: "document", resource_id: input.docId,
      org_id: input.orgId, user_id: input.actorId, user_email: input.actorEmail,
      details: {
        ...auditDetails,
        before: { number: before.document_number, libraryId: before.library_id, collectionId: before.collection_id },
        after: { number: newNumber ?? before.document_number, libraryId: input.libraryId, collectionId: input.collectionId },
      },
    }).then(() => undefined, () => undefined);
  }

  return note ? { ok: true, note } : { ok: true };
}

/** INTK-16: did the door create this document (documents.authored_by_link_id,
 *  20261104)? `null` when the column is not there yet (the function cannot
 *  be either — 20261141 requires 20261104), "unreadable" on any other error. */
async function intakeBorn(docId: string, orgId: string): Promise<boolean | null | "unreadable"> {
  const { data, error } = await supabase
    .from("documents").select("authored_by_link_id").eq("id", docId).eq("org_id", orgId).maybeSingle();
  if (error) {
    const msg = `${error.message ?? ""} ${(error as { details?: string | null }).details ?? ""}`;
    const missing = /^(42703|PGRST204)$/.test(String(error.code ?? "")) || /authored_by_link_id.*(does not exist|could not find)|could not find.*authored_by_link_id/i.test(msg);
    return missing ? null : "unreadable";
  }
  return ((data as { authored_by_link_id?: string | null } | null)?.authored_by_link_id ?? null) != null;
}

/** adopt_intake_document is not in the database yet (before 20261141). */
function missingAdoptFunction(e: { message?: string | null; code?: string | null }): boolean {
  return /^(PGRST202|42883)$/.test(String(e.code ?? "")) || /could not find the function|function .*adopt_intake_document.* does not exist/i.test(e.message ?? "");
}

/** A uniqueness-tuple part as the operator reads it. */
function keyPartName(k: string): string {
  return k === "documentNumber" ? "number" : k;
}

export interface FlagCollisionInput {
  orgId: string;
  projectId: string;
  candidate: TransitionCandidate;
  impact: TransitionImpact;
  actorId: string;
  actorEmail: string | null;
  actorRole: string | null;
}

/** Turn a collision/overlap into drafting work: a Revision ticket lands in
 *  the assignment queue pre-loaded with both sides of the conflict. If the
 *  sheet came through an intake link, the link id rides in metadata so the
 *  contractor's portal can request redlines against the ticket. */
export async function flagCollisionToDrafting(
  input: FlagCollisionInput,
): Promise<{ ok: boolean; ticketNumber?: string; error?: string }> {
  const { orgId, projectId, candidate, impact } = input;
  const nowIso = new Date().toISOString();

  // Which intake link authored this sheet (if any) — lets the contractor's
  // portal see the redline request.
  let intakeLinkId: string | null = null;
  try {
    const { data: v } = await supabase
      .from("document_versions")
      .select("intake_link_id")
      .eq("record_id", candidate.docId)
      .not("intake_link_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    intakeLinkId = ((v?.[0]?.intake_link_id as string | null) ?? null);
  } catch { /* optional */ }

  const lines: string[] = [
    `Intake sheet "${candidate.label}" (Rev ${candidate.rev ?? "—"}${candidate.company ? `, submitted by ${candidate.company}` : ""}) conflicts with the existing register:`,
    "",
  ];
  if (impact.numberCollision) {
    lines.push(`• NUMBER COLLISION — ${impact.numberCollision.label} (Rev ${impact.numberCollision.rev ?? "—"}) already carries this number. Decide the single source of truth (adopt-and-supersede, renumber, or reject the intake sheet).`);
  }
  for (const o of impact.overlapDocs) {
    lines.push(`• OVERLAP — ${o.label} (Rev ${o.rev ?? "—"}) shares equipment ${o.sharedTags.join(", ")}; it likely needs a tie-in revision.`);
  }
  lines.push("", "Resolution paths: draft the tie-in on our border, or request redline markups from the submitting company through their intake portal (attachments land on this ticket).");

  try {
    const ticketNumber = await generateTicketNumber(orgId);
    // LIFE-9: the same required-field set the request form enforces — the
    // unit comes from the intake sheet's own metadata (best-effort read).
    let unit = "";
    try {
      const { data: sheet } = await supabase.from("documents").select("metadata").eq("id", candidate.docId).eq("org_id", orgId).maybeSingle();
      unit = unitOfDocumentMetadata((sheet as { metadata?: Record<string, unknown> | null } | null)?.metadata) ?? "";
    } catch { /* unit stays blank; the ticket is still created */ }
    const { data: row, error } = await supabase.from("tickets").insert({
      org_id: orgId,
      ticket_id: ticketNumber,
      title: `Intake collision: ${candidate.label}`,
      description: lines.join("\n"),
      request_type: "Revision",
      status: "PENDING_ASSIGNMENT",
      priority: impact.numberCollision ? 1 : 2,
      unit,
      // Same SLA clock a request-form ticket gets, and the flagger follows it.
      target_completion_at: defaultSlaTargetDate("Revision"),
      watchers: [input.actorId],
      requester_id: input.actorId,
      requester_name: input.actorEmail?.split("@")[0] || "User",
      requester_email: input.actorEmail,
      requester_role: input.actorRole,
      history: [{
        action: "Created from transition-in impact scan",
        user: input.actorEmail, date: nowIso,
        details: `Project intake sheet: ${candidate.label}`,
      }],
      metadata: {
        source_document: buildSourceDocumentRef({ id: candidate.docId, documentNumber: candidate.number, title: candidate.title, rev: candidate.rev }),
        intake_collision: {
          projectId,
          intakeLinkId,
          numberCollisionDocId: impact.numberCollision?.id ?? null,
          overlaps: impact.overlapDocs.map((o) => ({ id: o.id, label: o.label, sharedTags: o.sharedTags })),
          flaggedAt: nowIso,
        },
      },
    }).select("id").single();
    if (error || !row) return { ok: false, error: error?.message ?? "Couldn't create the ticket." };

    // Same routing as any new drafting request.
    void (async () => {
      try {
        const recipients = await resolveTicketRecipients(orgId, "PENDING_ASSIGNMENT", input.actorId);
        if (!recipients.length) return;
        await emit({
          orgId,
          category: "assignment",
          kind: "request_pending_approval",
          title: `Intake collision flagged: ${candidate.label}`,
          body: impact.numberCollision
            ? "A submitted sheet collides with an existing document number — needs a drafter and a source-of-truth decision."
            : "A submitted sheet overlaps existing drawings — tie-in revision work to assign.",
          link: `/requests/${row.id}`,
          resource: { type: "ticket", id: String(row.id) },
          actorUserId: input.actorId,
          actorName: input.actorEmail?.split("@")[0],
          audience: { involved: recipients.map((m) => m.uid) },
        });
      } catch { /* non-blocking */ }
    })();

    await supabase.from("audit_logs").insert({
      action: "INTAKE_COLLISION_FLAGGED",
      resource_type: "document", resource_id: candidate.docId,
      org_id: orgId, user_id: input.actorId, user_email: input.actorEmail,
      details: {
        projectId, ticketNumber, ticketRef: String(row.id), intakeLinkId,
        numberCollision: impact.numberCollision?.label ?? null,
        overlaps: impact.overlapDocs.map((o) => o.label),
      },
    }).then(() => undefined, () => undefined);

    return { ok: true, ticketNumber };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
