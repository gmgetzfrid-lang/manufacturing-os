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
import { computeUniquenessKey } from "@/lib/uniqueness";

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
  /** A submission sits in the review queue right now. */
  pendingReview?: boolean;
}

/** Why a sheet's collision check could not say "clean" (INTK-7). */
export type UnverifiableReason = "no_number" | "no_equipment" | "check_failed";

export interface TransitionImpact {
  /** Candidate equipment tags found on the document's number/title. */
  tags: string[];
  /** Tags that resolve to real assets in the registry (tie-in points). */
  matchedAssets: Array<{ id: string; tag: string }>;
  /** Existing non-superseded document with the same number — hard collision. */
  numberCollision: { id: string; label: string; rev: string | null } | null;
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
 *  sheet whose latest intake submission was REJECTED is not a candidate
 *  (the organisation refused it); one with no approved revision yet is
 *  listed, marked, and blocked from adoption. */
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
    .filter((d) => latestState.get(String(d.id)) !== "rejected")
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
    }));
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
      const { data: dup, error } = await supabase
        .from("documents")
        .select("id, document_number, title, name, rev, status")
        .eq("org_id", orgId)
        .ilike("document_number", likeExact(number))
        .neq("id", candidate.docId)
        .or(`collection_id.is.null,collection_id.neq.${intakeCollectionId}`)
        .not("status", "in", RETIRED)
        .order("id", { ascending: true })
        .limit(25);
      if (error) failed();
      const live = (((dup ?? []) as Array<Record<string, unknown>>))
        .find((d) => sameNumber(d.document_number as string | null, number));
      if (live) {
        out.numberCollision = {
          id: String(live.id),
          label: String(live.document_number || live.title || live.name || "Document"),
          rev: (live.rev as string | null) ?? null,
        };
      }
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
 *  approved is refused, a rejected one is refused, and a number that
 *  collides with a live document is refused unless the sheet is renumbered
 *  to a number that is itself clear. INTK-5: the uniqueness key is computed
 *  for the destination library, so the database's unique index sees the
 *  adopted sheet — and its refusal reaches the operator as a sentence. */
export async function adoptDocument(input: AdoptInput): Promise<{ ok: boolean; error?: string }> {
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
  if (before.pending_version_id || !before.current_version_id) {
    return { ok: false, error: `${label} is still awaiting review — approve or reject its submission on the Intake tab before adopting it.` };
  }
  {
    const { data: latest, error: lErr } = await supabase
      .from("document_versions").select("review_state")
      .eq("record_id", input.docId).not("intake_link_id", "is", null)
      .order("created_at", { ascending: false }).limit(1);
    if (lErr) return { ok: false, error: "Couldn't read the sheet's review history — try again." };
    if ((((latest ?? []) as Array<{ review_state: string | null }>)[0]?.review_state) === "rejected") {
      return { ok: false, error: `${label}'s latest submission was rejected — it can't be adopted into the controlled register.` };
    }
  }

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
  if (impact.numberCollision) {
    return {
      ok: false,
      error: newNumber
        ? `${newNumber} is already the number of ${impact.numberCollision.label} (Rev ${impact.numberCollision.rev ?? "—"}) — pick a number that isn't in use.`
        : `${label} collides with ${impact.numberCollision.label} (Rev ${impact.numberCollision.rev ?? "—"}) — renumber it to a number that isn't in use, or resolve which one is the source of truth first.`,
    };
  }

  // INTK-5: the destination library's key tuple.
  const { data: lib, error: libErr } = await supabase
    .from("libraries").select("uniqueness_keys").eq("id", input.libraryId).eq("org_id", input.orgId).maybeSingle();
  if (libErr || !lib) return { ok: false, error: "Couldn't read the destination library — try again." };
  const uniquenessKey = computeUniquenessKey({
    documentNumber: effectiveNumber,
    title: ((before.title ?? null) as string | null),
    rev: (before.rev as string | null) ?? null,
    status: (before.status as string | null) ?? null,
    customFields: (before.metadata as Record<string, unknown> | null) ?? null,
  }, ((lib as { uniqueness_keys?: string[] | null }).uniqueness_keys ?? null));

  const patch: Record<string, unknown> = {
    library_id: input.libraryId,
    collection_id: input.collectionId,
    uniqueness_key: uniquenessKey,
    updated_at: nowIso,
  };
  if (newNumber) patch.document_number = newNumber;
  const { data: moved, error } = await supabase.from("documents").update(patch).eq("id", input.docId).select("id");
  if (error) {
    if (String(error.code ?? "") === "23505") {
      return { ok: false, error: `Another live document in that library already carries ${effectiveNumber ?? "this number"} — renumber the sheet before adopting it.` };
    }
    if (/requires Admin or Document Control/i.test(error.message ?? "")) {
      return { ok: false, error: "Adopting into the controlled register moves the document between folders, which needs Admin or Document Control." };
    }
    return { ok: false, error: `Couldn't adopt ${label} — try again, or ask Document Control.` };
  }
  if (!moved || (moved as unknown[]).length === 0) {
    return { ok: false, error: `${label} was not adopted — you may not have permission to move it. Ask Document Control.` };
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

  await supabase.from("audit_logs").insert({
    action: "TRANSITION_IN",
    resource_type: "document", resource_id: input.docId,
    org_id: input.orgId, user_id: input.actorId, user_email: input.actorEmail,
    details: {
      projectId: input.projectId,
      before: { number: before.document_number, libraryId: before.library_id, collectionId: before.collection_id },
      after: { number: newNumber ?? before.document_number, libraryId: input.libraryId, collectionId: input.collectionId },
      linkedAssetTags: input.linkAssets.map((a) => a.tag),
      unverifiable: impact.unverifiable,
    },
  }).then(() => undefined, () => undefined);

  return { ok: true };
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
