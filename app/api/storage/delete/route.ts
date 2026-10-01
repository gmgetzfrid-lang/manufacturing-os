import { NextRequest, NextResponse } from "next/server";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { assertSafeStorageKey } from "@/lib/storageKey";
import {
  retentionStatusFor, resolveEffectiveRetentionPolicy, computeRetentionUntil, retentionBasisISO,
} from "@/lib/retentionPolicy";
import type { RetentionPolicy } from "@/types/schema";

// Deleting a stored object destroys the bytes of a controlled record and is
// irreversible. This route is held to the same bar as /api/admin/purge:
//   - the caller must be a CONTROLLER (Admin/DocCtrl) of the key's org, read
//     additively (role OR roles[]) so a ['Manager','DocCtrl'] member is not
//     wrongly refused (the headline-only read is SURF-10);
//   - the key is traversal-checked (assertSafeStorageKey), as the download
//     route already does;
//   - a key belonging to a document under legal hold, an unreleased hold, or
//     inside its EFFECTIVE retention period is refused, FAIL CLOSED — the opposite of
//     the download route's fail-open, because destruction cannot be undone by
//     a later correct read. "Belonging" means named by any document_versions
//     row as its rendered file (file_url) OR its native source
//     (source_file_key);
//   - every deletion writes an audit row.
// (Audit finding SURF-2 / document-control RET-2 / intelligence DACL-2.)

const CONTROLLER_ROLES = new Set(["Admin", "DocCtrl"]);

/** The owning document's columns the hold and retention refusals read. */
interface OwnerDoc {
  legal_hold?: boolean | null;
  retention_until?: string | null;
  disposition_state?: string | null;
  retention_policy?: RetentionPolicy | null;
  collection_id?: string | null;
  library_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  effective_date?: string | null;
}
const OWNER_DOC_COLUMNS =
  "legal_hold, retention_until, disposition_state, retention_policy, collection_id, library_id, created_at, updated_at, effective_date";

/** The only retention date shape the refusal compares or quotes: a four-digit
 *  year. computeRetentionUntil ends in toISOString(), which past year 9999
 *  gives an extended-year string ("+012025-01-01"). That string sorts before
 *  every ISO date (so a plain `>` reads it as run) and the DATE column refuses
 *  it (so the row stays unclocked); it must read as a date that cannot be
 *  computed, which refuses. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A container's retention policy, read CHECKED: a failed read throws (the
 *  caller refuses 503) rather than resolving to "no policy" and clearing a
 *  record that its folder or library still retains. */
async function containerRetentionPolicy(table: "collections" | "libraries", id: string | null | undefined): Promise<RetentionPolicy | null> {
  if (!id) return null;
  const { data, error } = await supabaseAdmin.from(table).select("retention_policy").eq("id", id).maybeSingle();
  if (error) throw error;
  return ((data as { retention_policy?: RetentionPolicy | null } | null)?.retention_policy) ?? null;
}

