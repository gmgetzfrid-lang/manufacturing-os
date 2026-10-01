// lib/downloads.ts
// Centralized download / print path for documents.
//
// Decision rules:
//   - User holds an active checkout on the document  -> CONTROLLED copy (raw PDF)
//   - Otherwise                                       -> UNCONTROLLED copy (stamped)
//   - Never controlled, whoever asks (copyControlState): a non-current
//     revision (REV-1), a copy with markups baked in (PKG-10), a document
//     under an active hold or whose hold state cannot be read (HLD-1).
//
// Every download is logged to `download_audits`, and a refused log write is
// reported to the caller, never swallowed (EGR-6). Stamping rasterizes a
// rotated watermark + footer onto every page via pdf-lib (see lib/stamping.ts).

import { supabase } from "@/lib/supabase";
import { downloadStampedPdf, stampPdf } from "@/lib/stamping";
import { recordIntent } from "@/lib/intents";
import { publicOrigin } from "@/lib/publicOrigin";
import { decideHoldGate, readActiveHolds, type HoldGateDecision } from "@/lib/holdGate";
import type { DocumentRecord } from "@/types/schema";

export type ControlState = "controlled" | "uncontrolled";

export type DownloadContext = {
  doc: DocumentRecord;
  versionId?: string;
  /** Revision label of the BYTES being served (e.g. "2"). When the copy is of
   *  an older revision this differs from doc.rev (the current label), and the
   *  stamp/filename/QR must describe THIS, not the document's current rev
   *  (REV-1). Falls back to doc.rev only when the caller serves the current
   *  version and does not pass it. */
  versionRev?: string | null;
  /** True when the served bytes ARE the document's current version. False for
   *  a copy taken from version history. A non-current copy is never a
   *  controlled (unstamped) master, regardless of who holds the checkout. */
  versionIsCurrent?: boolean;
  fileUrl: string;            // resolved presigned URL or blob URL of the source PDF
  /** PKG-10: the bytes carry baked-in markups (redlines) — a copy that is
   *  not the controlled master, so it is always stamped UNCONTROLLED, the
   *  checkout holder's included. */
  markedUp?: boolean;
  filename?: string;
  userId: string;
  userEmail?: string | null;
  userLabel?: string | null;  // display name fallback
  expiresInHours?: number;    // default 24
};

/** The revision label to stamp/name a copy with: the served version's label
 *  when known, else the document's current label. */
function servedRev(ctx: { doc: DocumentRecord; versionRev?: string | null }): string | null {
  return ctx.versionRev ?? ctx.doc.rev ?? null;
}

export function determineControlState(
  doc: DocumentRecord,
  userId: string,
  versionIsCurrent = true,
): ControlState {
  // A controlled COPY is only available when the requester is the active
  // checkout holder AND the bytes are the current controlled master. A copy
  // of an OLD revision is never controlled, even for the checkout holder —
  // otherwise a superseded drawing walks to the field with no UNCONTROLLED
  // mark at all (REV-1).
  // NOTE: this is the COPY rule (download/print/markup). For the on-screen
  // viewer badge, use viewerStatusBadge instead — see below.
  if (!versionIsCurrent) return "uncontrolled";
  if (doc.checkedOutBy && doc.checkedOutBy === userId) return "controlled";
  return "uncontrolled";
}

/** The copy rule as a download / print applies it: determineControlState,
 *  plus the two facts it cannot see synchronously — a copy with markups baked
 *  in is never the controlled master (PKG-10), and neither is a copy of a
 *  document under an active hold, or one whose hold state could not be read
 *  (HLD-1: such a copy is stamped with the hold, never passed through raw). */
export function copyControlState(
  ctx: Pick<DownloadContext, "doc" | "userId" | "versionIsCurrent" | "markedUp">,
  hold?: Pick<HoldGateDecision, "blocked"> | null,
): ControlState {
  if (ctx.markedUp) return "uncontrolled";
  if (hold?.blocked) return "uncontrolled";
  return determineControlState(ctx.doc, ctx.userId, ctx.versionIsCurrent);
}

