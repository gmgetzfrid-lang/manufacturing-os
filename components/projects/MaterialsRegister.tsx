"use client";

// MaterialsRegister: every material and off-site repair an event needs, in
// one list: its specification, an owner, a status, a need-by date and any
// question holding it up (lib/materials). A specification with something
// missing can't be marked ready to order, and a question nobody has
// answered in 24 hours shows in red until it is.

import { Card } from "@/components/ui/PageHero";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { bandSeg, bandSegItem } from "@/components/admin/band";
import { Loader2, Plus, Trash2 } from "lucide-react";
import type { ProjectPhase } from "@/lib/projectPhases";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/Modal";
import {
  QUESTION_LIMIT_H, STATUSES, STATUS_WORD, ageWord, arrived, attention, blankMaterial, deleteMaterial, late, listMaterials, questionAgeH, questionOpen,
  saveMaterial, specIncomplete, statusAllowed, summarize, type Material, type MaterialFields, type MaterialStatus,
} from "@/lib/materials";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { appConfirm } from "@/components/providers/DialogProvider";
import { useDraft, clearDraft } from "@/hooks/useDraft";
import { sayError } from "@/components/projects/sayError";

const btn = "inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] whitespace-nowrap disabled:opacity-50";
const pri = "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[12px] font-semibold whitespace-nowrap disabled:opacity-50";
const field = "w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[13px] text-[var(--color-text)]";
const label = "text-[12px] font-semibold text-[var(--color-text-muted)]";
// State as soft pills (app/globals.css .ui-pill): red short, amber waiting, green here.
const red = "is-bad";
const amber = "is-warn";
const green = "is-good";
const quiet = "is-muted";
const tag = "ui-pill";
const statusTone = (s: MaterialStatus) => (s === "to_specify" || s === "short" ? red : arrived(s) ? green : s === "cancelled" ? quiet : amber);
const dateWord = (d: string | null) => { if (!d) return ""; const [, m, day] = d.split("-"); return `${Number(m)}/${Number(day)}`; };

type Filter = "all" | "attention" | "offsite" | "received";