export async function DELETE(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { path } = await req.json() as { path: string };
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  // Refuse traversal / control-byte keys before the org-prefix gate reasons
  // about them (mirrors download-url; closes the key that authorizes against
  // one prefix while naming another).
  try { assertSafeStorageKey(path); } catch { return NextResponse.json({ error: "Invalid path" }, { status: 400 }); }

  // Require the orgs/<uuid>/ prefix. A non-org-prefixed key previously skipped
  // authorization entirely — every object the app mints is orgs/<uuid>/…, so
  // nothing legitimate depended on that branch.
  const orgMatch = path.match(/^orgs\/([0-9a-fA-F-]{36})\//);
  if (!orgMatch) {
    return NextResponse.json({ error: "Only org-scoped keys may be deleted" }, { status: 403 });
  }
  const orgId = orgMatch[1];

  // Controller authority for the key's org, read additively.
  const { data: member } = await supabaseAdmin
    .from("org_members")
    .select("role, roles")
    .eq("org_id", orgId)
    .eq("uid", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!member) {
    return NextResponse.json({ error: "Not a member of this workspace" }, { status: 403 });
  }
  const held = new Set<string>([
    (member.role as string) || "",
    ...(((member.roles as string[] | null) ?? [])),
  ]);
  const isController = [...held].some((r) => CONTROLLER_ROLES.has(r));
  if (!isController) {
    return NextResponse.json({ error: "Deleting stored files requires Admin or Document Control." }, { status: 403 });
  }

  // Hold and retention refusal, FAIL CLOSED. Resolve the key to EVERY
  // document that names it — as a revision's rendered file (file_url) or its
  // native source (source_file_key: the DWG lib/revisions.ts stores under the
  // same library prefix) — and refuse if any of them is under legal hold, has
  // an unreleased document_holds row, or is inside its retention period. Two
  // exact-equality lookups, never a PostgREST .or() string:
  // assertSafeStorageKey admits commas and parentheses, which would break or
  // inject an .or() filter (upload-url's pattern). Any lookup error refuses —
  // never destroy bytes we cannot clear. (Intelligence DACL-2 criterion 1:
  // the file_url-only lookup let a held document's native source through.)
  let documentId: string | null = null;
  let versionId: string | null = null;
  try {
    // document id → the first version naming the key (for the custody row)
    const owners = new Map<string, string | null>();
    for (const col of ["file_url", "source_file_key"] as const) {
      const { data: vers, error: verErr } = await supabaseAdmin
        .from("document_versions")
        .select("id, record_id")
        .eq(col, path);
      if (verErr) throw verErr;
      for (const v of (vers ?? []) as Array<{ id?: string | null; record_id?: string | null }>) {
        if (v.record_id && !owners.has(v.record_id)) owners.set(v.record_id, v.id ?? null);
      }
    }
    for (const [ownerId, ownerVersionId] of owners) {
      if (documentId === null) {
        documentId = ownerId;
        versionId = ownerVersionId;
      }
      const [{ data: doc, error: docErr }, { data: holds, error: holdErr }] = await Promise.all([
        supabaseAdmin.from("documents").select(OWNER_DOC_COLUMNS).eq("id", ownerId).maybeSingle(),
        supabaseAdmin.from("document_holds").select("id").eq("document_id", ownerId).is("released_at", null).limit(1),
      ]);
      if (docErr) throw docErr;
      if (holdErr) throw holdErr;
      const row = doc as OwnerDoc | null;
      if (row?.legal_hold) {
        return NextResponse.json({ error: "This document is under legal hold; its files cannot be deleted." }, { status: 423 });
      }
      if ((holds ?? []).length > 0) {
        return NextResponse.json({ error: "This document has an active hold; release it before deleting files." }, { status: 423 });
      }
      // Retention, judged TWO ways and refused if EITHER says it is in force:
      //   (1) the materialized retention_until / disposition_state, through
      //       the one shared verdict (the register's and the pill's) —
      //       "active" is a period that has not run, and an unparseable date
      //       also reads as active;
      //   (2) the EFFECTIVE retention, resolved now from the document → folder
      //       → library policy by P9's pure resolver (the rules
      //       recomputeRetention and reclockRetentionForDocs clock with). The
      //       materialized row is written best-effort elsewhere — a re-clock
      //       can be refused or never reach a row — so a row that was never
      //       clocked, or carries a stale earlier date under an extended
      //       policy, must not read as clear. In force means the computed date
      //       is after today (the re-clock's "active"; a date that runs out
      //       today is eligible there and clear here); a policy in force whose
      //       date cannot be computed (no readable basis date, or a year past
      //       9999) refuses too.
      // A DISPOSED record is not exempt. disposeDocument checks no
      // eligibility (only the Dispose button's client-side gate does), so a
      // record can be disposed before its retention ran — and then bytes the
      // route refuses directly would be one click away. disposeDocument
      // leaves retention_until, created_at and effective_date as they were but
      // rewrites updated_at, so a disposed record is judged on (1) its stored
      // retention_until alone (its disposition_state no longer reads as
      // clear), and on (2) from its own basis only when the policy clocks
      // from one disposal cannot move: "created", or "effective" with an
      // effective_date. The issued / superseded / effective-without-a-date
      // bases clock from updated_at || created_at, and disposal resets
      // updated_at to today; every write path stamps updated_at with the time
      // of the write, so before disposal that basis was never earlier than
      // created_at. For those, (2) clocks from created_at: a LOWER BOUND on
      // the true date, so a record whose bound is still ahead (or cannot be
      // computed) is certainly in force and refuses.
      // Either container read failing throws → 503.
      if (row) {
        const disposed = row.disposition_state === "disposed";
        const storedActive = retentionStatusFor({
          retentionUntil: row.retention_until ?? null,
          dispositionState: disposed ? null : row.disposition_state ?? null,
        }) === "active";
        const [folderPolicy, libPolicy] = await Promise.all([
          containerRetentionPolicy("collections", row.collection_id),
          containerRetentionPolicy("libraries", row.library_id),
        ]);
        const policy = resolveEffectiveRetentionPolicy(row.retention_policy ?? null, folderPolicy, libPolicy);
        const basis = policy?.basis ?? "created";
        const basisFixed = basis === "created" || (basis === "effective" && !!row.effective_date);
        // true: (2) is a lower bound clocked from created_at (see above).
        const lowerBound = disposed && !basisFixed;
        const computed = policy
          ? computeRetentionUntil(
              lowerBound
                ? row.created_at ?? null
                : retentionBasisISO(policy, {
                    created_at: row.created_at ?? null,
                    updated_at: row.updated_at ?? null,
                    effective_date: row.effective_date ?? null,
                  }),
              policy,
            )
          : null;
        const effectiveUntil = computed !== null && ISO_DATE.test(computed) ? computed : null;
        const today = new Date().toISOString().slice(0, 10);
        const unclockable = !!policy?.years && effectiveUntil === null;
        const effectiveActive = unclockable || (effectiveUntil !== null && effectiveUntil > today);
        if (storedActive || effectiveActive) {
          // A policy in force with no computable end quotes no date: an
          // earlier stored date would read as the day the record becomes
          // deletable, which it never does. Otherwise name the later of the
          // two dates in force (an unreadable stored date is refused but not
          // quoted), and a lower bound as one.
          if (unclockable) {
            return NextResponse.json(
              { error: "This document is under a retention policy with no computable end date; its files cannot be deleted." },
              { status: 423 },
            );
          }
          const storedDate = storedActive && row.retention_until ? String(row.retention_until).slice(0, 10) : null;
          const stored = storedDate && ISO_DATE.test(storedDate) ? storedDate : null;
          const effective = effectiveActive ? effectiveUntil : null;
          const until = effective && (!stored || effective > stored)
            ? ` until ${lowerBound ? "at least " : ""}${effective}`
            : stored ? ` until ${stored}` : "";
          return NextResponse.json(
            { error: `This document is under retention${until}; its files cannot be deleted before the retention period ends.` },
            { status: 423 },
          );
        }
      }
    }
  } catch {
    return NextResponse.json({ error: "Could not verify hold or retention status; deletion refused." }, { status: 503 });
  }

  // Chain of custody BEFORE destruction, and FAIL CLOSED on it — the same
  // posture as the hold check above. Written after the delete, a DB hiccup in
  // that gap would leave bytes destroyed with no custody record and a 200
  // (postgrest-js resolves failures into { error } rather than throwing, so a
  // try/catch alone would be dead code and the error invisible). Refusing the
  // delete when the record cannot be written is recoverable; the reverse is
  // not.
  const { data: auditRow, error: auditErr } = await supabaseAdmin
    .from("audit_logs")
    .insert({
      action: "STORAGE_OBJECT_DELETE",
      resource_type: "storage_object",
      resource_id: documentId ?? path,
      org_id: orgId,
      user_id: user.id,
      user_email: user.email ?? null,
      details: { path, documentId, versionId },
    })
    .select("id")
    .maybeSingle();
  if (auditErr) {
    console.error("storage/delete: audit insert failed; deletion refused", { path, orgId, error: auditErr.message });
    return NextResponse.json({ error: "Could not record the deletion; nothing was deleted." }, { status: 503 });
  }

  try {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: path }));
  } catch (e) {
    // The object may still exist — mark the custody row so it never reads as
    // a completed destruction. Best-effort: the failure response stands
    // either way.
    if (auditRow?.id) {
      await supabaseAdmin
        .from("audit_logs")
        .update({ details: { path, documentId, versionId, failed: true, error: (e as Error).message } })
        .eq("id", auditRow.id);
    }
    return NextResponse.json({ error: "Storage deletion failed; the object was not removed." }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