/** HLD-1 (the download / print / book limb): the document's hold state at
 *  the moment a copy is taken, through THE hold gate (lib/holdGate.ts) — an
 *  unreadable hold state is a hold (fail closed). Never throws. */
export async function readCopyHoldState(documentId: string | null | undefined): Promise<HoldGateDecision> {
  if (!documentId) return { blocked: false, holds: [] };
  return decideHoldGate(await readActiveHolds(documentId), "taking a copy");
}

/** HLD-1: the hold line a copy of a held document carries in its footer —
 *  the paper says work from it is stopped, rather than the copy leaving
 *  silently. Null when the document is not held. */
export function holdFooterLine(hold: Pick<HoldGateDecision, "blocked"> & { holds?: Array<{ reason: string }>; unreadable?: boolean } | null | undefined): string | null {
  if (!hold?.blocked) return null;
  if (hold.unreadable) {
    return "HOLD STATUS UNKNOWN at time of issue — treat this document as ON HOLD until Document Control confirms otherwise.";
  }
  const reasons = (hold.holds ?? []).map((h) => h.reason).filter(Boolean);
  return `ON HOLD at time of issue${reasons.length ? ` (${[...new Set(reasons)].join(", ")})` : ""} — work from this document is stopped until Document Control releases the hold.`;
}

/** The diagonal watermark of a stamped copy: a held document's copy says
 *  ON HOLD (HLD-1), an old revision's says SUPERSEDED (PKG-10 done-when 2),
 *  anything else the review watermark. */
export function copyWatermark(
  ctx: Pick<DownloadContext, "versionIsCurrent">,
  hold?: Pick<HoldGateDecision, "blocked"> & { unreadable?: boolean } | null,
): string {
  if (hold?.blocked) return hold.unreadable ? "UNCONTROLLED — HOLD STATUS UNKNOWN" : "ON HOLD — DO NOT USE";
  if (ctx.versionIsCurrent === false) return "SUPERSEDED — NOT CURRENT";
  return "UNCONTROLLED — FOR REVIEW ONLY";
}

export type ViewBadgeTone = "controlled" | "caution" | "danger" | "muted";

/**
 * The badge shown while VIEWING a document — distinct from the copy-control state
 * used for downloads/prints. Viewing the LIVE current version of an issued doc IS
 * the controlled master (always current), so it should read "Controlled", not
 * "Uncontrolled". The uncontrolled-copy warning belongs only on a copy you take
 * (download / print / markup). Pass viewingCurrentVersion=false when showing an
 * older/superseded revision (e.g. from version history).
 */
export function viewerStatusBadge(
  doc: { status?: string | null; rev?: string | null },
  viewingCurrentVersion = true,
): { label: string; tone: ViewBadgeTone } {
  if (!viewingCurrentVersion) return { label: "Old revision — not current", tone: "caution" };
  switch (doc.status) {
    case "Issued":
    case "Locked":
      return { label: doc.rev ? `Controlled · Rev ${doc.rev}` : "Controlled", tone: "controlled" };
    case "Draft":
      return { label: "Draft — not issued", tone: "caution" };
    case "Superseded":
      return { label: "Superseded — not current", tone: "danger" };
    case "Void":
      return { label: "Void", tone: "danger" };
    case "Archived":
      return { label: "Archived", tone: "muted" };
    default:
      return { label: doc.status || "Uncontrolled", tone: "caution" };
  }
}

function defaultFilename(ctx: DownloadContext, suffix: string): string {
  const stem =
    (ctx.doc.documentNumber || ctx.doc.title || ctx.doc.name || "document").replace(/[^\w.\-]+/g, "_");
  const label = servedRev(ctx);
  const rev = label ? `_Rev${label}` : "";
  return `${stem}${rev}${suffix}.pdf`;
}

