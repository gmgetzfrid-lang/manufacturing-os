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
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary } from "@/components/ui/PageHero";
import { plural } from "@/components/admin/band";
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
import { formatBytes } from "@/lib/formatBytes";


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

  const markers = (plans ?? []).reduce((n, p) => n + p.markers.length, 0);
  const answer = !plans ? (loadError ? "Couldn't load plot plans." : "Plot plans")
    : plans.length === 0 ? "No plot plans yet."
    : `${plural(plans.length, "plot plan")}.`;
  const sub = plans && plans.length > 0
    ? `${plural(markers, "marker")} on them. Find equipment on the drawing; each marker shows that item's state.`
    : "Find equipment on the drawing. Each marker shows that item's state.";

  return (
    <PageShell width="work">
        <PageHero
          kicker="Operating areas · Map"
          title={answer}
          sub={sub}
          primary={isController ? (
            <button type="button" onClick={() => setShowCreate(true)} className={heroPrimary}>
              <Plus className="w-4 h-4" /> New plot plan
            </button>
          ) : undefined}
        >
          <div className="[&>div]:mb-0">
            <ViewTabs tabs={EQUIPMENT_VIEWS} variant="dark" />
          </div>
        </PageHero>

        <PageBody>
        {loadError && !plans ? (
          <Card>
            <p role="alert" className="text-[14px] text-red-700 dark:text-red-400">
              Couldn&apos;t load plot plans: {loadError}{" "}
              <button type="button" onClick={() => void refresh()} className="font-bold underline">Try again</button>
            </p>
          </Card>
        ) : !plans ? (
          <Card><LoadingBlock what="plot plans" className="border-0 p-0" /></Card>
        ) : plans.length === 0 ? (
          <Card className="text-center py-10">
            <div className="w-12 h-12 rounded-xl bg-[var(--color-surface-2)] mx-auto mb-3 flex items-center justify-center">
              <MapIcon className="w-6 h-6 text-[var(--color-text-muted)]" />
            </div>
            <h3 className="text-[14px] font-bold text-[var(--color-text)]">Start with one drawing</h3>
            <p className="mt-1 text-[14px] text-[var(--color-text-muted)] max-w-md mx-auto">Upload a plot plan, P&amp;ID or unit layout, then place markers on its equipment.</p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {plans.map((p) => (
              <div key={p.id} className="bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-card)] overflow-hidden hover-lift">
                <Link href={`/plot-plans/${p.id}`} className="block" aria-label={`Open ${p.name}`}>
                  <div className="aspect-video bg-[var(--color-surface-2)] flex items-center justify-center overflow-hidden">
                    {p.imagePath ? (
                      <SignedPlotImage path={p.imagePath} alt={p.name} className="w-full h-full object-cover" />
                    ) : (
                      <ImageIcon className="w-10 h-10 text-[var(--color-text-faint)]" />
                    )}
                  </div>
                </Link>
                <div className="p-4 flex items-start gap-2">
                  <Link href={`/plot-plans/${p.id}`} className="min-w-0 flex-1">
                    <div className="text-[14px] font-bold text-[var(--color-text)] truncate">{p.name}</div>
                    <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5">{p.markers.length} marker{p.markers.length === 1 ? "" : "s"}</div>
                  </Link>
                  {isController && (
                    <button type="button" onClick={() => onDelete(p)} title="Delete" aria-label={`Delete ${p.name}`} className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-red-600 hover:bg-[var(--color-surface-2)] transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        </PageBody>

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
          <span className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">Background image</span>
          <label {...drag.bind} className={`flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-6 cursor-pointer hover:border-[var(--color-text-muted)] transition-colors ${drag.ring}`}>
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
