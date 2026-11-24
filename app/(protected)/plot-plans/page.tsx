"use client";

// /plot-plans — spatial navigation. List of plot plans / P&IDs / unit layouts.
// Each is a background image with asset markers heat-mapped by operational
// state. This turns the list-based DMS into a spatial operating picture: click
// equipment on the drawing to see and advance its state, or jump to the asset.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, ImageIcon, Trash2, ExternalLink } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { listPlotPlans, createPlotPlan, deletePlotPlan } from "@/lib/plotPlans";
import { SignedPlotImage } from "@/components/plotPlans/SignedPlotImage";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary } from "@/components/ui/PageHero";
import { humanDate } from "@/components/documents/StatusTag";
import { plural } from "@/components/admin/band";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Field";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SkeletonRows } from "@/components/ui/Skeleton";
import MoreMenu from "@/components/ui/MoreMenu";
import { btnIcon, btnQuiet, Problem } from "@/components/admin/kit";
import { friendlyError } from "@/lib/friendlyError";
import { transitionPush } from "@/lib/viewTransition";
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
  const [loadError, setLoadError] = useState<unknown>(null);
  const [showCreate, setShowCreate] = useState(false);

  const isController = activeRole === "Admin" || activeRole === "DocCtrl";

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try { const data = await listPlotPlans(activeOrgId); setPlans(data); setLoadError(null); }
    catch (e) { setLoadError(e ?? true); }
  }, [activeOrgId]);

  useEffect(() => { void (async () => { await refresh(); })(); }, [refresh]);

  const onDelete = async (p: PlotPlan) => {
    if (!(await appConfirm({
      title: `Delete ${p.name}?`,
      message: "Its markers go with it. The equipment itself is untouched.",
      confirmLabel: "Delete",
      tone: "danger",
    }))) return;
    try { await deletePlotPlan(p.id); await refresh(); }
    catch (e) { showToast({ type: "error", title: "Couldn't delete it", message: friendlyError(e) }); }
  };

  const markers = (plans ?? []).reduce((n, p) => n + p.markers.length, 0);
  const answer = !plans ? (loadError ? "Couldn't load plot plans." : "Plot plans")
    : plans.length === 0 ? "No plot plans yet."
    : `${plural(plans.length, "plot plan")}, ${plural(markers, "marker")}.`;
  const sub = "Find equipment on the drawing. Each marker shows that item's state.";
  const noImage = (plans ?? []).filter((p) => !p.imagePath).length;
  const facts = plans && plans.length > 0 && noImage > 0 ? [
    { label: "No drawing yet", value: noImage.toLocaleString(), tone: "warn" as const },
  ] : undefined;
  const open = (p: PlotPlan) => transitionPush(router, `/plot-plans/${p.id}`);

  return (
    <PageShell width="work">
        <PageHero
          kicker="Operating areas"
          title={answer}
          sub={sub}
          facts={facts}
          factsHero="none"
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
        {!!loadError && !plans ? (
          <ErrorNote error={loadError} title="Couldn't load the plot plans." onRetry={() => void refresh()} />
        ) : !plans ? (
          <SkeletonRows rows={4} cols={2} what="plot plans" />
        ) : plans.length === 0 ? (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-6 flex items-center gap-x-4 gap-y-3 flex-wrap">
            <p className="flex-1 min-w-[16rem] text-reading text-[var(--color-text-muted)]">Upload a plot plan, P&amp;ID or unit layout, then place markers on its equipment.</p>
            {isController && <button type="button" onClick={() => setShowCreate(true)} className={btnQuiet}><Plus className="w-4 h-4" /> Upload the first drawing</button>}
          </div>
        ) : (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            <table className="w-full text-body tabular-nums">
              <thead className="bg-[var(--color-surface-2)] text-body text-[var(--color-text-muted)] text-left max-sm:hidden">
                <tr>
                  <th className="font-medium px-4 h-10 w-[128px]"><span className="sr-only">Drawing</span></th>
                  <th className="font-medium px-4">Plot plan</th>
                  <th className="font-medium px-4 text-right w-28">Markers</th>
                  <th className="font-medium px-4 w-44 hidden md:table-cell">Last change</th>
                  <th className="w-14"><span className="sr-only">More</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
              {plans.map((p) => {
                const changed = p.updatedAt && p.createdAt && p.updatedAt > p.createdAt ? `Changed ${humanDate(p.updatedAt)}` : `Added ${humanDate(p.createdAt)}${p.createdByName ? ` by ${p.createdByName}` : ""}`;
                return (
                <tr key={p.id} className="hover:bg-[var(--color-surface-2)] cursor-pointer" onClick={() => open(p)}>
                  <td className="pl-4 pr-2 py-2.5 w-[112px] sm:w-[128px]">
                    <div className="w-24 aspect-video rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-faint)] flex items-center justify-center overflow-hidden">
                      {p.imagePath ? (
                        <SignedPlotImage path={p.imagePath} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <ImageIcon aria-hidden className="w-5 h-5" />
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 max-sm:pl-1 min-w-0">
                    <Link href={`/plot-plans/${p.id}`} onClick={(e) => e.stopPropagation()} className="text-reading font-medium text-[var(--color-text)] hover:text-[var(--color-accent-text)] hover:underline underline-offset-2">{p.name}</Link>
                    {p.description && <div className="text-body text-[var(--color-text-muted)] truncate max-w-[60ch]">{p.description}</div>}
                    {!p.imagePath && <div className="mt-0.5"><span className="ui-pill is-warn">No drawing yet</span></div>}
                    <div className="sm:hidden mt-0.5 text-body text-[var(--color-text-muted)]">{plural(p.markers.length, "marker")} · {changed}</div>
                  </td>
                  <td className={`px-4 py-2.5 text-right max-sm:hidden ${p.markers.length === 0 ? "text-[var(--color-text-faint)]" : "text-[var(--color-text)]"}`}>{p.markers.length.toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-body text-[var(--color-text-muted)] hidden md:table-cell">{changed}</td>
                  <td className="pr-3 py-2.5 text-right">
                    <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
                      <MoreMenu iconOnly label={`More for ${p.name}`} triggerClass={btnIcon} items={[
                        { icon: <ExternalLink className="w-4 h-4" />, label: "Open", onClick: () => open(p) },
                        ...(isController ? [{ icon: <Trash2 className="w-4 h-4" />, label: "Delete", tone: "bad" as const, line: true, onClick: () => void onDelete(p) }] : []),
                      ]} />
                    </span>
                  </td>
                </tr>
                );
              })}
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
      setError(`Couldn't create the plot plan. ${friendlyError(e)}`);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} size="sm">
      <ModalHeader title="New plot plan" onClose={onClose} />
      <ModalBody className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Unit 200 plot plan" autoComplete="off" />
        </Field>
        <div>
          <span className="block text-body font-medium text-[var(--color-text)] mb-1.5">Drawing</span>
          <label {...drag.bind} className={`flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-6 cursor-pointer hover:border-[var(--color-text-muted)] transition-colors ${drag.ring}`}>
            {drag.over ? (
              <span className="text-body font-medium text-[var(--color-text)]">{drag.say}</span>
            ) : file ? (
              <span className="flex items-center gap-2 min-w-0">
                <FileThumb file={file} />
                <span className="min-w-0 text-left">
                  <span className="block text-body font-medium text-[var(--color-text)] truncate max-w-[14rem]">{file.name}</span>
                  <span className="block text-body text-[var(--color-text-muted)]">{formatBytes(file.size)}{dims ? ` · ${dims.w} × ${dims.h}` : ""}</span>
                </span>
              </span>
            ) : (
              <>
                <ImageIcon className="w-6 h-6 text-[var(--color-text-faint)]" />
                <span className="text-body text-[var(--color-text-muted)]">Plot plan, P&amp;ID or unit layout (PNG or JPG)</span>
              </>
            )}
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => { onPick(e.target.files?.[0] ?? null); e.target.value = ""; }} />
          </label>
        </div>
        {error && <Problem>{error}</Problem>}
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant={name.trim() ? "primary" : "secondary"} onClick={submit} disabled={!name.trim()} loading={busy}>Create</Button>
      </ModalFooter>
    </Modal>
  );
}