/** The stamped footer notice: rev-at-issue + (when someone else is mid-change)
 *  an active-change warning, so a stale print on a desk announces itself. The
 *  rev printed is the SERVED version's (REV-1), and a copy of an older
 *  revision says so outright. A held document's copy LEADS with the hold
 *  (HLD-1) — pass the hold decision read when the copy was taken. */
export function buildFooterNotice(
  ctx: DownloadContext,
  hold?: Parameters<typeof holdFooterLine>[0],
): string {
  const parts: string[] = [];
  const holdLine = holdFooterLine(hold);
  if (holdLine) parts.push(holdLine);
  const label = servedRev(ctx);
  if (ctx.versionIsCurrent === false) {
    parts.push(`SUPERSEDED REVISION — Rev ${label ?? "?"}. This is NOT the current revision; do not use for construction. Scan to verify.`);
  } else {
    parts.push(`Rev ${label ?? "?"} at time of issue — verify current revision before use.`);
  }
  if (ctx.doc.checkedOutBy && ctx.doc.checkedOutBy !== ctx.userId) {
    const who = ctx.doc.checkedOutByName || "another user";
    parts.push(`ACTIVE CHANGE IN PROGRESS: checked out by ${who} at time of issue.`);
  }
  return parts.join(" ");
}

/** The scan-to-verify URL stamped as a QR on every uncontrolled copy. Encodes
 *  document + the exact version this copy was printed from, so the field can
 *  check a paper print against the current revision with a phone. Always
 *  built on the PUBLIC origin — a print made from a preview deploy must not
 *  QR-link to a Vercel-gated URL. No resolvable version → NO QR (VFY-3): a
 *  document-only code cannot say which revision the paper is, so it is never
 *  stamped — the same guard lib/docPack.ts and app/api/share/file use. */
export function buildVerifyUrl(ctx: DownloadContext): string | undefined {
  if (!ctx.doc.id) return undefined;
  const origin = publicOrigin();
  if (!origin) return undefined;
  const version = ctx.versionId ?? ctx.doc.currentVersionId;
  if (!version) return undefined;
  return `${origin}/verify/${ctx.doc.id}?v=${version}`;
}

/** Ambient intent capture for a content pull. Fire-and-forget: a holder's
 *  download is work ('edit'); anyone else's is 'reference'. */
function captureDownloadIntent(
  ctx: DownloadContext,
  source: "download" | "print",
): void {
  if (!ctx.doc.id || !ctx.doc.orgId) return;
  // A pull of an OLD revision is a REFERENCE, never an edit base — otherwise
  // a revision drafted on top of superseded bytes would resolve its expected
  // base to that old version and pass the stale-base contract cleanly (REV-1
  // chain reaction). Only a current-version pull by the checkout holder is an
  // edit base.
  const isEdit = ctx.versionIsCurrent !== false && ctx.doc.checkedOutBy === ctx.userId;
  void recordIntent({
    orgId: ctx.doc.orgId,
    documentId: ctx.doc.id,
    libraryId: ctx.doc.libraryId ?? null,
    userId: ctx.userId,
    userName: ctx.userLabel ?? ctx.userEmail ?? null,
    kind: isEdit ? "edit" : "reference",
    source,
    baseVersionId: ctx.versionId ?? ctx.doc.currentVersionId ?? null,
  });
}

/** EGR-6 / DIST-9: the outcome of a distribution-record write. supabase-js
 *  RESOLVES with `{ error }` on a refused insert (RLS, a NOT NULL org, a
 *  dropped connection) — it does not throw — so the old try/catch around it
 *  could never fire and a refused record read exactly like a written one. */
export type DownloadAuditResult = { recorded: true } | { recorded: false; error: string };

/** EGR-6: a copy that left the app WITHOUT its distribution record. Thrown
 *  by downloadDocumentPdf / printDocumentPdf only AFTER the copy is in the
 *  person's hands (auditing failure still never blocks the download) — so
 *  the caller's error line says the copy is unrecorded instead of the UI
 *  reading as a clean success. */
