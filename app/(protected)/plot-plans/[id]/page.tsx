"use client";

// /plot-plans/[id] — the spatial board. A background drawing with asset markers
// heat-mapped by operational state. View mode: tap a marker to see/advance its
// state or jump to the asset. Edit mode (controllers): place markers by picking
// an asset then clicking the drawing, drag to reposition, save.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Pencil, X, MapPin, Search, ExternalLink, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CopyId } from "@/components/ui/CopyId";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { friendlyError } from "@/lib/friendlyError";
import { useRole } from "@/components/providers/RoleContext";
import { getPlotPlan, saveMarkers } from "@/lib/plotPlans";
import { listAssets, type Asset } from "@/lib/assets";
import { STATE_CONFIG, WHITEBOARD_STATES, nextState, setEquipmentState } from "@/lib/whiteboard";
import { SignedPlotImage } from "@/components/plotPlans/SignedPlotImage";
import { useToast } from "@/components/providers/ToastProvider";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import type { PlotPlan, PlotPlanMarker, WhiteboardState } from "@/types/schema";

export default function PlotPlanBoard() {
  const params = useParams();
  const id = String(params?.id ?? "");
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const { showToast } = useToast();
  const isController = activeRole === "Admin" || activeRole === "DocCtrl";

  const [plan, setPlan] = useState<PlotPlan | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [markers, setMarkers] = useState<PlotPlanMarker[]>([]);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [placingAssetId, setPlacingAssetId] = useState<string | null>(null);
  const [selectedMarker, setSelectedMarker] = useState<string | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");
  const imgWrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ assetId: string } | null>(null);

  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  const load = useCallback(async () => {
    if (!activeOrgId || !id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [p, a] = await Promise.all([getPlotPlan(id), listAssets({ orgId: activeOrgId, archived: false })]);
      setPlan(p);
      setMarkers(p?.markers ?? []);
      setAssets(a);
    } catch (e) {
      setLoadError(e ?? true);
    } finally { setLoading(false); }
  }, [activeOrgId, id]);

  useEffect(() => { void load(); }, [load]);

  // Warn before leaving with unsaved marker edits.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const pctFromEvent = (clientX: number, clientY: number) => {
    const el = imgWrapRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * 100;
    const y = ((clientY - r.top) / r.height) * 100;
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
  };

  const onBoardClick = (e: React.MouseEvent) => {
    if (!editing || !placingAssetId) return;
    const pt = pctFromEvent(e.clientX, e.clientY);
    if (!pt) return;
    setMarkers((prev) => {
      const without = prev.filter((m) => m.assetId !== placingAssetId);
      return [...without, { assetId: placingAssetId, xPct: pt.x, yPct: pt.y }];
    });
    setDirty(true);
    setPlacingAssetId(null);
  };

  // Drag an existing marker (pointer events → works on touch too).
  const onMarkerPointerDown = (e: React.PointerEvent, assetId: string) => {
    if (!editing) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { assetId };
  };
  const onBoardPointerMove = (e: React.PointerEvent) => {
    if (!editing || !dragRef.current) return;
    const pt = pctFromEvent(e.clientX, e.clientY);
    if (!pt) return;
    const { assetId } = dragRef.current;
    setMarkers((prev) => prev.map((m) => (m.assetId === assetId ? { ...m, xPct: pt.x, yPct: pt.y } : m)));
    setDirty(true);
  };
  const onBoardPointerUp = () => { dragRef.current = null; };

  const removeMarker = (assetId: string) => {
    setMarkers((prev) => prev.filter((m) => m.assetId !== assetId));
    setDirty(true);
    setSelectedMarker(null);
  };

  const save = async () => {
    if (!uid) { showToast({ type: "error", title: "Couldn't save yet", message: "Your sign-in is still loading. Try again in a moment." }); return; }
    setSaving(true);
    setSaved(false);
    try {
      await saveMarkers({ id, markers, actorUserId: uid });
      setDirty(false);
      // "Saved" shows in the button for a moment, then the board leaves edit mode.
      setSaved(true);
      window.setTimeout(() => { setEditing(false); setSaved(false); }, 900);
    } catch (e) {
      showToast({ type: "error", title: "Couldn't save the markers", message: friendlyError(e) });
    } finally { setSaving(false); }
  };

  const advanceState = async (asset: Asset) => {
    if (!uid || !activeOrgId) return;
    const cur = (asset.whiteboard_state ?? "pending") as WhiteboardState;
    const next = nextState(cur);
    try {
      await setEquipmentState({ assetId: asset.id, orgId: activeOrgId, newState: next, previousState: cur, actorUserId: uid, actorEmail: userEmail ?? undefined, actorRole: activeRole ?? undefined });
      setAssets((prev) => prev.map((a) => (a.id === asset.id ? { ...a, whiteboard_state: next } : a)));
    } catch (e) {
      showToast({ type: "error", title: "Couldn't change its state", message: friendlyError(e) });
    }
  };

  const setBlocked = async (asset: Asset) => {
    if (!uid || !activeOrgId) return;
    try {
      await setEquipmentState({ assetId: asset.id, orgId: activeOrgId, newState: "blocked", previousState: (asset.whiteboard_state ?? "pending") as WhiteboardState, actorUserId: uid, actorEmail: userEmail ?? undefined, actorRole: activeRole ?? undefined });
      setAssets((prev) => prev.map((a) => (a.id === asset.id ? { ...a, whiteboard_state: "blocked" } : a)));
    } catch (e) { showToast({ type: "error", title: "Couldn't change its state", message: friendlyError(e) }); }
  };

  // Live state counts across markers.
  const counts = useMemo(() => {
    const c: Record<WhiteboardState, number> = { pending: 0, drafting: 0, executing: 0, completed: 0, blocked: 0 };
    for (const m of markers) {
      const a = assetById.get(m.assetId);
      const s = (a?.whiteboard_state ?? "pending") as WhiteboardState;
      c[s]++;
    }
    return c;
  }, [markers, assetById]);

  const placedIds = useMemo(() => new Set(markers.map((m) => m.assetId)), [markers]);
  const pickerAssets = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase();
    return assets
      .filter((a) => !placedIds.has(a.id))
      .filter((a) => !q || a.tag.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q))
      .slice(0, 50);
  }, [assets, placedIds, pickerSearch]);

  const back = { href: "/plot-plans", label: "Back to plot plans" };
  if (loading) return (
    <PageShell width="full">
      <PageHero kicker="Operating areas" title="Plot plan" back={back} size="md" overlap={false} />
      <PageBody><SkeletonRows rows={6} cols={1} what="the plot plan" /></PageBody>
    </PageShell>
  );
  if (loadError || !plan) {
    return (
      <PageShell width="full">
        <PageHero kicker="Operating areas" back={back} size="md"
          title={loadError ? "Couldn't load this plot plan." : "Plot plan not found."} />
        <PageBody>
          {loadError ? (
            <ErrorNote error={loadError} title="Couldn't load this plot plan." onRetry={() => void load()} />
          ) : (
            <Card>
              <p className="text-reading text-[var(--color-text-muted)]">It may have been deleted. <Link href="/plot-plans" className="text-[var(--color-accent-text)] hover:underline">See all plot plans</Link></p>
            </Card>
          )}
        </PageBody>
      </PageShell>
    );
  }

  const selAsset = selectedMarker ? assetById.get(selectedMarker) : null;
  const selMarker = selectedMarker ? markers.find((m) => m.assetId === selectedMarker) : null;
  // The answer: where the equipment on this drawing stands.
  const total = markers.length;
  const answer = total === 0 ? "Nothing placed yet."
    : counts.blocked > 0 ? `${counts.blocked} blocked.`
    : counts.completed === total ? `All ${total} done.`
    : `${counts.completed} of ${total} done.`;
  const facts = total === 0 ? undefined : [
    ...(counts.blocked > 0 ? [{ label: "Done", value: `${counts.completed} of ${total}` }] : []),
    { label: "Markers", value: total.toLocaleString() },
  ];
  const cancelEdit = () => { setMarkers(plan.markers); setDirty(false); setEditing(false); setPlacingAssetId(null); };

  return (
    <PageShell width="full">
      <PageHero
        kicker={<>Operating areas / {plan.name}</>}
        back={back}
        size="md"
        title={answer}
        facts={facts}
        sub={<>{plan.name}{dirty ? <span className="ml-3 font-medium text-[var(--state-held)]">Unsaved changes</span> : null}</>}
        tools={isController ? (editing ? (
          <button type="button" onClick={cancelEdit} className={heroQuiet}><X className="w-4 h-4" /> Cancel</button>
        ) : (
          <button type="button" onClick={() => { setEditing(true); setSelectedMarker(null); }} className={heroQuiet}><Pencil className="w-4 h-4" /> Edit markers</button>
        )) : undefined}
        primary={isController && editing ? (
          <Button loading={saving} done={saved} doneLabel="Saved" onClick={() => void save()} disabled={!dirty && !saved}>Save markers</Button>
        ) : undefined}
      >
        {/* Legend: how many markers sit in each state. */}
        <ul className="flex items-center gap-x-4 gap-y-2 flex-wrap" aria-label="Marker states">
          {WHITEBOARD_STATES.map((st) => (
            <li key={st} className="inline-flex items-center gap-1.5 text-body font-medium text-[var(--color-text)]">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: STATE_CONFIG[st].hex }} />
              {STATE_CONFIG[st].label} <span className="font-display tabular-nums text-[var(--color-text-muted)]">{counts[st]}</span>
            </li>
          ))}
        </ul>
      </PageHero>

      <PageBody>
      <Card pad={false} className="overflow-hidden">
      <div className="flex flex-col md:flex-row min-h-[50vh]">
        {/* Edit-mode asset picker rail */}
        {editing && (
          <div className="md:w-64 shrink-0 border-b md:border-b-0 md:border-r border-[var(--color-border)] flex flex-col max-h-72 md:max-h-none">
            <div className="p-4 border-b border-[var(--color-border)]">
              <label htmlFor="pp-pick" className="block text-body font-medium text-[var(--color-text)] mb-1.5">Place equipment</label>
              <div className="relative">
                <Search aria-hidden className="w-4 h-4 text-[var(--color-text-faint)] absolute left-3 top-1/2 -translate-y-1/2" />
                <input id="pp-pick" value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} placeholder="e.g. P-2001" autoComplete="off" enterKeyHint="search" className="w-full h-10 pointer-coarse:h-11 pl-9 pr-2 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] text-[var(--color-text)] text-reading placeholder:text-[var(--color-text-faint)]" />
              </div>
              {placingAssetId && <p role="status" className="mt-2 text-body text-[var(--color-text)]">Now tap the drawing to place <span className="font-display font-semibold tabular-nums">{assetById.get(placingAssetId)?.tag}</span>.</p>}
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {pickerAssets.length === 0 ? (
                <div className="text-center text-body text-[var(--color-text-muted)] py-6">{placedIds.size > 0 ? "All matching assets are placed." : "No equipment found."}</div>
              ) : pickerAssets.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setPlacingAssetId(a.id)}
                  type="button"
                  aria-pressed={placingAssetId === a.id}
                  className={`relative w-full text-left px-2.5 py-2 rounded-md text-body flex items-center gap-2 transition ${placingAssetId === a.id ? "bg-[var(--color-surface-2)] text-[var(--color-text)] ring-1 ring-[var(--color-border-strong)]" : "hover:bg-[var(--color-surface-2)] text-[var(--color-text)]"}`}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: STATE_CONFIG[(a.whiteboard_state ?? "pending") as WhiteboardState].hex }} />
                  <span className="font-display text-reading font-semibold tabular-nums truncate">{a.tag}</span>
                  <MapPin className="w-3 h-3 ml-auto opacity-40" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* The board */}
        <div className="flex-1 min-w-0 overflow-auto p-3 sm:p-6 flex items-start justify-center bg-[var(--color-surface-2)]">
          <div
            ref={imgWrapRef}
            onClick={onBoardClick}
            onPointerMove={onBoardPointerMove}
            onPointerUp={onBoardPointerUp}
            className={`relative inline-block max-w-full rounded-md overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface)] ${editing && placingAssetId ? "cursor-crosshair" : ""}`}
            style={{ touchAction: editing ? "none" : "auto" }}
          >
            {plan.imagePath ? (
              <SignedPlotImage path={plan.imagePath} alt={plan.name} className="block max-w-full h-auto select-none" />
            ) : (
              <div className="w-[640px] max-w-full aspect-video bg-[var(--color-surface)] flex items-center justify-center text-[var(--color-text-muted)] text-body p-4 text-center">No background image. Markers can still go on this blank sheet.</div>
            )}

            {markers.map((m) => {
              const a = assetById.get(m.assetId);
              const state = (a?.whiteboard_state ?? "pending") as WhiteboardState;
              const hex = STATE_CONFIG[state].hex;
              return (
                <button
                  key={m.assetId}
                  type="button"
                  aria-label={`${a?.tag ?? "Unknown asset"}: ${STATE_CONFIG[state].label}`}
                  onPointerDown={(e) => onMarkerPointerDown(e, m.assetId)}
                  onClick={(e) => { e.stopPropagation(); setSelectedMarker((s) => (s === m.assetId ? null : m.assetId)); }}
                  title={a?.tag ?? "Unknown asset"}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md flex items-center justify-center ${editing ? "cursor-move" : "cursor-pointer hover:scale-110"} transition-transform`}
                  style={{ left: `${m.xPct}%`, top: `${m.yPct}%`, width: 22, height: 22, backgroundColor: hex }}
                >
                  {state === "blocked" && <span className="text-white text-body font-medium leading-none">!</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected marker popover (view mode) */}
        {!editing && selAsset && selMarker && (
          <div className="md:w-72 shrink-0 border-t md:border-t-0 md:border-l border-[var(--color-border)] p-5">
            <div className="flex items-center gap-2 mb-2">
              <div className="text-body font-medium text-[var(--color-text-muted)] flex-1">On this drawing</div>
              <button type="button" onClick={() => setSelectedMarker(null)} aria-label="Close" className="ui-hit w-9 h-9 grid place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
            </div>
            <div className="font-display text-[26px] leading-tight font-semibold text-[var(--color-text)] break-words mb-2"><CopyId value={selAsset.tag} label="tag" /></div>
            {selAsset.description && <p className="text-body text-[var(--color-text-muted)] mb-3">{selAsset.description}</p>}
            <div className="mb-3">
              <span className="inline-flex items-center gap-1.5 text-body font-medium text-[var(--color-text)]">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: STATE_CONFIG[(selAsset.whiteboard_state ?? "pending") as WhiteboardState].hex }} />
                {STATE_CONFIG[(selAsset.whiteboard_state ?? "pending") as WhiteboardState].label}
              </span>
            </div>
            <div className="space-y-2">
              <button type="button" onClick={() => advanceState(selAsset)} className={`${heroPrimary} w-full`}>
                Advance to {STATE_CONFIG[nextState((selAsset.whiteboard_state ?? "pending") as WhiteboardState)].label} <ChevronRight className="w-4 h-4" />
              </button>
              {selAsset.whiteboard_state !== "blocked" && (
                <button type="button" onClick={() => setBlocked(selAsset)} className={`${heroQuiet} w-full !text-[var(--state-overdue-text)]`}>
                  Mark blocked
                </button>
              )}
              <Link href={`/assets/${encodeURIComponent(selAsset.tag)}`} className={`${heroQuiet} w-full`}>
                Open its page <ExternalLink className="w-4 h-4" />
              </Link>
            </div>
          </div>
        )}

        {/* Selected marker actions (edit mode → remove) */}
        {editing && selectedMarker && (
          <div className="md:w-60 shrink-0 border-t md:border-t-0 md:border-l border-[var(--color-border)] p-5">
            <div className="font-display text-section font-semibold tabular-nums text-[var(--color-text)] mb-2">{assetById.get(selectedMarker)?.tag}</div>
            <button type="button" onClick={() => removeMarker(selectedMarker)} className={`${heroQuiet} w-full !text-[var(--state-overdue-text)]`}>Remove marker</button>
          </div>
        )}
      </div>
      </Card>
      </PageBody>
    </PageShell>
  );
}
