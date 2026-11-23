"use client";

// EquipmentStartOver - an admin starts the equipment over from the
// drawings. A preview first (what goes, what merges, what comes off the
// drawings, what stays), then the run only on confirm, then "Read the
// drawings again" with the fixed matching. The server does the work
// (/api/equipment-bridge/start-over) and audits it.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, Loader2, CheckCircle2, ChevronRight, Square } from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { btnPrimary, btnQuiet, btnDanger, Problem } from "@/components/admin/kit";
import { SkeletonText } from "@/components/ui/Skeleton";
import { friendlyError } from "@/lib/friendlyError";
import { plural } from "@/components/admin/band";
import { appConfirm } from "@/components/providers/DialogProvider";
import { estatePost } from "@/lib/estate/client";
import type { StartOverPreview, StartOverResult, RereadResult } from "@/lib/equipmentStartOverServer";
import type { PlanAsset } from "@/lib/equipmentStartOver";

const URL = "/api/equipment-bridge/start-over";

type Stage =
  | { k: "loading" }
  | { k: "preview"; p: StartOverPreview }
  | { k: "running"; p: StartOverPreview }
  | { k: "done"; r: StartOverResult }
  | { k: "reading"; so: RereadResult; r: StartOverResult | null }
  | { k: "read"; so: RereadResult };

const label = (a: Pick<PlanAsset, "tag" | "code">) => `${a.tag.replace(/\s*\(.*$/, "")}${a.code ? ` (${a.code})` : ""}`;
/** "a, b and c", leaving out what's empty. */
const and = (parts: Array<string | null | false>) => { const l = parts.filter(Boolean) as string[]; return l.length > 1 ? `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}` : l[0] ?? ""; };

/** "Unit 20: C-02, C-03 (2030.03)" lines, one per unit. */
function ByUnit({ list, limit = 400 }: { list: PlanAsset[]; limit?: number }) {
  const units = new Map<string, PlanAsset[]>();
  for (const a of list.slice(0, limit)) units.set(a.unitCode ?? "", [...(units.get(a.unitCode ?? "") ?? []), a]);
  return (
    <div className="space-y-1.5">
      {[...units.entries()].map(([u, l]) => (
        <p key={u} className="text-[13px] leading-relaxed">
          <span className="font-semibold">{u ? `Unit ${u}` : "No unit"}:</span>{" "}
          <span className="text-[var(--color-text-muted)] tabular-nums">{l.map(label).join(", ")}</span>
        </p>
      ))}
      {list.length > limit && <p className="text-[13px] text-[var(--color-text-muted)]">and {list.length - limit} more</p>}
    </div>
  );
}

/** One line of the preview: a count, what it means, and the list behind it. */
function Row({ n, title, children, tone }: { n: number; title: React.ReactNode; children?: React.ReactNode; tone?: "bad" | "good" }) {
  const head = (
    <span className="flex items-baseline gap-3 min-w-0">
      <span className={`font-display text-[20px] font-semibold tabular-nums w-14 shrink-0 text-right ${n === 0 ? "text-[var(--color-text-faint)]" : tone === "bad" ? "text-[var(--state-overdue-text)]" : "text-[var(--color-heading)]"}`}>{n.toLocaleString()}</span>
      <span className="text-[15px] text-[var(--color-text)]">{title}</span>
    </span>
  );
  if (!children || n === 0) return <div className="py-2.5 border-b border-[var(--color-border)] last:border-0">{head}</div>;
  return (
    <details className="group py-2.5 border-b border-[var(--color-border)] last:border-0">
      <summary className="flex items-center justify-between gap-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        {head}
        <span className="shrink-0 inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--color-accent-text)]">
          <span className="group-open:hidden">Show</span><span className="hidden group-open:inline">Hide</span>
          <ChevronRight className="ui-chevron w-3.5 h-3.5 group-open:rotate-90" aria-hidden />
        </span>
      </summary>
      <div className="mt-2 ml-[68px] max-h-56 overflow-y-auto pr-1">{children}</div>
    </details>
  );
}