export class DownloadUnrecordedError extends Error {
  readonly code = "download_unrecorded" as const;
  constructor(detail: string) {
    super(
      `The copy was delivered, but it could NOT be recorded on the distribution record (${detail}), ` +
      "so it will not be recalled if this document changes. Tell Document Control.",
    );
    this.name = "DownloadUnrecordedError";
  }
}

export async function logDownloadAudit(params: {
  doc: DocumentRecord;
  versionId?: string;
  userId: string;
  userEmail?: string | null;
  state: ControlState;
  expiresAt?: Date | null;
}): Promise<DownloadAuditResult> {
  // download_audits.org_id is required (20261068) — a row without one is a
  // write RLS is guaranteed to refuse, so it is reported, never sent.
  if (!params.doc.orgId || !params.doc.id) {
    const error = "the document has no organization or id on record";
    console.error("[download_audits] NOT RECORDED — this copy is missing from the distribution record:", error);
    return { recorded: false, error };
  }
  try {
    const { error } = await supabase.from("download_audits").insert({
      org_id: params.doc.orgId,
      document_id: params.doc.id,
      version_id: params.versionId ?? null,
      user_id: params.userId,
      user_email: params.userEmail ?? null,
      created_at: new Date().toISOString(),
      expires_at: params.expiresAt ? params.expiresAt.toISOString() : null,
      watermark_policy_id: null,
    });
    if (error) {
      console.error("[download_audits] REFUSED — this copy is missing from the distribution record:", error.message, {
        document: params.doc.id, version: params.versionId ?? null,
      });
      return { recorded: false, error: error.message || "the record write was refused" };
    }
    return { recorded: true };
  } catch (e) {
    // Auditing failure never blocks the download — but it is said, loudly.
    const error = (e as Error)?.message || String(e);
    console.error("[download_audits] insert failed — this copy is missing from the distribution record:", error);
    return { recorded: false, error };
  }
}

/**
 * Download the document as a PDF. Adds the UNCONTROLLED stamp when the
 * requester does not hold the checkout. Returns the resolved control state.
 */

/** Hard-gated read-&-understood: when the doc's effective ack policy sets
 *  hardGate and THIS user still has a pending acknowledgment for the current
 *  revision, the pull is blocked until they sign. This is the enforcement the
 *  "blocked" pill has always promised. Fails OPEN on any lookup error — a
 *  broken policy read must never brick downloads. */
export class AcknowledgmentRequiredError extends Error {
  constructor(docLabel: string) {
    super(
      `Read-&-understood required: "${docLabel}" has a hard acknowledgment gate and your sign-off is outstanding. ` +
      "Open the document's Acknowledgments section (or your Inbox) and sign before downloading.",
    );
    this.name = "AcknowledgmentRequiredError";
  }
}

// Effective-policy memo: the gate runs on EVERY download/print, and resolving
// the inherited policy costs 1-2 round-trips (folder + library) before it can
// even decide "no policy here". Most pulls hit the same few libraries, and a
// multi-sheet book assembly hits one library N times in a row — cache per
// (doc-policy, folder, library) for a minute. Policy edits propagate within
// 60s, which is faster than the page reload that usually follows them.
const ackPolicyMemo = new Map<string, { at: number; policy: unknown }>();
const ACK_POLICY_TTL_MS = 60_000;
/** The pending-acknowledgment read is chunked so a large pack stays under
 *  PostgREST's URL limit (the lib/acknowledgments.ts chunk size). */
const ACK_IN_CHUNK = 150;

/** A document as the read-&-understood gate reads it — a DocumentRecord, or
 *  a raw pack row mapped to these four fields (lib/docPack.ts). */
export interface AckGateDoc {
  id?: string | null;
  libraryId?: string | null;
  collectionId?: string | null;
  ackPolicy?: unknown;
}

/** PKG-9: the gate's whole answer. `gated` — the documents whose effective
 *  ack policy sets `hardGate` AND for which the person still has a pending
 *  acknowledgment; `unknown` — the documents it could not decide because a
 *  read failed (their chunk's pending-acknowledgment read, the policy
 *  module, or their own policy read). */
