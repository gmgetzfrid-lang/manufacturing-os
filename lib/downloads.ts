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
import type { DocumentRecord } from "@/types/schema";

export type ControlState = "controlled" | "uncontrolled";

export type DownloadContext = {
  doc: DocumentRecord;
  versionId?: string;
  fileUrl: string;            // resolved presigned URL or blob URL of the source PDF
  filename?: string;
  userId: string;
  userEmail?: string | null;
  userLabel?: string | null;  // display name fallback
  expiresInHours?: number;    // default 24
};

export function determineControlState(doc: DocumentRecord, userId: string): ControlState {
  // A controlled COPY is only available when the requester is the active
  // checkout holder. Everyone else gets a stamped uncontrolled copy.
  // NOTE: this is the COPY rule (download/print/markup). For the on-screen
  // viewer badge, use viewerStatusBadge instead — see below.
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

function defaultFilename(doc: DocumentRecord, suffix: string): string {
  const stem =
    (doc.documentNumber || doc.title || doc.name || "document").replace(/[^\w.\-]+/g, "_");
  const rev = doc.rev ? `_Rev${doc.rev}` : "";
  return `${stem}${rev}${suffix}.pdf`;
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
export async function downloadDocumentPdf(ctx: DownloadContext): Promise<ControlState> {
  const state = determineControlState(ctx.doc, ctx.userId);
  const expiresAt = new Date(Date.now() + (ctx.expiresInHours ?? 24) * 3600 * 1000);

  if (state === "controlled") {
    // Pass-through download of the original file
    const res = await fetch(ctx.fileUrl);
    const blob = await res.blob();
    triggerBlobDownload(blob, ctx.filename ?? defaultFilename(ctx.doc, ""));
  } else {
    await downloadStampedPdf({
      url: ctx.fileUrl,
      filename: ctx.filename ?? defaultFilename(ctx.doc, "_UNCONTROLLED"),
      options: {
        userLabel: ctx.userLabel ?? undefined,
        email: ctx.userEmail ?? undefined,
        timestamp: new Date(),
        expiresAt,
        watermarkText: "UNCONTROLLED — FOR REVIEW ONLY",
      },
    });
  }

  await logDownloadAudit({
    doc: ctx.doc,
    versionId: ctx.versionId,
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
  const state = determineControlState(ctx.doc, ctx.userId);
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
    });
  }

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
    versionId: ctx.versionId,
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
