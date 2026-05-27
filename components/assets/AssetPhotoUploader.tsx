"use client";

// AssetPhotoUploader — drag-drop zone for adding photos to an asset.
// Auto-detects capture date from filename (e.g., IMG_20240815_*.jpg).
// Each photo can have an optional caption + manual date override.

import React, { useState, useCallback } from "react";
import {
  Upload, X, Camera, Calendar, Loader2, CheckCircle2,
  AlertTriangle, Image as ImageIcon,
} from "lucide-react";
import {
  createPhotoRecord, parseCapturedAtFromFilename, invalidateAssetCache,
  type Asset,
} from "@/lib/assets";
import { uploadToPath } from "@/lib/storage";

interface PendingPhoto {
  id: string;
  file: File;
  previewUrl: string;
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
  onUploaded: () => void;
}

export default function AssetPhotoUploader({
  isOpen, asset, userId, onClose, onUploaded,
}: AssetPhotoUploaderProps) {
  const [pending, setPending] = useState<PendingPhoto[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stagePendingFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const fileArr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (fileArr.length === 0) {
      setError("Please drop image files.");
      return;
    }
    setError(null);
    const staged: PendingPhoto[] = fileArr.map((f, i) => {
      const dateIso = parseCapturedAtFromFilename(f.name) ?? new Date(f.lastModified).toISOString();
      return {
        id: `pending-${Date.now()}-${i}`,
        file: f,
        previewUrl: URL.createObjectURL(f),
        caption: "",
        capturedAt: dateIso.slice(0, 10),    // YYYY-MM-DD for date input
        status: "pending",
      };
    });
    setPending((prev) => [...prev, ...staged]);
  }, []);

  const removePending = (id: string) => {
    setPending((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  };

  const updatePending = (id: string, patch: Partial<PendingPhoto>) => {
    setPending((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const uploadAll = async () => {
    if (pending.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      for (const p of pending) {
        if (p.status === "done") continue;
        updatePending(p.id, { status: "uploading" });
        try {
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
          updatePending(p.id, { status: "done" });
        } catch (e) {
          updatePending(p.id, { status: "error", error: (e as Error).message });
        }
      }
      invalidateAssetCache();
      // If everything succeeded, close + notify parent
      const anyFailed = pending.some((p) => p.status === "error");
      if (!anyFailed) {
        // Free URLs
        pending.forEach((p) => URL.revokeObjectURL(p.previewUrl));
        setPending([]);
        onUploaded();
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const doneCount = pending.filter((p) => p.status === "done").length;
  const errorCount = pending.filter((p) => p.status === "error").length;

  return (
    <div
      className="fixed inset-0 z-[510] bg-slate-900/80 backdrop-blur-md flex items-center justify-center p-4"
      onClick={onClose}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="w-full max-w-3xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-slate-200 flex items-start justify-between gap-3 shrink-0">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="p-2 bg-emerald-100 rounded-lg shrink-0"><Camera className="w-4 h-4 text-emerald-700" /></div>
            <div className="min-w-0">
              <div className="text-sm font-black text-slate-900 truncate">
                Photos for <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-blue-50 text-blue-800 border border-blue-200 text-[11px] font-bold align-middle ml-0.5">{asset.tag}</span>
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                These photos attach <b>directly to this equipment asset</b> — they do NOT become documents and won&apos;t appear in your library folders. Visible everywhere this tag appears.
              </div>
            </div>
          </div>
          <button onClick={onClose} disabled={submitting} className="p-1.5 rounded text-slate-400 hover:text-slate-900 hover:bg-slate-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Drop zone */}
        <div className="px-5 pt-4 shrink-0">
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e) => {
              e.preventDefault(); setIsDragOver(false);
              stagePendingFiles(e.dataTransfer.files);
            }}
            className={`relative rounded-xl border-2 border-dashed p-6 text-center transition-all ${
              isDragOver
                ? "border-emerald-400 bg-emerald-50"
                : "border-slate-300 bg-slate-50/50 hover:border-slate-400"
            }`}
          >
            <input
              type="file"
              multiple
              accept="image/*"
              onChange={(e) => stagePendingFiles(e.target.files)}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
            <div className="p-3 bg-white rounded-xl border border-slate-200 w-fit mx-auto mb-3 shadow-sm">
              <Upload className="w-5 h-5 text-emerald-600" />
            </div>
            <p className="text-sm font-bold text-slate-900">
              {isDragOver ? "Drop photos here" : "Drag photos in or click to select"}
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              Capture date auto-detected from filename. JPEG, PNG, HEIC, or any image format.
            </p>
          </div>
        </div>

        {error && (
          <div className="mx-5 mt-3 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* Pending photos list */}
        {pending.length > 0 && (
          <div className="flex-1 overflow-auto px-5 pt-4 pb-2">
            <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
              Photos to upload ({pending.length})
            </div>
            <div className="space-y-2">
              {pending.map((p) => (
                <div key={p.id} className="bg-slate-50 border border-slate-200 rounded-xl p-2.5 flex items-start gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.previewUrl} alt="" className="w-16 h-16 object-cover rounded-lg shrink-0 border border-slate-300" />
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-900 truncate flex-1">{p.file.name}</span>
                      <span className="text-[10px] text-slate-500">{formatBytes(p.file.size)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <input
                          value={p.caption}
                          onChange={(e) => updatePending(p.id, { caption: e.target.value })}
                          disabled={p.status === "uploading" || p.status === "done"}
                          placeholder="Caption (optional) — e.g., 'inlet side, north face'"
                          className="w-full text-[11px] border border-slate-200 rounded px-2 py-1 bg-white"
                        />
                      </div>
                      <div className="shrink-0 inline-flex items-center gap-1 text-[10px] text-slate-500">
                        <Calendar className="w-3 h-3" />
                        <input
                          type="date"
                          value={p.capturedAt}
                          onChange={(e) => updatePending(p.id, { capturedAt: e.target.value })}
                          disabled={p.status === "uploading" || p.status === "done"}
                          className="text-[10px] border border-slate-200 rounded px-1.5 py-1 bg-white"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0">
                    {p.status === "pending" && (
                      <button onClick={() => removePending(p.id)} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {p.status === "uploading" && <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />}
                    {p.status === "done" && <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
                    {p.status === "error" && (
                      <div title={p.error} className="p-1 text-red-600">
                        <AlertTriangle className="w-4 h-4" />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between shrink-0">
          <div className="text-[11px] text-slate-500">
            {pending.length === 0 ? (
              "Drop or click above to start."
            ) : (
              <>
                {pending.length} photo{pending.length === 1 ? "" : "s"} staged
                {doneCount > 0 && <span className="text-emerald-700 font-bold"> · {doneCount} uploaded</span>}
                {errorCount > 0 && <span className="text-red-700 font-bold"> · {errorCount} failed</span>}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={submitting} className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200">
              {doneCount > 0 ? "Done" : "Cancel"}
            </button>
            <button
              onClick={uploadAll}
              disabled={pending.length === 0 || submitting || pending.every((p) => p.status === "done")}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-black text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 shadow"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              {submitting ? "Uploading…" : `Upload ${pending.filter((p) => p.status !== "done").length} photo${pending.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}
