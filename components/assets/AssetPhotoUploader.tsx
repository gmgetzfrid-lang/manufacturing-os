"use client";

// AssetPhotoUploader — drag-drop zone for adding photos to an asset.
// Auto-detects capture date from filename (e.g., IMG_20240815_*.jpg).
// Each photo can have an optional caption + manual date override.

import React, { useState, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  Upload, X, Camera, Calendar, Loader2, CheckCircle2,
  AlertTriangle, RotateCcw,
} from "lucide-react";
import {
  createPhotoRecord, parseCapturedAtFromFilename, invalidateAssetCache,
  type Asset,
} from "@/lib/assets";
import { uploadToPath } from "@/lib/storage";
import { tryUpload } from "@/lib/uploadRetry";
import { useFileDrag } from "@/hooks/useFileDrag";
import FileThumb from "@/components/ui/FileThumb";
import { equipmentLabel } from "@/lib/equipmentPick";

interface PendingPhoto {
  id: string;
  file: File;
  caption: string;
  capturedAt: string;     // ISO date input value (YYYY-MM-DD)
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
}

interface AssetPhotoUploaderProps {
  isOpen: boolean;
  asset: Asset;
  userId: string;
  onClose: () => void;
  /** Called after photos land. `allDone` is true when none are left to send. */
  onUploaded: (allDone?: boolean) => void;
}

