"use client";

// LogoUploadModal — a lightweight, in-place way to add or change the workspace
// logo straight from the sidebar (Admins only). Full palette/branding control
// still lives at /admin/branding; this just handles the logo so you don't have
// to hunt for the page.

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { X, Upload, Trash2, Loader2, Image as ImageIcon } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useOrgBranding } from "@/components/providers/OrgBrandingProvider";
import { uploadToPath } from "@/lib/storage";

export default function LogoUploadModal({ onClose }: { onClose: () => void }) {
  const { activeOrgId } = useRole();
  const { branding, logoUrl, save } = useOrgBranding();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shape, setShape] = useState<"mark" | "full">(branding?.logoShape ?? "full");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pick = async (file: File | undefined | null) => {
    if (!file || !activeOrgId) return;
    if (!file.type.startsWith("image/")) { setError("Please choose an image file."); return; }
    setBusy(true); setError(null);
    try {
      const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
      const rand = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}`;
      const path = `orgs/${activeOrgId}/branding/logo-${rand}.${ext}`;
      await uploadToPath(file, path, { contentType: file.type });
      await save({ ...branding, logoPath: path, logoShape: shape });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true); setError(null);
    try {
      await save({ ...branding, logoPath: undefined, logoShape: shape });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <h2 className="text-sm font-black text-[var(--color-text)]">Workspace logo</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)] h-24 grid place-items-center overflow-hidden p-2">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- signed storage URL
              <img src={logoUrl} alt="Workspace logo" className="max-h-16 max-w-[80%] object-contain" draggable={false} />
            ) : (
              <div className="text-xs text-[var(--color-text-muted)] flex items-center gap-2"><ImageIcon className="w-4 h-4" /> No logo yet</div>
            )}
          </div>

          <div>
            <div className="text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-widest mb-1.5">Display as</div>
            <div className="flex bg-[var(--color-surface-2)] p-1 rounded-lg w-fit">
              {(["full", "mark"] as const).map((s) => (
                <button key={s} onClick={() => setShape(s)}
                  className={`px-3 py-1.5 text-xs font-bold rounded-md transition-colors ${shape === s ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                  {s === "full" ? "Full logo" : "Mark / icon"}
                </button>
              ))}
            </div>
          </div>

          {error && <div className="text-xs text-red-600">{error}</div>}

          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
          <button onClick={() => fileRef.current?.click()} disabled={busy}
            className="w-full py-2.5 rounded-xl bg-[var(--color-accent)] text-white font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-60 hover:opacity-90 transition-opacity">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {logoUrl ? "Replace logo" : "Upload logo"}
          </button>

          {logoUrl && (
            <button onClick={remove} disabled={busy}
              className="w-full py-2 rounded-xl text-xs font-bold text-red-600 hover:bg-red-50 flex items-center justify-center gap-1.5 disabled:opacity-60 transition-colors">
              <Trash2 className="w-3.5 h-3.5" /> Remove logo
            </button>
          )}

          <Link href="/admin/branding" onClick={onClose}
            className="block text-center text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors">
            Full branding settings (colors &amp; palette) →
          </Link>
        </div>
      </div>
    </div>
  );
}
