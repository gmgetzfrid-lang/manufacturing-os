"use client";

// AddToPackageButton — "add this drawing to a work package" from where the
// document actually lives (the inspector), instead of only from /packages.
// Lists open packages on demand; one click pins the doc at its current rev.

import React, { useEffect, useRef, useState } from "react";
import { Package, Loader2, Check, Plus } from "lucide-react";
import { listWorkPackages, addDocumentToPackage, createWorkPackage } from "@/lib/workPackages";
import { appAlert, appPrompt } from "@/components/providers/DialogProvider";
import type { DocumentRecord } from "@/types/schema";

export default function AddToPackageButton({ doc, orgId, userId, userName, openSignal = 0, hideTrigger = false }: {
  doc: DocumentRecord; orgId: string; userId: string; userName?: string | null;
  /** Bump to open the list from elsewhere (a More menu); hideTrigger drops the button. */
  openSignal?: number; hideTrigger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [packages, setPackages] = useState<Array<{ id: string; name: string }>>([]);
  const [addedTo, setAddedTo] = useState<string | null>(null);

  const seen = useRef(openSignal);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (openSignal === seen.current) return;
    seen.current = openSignal; setOpen(true); void loadPackages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);
  // Tap outside closes it.
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    const t = setTimeout(() => document.addEventListener("mousedown", h), 0);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", h); };
  }, [open]);
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
    <div className="relative" ref={boxRef}>
      {!hideTrigger && <button
        onClick={() => { setOpen((v) => !v); if (!open) void loadPackages(); }}
        className="inline-flex items-center justify-center gap-1.5 h-10 px-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-all"
        title="Pin this drawing (at its current revision) into a job's work package"
      >
        <Package className="w-3.5 h-3.5" /> Work package
      </button>}
      {open && (
        <div className="absolute z-30 mt-1 w-64 left-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl p-1.5 space-y-0.5">
          {addedTo ? (
            <div className="px-2 py-2 text-[13px] font-bold text-emerald-700 inline-flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" /> Added to {addedTo}
            </div>
          ) : loading ? (
            <div className="px-2 py-2 text-[13px] text-[var(--color-text-muted)] inline-flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading packages…
            </div>
          ) : (
            <>
              {packages.map((p) => (
                <button key={p.id} onClick={() => void addTo(p.id, p.name)}
                  className="w-full text-left px-2 py-1.5 rounded-lg text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] truncate">
                  {p.name}
                </button>
              ))}
              {packages.length === 0 && (
                <div className="px-2 py-1.5 text-[13px] text-[var(--color-text-muted)]">No open packages yet.</div>
              )}
              <button onClick={() => void createAndAdd()}
                className="w-full text-left px-2 py-1.5 rounded-lg text-[13px] font-bold text-[var(--color-accent-text)] hover:bg-[var(--color-surface-2)] inline-flex items-center gap-1.5">
                <Plus className="w-3 h-3" /> New package with this drawing…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