export default function AssetPhotoUploader({
  isOpen, asset, userId, onClose, onUploaded,
}: AssetPhotoUploaderProps) {
  const [pending, setPending] = useState<PendingPhoto[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stagePendingFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const fileArr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (fileArr.length === 0) {
      setError("Only photos can go here. Pick image files.");
      return;
    }
    setError(null);
    const staged: PendingPhoto[] = fileArr.map((f, i) => {
      const dateIso = parseCapturedAtFromFilename(f.name) ?? new Date(f.lastModified).toISOString();
      return {
        id: `pending-${Date.now()}-${i}`,
        file: f,
        caption: "",
        capturedAt: dateIso.slice(0, 10),    // YYYY-MM-DD for date input
        status: "pending",
      };
    });
    setPending((prev) => [...prev, ...staged]);
  }, []);
  const drag = useFileDrag((files) => stagePendingFiles(files), submitting);

  // Escape closes, unless photos are on their way up.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !submitting) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, submitting, onClose]);

  const removePending = (id: string) => {
    setPending((prev) => prev.filter((p) => p.id !== id));
  };

  const updatePending = (id: string, patch: Partial<PendingPhoto>) => {
    setPending((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  // One photo: the transfer, then its record. Safe to repeat: each try
  // goes to a new path and the record is made only after the file lands.
  const sendOne = (p: PendingPhoto) => async () => {
    const storagePath = `orgs/${asset.org_id}/assets/${asset.id}/photos/${Date.now()}-${p.file.name}`;
    const result = await uploadToPath(p.file, storagePath, {
      contentType: p.file.type || "image/jpeg",
    });
    await createPhotoRecord({
      orgId: asset.org_id,
      assetId: asset.id,
      fileUrl: result.url,
      fileSize: result.size ?? p.file.size,
      contentType: p.file.type || "image/jpeg",
      capturedAt: p.capturedAt ? new Date(p.capturedAt).toISOString() : undefined,
      caption: p.caption.trim() || undefined,
      uploadedBy: userId,
    });
  };

  const uploadOne = async (p: PendingPhoto): Promise<boolean> => {
    updatePending(p.id, { status: "uploading", error: undefined });
    try {
      await tryUpload(p.file.name, sendOne(p), {
        onRetried: () => {
          updatePending(p.id, { status: "done", error: undefined });
          invalidateAssetCache();
          onUploaded(false);
        },
      }, `asset-photo-${p.id}`);
      updatePending(p.id, { status: "done" });
      return true;
    } catch (e) {
      updatePending(p.id, { status: "error", error: (e as Error).message || "It didn't go through." });
      return false;
    }
  };

  // Try one failed photo again, with whatever caption and date it has now.
  const retryOne = async (id: string) => {
    const p = pending.find((x) => x.id === id);
    if (!p || p.status === "uploading") return;
    if (await uploadOne(p)) { invalidateAssetCache(); onUploaded(false); }
  };

  const uploadAll = async () => {
    if (pending.length === 0) return;
    setSubmitting(true);
    setError(null);
    const PHOTO_CONCURRENCY = 4;
    try {
      const todo = pending.filter((p) => p.status !== "done" && p.status !== "uploading");
      let failed = 0;

      // Run in capped-concurrency chunks so 10+ photos don't take 10x
      // the time of one. One failure never stops the others.
      for (let i = 0; i < todo.length; i += PHOTO_CONCURRENCY) {
        const chunk = todo.slice(i, i + PHOTO_CONCURRENCY);
        const ok = await Promise.all(chunk.map(uploadOne));
        failed += ok.filter((x) => !x).length;
      }

      invalidateAssetCache();
      if (failed > 0) onUploaded(false);
      else {
        setPending([]);
        onUploaded(true);
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const doneCount = pending.filter((p) => p.status === "done").length;
  const errorCount = pending.filter((p) => p.status === "error").length;
  const toSend = pending.filter((p) => p.status === "pending" || p.status === "error").length;

  // Portal so the uploader overlay escapes any transformed ancestor.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[510] bg-[var(--color-ink)]/60 flex items-start sm:items-center justify-center overflow-y-auto p-4"
      onClick={() => { if (!submitting) onClose(); }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="w-full max-w-3xl bg-[var(--color-surface)] rounded-lg shadow-2xl border border-[var(--color-border)] overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-start justify-between gap-3 shrink-0">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="p-2 bg-[var(--color-surface-2)] rounded-lg shrink-0"><Camera className="w-4 h-4 text-[var(--color-text)]" /></div>
            <div className="min-w-0">
              <div className="text-body font-medium text-[var(--color-text)] truncate">
                Photos for <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] text-body font-medium align-middle ml-0.5">{equipmentLabel({ tag: asset.tag, code: asset.code })}</span>
              </div>
              <div className="text-body text-[var(--color-text-muted)] mt-0.5 leading-snug">
                These go on the equipment, not in a library folder. They show wherever this tag appears.
              </div>
            </div>
          </div>
          <button onClick={onClose} disabled={submitting} aria-label="Close" className="p-1.5 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Drop zone */}
        <div className="px-5 pt-4 shrink-0">
          <div
            {...drag.bind}
            className={`relative rounded-xl border-2 border-dashed p-6 text-center transition-all border-[var(--color-border-strong)] bg-[var(--color-surface-2)] hover:border-[var(--color-text-faint)] ${drag.ring}`}
          >
            <input
              type="file"
              multiple
              accept="image/*"
              onChange={(e) => { stagePendingFiles(e.target.files); e.target.value = ""; }}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
            <div className="p-3 bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] w-fit mx-auto mb-3 shadow-sm">
              <Upload className="w-5 h-5 text-[var(--color-text-muted)]" />
            </div>
            <p className="text-body font-medium text-[var(--color-text)]">
              {drag.over ? drag.say : "Drag photos in or click to select"}
            </p>
            <p className="text-body text-[var(--color-text-muted)] mt-1">
              The date comes from the file name when it has one. Any image type.
            </p>
          </div>

          {/* Camera capture — one-tap, rear camera on mobile. Surfaced as a
              distinct affordance so field users go straight to the camera
              instead of the file picker. Renders everywhere; on desktop with
              no camera the browser falls back to a file dialog. */}
          <label className="mt-2 inline-flex items-center justify-center gap-2 w-full sm:w-auto px-4 py-3 sm:py-2 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] text-body font-medium cursor-pointer transition-colors">
            <Camera className="w-4 h-4" />
            Take photo
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => { stagePendingFiles(e.target.files); e.target.value = ""; }}
              className="sr-only"
            />
          </label>
        </div>

        {error && (
          <p role="alert" className="mx-5 mt-3 border-l-2 border-[var(--state-overdue)] pl-3 text-body text-[var(--state-overdue)] flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
          </p>
        )}

        {/* Pending photos list */}
        {pending.length > 0 && (
          <div className="flex-1 overflow-auto px-5 pt-4 pb-2">
            <div className="text-body font-medium text-[var(--color-text-muted)] mb-2">
              Photos to upload ({pending.length})
            </div>
            <div className="space-y-2">
              {pending.map((p) => (
                <div key={p.id} className="bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-xl p-2.5 flex items-start gap-3">
                  <FileThumb file={p.file} size={64} />
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-medium text-[var(--color-text)] truncate flex-1">{p.file.name}</span>
                      <span className="text-body text-[var(--color-text-muted)]">{formatBytes(p.file.size)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <input
                          value={p.caption}
                          onChange={(e) => updatePending(p.id, { caption: e.target.value })}
                          disabled={p.status === "uploading" || p.status === "done"}
                          placeholder="Caption (optional), e.g. inlet side, north face"
                          className="w-full text-body border border-[var(--color-border)] rounded px-2 py-1 bg-[var(--color-surface)] text-[var(--color-text)]"
                        />
                      </div>
                      <div className="shrink-0 inline-flex items-center gap-1 text-body text-[var(--color-text-muted)]">
                        <Calendar className="w-3 h-3" />
                        <input
                          type="date"
                          value={p.capturedAt}
                          onChange={(e) => updatePending(p.id, { capturedAt: e.target.value })}
                          disabled={p.status === "uploading" || p.status === "done"}
                          className="text-body border border-[var(--color-border)] rounded px-1.5 py-1 bg-[var(--color-surface)] text-[var(--color-text)]"
                        />
                      </div>
                    </div>
                    {p.status === "error" && (
                      <div className="flex items-center gap-2 text-body text-[var(--state-overdue)]">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate flex-1" title={p.error}>Didn&apos;t upload: {p.error}</span>
                        <button type="button" onClick={() => void retryOne(p.id)} disabled={submitting}
                          className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] font-medium hover:bg-[var(--color-surface-2)] disabled:opacity-50">
                          <RotateCcw className="w-3 h-3" /> Try again
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="shrink-0">
                    {(p.status === "pending" || p.status === "error") && (
                      <button onClick={() => removePending(p.id)} aria-label={`Remove ${p.file.name}`} className="p-1.5 text-[var(--color-text-faint)] hover:text-[var(--state-overdue)] hover:bg-[var(--color-surface)] rounded">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {p.status === "uploading" && <span className="inline-flex items-center gap-1 text-body text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Sending</span>}
                    {p.status === "done" && <span className="inline-flex items-center gap-1 text-body font-medium text-[var(--state-released)]"><CheckCircle2 className="w-4 h-4" /> Added</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-between shrink-0">
          <div className="text-body text-[var(--color-text-muted)]">
            {pending.length === 0 ? (
              "Drop or click above to start."
            ) : (
              <>
                {pending.length} photo{pending.length === 1 ? "" : "s"} staged
                {doneCount > 0 && <span className="text-[var(--state-released)] font-medium"> · {doneCount} uploaded</span>}
                {errorCount > 0 && <span className="text-[var(--state-overdue)] font-medium"> · {errorCount} didn&apos;t upload</span>}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={submitting} className="px-3 py-2 rounded-lg text-body font-medium text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)]">
              {doneCount > 0 ? "Done" : "Cancel"}
            </button>
            <button
              onClick={uploadAll}
              disabled={toSend === 0 || submitting}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-body font-medium text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              {submitting ? "Uploading…" : toSend > 0 && toSend === errorCount ? `Try again (${toSend})` : `Upload ${toSend} photo${toSend === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}