export default function EquipmentStartOver({ orgId, onClose, onChanged }: { orgId: string; onClose: () => void; onChanged: () => void }) {
  const [stage, setStage] = useState<Stage>({ k: "loading" });
  const [keepEdited, setKeepEdited] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Reading the drawings again runs in steps; Stop ends it after the step
  // in flight (what was read so far stays).
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);

  const fetchPreview = useCallback((keep: boolean) => estatePost<StartOverPreview>(URL, { orgId, action: "preview", keepEdited: keep }), [orgId]);
  const load = async (keep: boolean) => {
    setError(null);
    setStage({ k: "loading" });
    try { setStage({ k: "preview", p: await fetchPreview(keep) }); }
    catch (e) { setError(friendlyError(e)); setStage({ k: "loading" }); }
  };
  useEffect(() => {
    let alive = true;
    fetchPreview(true)
      .then((p) => { if (alive) setStage({ k: "preview", p }); })
      .catch((e) => { if (alive) setError(friendlyError(e)); });
    return () => { alive = false; };
  }, [fetchPreview]);

  const busy = stage.k === "running" || stage.k === "reading";

  const run = async (p: StartOverPreview) => {
    const removed = p.plan.remove.length;
    const merged = p.plan.merges.reduce((n, m) => n + m.drop.length, 0);
    const ok = await appConfirm({
      title: "Start over?",
      message: `This ${and([
        removed > 0 && `removes ${plural(removed, "record")}`,
        merged > 0 && `merges ${plural(merged, "copy", "copies")}`,
        (p.drawings.entries > 0 || p.drawings.links > 0) && `takes ${plural(p.drawings.entries + p.drawings.links, "entry and link", "entries and links")} off ${plural(p.drawings.list.length, "drawing")}`,
      ])}. It can't be undone.`,
      confirmLabel: "Start over",
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    setStage({ k: "running", p });
    try {
      const r = await estatePost<StartOverResult>(URL, { orgId, action: "run", planKey: p.planKey, keepEdited });
      setStage({ k: "done", r });
      onChanged();
    } catch (e) {
      setError(friendlyError(e));
      // The list changed since the preview: show it again as it is now.
      await load(keepEdited);
    }
  };

  const runIdRef = useRef<string | null>(null);
  const reread = async (r: StartOverResult | null, resume = false) => {
    setError(null);
    // Carrying on after a Stop keeps the same run, so it undoes as one.
    const runId = resume && runIdRef.current ? runIdRef.current : `start-over-${new Date().toISOString().slice(0, 16)}`;
    runIdRef.current = runId;
    const sum: RereadResult = { drawings: 0, applied: 0, assets: 0, left: 0, libraries: 0, linked: false };
    stopRef.current = false;
    setStopping(false);
    setStage({ k: "reading", so: sum, r });
    try {
      for (let i = 0; i < 40; i++) {
        if (stopRef.current) break;
        const step = await estatePost<RereadResult>(URL, { orgId, action: "reread", runId });
        sum.drawings += step.drawings; sum.applied += step.applied; sum.assets += step.assets;
        sum.left = step.left; sum.libraries = step.libraries; sum.linked = step.linked;
        setStage({ k: "reading", so: { ...sum }, r });
        if (step.left === 0) break;
      }
      setStage({ k: "read", so: { ...sum } });
      onChanged();
    } catch (e) {
      setError(friendlyError(e));
      setStage({ k: "read", so: { ...sum } });
    } finally {
      setStopping(false);
    }
  };

  let body: React.ReactNode;
  let footer: React.ReactNode;
  if (stage.k === "loading") {
    body = error
      ? <Problem retry={() => void load(keepEdited)}>Couldn&apos;t work out what would change. {error}</Problem>
      : <div><p className="mb-3 text-[14px] text-[var(--color-text-muted)]">Working out what would change.</p><SkeletonText lines={4} /></div>;
    footer = <button type="button" className={btnQuiet} onClick={onClose}>Cancel</button>;
  } else if (stage.k === "preview" || stage.k === "running") {
    const p = stage.p;
    const merged = p.plan.merges.reduce((n, m) => n + m.drop.length, 0);
    const nothing = !p.plan.remove.length && !merged && !p.drawings.entries && !p.drawings.links;
    body = (
      <div>
        {error && <Problem className="mb-3">{error}</Problem>}
        <Row n={p.plan.remove.length} tone="bad" title={<>{p.plan.remove.length === 1 ? "record the reader added that has" : "records the reader added that have"} no photos, files or notes. <b>Removed.</b></>}>
          <ByUnit list={p.plan.remove} />
        </Row>
        <Row n={merged} tone="bad" title={<>{merged === 1 ? "copy" : "copies"} of equipment already listed. <b>Merged</b> into the one that stays, photos and files with it.</>}>
          <ul className="space-y-1">
            {p.plan.merges.map((m) => (
              <li key={m.keep.id} className="text-[13px]">
                <span className="font-semibold tabular-nums">{label(m.keep)}</span>
                <span className="text-[var(--color-text-muted)]">{m.keep.unitCode ? `, unit ${m.keep.unitCode}` : ""}: keeps the one {m.keep.origin === "manual" ? "you added" : m.keep.code ? "with the ID" : "with photos"}{(() => { const ph = m.drop.reduce((n, d) => n + d.photos, 0), fl = m.drop.reduce((n, d) => n + d.files, 0); const t = and([ph > 0 && plural(ph, "photo"), fl > 0 && plural(fl, "file")]); return t ? `, ${t} ${ph + fl === 1 ? "moves" : "move"}` : ""; })()}</span>
              </li>
            ))}
          </ul>
        </Row>
        <Row n={p.drawings.entries} tone="bad" title={<>equipment {p.drawings.entries === 1 ? "entry" : "entries"} the reader wrote on {plural(p.drawings.list.length, "drawing")}, and {plural(p.drawings.links, "link")} it drew. <b>Taken off.</b> What people typed stays.</>}>
          <ul className="space-y-1">
            {p.drawings.list.slice(0, 300).map((d) => (
              <li key={d.documentId} className="text-[13px]"><span className="font-semibold">{d.label}</span><span className="text-[var(--color-text-muted)] tabular-nums">: {d.removed.length ? d.removed.join(", ") : `${plural(d.links, "link")} only`}</span></li>
            ))}
          </ul>
        </Row>
        <Row n={p.plan.kept.total} tone="good" title={<>{p.plan.kept.total === 1 ? "stays as it is" : "stay as they are"}: {plural(p.plan.kept.manual, "record")} you added, {p.plan.kept.reader.toLocaleString()} the reader added with photos, files or notes.</>} />
        {p.plan.unsure.length > 0 && (
          <Row n={p.plan.unsure.length} title={p.plan.unsure.length === 1 ? "tag left for you to sort out in its unit." : "tags left for you to sort out in their units."}>
            <ul className="space-y-1">
              {p.plan.unsure.map((u, i) => (
                <li key={i} className="text-[13px]">
                  <span className="font-semibold">{u.tag}</span>
                  <span className="text-[var(--color-text-muted)]">{u.unitCode ? `, unit ${u.unitCode}` : ""}: {u.why === "ids" ? `listed with ${u.ids.length} IDs (${u.ids.join(", ")}), and a copy with none` : `added by hand more than once (${u.ids.join(", ")})`}</span>
                </li>
              ))}
            </ul>
          </Row>
        )}
        {p.totals.edited > 0 && (
          <label className="mt-3 flex items-center gap-2 text-[14px] cursor-pointer">
            <input type="checkbox" checked={keepEdited} disabled={busy} className="w-4 h-4 accent-[var(--color-accent)]"
              onChange={(e) => { setKeepEdited(e.target.checked); void load(e.target.checked); }} />
            Keep the {plural(p.totals.edited, "record")} changed after the reader added {p.totals.edited === 1 ? "it" : "them"}
          </label>
        )}
        {nothing && <p className="mt-3 text-[14px] text-[var(--color-text-muted)]">Nothing to clear. You can still read the drawings again.</p>}
      </div>
    );
    footer = (
      <>
        <button type="button" className={btnQuiet} onClick={onClose} disabled={busy}>Cancel</button>
        {nothing ? (
          <button type="button" className={btnPrimary} onClick={() => void reread(null)}>Read the drawings again</button>
        ) : (
          <button type="button" className={btnDanger} disabled={busy} onClick={() => void run(p)}>
            {stage.k === "running" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
            {stage.k === "running" ? "Starting over" : (() => {
              const t = and([p.plan.remove.length > 0 && `remove ${p.plan.remove.length.toLocaleString()}`, merged > 0 && `merge ${merged.toLocaleString()}`]) || "clear the drawings";
              return t.charAt(0).toUpperCase() + t.slice(1);
            })()}
          </button>
        )}
      </>
    );
  } else if (stage.k === "done") {
    const r = stage.r;
    body = (
      <div className="space-y-2 text-[15px]">
        <p className="inline-flex items-center gap-2 font-semibold"><CheckCircle2 className="w-4 h-4 text-[var(--state-released)]" /> Started over.</p>
        <p>{(() => {
          const t = and([
            `removed ${plural(r.removed, "record")}`,
            r.merged > 0 && `merged ${plural(r.merged, "copy", "copies")}${r.moved.photos ? ` (${plural(r.moved.photos, "photo")} moved)` : ""}`,
            r.drawings > 0 && `took ${plural(r.entries, "entry", "entries")} and ${plural(r.links, "link")} off ${plural(r.drawings, "drawing")}`,
          ]);
          return `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
        })()}</p>
        {r.skipped.length > 0 && <p className="text-[14px] text-[var(--color-text-muted)]">Left as they were: {r.skipped.slice(0, 6).join("; ")}{r.skipped.length > 6 ? ` and ${r.skipped.length - 6} more` : ""}.</p>}
        {error && <Problem>{error}</Problem>}
        <p className="text-[14px] text-[var(--color-text-muted)]">Next, read the drawings again: equipment is matched by its ID first, then by its tag in the unit.</p>
      </div>
    );
    footer = (
      <>
        <button type="button" className={btnQuiet} onClick={onClose}>Close</button>
        <button type="button" className={btnPrimary} onClick={() => void reread(r)}>Read the drawings again</button>
      </>
    );
  } else {
    const so = stage.so;
    const reading = stage.k === "reading";
    body = (
      <div className="space-y-2 text-[15px]">
        <p className="inline-flex items-center gap-2 font-semibold">
          {reading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4 text-[var(--state-released)]" />}
          {reading ? (stopping ? "Stopping after this batch" : "Reading the drawings again") : so.libraries === 0 ? "No drawings have been read yet." : so.left > 0 ? "Stopped. What was read so far stays." : "Drawings read again."}
        </p>
        <p className="tabular-nums">{plural(so.applied, "drawing")} matched, {plural(so.assets, "record")} added{so.left ? `, ${so.left.toLocaleString()} to go` : ""}.</p>
        {error && <Problem>{error}</Problem>}
        {!reading && so.libraries === 0 && <p className="text-[14px] text-[var(--color-text-muted)]">Read them first in Intelligence, then come back.</p>}
      </div>
    );
    // While it reads, the same spot holds Stop (it ends after the batch in
    // flight); when it's done, Done.
    footer = reading
      ? <button type="button" className={btnQuiet} disabled={stopping} onClick={() => { stopRef.current = true; setStopping(true); }}>
          {stopping ? <Loader2 aria-hidden className="w-4 h-4 animate-spin" /> : <Square aria-hidden className="w-3.5 h-3.5 fill-current" />} {stopping ? "Stopping" : "Stop"}
        </button>
      : <>
          {so.left > 0 && so.libraries > 0 && <button type="button" className={btnQuiet} onClick={() => void reread(null, true)}>Read the rest</button>}
          <button type="button" className={btnPrimary} onClick={onClose}>Done</button>
        </>;
  }

  return (
    <Modal onClose={onClose} size="lg" dismissable={!busy}>
      <ModalHeader icon={RotateCcw} title="Start over from the drawings"
        subtitle="Clears what the drawing reader added. What people added stays." onClose={busy ? undefined : onClose} />
      <ModalBody>{body}</ModalBody>
      <ModalFooter>{footer}</ModalFooter>
    </Modal>
  );
}
