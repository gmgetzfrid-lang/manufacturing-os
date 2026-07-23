// lib/docPack.ts
//
// DOC PACK — one click from an equipment tag to a single stamped PDF of
// every current-revision drawing for that asset. The person heading to the
// field gets the right, current, stamped set in seconds — and every sheet
// carries the verify-QR, so the pack keeps protecting itself after it's
// printed.
//
// Client-side assembly with pdf-lib: fetch each current revision, stamp it
// (uncontrolled footer + per-document QR), merge, download. Every included
// document is download-audited and leaves a 'reference' intent, exactly
// like an individual download would.

import { PDFDocument } from "pdf-lib";
import { supabase } from "@/lib/supabase";
import { applyStampToPdfDoc } from "@/lib/stamping";
import { recordIntent } from "@/lib/intents";
import type { DocumentRecord } from "@/types/schema";

export interface DocPackResult {
  included: number;
  skipped: Array<{ label: string; reason: string }>;
}

async function resolveToHttpUrl(raw: string): Promise<string> {
  if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("blob:")) return raw;
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(
    `/api/storage/download-url?path=${encodeURIComponent(raw)}&expiresIn=3600`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Storage resolve failed (HTTP ${res.status})`);
  const { url } = await res.json();
  return url as string;
}

export async function buildAndDownloadDocPack(input: {
  orgId: string;
  packLabel: string;               // e.g. the asset tag — used in the filename
  documentIds: string[];
  userId: string;
  userEmail?: string | null;
  onProgress?: (done: number, total: number) => void;
}): Promise<DocPackResult> {
  const { data: docRows } = await supabase
    .from("documents")
    .select("id, org_id, document_number, title, name, rev, library_id, current_version_id, checked_out_by, checked_out_by_name, checkout_note")
    .in("id", input.documentIds);
  const docs = (docRows as Array<Record<string, unknown>>) ?? [];

  const versionIds = docs
    .map((d) => d.current_version_id as string | null)
    .filter((v): v is string => !!v);
  const { data: versionRows } = await supabase
    .from("document_versions")
    .select("id, file_url")
    .in("id", versionIds);
  const urlByVersion = new Map(
    ((versionRows as Array<{ id: string; file_url: string }>) ?? []).map((v) => [v.id, v.file_url]),
  );

  const merged = await PDFDocument.create();
  const skipped: DocPackResult["skipped"] = [];
  let included = 0;
  let done = 0;

  for (const d of docs) {
    const label = String(d.document_number || d.title || d.name || "Document");
    try {
      const versionId = (d.current_version_id as string | null) ?? null;
      const rawUrl = versionId ? urlByVersion.get(versionId) : undefined;
      if (!rawUrl) { skipped.push({ label, reason: "no current file" }); continue; }

      const httpUrl = await resolveToHttpUrl(rawUrl);
      const res = await fetch(httpUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();

      // Stamp each document individually so its footer + QR are its own.
      const single = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const doc = d as unknown as DocumentRecord & { checkout_note?: string };
      const holderWarning = d.checked_out_by && (
        ` ACTIVE CHANGE IN PROGRESS: checked out by ${(d.checked_out_by_name as string) || "another user"} at time of issue.`
      );
      await applyStampToPdfDoc(single, {
        userLabel: input.userEmail?.split("@")[0] ?? undefined,
        email: input.userEmail ?? undefined,
        timestamp: new Date(),
        watermarkText: "UNCONTROLLED — FIELD PACK",
        footerNotice:
          `${label} Rev ${(d.rev as string) ?? "?"} at time of issue — verify current revision before use.` +
          (holderWarning || ""),
        verifyUrl: typeof window !== "undefined" && versionId
          ? `${window.location.origin}/verify/${String(d.id)}?v=${versionId}`
          : undefined,
      });

      const pages = await merged.copyPages(single, single.getPageIndices());
      for (const p of pages) merged.addPage(p);
      included += 1;

      // Same tracking as an individual pull: audit + reference intent.
      void supabase.from("download_audits").insert({
        org_id: input.orgId,
        document_id: String(d.id),
        version_id: versionId,
        user_id: input.userId,
        user_email: input.userEmail ?? null,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        watermark_policy_id: null,
      }).then(() => {}, () => {});
      void recordIntent({
        orgId: input.orgId,
        documentId: String(d.id),
        libraryId: (d.library_id as string | null) ?? null,
        userId: input.userId,
        userName: input.userEmail?.split("@")[0] ?? null,
        kind: doc.checkedOutBy === input.userId ? "edit" : "reference",
        source: "download",
        baseVersionId: versionId,
      });
    } catch (e) {
      skipped.push({ label, reason: (e as Error).message });
    } finally {
      done += 1;
      input.onProgress?.(done, docs.length);
    }
  }

  if (included === 0) {
    throw new Error(
      skipped.length > 0
        ? `No documents could be packed (${skipped[0].label}: ${skipped[0].reason})`
        : "Nothing to pack",
    );
  }

  const bytes = await merged.save();
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const dateStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `DocPack_${input.packLabel.replace(/[^\w.\-]+/g, "_")}_${dateStr}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { included, skipped };
}
