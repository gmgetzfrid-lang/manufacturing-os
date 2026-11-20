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
import { humanDate } from "@/components/documents/StatusTag";
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
  const sub = "Find equipment on the drawing. Each marker shows that item's state.";
  const facts = plans && plans.length > 0 ? [
    { label: "Markers", value: markers.toLocaleString() },
    { label: "No image", value: plans.filter((p) => !p.imagePath).length.toLocaleString() },
  ] : undefined;

  return (
    <PageShell width="work">
        <PageHero
          kicker="Operating areas"
          title={answer}
          sub={sub}
          facts={facts}
          primary={isController ? (
            <button type="button" onClick={() => setShowCreate(true)} className={heroPrimary}>
              <Plus className="w-4 h-4" /> New plot plan
            </button>
          ) : undefined}
        >
          <div className="[&>div]:mb-0">
            <ViewTabs tabs={EQUIPMENT_VIEWS} />
          </div>
        </PageHero>

        <PageBody>
        {loadError && !plans ? (
          <Card>
            <p role="alert" className="text-[15px] font-semibold text-[var(--state-overdue)]">
              Couldn&apos;t load plot plans: {loadError}{" "}
              <button type="button" onClick={() => void refresh()} className="font-normal text-[var(--color-accent-text)] hover:underline">Try again</button>
            </p>
          </Card>
        ) : !plans ? (
          <Card><LoadingBlock what="plot plans" className="border-0 p-0" /></Card>
        ) : plans.length === 0 ? (
          <Card>
            <div className="flex items-start gap-3">
              <MapIcon className="w-5 h-5 mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
              <div>
                <h2 className="text-[15px] font-semibold text-[var(--color-text)]">Start with one drawing</h2>
                <p className="mt-0.5 text-[15px] text-[var(--color-text-muted)]">Upload a plot plan, P&amp;ID or unit layout, then place markers on its equipment.</p>
              </div>
            </div>
          </Card>
        ) : (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            <table className="w-full text-[15px]">
              <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left max-sm:hidden">
                <tr>
                  <th className="font-semibold px-4 h-10 w-[128px]"><span className="sr-only">Drawing</span></th>
                  <th className="font-semibold px-4">Plot plan</th>
                  <th className="font-semibold px-4 text-right w-28">Markers</th>
                  <th className="font-semibold px-4 w-32 hidden md:table-cell">Added</th>
                  <th className="w-14"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
              {plans.map((p) => (
                <tr key={p.id} className="hover:bg-[var(--color-surface-2)] cursor-pointer" onClick={() => router.push(`/plot-plans/${p.id}`)}>
                  <td className="pl-4 pr-2 py-2.5 w-[112px] sm:w-[128px]">
                    <div className="w-24 aspect-video rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-center overflow-hidden">
                      {p.imagePath ? (
                        <SignedPlotImage path={p.imagePath} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <ImageIcon className="w-5 h-5 text-[var(--color-text-faint)]" />
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 max-sm:pl-1">
                    <Link href={`/plot-plans/${p.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{p.name}</Link>
                    {p.description && <div className="text-[13px] text-[var(--color-text-muted)] truncate max-w-[60ch]">{p.description}</div>}
                    <div className="sm:hidden text-[13px] text-[var(--color-text-muted)]">{plural(p.markers.length, "marker")}</div>
                  </td>
                  <td className="px-4 py-2.5 text-right font-display text-[17px] font-semibold tabular-nums max-sm:hidden">{p.markers.length.toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-[14px] hidden md:table-cell">{humanDate(p.createdAt)}</td>
                  <td className="pr-3 py-2.5 text-right">
                    {isController && (
                      <button type="button" onClick={(e) => { e.stopPropagation(); void onDelete(p); }} title="Delete" aria-label={`Delete ${p.name}`}
                        className="inline-grid w-8 h-8 place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--state-overdue)] hover:bg-[var(--color-surface-2)] transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              </tbody>
            </table>
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
          <label {...drag.bind} className={`flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-6 cursor-pointer hover:border-[var(--color-text-muted)] transition-colors ${drag.ring}`}>
            {drag.over ? (
              <span className="text-[14px] font-semibold text-[var(--color-text)]">{drag.say}</span>
            ) : file ? (
              <span className="flex items-center gap-2 min-w-0">
                <FileThumb file={file} />
                <span className="min-w-0 text-left">
                  <span className="block text-[14px] font-semibold text-[var(--color-text)] truncate max-w-[14rem]">{file.name}</span>
                  <span className="block text-[13px] text-[var(--color-text-muted)]">{formatBytes(file.size)}{dims ? ` · ${dims.w} × ${dims.h}` : ""}</span>
                </span>
              </span>
            ) : (
              <>
                <ImageIcon className="w-6 h-6 text-[var(--color-text-faint)]" />
                <span className="text-[14px] text-[var(--color-text-muted)]">Plot plan, P&amp;ID or unit layout (PNG or JPG)</span>
              </>
            )}
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => { onPick(e.target.files?.[0] ?? null); e.target.value = ""; }} />
          </label>
        </div>
        {error && <p role="alert" className="text-[14px] font-semibold text-[var(--state-overdue)]">{error}</p>}
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={!name.trim()} loading={busy}>Create</Button>
      </ModalFooter>
    </Modal>
  );
}
