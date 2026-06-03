"use client";

// CustomizeNodeModal — set the presentational appearance of a folder (or
// library): brand color, icon, cover image, palette tint, and a short
// description. Mirrors SharePoint's library/folder customization, tied
// to the workspace palette via the "brand" duotone tint.

import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Check, Loader2, ImageIcon, Upload } from "lucide-react";
import { NODE_ICON_KEYS, NodeIcon } from "@/lib/nodeIcons";
import NodeCover, { type NodeAppearanceLike } from "@/components/documents/NodeCover";
import { uploadToPath } from "@/lib/storage";

const COLOR_SWATCHES = ["#4f46e5", "#2563eb", "#0ea5e9", "#0d9488", "#059669", "#65a30d", "#ea580c", "#dc2626", "#e11d48", "#db2777", "#7c3aed", "#475569"];

export interface CustomizeValue {
  description?: string;
  color?: string;
  icon?: string;
  coverImageUrl?: string;
  coverTint?: "none" | "brand" | "mono";
}

export default function CustomizeNodeModal({
  open, initial, title = "Customize folder", storagePrefix, onClose, onSave,
}: {
  open: boolean;
  initial: CustomizeValue;
  title?: string;
  /** When set (e.g. "orgs/<org>/branding"), enables uploading a cover
   *  image; the uploaded R2 path is stored and signed at render time. */
  storagePrefix?: string;
  onClose: () => void;
  onSave: (v: CustomizeValue) => Promise<void> | void;
}) {
  // Parent remounts this modal via `key`, so a plain initializer is the
  // freshest seed (no reseed effect needed).
  const [v, setV] = useState<CustomizeValue>(initial);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open || typeof document === "undefined") return null;

  const preview: NodeAppearanceLike = { color: v.color, icon: v.icon, coverImageUrl: v.coverImageUrl, coverTint: v.coverTint };
  const set = (patch: Partial<CustomizeValue>) => setV((p) => ({ ...p, ...patch }));

  const handleUpload = async (file: File) => {
    if (!storagePrefix) return;
    setUploading(true);
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
      const rand = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}`;
      const path = `${storagePrefix.replace(/\/+$/, "")}/covers/${rand}.${ext}`;
      await uploadToPath(file, path, { contentType: file.type });
      set({ coverImageUrl: path }); // stored as a storage path; NodeCover signs it
    } catch (e) {
      alert(`Upload failed: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try { await onSave(v); onClose(); } finally { setSaving(false); }
  };

  return createPortal(
    <div className="fixed inset-0 z-[400] grid place-items-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--color-border)]">
          <h2 className="font-black text-[var(--color-text)]">{title}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-auto">
          {/* live preview */}
          <NodeCover appearance={preview} className="h-28 w-full" iconSize="w-7 h-7" />

          {/* description */}
          <div>
            <label className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Description</label>
            <textarea value={v.description ?? ""} onChange={(e) => set({ description: e.target.value })} rows={2}
              placeholder="What lives in this folder?"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-sm text-[var(--color-text)] resize-none" />
          </div>

          {/* color */}
          <div>
            <label className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Color</label>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <button onClick={() => set({ color: undefined })} title="Match theme"
                className={`px-2.5 h-7 rounded-full text-[11px] font-bold border ${!v.color ? "border-[var(--color-accent)] text-[var(--color-text)]" : "border-[var(--color-border)] text-[var(--color-text-muted)]"}`} style={!v.color ? { background: "var(--brand-gradient)", color: "#fff" } : undefined}>Theme</button>
              {COLOR_SWATCHES.map((c) => (
                <button key={c} onClick={() => set({ color: c })} title={c}
                  className={`w-7 h-7 rounded-full ${v.color === c ? "ring-2 ring-offset-2 ring-[var(--color-text-muted)] ring-offset-[var(--color-surface)]" : ""}`} style={{ backgroundColor: c }}>
                  {v.color === c && <Check className="w-3.5 h-3.5 text-white mx-auto drop-shadow" />}
                </button>
              ))}
            </div>
          </div>

          {/* icon */}
          <div>
            <label className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Icon</label>
            <div className="mt-1.5 grid grid-cols-9 gap-1.5">
              {NODE_ICON_KEYS.map((k) => {
                const active = v.icon === k;
                return (
                  <button key={k} onClick={() => set({ icon: active ? undefined : k })} title={k}
                    className={`aspect-square grid place-items-center rounded-lg border transition-colors ${active ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]"}`}>
                    <NodeIcon name={k} className="w-4 h-4" />
                  </button>
                );
              })}
            </div>
          </div>

          {/* cover image */}
          <div>
            <label className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-faint)] flex items-center gap-1.5"><ImageIcon className="w-3 h-3" /> Cover image</label>
            <div className="mt-1 flex gap-2">
              <input value={v.coverImageUrl ?? ""} onChange={(e) => set({ coverImageUrl: e.target.value || undefined })}
                placeholder={storagePrefix ? "Paste a URL or upload →" : "https://…/photo.jpg"}
                className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-sm text-[var(--color-text)]" />
              {storagePrefix && (
                <>
                  <input ref={fileRef} type="file" accept="image/*" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload(f); e.target.value = ""; }} />
                  <button onClick={() => fileRef.current?.click()} disabled={uploading}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 shrink-0">
                    {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Upload
                  </button>
                </>
              )}
            </div>
            {v.coverImageUrl && !/^(https?:|data:|blob:)/i.test(v.coverImageUrl) && (
              <p className="text-[11px] text-[var(--color-text-muted)] mt-1">Uploaded image · stored securely</p>
            )}
          </div>

          {/* tint (only meaningful with a cover) */}
          {v.coverImageUrl && (
            <div>
              <label className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Photo treatment</label>
              <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                {([["none", "Original"], ["brand", "Brand duotone"], ["mono", "Mono"]] as const).map(([key, label]) => (
                  <button key={key} onClick={() => set({ coverTint: key })}
                    className={`py-1.5 rounded-lg text-xs font-bold border ${ (v.coverTint ?? "none") === key ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)]" : "border-[var(--color-border)] text-[var(--color-text-muted)]"}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-[var(--color-border)] flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-[var(--color-accent-fg)] disabled:opacity-50" style={{ background: "var(--color-accent)" }}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