export default function MaterialsRegister({ orgId, projectId, phases, canManage, actor }: {
  orgId: string; projectId: string; phases: ProjectPhase[];
  canManage: boolean; actor: { uid: string; email: string | null };
}) {
  // Work order names to pick from: the tasks the schedule's steps sit under.
  const [workOrders, setWorkOrders] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void fetchAllRows<{ id: string; name: string; parent_id: string | null; is_summary: boolean | null; cancelled_at?: string | null }>((from, to) => supabase.from("milestones").select("id, name, parent_id, is_summary, cancelled_at").eq("project_id", projectId).order("id").range(from, to) as unknown as PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>)
      .then(({ rows }) => {
        if (!live) return;
        const parents = new Set(rows.filter((m) => !m.is_summary && m.parent_id && !m.cancelled_at).map((m) => m.parent_id!));
        setWorkOrders([...new Set(rows.filter((m) => parents.has(m.id)).map((m) => (m.name ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
      }).catch(() => {});
    return () => { live = false; };
  }, [projectId]);
  const [rows, setRows] = useState<Material[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [phaseId, setPhaseId] = useState<string | null>(null);
  const [open, setOpen] = useState<{ row: Material | null; fields: MaterialFields } | null>(null);
  const [busy, setBusy] = useState(false);
  // One "now" per load, so ages and lateness agree across the page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [rows]);

  const load = useCallback(() => {
    listMaterials(projectId).then((r) => setRows(r.rows)).catch((e) => { setErr(sayError(e)); setRows([]); });
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const scoped = useMemo(() => (rows ?? []).filter((r) => !phaseId || r.phaseId === phaseId), [rows, phaseId]);
  const sum = useMemo(() => summarize(scoped, now), [scoped, now]);
  const shown = useMemo(() => scoped.filter((r) => filter === "all" ? true : filter === "attention" ? attention(r, now).length > 0 : filter === "offsite" ? r.kind === "offsite" && r.status !== "cancelled" : arrived(r.status))
    .sort((a, b) => Number(attention(b, now).length > 0) - Number(attention(a, now).length > 0) || (a.needBy ?? "9").localeCompare(b.needBy ?? "9") || a.item.localeCompare(b.item)), [scoped, filter, now]);

  const save = async () => {
    if (!open) return;
    setBusy(true); setErr(null);
    try {
      await saveMaterial({ id: open.row?.id, orgId, projectId, fields: open.fields, was: open.row, actor: { id: actor.uid, name: actor.email } });
      if (!open.row) clearDraft(`material:${projectId}`);
      setOpen(null); load();
    }
    catch (e) { setErr(sayError(e)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!open?.row || !(await appConfirm({ message: `Remove "${open.row.item}" from the register?`, tone: "danger", confirmLabel: "Remove" }))) return;
    setBusy(true); setErr(null);
    try { await deleteMaterial(open.row.id, projectId); setOpen(null); load(); }
    catch (e) { setErr(sayError(e)); }
    finally { setBusy(false); }
  };

  if (!rows) return <Card><LoadingBlock what="the materials register" className="border-0 p-0" /></Card>;

  const Pill = ({ id, children }: { id: Filter; children: React.ReactNode }) => (
    <button type="button" onClick={() => setFilter(id)} aria-pressed={filter === id} className={bandSegItem(filter === id)}>{children}</button>
  );
  // The counts in one line the eye runs along; a bad count in red.
  const Kpi = ({ name, value, detail, bad }: { name: string; value: number; detail: string; bad?: boolean }) => (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap" title={detail}>
      <b className={`tabular-nums ${bad && value > 0 ? "text-[var(--state-overdue-text)]" : "text-[var(--color-text)]"}`}>{value}</b>
      <span className="text-[var(--color-text-muted)]">{name.toLowerCase()}</span>
    </span>
  );
  const question = (r: Material) => {
    if (!r.question.trim()) return null;
    if (!questionOpen(r)) return <span className="text-[12px] text-[var(--color-text-muted)]">&ldquo;{r.question}&rdquo; Answered: {r.answer}</span>;
    const age = questionAgeH(r, now);
    return <span className={`${tag} ${age >= QUESTION_LIMIT_H ? red : amber} !whitespace-normal !h-auto py-0.5`}>&ldquo;{r.question}&rdquo; · open {ageWord(age)}{r.questionBy ? ` · asked by ${r.questionBy}` : ""}</span>;
  };
  const specCell = (r: Material) => <>{r.spec || <span className="text-[var(--color-text-muted)]">None written</span>}{r.qty ? <span className="text-[var(--color-text-muted)]"> · qty {r.qty}</span> : null}{r.specMissing.trim() ? <> <span className={`${tag} ${red} !whitespace-normal !h-auto py-0.5`}>Missing: {r.specMissing}</span></> : null}</>;
  const etaCell = (r: Material) => <>{r.eta ? <span className={late(r, now) ? "font-bold text-[var(--state-overdue-text)]" : ""}>{dateWord(r.eta)}</span> : null}{r.etaNote ? <span className="text-[var(--color-text-muted)]">{r.eta ? " · " : ""}{r.etaNote}</span> : null}</>;

  return (
    <div className="space-y-4" data-materials-register>
      <Card label="Materials register" action={canManage ? <button type="button" onClick={() => setOpen({ row: null, fields: blankMaterial(phaseId) })} className={pri}><Plus className="w-4 h-4" /> Add item</button> : undefined}>
      <p className="text-[14px] font-bold text-[var(--color-text)]">{sum.lines === 0 ? "Nothing on it yet. Open it at scope freeze." : sum.needAttention ? `${sum.needAttention} line${sum.needAttention === 1 ? " needs" : "s need"} someone.` : "Every line is on track."}</p>
      {err && <div role="alert" className="mt-1 text-[13px] font-semibold text-[var(--state-overdue-text)]">{err}</div>}

      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        <Kpi name="Lines" value={sum.lines} detail={`${sum.materials} material${sum.materials === 1 ? "" : "s"} · ${sum.offsite} off-site repair${sum.offsite === 1 ? "" : "s"}`} />
        <Kpi name="Spec incomplete" value={sum.specIncomplete} bad detail="can't be ordered yet" />
        <Kpi name={`Questions open over ${QUESTION_LIMIT_H} h`} value={sum.openQuestions} bad detail="waiting on an answer" />
        <Kpi name="Short or late" value={sum.late} bad detail="against the need-by date" />
      </div>

      <div className="mt-3 pt-3 border-t border-[var(--color-border)] flex gap-2 flex-wrap items-center">
        <div className={bandSeg} role="group" aria-label="Show">
          <Pill id="all">All <span className="tabular-nums text-[var(--color-text-muted)]">{scoped.length}</span></Pill>
          <Pill id="attention">Needs attention <span className="tabular-nums text-[var(--color-text-muted)]">{sum.needAttention}</span></Pill>
          <Pill id="offsite">Off-site repairs <span className="tabular-nums text-[var(--color-text-muted)]">{sum.offsite}</span></Pill>
          <Pill id="received">Received <span className="tabular-nums text-[var(--color-text-muted)]">{sum.received}</span></Pill>
        </div>
        {phases.length > 0 && <select aria-label="Phase" value={phaseId ?? ""} onChange={(e) => setPhaseId(e.target.value || null)} className={`${field} !w-auto ml-auto h-8 !py-0`}><option value="">All phases</option>{phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      </div>
      </Card>

      {shown.length === 0 ? (
        <Card><p className="text-[15px] text-[var(--color-text-muted)]">{scoped.length ? "Nothing under this filter." : <>No lines yet. <HelpTooltip>Add each material and each item sent out for repair, with who owns it and when it&apos;s needed.</HelpTooltip></>}</p></Card>
      ) : <Card pad={false} className="overflow-hidden">
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-[12px] border-collapse">
            <thead><tr>{["Item", "Spec", "Work order", "Owner", "Status", "Need-by", "ETA / return", "Open question"].map((h) => <th key={h} className="text-left px-2.5 py-2 bg-[var(--color-surface-2)] text-[12px] font-semibold text-[var(--color-text-muted)] border-b border-[var(--color-border)]">{h}</th>)}</tr></thead>
            <tbody>
              {shown.map((r) => {
                const why = attention(r, now);
                return (
                  <tr key={r.id} onClick={() => canManage && setOpen({ row: r, fields: { ...r } })} title={why.join(" · ")} className={`border-b last:border-b-0 border-[var(--color-border)] align-top ${canManage ? "cursor-pointer hover:bg-[var(--color-surface-2)]" : ""} ${why.length ? "bg-[var(--color-surface-2)] dark:bg-[var(--color-surface-2)]" : ""}`}>
                    <td className="px-2.5 py-2"><b className="text-[var(--color-text)]">{r.item}</b>{(r.kind === "offsite" || r.vendor) && <div className="text-[12px] text-[var(--color-text-muted)]">{r.kind === "offsite" ? "Off-site repair" : ""}{r.kind === "offsite" && r.vendor ? " · " : ""}{r.vendor}</div>}</td>
                    <td className="px-2.5 py-2 text-[var(--color-text)]">{specCell(r)}</td>
                    <td className="px-2.5 py-2 text-[var(--color-text)]">{r.workOrder}</td>
                    <td className="px-2.5 py-2 text-[var(--color-text)]">{r.owner || <span className={`${tag} ${red}`}>No owner</span>}</td>
                    <td className="px-2.5 py-2"><span className={`${tag} ${statusTone(r.status)}`}>{STATUS_WORD[r.status]}</span></td>
                    <td className="px-2.5 py-2 text-[var(--color-text)] whitespace-nowrap">{dateWord(r.needBy) || <span className="text-[var(--color-text-muted)]">Not set</span>}</td>
                    <td className="px-2.5 py-2 text-[var(--color-text)]">{etaCell(r)}</td>
                    <td className="px-2.5 py-2">{question(r)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ul className="md:hidden divide-y divide-[var(--color-border)]">
          {shown.map((r) => {
            const why = attention(r, now);
            return (
              <li key={r.id}>
                <button type="button" disabled={!canManage} onClick={() => setOpen({ row: r, fields: { ...r } })} className={`w-full text-left px-4 py-3 text-[13px] ${why.length ? "bg-[var(--color-surface-2)]" : ""}`}>
                  <div className="flex items-start gap-2"><b className="min-w-0 flex-1 text-[14px] text-[var(--color-text)]">{r.item}</b><span className={`${tag} ${statusTone(r.status)}`}>{STATUS_WORD[r.status]}</span></div>
                  <div className="text-[var(--color-text-muted)]">{[r.kind === "offsite" ? "Off-site repair" : null, r.vendor, r.workOrder].filter(Boolean).join(" · ")}</div>
                  <div className="mt-1 text-[var(--color-text)]"><span className="text-[var(--color-text-muted)]">Spec: </span>{specCell(r)}</div>
                  <div className="text-[var(--color-text)]"><span className="text-[var(--color-text-muted)]">Owner: </span>{r.owner || "none"} · <span className="text-[var(--color-text-muted)]">Need-by: </span>{dateWord(r.needBy) || "not set"}{r.eta || r.etaNote ? <> · <span className="text-[var(--color-text-muted)]">ETA: </span>{etaCell(r)}</> : null}</div>
                  {r.question.trim() && <div className="mt-1">{question(r)}</div>}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="px-4 sm:px-5 py-3 border-t border-[var(--color-border)] text-[12px] text-[var(--color-text-muted)]">Shaded rows need someone: a specification that isn&rsquo;t complete, a question open over {QUESTION_LIMIT_H} hours, short or late against the need-by date, or no owner. A line with something missing from its specification stays at &ldquo;Spec incomplete&rdquo; until that is filled in.</p>
      </Card>}

      {open && (
        <Modal onClose={() => !busy && setOpen(null)} size="lg">
          <ModalHeader title={open.row ? open.row.item : "Add an item"} subtitle={open.row ? `Last changed${open.row.updatedByName ? ` by ${open.row.updatedByName}` : ""}` : "A material to order, or an item sent out for repair"} onClose={() => !busy && setOpen(null)} />
          <ModalBody>
            {/* A new line being written comes back if the window closes or the page reloads. */}
            {!open.row && <MaterialDraft draftKey={`material:${projectId}`} fields={open.fields} set={(v) => setOpen((o) => (o ? { ...o, fields: v } : o))} />}
            <MaterialForm f={open.fields} set={(patch) => setOpen((o) => (o ? { ...o, fields: { ...o.fields, ...patch } } : o))} phases={phases} workOrders={workOrders} />
          </ModalBody>
          <ModalFooter>
            {open.row && <button type="button" disabled={busy} onClick={() => void remove()} className={`${btn} mr-auto`}><Trash2 className="w-4 h-4" /> Remove</button>}
            <button type="button" disabled={busy} onClick={() => setOpen(null)} className={btn}>Cancel</button>
            <button type="button" disabled={busy || !open.fields.item.trim()} onClick={() => void save()} className={pri}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save</button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
}

function MaterialDraft({ draftKey, fields, set }: { draftKey: string; fields: MaterialFields; set: (v: MaterialFields) => void }) {
  useDraft<MaterialFields>(draftKey, fields, set, (v) => !v.item?.trim() && !v.spec?.trim() && !v.note?.trim() && !v.question?.trim());
  return null;
}

function MaterialForm({ f, set, phases, workOrders }: { f: MaterialFields; set: (patch: Partial<MaterialFields>) => void; phases: ProjectPhase[]; workOrders: string[] }) {
  const incomplete = specIncomplete(f);
  const text = (k: "item" | "spec" | "specMissing" | "qty" | "workOrder" | "owner" | "vendor" | "etaNote" | "question" | "answer" | "note", name: string, hint: string, list?: string) => (
    <label className="block"><span className={label}>{name}</span><input list={list} value={f[k]} onChange={(e) => set({ [k]: e.target.value })} placeholder={hint} className={`${field} mt-0.5`} /></label>
  );
  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        {(["material", "offsite"] as const).map((k) => (
          <button key={k} type="button" aria-pressed={f.kind === k} onClick={() => set({ kind: k })} className={`h-9 px-3 rounded-lg border text-[12px] font-semibold ${f.kind === k ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)] ring-1 ring-inset ring-[var(--color-accent-text)]/30 border-transparent" : "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border-strong)]"}`}>{k === "material" ? "Material to order" : "Off-site repair or calibration"}</button>
        ))}
      </div>
      {text("item", "Item", f.kind === "material" ? "Long weld neck flange" : "FV-008B control valve")}
      <div className="grid gap-3 sm:grid-cols-2">
        {text("spec", "Specification", f.kind === "material" ? "6 in 300# RF, Sch 80 bore, A105" : "Rebuild and calibrate")}
        {text("specMissing", "Missing from the spec", "Length (leave blank when complete)")}
        {text("qty", "Quantity", "24")}
        {text("workOrder", "Work order or equipment", "E-12", "mr-work-orders")}
        {text("owner", "Owner", "Who chases it")}
        {text("vendor", f.kind === "material" ? "Supplier" : "Shop", "")}
      </div>
      <datalist id="mr-work-orders">{workOrders.map((w) => <option key={w} value={w} />)}</datalist>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block"><span className={label}>Status</span>
          <select value={incomplete && f.status !== "cancelled" ? "to_specify" : f.status} onChange={(e) => set({ status: e.target.value as MaterialStatus })} className={`${field} mt-0.5`}>
            {STATUSES.map((s) => <option key={s} value={s} disabled={!statusAllowed(f, s) || (!incomplete && s === "to_specify")}>{STATUS_WORD[s]}</option>)}
          </select>
        </label>
        <label className="block"><span className={label}>Need-by</span><input type="date" value={f.needBy ?? ""} onChange={(e) => set({ needBy: e.target.value || null })} className={`${field} mt-0.5`} /></label>
        <label className="block"><span className={label}>{f.kind === "material" ? "ETA" : "Return date"}</span><input type="date" value={f.eta ?? ""} onChange={(e) => set({ eta: e.target.value || null })} className={`${field} mt-0.5`} /></label>
      </div>
      {incomplete && <p className="text-[12px] font-semibold text-[var(--state-overdue-text)]">{f.specMissing.trim() ? `It stays at "Spec incomplete" until "${f.specMissing.trim()}" is filled in and that box is cleared.` : "Write the specification to move it to Ready to order."}</p>}
      {text("etaNote", "About the date", f.kind === "material" ? "4 on back order" : "Quoted 72 h")}
      <div className="grid gap-3 sm:grid-cols-2">
        {text("question", "Open question", "How long is the weld neck?")}
        {text("answer", "Answer", "Closes the question")}
      </div>
      {text("note", "Note", "")}
      {phases.length > 0 && <label className="block"><span className={label}>Phase</span><select value={f.phaseId ?? ""} onChange={(e) => set({ phaseId: e.target.value || null })} className={`${field} mt-0.5`}><option value="">Whole project</option>{phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
    </div>
  );
}
