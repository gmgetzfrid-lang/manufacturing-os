"use client";

// /plot-plans — spatial navigation. List of plot plans / P&IDs / unit layouts.
// Each is a background image with asset markers heat-mapped by operational
// state. This turns the list-based DMS into a spatial operating picture: click
// equipment on the drawing to see and advance its state, or jump to the asset.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Map as MapIcon, Plus, ImageIcon, Trash2 } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { listPlotPlans, createPlotPlan, deletePlotPlan } from "@/lib/plotPlans";
import { SignedPlotImage } from "@/components/plotPlans/SignedPlotImage";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Field";
import LoadingBlock from "@/components/ui/LoadingBlock";
import FileThumb from "@/components/ui/FileThumb";
import { useFileDrag } from "@/hooks/useFileDrag";
import { tryUpload } from "@/lib/uploadRetry";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { appConfirm } from "@/components/providers/DialogProvider";
import ViewTabs, { EQUIPMENT_VIEWS } from "@/components/navigation/ViewTabs";
import { useToast } from "@/components/providers/ToastProvider";
import type { PlotPlan } from "@/types/schema";

const formatBytes = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export default function PlotPlansPage() {
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const { showToast } = useToast();
  const router = useRouter();
  const [plans, setPlans] = useState<PlotPlan[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const isController = activeRole === "Admin" || activeRole === "DocCtrl";

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try { const data = await listPlotPlans(activeOrgId); setPlans(data); setLoadError(null); }
    catch (e) { setLoadError((e as Error).message || "Couldn't load plot plans."); }
  }, [activeOrgId]);

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
        <ViewTabs title="Operating areas" tabs={EQUIPMENT_VIEWS} />
        <PageHeaderBar
          icon={MapIcon}
          title="Plot Plans"
          subtitle="Find equipment on the drawing. Each marker shows that item's state."
          actions={isController && plans && plans.length > 0 ? (
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4" /> New plot plan
            </Button>
          ) : undefined}
        />

        {loadError && !plans ? (
          <p role="alert" className="border-l-2 border-red-500 pl-3 py-1 text-sm text-red-700 dark:text-red-400">
            Couldn&apos;t load plot plans: {loadError}{" "}
            <button type="button" onClick={() => void refresh()} className="font-bold underline">Try again</button>
          </p>
        ) : !plans ? (
          <LoadingBlock what="plot plans" />
        ) : plans.length === 0 ? (
          <EmptyState
            icon={MapIcon}
            title="No plot plans yet"
            description="Upload a plot plan, P&ID or unit layout, then place markers on its equipment."
            action={isController ? <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4" /> New plot plan</Button> : undefined}
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {plans.map((p) => (
              <div key={p.id} className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden transition-shadow hover:shadow-md">
                <Link href={`/plot-plans/${p.id}`} className="block">
                  <div className="aspect-video bg-[var(--color-surface-2)] flex items-center justify-center overflow-hidden">
                    {p.imagePath ? (
                      <SignedPlotImage path={p.imagePath} alt={p.name} className="w-full h-full object-cover" />
                    ) : (
                      <ImageIcon className="w-10 h-10 text-[var(--color-text-faint)]" />
                    )}
                  </div>
                </Link>
                <div className="p-3 flex items-start gap-2">
                  <Link href={`/plot-plans/${p.id}`} className="min-w-0 flex-1">
                    <div className="font-bold text-[var(--color-text)] truncate">{p.name}</div>
                    <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{p.markers.length} marker{p.markers.length === 1 ? "" : "s"}</div>
                  </Link>
                  {isController && (
                    <button onClick={() => onDelete(p)} title="Delete" aria-label={`Delete ${p.name}`} className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-red-600 hover:bg-[var(--color-surface-2)] transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
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
          onCreated={(plan) => { setShowCreate(false); router.push(`/plot-plans/${plan.id}`); }}
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
  onCreated: (plan: PlotPlan) => void;
}) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPick = (f: File | null) => {
    setFile(f);
    setError(null);
    if (f) {
      const img = new Image();
      const url = URL.createObjectURL(f);
      img.onload = () => { setDims({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
      img.src = url;
    } else setDims(null);
  };
  const drag = useFileDrag((files) => { const f = files.find((x) => x.type.startsWith("image/")); if (f) onPick(f); }, busy);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    // The image goes up first and the record is made after, so a retry
    // can't make the plot plan twice.
    const run = () => createPlotPlan({
      orgId, name, image: file ?? undefined,
      imageWidth: dims?.w, imageHeight: dims?.h,
      actorUserId, actorName,
    });
    try {
      const plan = file ? await tryUpload(file.name, run, { onRetried: onCreated }) : await run();
      onCreated(plan);
    } catch (e) {
      setError((e as Error).message || "Couldn't create the plot plan.");
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
          <span className="block text-[11px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5">Background image</span>
          <label {...drag.bind} className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-6 cursor-pointer hover:border-[var(--color-accent-ring)] transition-colors ${drag.ring}`}>
            {drag.over ? (
              <span className="text-xs font-bold text-[var(--color-text)]">{drag.say}</span>
            ) : file ? (
              <span className="flex items-center gap-2 min-w-0">
                <FileThumb file={file} />
                <span className="min-w-0 text-left">
                  <span className="block text-xs font-bold text-[var(--color-text)] truncate max-w-[14rem]">{file.name}</span>
                  <span className="block text-[11px] text-[var(--color-text-muted)]">{formatBytes(file.size)}{dims ? ` · ${dims.w} × ${dims.h}` : ""}</span>
                </span>
              </span>
            ) : (
              <>
                <ImageIcon className="w-6 h-6 text-[var(--color-text-faint)]" />
                <span className="text-xs font-medium text-[var(--color-text-muted)]">Plot plan, P&amp;ID or unit layout (PNG/JPG)</span>
              </>
            )}
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => { onPick(e.target.files?.[0] ?? null); e.target.value = ""; }} />
          </label>
        </div>
        {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={!name.trim()} loading={busy}>Create</Button>
      </ModalFooter>
    </Modal>
  );
}
