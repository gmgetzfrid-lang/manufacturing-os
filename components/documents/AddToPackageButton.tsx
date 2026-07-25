"use client";

// AddToPackageButton — "add this drawing to a work package" from where the
// document actually lives (the inspector), instead of only from /packages.
// Lists open packages on demand; one click pins the doc at its current rev.

import React, { useState } from "react";
import { Package, Loader2, Check, Plus } from "lucide-react";
import { listWorkPackages, addDocumentToPackage, createWorkPackage } from "@/lib/workPackages";
import { appAlert, appPrompt } from "@/components/providers/DialogProvider";
import type { DocumentRecord } from "@/types/schema";

export default function AddToPackageButton({ doc, orgId, userId, userName }: {
  doc: DocumentRecord; orgId: string; userId: string; userName?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [packages, setPackages] = useState<Array<{ id: string; name: string }>>([]);
  const [addedTo, setAddedTo] = useState<string | null>(null);

  const loadPackages = async () => {
    setLoading(true);
    try {
      const pkgs = await listWorkPackages(orgId, { includeClosed: false });
      setPackages(pkgs.map((p) => ({ id: p.id, name: p.name })));
    } catch { setPackages([]); }
    finally { setLoading(false); }
  };

  const addTo = async (packageId: string, name: string) => {
    if (!doc.id) return;
    try {
      await addDocumentToPackage({
        packageId, orgId,
        doc: { id: doc.id, rev: doc.rev ?? null, currentVersionId: doc.currentVersionId ?? null },
        actorName: userName ?? null,
      });
      setAddedTo(name);
      setTimeout(() => { setAddedTo(null); setOpen(false); }, 1400);
    } catch (e) {
      await appAlert({ message: `Couldn't add to the package: ${(e as Error).message}`, tone: "danger" });
    }
  };

  const createAndAdd = async () => {
    const name = await appPrompt({
      title: "New work package",
      message: "Name the package (e.g. the job or outage it's for). This drawing is added pinned at its current revision.",
      placeholder: "TA-2026 Exchanger bundle",
    });
    if (!name?.trim() || !doc.id) return;
    try {
      const pkgId = await createWorkPackage({
        orgId, name: name.trim(),
        documentIds: [doc.id],
        actorUserId: userId,
        actorName: userName ?? "",
      });
      void pkgId;
      setAddedTo(name.trim());
      setTimeout(() => { setAddedTo(null); setOpen(false); }, 1400);
    } catch (e) {
      await appAlert({ message: `Couldn't create the package: ${(e as Error).message}`, tone: "danger" });
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => { setOpen((v) => !v); if (!open) void loadPackages(); }}
        className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-teal-200 bg-teal-50 text-xs font-bold text-teal-800 hover:bg-teal-100 transition-all"
        title="Pin this drawing (at its current revision) into a job's work package"
      >
        <Package className="w-3.5 h-3.5" /> Add to work package
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl p-1.5 space-y-0.5">
          {addedTo ? (
            <div className="px-2 py-2 text-xs font-bold text-emerald-700 inline-flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" /> Added to {addedTo}
            </div>
          ) : loading ? (
            <div className="px-2 py-2 text-xs text-[var(--color-text-muted)] inline-flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading packages…
            </div>
          ) : (
            <>
              {packages.map((p) => (
                <button key={p.id} onClick={() => void addTo(p.id, p.name)}
                  className="w-full text-left px-2 py-1.5 rounded-lg text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] truncate">
                  {p.name}
                </button>
              ))}
              {packages.length === 0 && (
                <div className="px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">No open packages yet.</div>
              )}
              <button onClick={() => void createAndAdd()}
                className="w-full text-left px-2 py-1.5 rounded-lg text-xs font-bold text-teal-700 hover:bg-teal-50 inline-flex items-center gap-1.5">
                <Plus className="w-3 h-3" /> New package with this drawing…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
