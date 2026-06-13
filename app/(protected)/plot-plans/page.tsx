"use client";

// /plot-plans — spatial navigation. List of plot plans / P&IDs / unit layouts.
// Each is a background image with asset markers heat-mapped by operational
// state. This turns the list-based DMS into a spatial operating picture: click
// equipment on the drawing to see and advance its state, or jump to the asset.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Map as MapIcon, Plus, ImageIcon, Trash2 } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { listPlotPlans, createPlotPlan, deletePlotPlan } from "@/lib/plotPlans";
import { SignedPlotImage } from "@/components/plotPlans/SignedPlotImage";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { appConfirm } from "@/components/providers/DialogProvider";
import ViewTabs, { EQUIPMENT_VIEWS } from "@/components/navigation/ViewTabs";
import { useToast } from "@/components/providers/ToastProvider";
import type { PlotPlan } from "@/types/schema";

export default function PlotPlansPage() {
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const { showToast } = useToast();
  const [plans, setPlans] = useState<PlotPlan[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const isController = activeRole === "Admin" || activeRole === "DocCtrl";

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try { const data = await listPlotPlans(activeOrgId); setPlans(data); }
    catch (e) { showToast({ type: "error", title: "Couldn't load plot plans", message: (e as Error).message }); }
  }, [activeOrgId, showToast]);

  useEffect(() => { void (async () => { await refresh(); })(); }, [refresh]);

  const onDelete = async (p: PlotPlan) => {
    if (!(await appConfirm({
      title: `Delete plot plan "${p.name}"?`,
      message: "Markers are removed; assets are untouched.",
      tone: "danger",
    }))) return;
    try { await deletePlotPlan(p.id); await refresh(); }
    catch (e) { showToast({ type: "error", title: "Delete failed", message: (e as Error).message }); }
  };

  return (
    <PageShell width="work">
        <ViewTabs title="Equipment" tabs={EQUIPMENT_VIEWS} />
        <PageHeaderBar
          icon={MapIcon}
          title="Plot Plans"
          subtitle="Navigate documents and equipment spatially. Markers are colored by operational state."
          actions={isController ? (
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4" /> New plot plan
            </Button>
          ) : undefined}
        />

        {!plans ? (
          <div className="flex justify-center py-20"><Spinner /></div>
        ) : plans.length === 0 ? (
          <EmptyState
            icon={MapIcon}
            title="No plot plans yet"
            description="Upload a plot plan, P&ID, or unit layout, then drop markers on the equipment it shows. Each marker glows with that asset's live operational state."
            action={isController ? <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4" /> New plot plan</Button> : undefined}
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {plans.map((p) => (
              <div key={p.id} className="group relative bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden transition-all hover:shadow-md hover:-translate-y-0.5">
                <Link href={`/plot-plans/${p.id}`} className="block">
                  <div className="aspect-video bg-[var(--color-surface-2)] flex items-center justify-center overflow-hidden">
                    {p.imagePath ? (
                      <SignedPlotImage path={p.imagePath} alt={p.name} className="w-full h-full object-cover" />
                    ) : (
                      <ImageIcon className="w-10 h-10 text-slate-300" />
                    )}
                  </div>
                  <div className="p-3">
                    <div className="font-bold text-[var(--color-text)] truncate">{p.name}</div>
                    <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{p.markers.length} marker{p.markers.length === 1 ? "" : "s"}</div>
                  </div>
                </Link>
                {isController && (
                  <button onClick={() => onDelete(p)} title="Delete" className="absolute top-2 right-2 p-1.5 rounded-lg bg-white/90 text-[var(--color-text-faint)] hover:text-red-600 shadow opacity-0 group-hover:opacity-100 transition">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

      {showCreate && activeOrgId && uid && (
        <CreatePlotPlanModal
          orgId={activeOrgId}
          actorUserId={uid}
          actorName={userEmail ?? undefined}
          onClose={() => setShowCreate(false)}
          onCreated={async () => { setShowCreate(false); await refresh(); }}
        />
      )}
    </PageShell>
  );
}

function CreatePlotPlanModal({
  orgId, actorUserId, actorName, onClose, onCreated,
}: {
  orgId: string;
  actorUserId: string;
  actorName?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { showToast } = useToast();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const onPick = (f: File | null) => {
    setFile(f);
    if (f) {
      const img = new Image();
      img.onload = () => setDims({ w: img.naturalWidth, h: img.naturalHeight });
      img.src = URL.createObjectURL(f);
    } else setDims(null);
  };

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await createPlotPlan({
        orgId, name, image: file ?? undefined,
        imageWidth: dims?.w, imageHeight: dims?.h,
        actorUserId, actorName,
      });
      onCreated();
    } catch (e) {
      showToast({ type: "error", title: "Couldn't create", message: (e as Error).message });
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} size="sm">
      <ModalHeader icon={MapIcon} title="New plot plan" onClose={onClose} />
      <ModalBody className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Unit 200 Plot Plan" />
        </Field>
        <div>
          <span className="block text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5">Background image</span>
          <label className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-6 cursor-pointer hover:border-[var(--color-accent-ring)] transition-colors">
            <ImageIcon className="w-6 h-6 text-[var(--color-text-faint)]" />
            <span className="text-xs font-medium text-[var(--color-text-muted)]">{file ? file.name : "Plot plan, P&ID, or unit layout (PNG/JPG)"}</span>
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
          </label>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={!name.trim()} loading={busy}>Create</Button>
      </ModalFooter>
    </Modal>
  );
}