export interface AckGateOutcome {
  gated: Set<string>;
  unknown: Set<string>;
}

/** PKG-9: THE hard read-&-understood gate — the one helper every copy path
 *  calls: the single-document download and print (assertAckGate below, via
 *  `ackGatedDocumentIds`), the field doc pack (lib/docPack.ts) and the book
 *  viewer's merged book. It never decides a document it could not read:
 *  those are `unknown`, and each caller chooses its posture. The single
 *  download reads `gated` alone and so fails OPEN (unchanged: a broken read
 *  must never brick every desk copy — this gate is a client-side courtesy,
 *  not a rail); the field pack and the book refuse `unknown` too — they fail
 *  CLOSED, as the pack's hold gate does (P8's fourth fix pass).
 *  The person's PENDING acknowledgments are read first (one chunked read),
 *  and a policy is resolved only for a document with one — most people
 *  printing have none, so a pack spread over many folders makes no policy
 *  round trips at all (it used to resolve every sheet's policy, up to two
 *  sequential reads per folder / library, before asking). */
export async function ackGateDocuments(docs: AckGateDoc[], userId: string): Promise<AckGateOutcome> {
  const gated = new Set<string>();
  const unknown = new Set<string>();
  const candidates = docs.filter((d): d is AckGateDoc & { id: string; libraryId: string } => !!d.id && !!d.libraryId);
  if (candidates.length === 0) return { gated, unknown };
  const pending = new Set<string>();
  const ids = [...new Set(candidates.map((d) => d.id))];
  for (let i = 0; i < ids.length; i += ACK_IN_CHUNK) {
    const chunk = ids.slice(i, i + ACK_IN_CHUNK);
    try {
      const { data, error } = await supabase
        .from("document_acknowledgments")
        .select("document_id")
        .in("document_id", chunk)
        .eq("assignee_user_id", userId)
        .eq("status", "pending");
      if (error) { for (const id of chunk) unknown.add(id); continue; } // this chunk is undecided
      for (const r of (data as Array<{ document_id: string }> | null) ?? []) pending.add(String(r.document_id));
    } catch {
      for (const id of chunk) unknown.add(id);
    }
  }
  if (pending.size === 0) return { gated, unknown };
  let effectiveAckPolicyForDocument: typeof import("@/lib/acknowledgments").effectiveAckPolicyForDocument;
  try {
    ({ effectiveAckPolicyForDocument } = await import("@/lib/acknowledgments"));
  } catch {
    for (const id of pending) unknown.add(id);
    return { gated, unknown };
  }
  type Policy = Awaited<ReturnType<typeof effectiveAckPolicyForDocument>>;
  for (const d of candidates) {
    if (!pending.has(d.id) || gated.has(d.id)) continue;
    try {
      const memoKey = `${JSON.stringify(d.ackPolicy ?? null)}|${d.collectionId ?? ""}|${d.libraryId}`;
      const hit = ackPolicyMemo.get(memoKey);
      let policy: Policy;
      if (hit && Date.now() - hit.at < ACK_POLICY_TTL_MS) {
        policy = hit.policy as Policy;
      } else {
        policy = await effectiveAckPolicyForDocument({
          ackPolicy: (d.ackPolicy ?? null) as Parameters<typeof effectiveAckPolicyForDocument>[0]["ackPolicy"],
          collectionId: d.collectionId ?? null,
          libraryId: d.libraryId,
        });
        ackPolicyMemo.set(memoKey, { at: Date.now(), policy });
        if (ackPolicyMemo.size > 200) {
          const oldest = ackPolicyMemo.keys().next().value;
          if (oldest !== undefined) ackPolicyMemo.delete(oldest);
        }
      }
      if (policy?.enabled && policy.hardGate) gated.add(d.id);
    } catch {
      unknown.add(d.id); // undecided: its policy could not be read
    }
  }
  return { gated, unknown };
}

/** PKG-9: the gated ids alone — the single download's posture: it fails
 *  OPEN on a read error (an `unknown` document is not gated), as it always
 *  has. */
