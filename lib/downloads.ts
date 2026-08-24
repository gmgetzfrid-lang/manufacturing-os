// lib/downloads.ts
// Centralized download / print path for documents.
//
// Decision rules:
//   - User holds an active checkout on the document  -> CONTROLLED copy (raw PDF)
//   - Otherwise                                       -> UNCONTROLLED copy (stamped)
//
// Every download is logged to `download_audits`. Stamping rasterizes a
// rotated watermark + footer onto every page via pdf-lib (see lib/stamping.ts).

import { supabase } from "@/lib/supabase";
import { downloadStampedPdf, stampPdf } from "@/lib/stamping";
import { recordIntent } from "@/lib/intents";
import { publicOrigin } from "@/lib/publicOrigin";
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
 *  revision says so outright. */
export function buildFooterNotice(ctx: DownloadContext): string {
  const parts: string[] = [];
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
 *  QR-link to a Vercel-gated URL. */
export function buildVerifyUrl(ctx: DownloadContext): string | undefined {
  if (!ctx.doc.id) return undefined;
  const origin = publicOrigin();
  if (!origin) return undefined;
  const version = ctx.versionId ?? ctx.doc.currentVersionId;
  const base = `${origin}/verify/${ctx.doc.id}`;
  return version ? `${base}?v=${version}` : base;
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

export async function logDownloadAudit(params: {
  doc: DocumentRecord;
  versionId?: string;
  userId: string;
  userEmail?: string | null;
  state: ControlState;
  expiresAt?: Date | null;
}) {
  try {
    await supabase.from("download_audits").insert({
      org_id: params.doc.orgId ?? null,
      document_id: params.doc.id ?? null,
      version_id: params.versionId ?? null,
      user_id: params.userId,
      user_email: params.userEmail ?? null,
      created_at: new Date().toISOString(),
      expires_at: params.expiresAt ? params.expiresAt.toISOString() : null,
      watermark_policy_id: null,
    });
  } catch (e) {
    // Auditing failure should never block the download.
    console.error("download_audits insert failed", e);
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

async function assertAckGate(ctx: DownloadContext): Promise<void> {
  if (!ctx.doc.id || !ctx.doc.orgId) return;
  try {
    const { effectiveAckPolicyForDocument } = await import("@/lib/acknowledgments");
    const memoKey = `${JSON.stringify(ctx.doc.ackPolicy ?? null)}|${ctx.doc.collectionId ?? ""}|${ctx.doc.libraryId}`;
    const hit = ackPolicyMemo.get(memoKey);
    let policy: Awaited<ReturnType<typeof effectiveAckPolicyForDocument>>;
    if (hit && Date.now() - hit.at < ACK_POLICY_TTL_MS) {
      policy = hit.policy as Awaited<ReturnType<typeof effectiveAckPolicyForDocument>>;
    } else {
      policy = await effectiveAckPolicyForDocument({
        ackPolicy: ctx.doc.ackPolicy ?? null,
        collectionId: ctx.doc.collectionId ?? null,
        libraryId: ctx.doc.libraryId,
      });
      ackPolicyMemo.set(memoKey, { at: Date.now(), policy });
      if (ackPolicyMemo.size > 200) {
        const oldest = ackPolicyMemo.keys().next().value;
        if (oldest !== undefined) ackPolicyMemo.delete(oldest);
      }
    }
    if (!policy?.enabled || !policy.hardGate) return;
    const { data } = await supabase
      .from("document_acknowledgments")
      .select("id")
      .eq("document_id", ctx.doc.id)
      .eq("assignee_user_id", ctx.userId)
      .eq("status", "pending")
      .limit(1);
    if (((data as unknown[]) ?? []).length > 0) {
      throw new AcknowledgmentRequiredError(
        String(ctx.doc.documentNumber || ctx.doc.title || ctx.doc.name || "Document"),
      );
    }
  } catch (e) {
    if (e instanceof AcknowledgmentRequiredError) throw e;
    /* fail open: enforcement must not outlive its data */
  }
}

export async function downloadDocumentPdf(ctx: DownloadContext): Promise<ControlState> {
  await assertAckGate(ctx);
  const state = determineControlState(ctx.doc, ctx.userId, ctx.versionIsCurrent);
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
        watermarkText: "UNCONTROLLED — FOR REVIEW ONLY",
        footerNotice: buildFooterNotice(ctx),
        verifyUrl: buildVerifyUrl(ctx),
      },
    });
  }

  captureDownloadIntent(ctx, "download");

  await logDownloadAudit({
    doc: ctx.doc,
    versionId: ctx.versionId ?? ctx.doc.currentVersionId ?? undefined,
    userId: ctx.userId,
    userEmail: ctx.userEmail,
    state,
    expiresAt: state === "uncontrolled" ? expiresAt : null,
  });

  return state;
}

/**
 * Open the document in a new tab and trigger the browser print dialog.
 * Uncontrolled prints are stamped first so the watermark appears on paper.
 */
export async function printDocumentPdf(ctx: DownloadContext): Promise<ControlState> {
  await assertAckGate(ctx);
  const state = determineControlState(ctx.doc, ctx.userId, ctx.versionIsCurrent);
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
      watermarkText: "UNCONTROLLED — FOR REVIEW ONLY",
      footerNotice: buildFooterNotice(ctx),
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

  await logDownloadAudit({
    doc: ctx.doc,
    versionId: ctx.versionId ?? ctx.doc.currentVersionId ?? undefined,
    userId: ctx.userId,
    userEmail: ctx.userEmail,
    state,
    expiresAt: state === "uncontrolled" ? expiresAt : null,
  });

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