export async function ackGatedDocumentIds(docs: AckGateDoc[], userId: string): Promise<Set<string>> {
  return (await ackGateDocuments(docs, userId)).gated;
}

async function assertAckGate(ctx: DownloadContext): Promise<void> {
  if (!ctx.doc.id || !ctx.doc.orgId) return;
  const gated = await ackGatedDocumentIds([ctx.doc], ctx.userId);
  if (gated.has(ctx.doc.id)) {
    throw new AcknowledgmentRequiredError(
      String(ctx.doc.documentNumber || ctx.doc.title || ctx.doc.name || "Document"),
    );
  }
}

export async function downloadDocumentPdf(ctx: DownloadContext): Promise<ControlState> {
  await assertAckGate(ctx);
  const hold = await readCopyHoldState(ctx.doc.id);
  const state = copyControlState(ctx, hold);
  const expiresAt = new Date(Date.now() + (ctx.expiresInHours ?? 24) * 3600 * 1000);

  if (state === "controlled") {
    // Pass-through download of the original file
    const res = await fetch(ctx.fileUrl);
    const blob = await res.blob();
    triggerBlobDownload(blob, ctx.filename ?? defaultFilename(ctx, ""));
  } else {
    await downloadStampedPdf({
      url: ctx.fileUrl,
      filename: ctx.filename ?? defaultFilename(ctx, "_UNCONTROLLED"),
      options: {
        userLabel: ctx.userLabel ?? undefined,
        email: ctx.userEmail ?? undefined,
        timestamp: new Date(),
        expiresAt,
        watermarkText: copyWatermark(ctx, hold),
        footerNotice: buildFooterNotice(ctx, hold),
        verifyUrl: buildVerifyUrl(ctx),
      },
    });
  }

  captureDownloadIntent(ctx, "download");

  const audit = await logDownloadAudit({
    doc: ctx.doc,
    versionId: ctx.versionId ?? ctx.doc.currentVersionId ?? undefined,
    userId: ctx.userId,
    userEmail: ctx.userEmail,
    state,
    expiresAt: state === "uncontrolled" ? expiresAt : null,
  });
  if (!audit.recorded) throw new DownloadUnrecordedError(audit.error);

  return state;
}

/**
 * Open the document in a new tab and trigger the browser print dialog.
 * Uncontrolled prints are stamped first so the watermark appears on paper.
 */
export async function printDocumentPdf(ctx: DownloadContext): Promise<ControlState> {
  await assertAckGate(ctx);
  const hold = await readCopyHoldState(ctx.doc.id);
  const state = copyControlState(ctx, hold);
  const expiresAt = new Date(Date.now() + (ctx.expiresInHours ?? 24) * 3600 * 1000);

  let blob: Blob;
  if (state === "controlled") {
    const res = await fetch(ctx.fileUrl);
    blob = await res.blob();
  } else {
    blob = await stampPdf(ctx.fileUrl, {
      userLabel: ctx.userLabel ?? undefined,
      email: ctx.userEmail ?? undefined,
      timestamp: new Date(),
      expiresAt,
      watermarkText: copyWatermark(ctx, hold),
      footerNotice: buildFooterNotice(ctx, hold),
      verifyUrl: buildVerifyUrl(ctx),
    });
  }

  captureDownloadIntent(ctx, "print");

  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank");
  if (w) {
    // Give the browser a beat to load the PDF before invoking print().
    w.addEventListener("load", () => setTimeout(() => w.print(), 250));
  }
  // Best-effort cleanup; do not revoke immediately or the new window blanks.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);

  const audit = await logDownloadAudit({
    doc: ctx.doc,
    versionId: ctx.versionId ?? ctx.doc.currentVersionId ?? undefined,
    userId: ctx.userId,
    userEmail: ctx.userEmail,
    state,
    expiresAt: state === "uncontrolled" ? expiresAt : null,
  });
  if (!audit.recorded) throw new DownloadUnrecordedError(audit.error);

  return state;
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
