"use client";

// Findings on screen: "+ Finding" during the job (a step, a work order,
// the hour by hour), the close-out's Lessons & findings review, and "From
// past jobs" on the next project's plan. lib/findings has the rules.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, History, Lightbulb, Loader2, Pencil, Plus, RotateCcw, X } from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import type { Milestone, MilestoneNote } from "@/types/schema";
import { listMilestones, notesFor } from "@/lib/milestones";
import { recordLessons } from "@/lib/projectReport";
import { useShiftRecords, saveShiftRecord, newId, CLOSEOUT_KEY } from "@/lib/shiftRecord";
import { fmtInTz, normalizeTimeZone } from "@/lib/scheduleTz";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { useProjectTypeCtx } from "@/components/projects/ProjectTypeContext";
import { useProjectType } from "@/lib/shiftTimesStore";
import { listEdgesFor } from "@/lib/estate/client";
import { nid } from "@/lib/estate/ids";
import { setupOrders } from "@/lib/projectEquipment";
import {
  APPLIES, APPLIES_WORD, KINDS, KIND_WORD, TOPICS, FINDINGS_SQL, ACK_WORD,
  suggestFindings, reviewState, fieldsProblem, equipmentOf, guessKind, guessTopic, tagKey, findingLine, pastJobsFor,
  listFindings, listKeptFindings, saveFinding, listAcks, setAck, FindingsMissing,
  type AckStatus, type Equipment, type Finding, type FindingDraft, type FindingFields, type RecordLesson, type ReviewState,
} from "@/lib/findings";

export const NEW_FINDING_EVENT = "finding:new";
/** Open "+ Finding" from anywhere on the project's tabs. */
export const newFinding = (detail: { milestoneId?: string | null; at?: number } = {}) =>
  window.dispatchEvent(new CustomEvent(NEW_FINDING_EVENT, { detail }));
/** Open the close-out review from anywhere (the Complete gate, Reports). */
export const OPEN_REVIEW_EVENT = "findings:review";
export const openFindingsReview = () => window.dispatchEvent(new CustomEvent(OPEN_REVIEW_EVENT));

const btn = "inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[12.5px] font-bold px-3.5 py-2 shadow-sm disabled:opacity-50";
const quiet = "inline-flex items-center justify-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[12px] font-semibold text-[var(--color-text)] px-2.5 py-1.5 disabled:opacity-50";
const field = "w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px] text-[var(--color-text)]";
const label = "block text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1";

const KIND_TONE: Record<FindingFields["kind"], string> = {
  problem: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900",
  lesson: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900",
  material: "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  missed_scope: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900",
};
export function KindChip({ kind }: { kind: FindingFields["kind"] }) {
  return <span className={`inline-block shrink-0 rounded border px-1.5 py-px text-[10.5px] font-black uppercase tracking-wider ${KIND_TONE[kind]}`}>{KIND_WORD[kind]}</span>;
}

const when = (ms: number, tz: string) => fmtInTz(ms, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
const day = (ms: number, tz: string) => fmtInTz(ms, tz, { month: "short", day: "numeric", year: "numeric" });

const missingMsg = `Findings need the database update (${FINDINGS_SQL}) run first. Until then nothing can be saved.`;
const errText = (e: unknown) => (e instanceof FindingsMissing ? missingMsg : /permission|policy|row-level/i.test((e as Error).message) ? "Only the project's owner, co-owners and editors can change findings." : (e as Error).message);

// ─── Data ──────────────────────────────────────────────────────────

/** This project's findings, fresh after any save. */
export function useProjectFindings(projectId: string | null | undefined) {
  const [rows, setRows] = useState<Finding[]>([]);
  const [missing, setMissing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    listFindings(projectId).then((r) => { if (alive) { setRows(r.rows); setMissing(r.missing); setLoaded(true); } }).catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [projectId, tick]);
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent).detail?.projectId === projectId) reload(); };
    window.addEventListener("findings:changed", on);
    return () => window.removeEventListener("findings:changed", on);
  }, [projectId, reload]);
  return { rows, missing, loaded, reload };
}

/** The project's unit: its scope link to a codebook unit. */
export function useProjectUnit(orgId: string | null | undefined, projectId: string) {
  const [unit, setUnit] = useState<{ code: string; label: string } | null>(null);
  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    const read = () => void listEdgesFor(orgId, [nid.proj(projectId)]).then(async (es) => {
      const e = es.find((x) => x.type === "project_scope" && x.status === "applied" && x.a === nid.proj(projectId) && x.b.startsWith("cbunit:"));
      const code = e ? e.b.slice("cbunit:".length) : null;
      if (!code) { if (alive) setUnit(null); return; }
      const { data } = await supabase.from("codebook_entries").select("label").eq("org_id", orgId).eq("kind", "unit").eq("code", code).maybeSingle();
      if (alive) setUnit({ code, label: (data as { label?: string } | null)?.label ?? `Unit ${code}` });
    }).catch(() => undefined);
    read();
    window.addEventListener("project-equipment:changed", read);
    return () => { alive = false; window.removeEventListener("project-equipment:changed", read); };
  }, [orgId, projectId]);
  return unit;
}

/** The equipment on the project's work orders, one per tag. */
export function projectEquipmentList(milestones: Milestone[]): Equipment[] {
  const byId = new Map<string, Milestone>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  const out = new Map<string, Equipment>();
  for (const g of setupOrders(milestones)) {
    const e = equipmentOf(g.owner, byId);
    if (!e) continue;
    const k = tagKey(e.tag);
    const had = out.get(k);
    if (!had || (!had.assetId && e.assetId)) out.set(k, e);
  }
  return [...out.values()].sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }));
}

/** Everything the close-out review reads: the schedule, its comments, the
 *  close-out lessons, the old Lessons learned box, the unit, the findings. */
export function useFindingsReview(orgId: string | null | undefined, projectId: string) {
  const { rows, missing, loaded, reload } = useProjectFindings(projectId);
  const { records } = useShiftRecords(projectId);
  const unit = useProjectUnit(orgId, projectId);
  const [base, setBase] = useState<{ milestones: Milestone[]; notes: MilestoneNote[]; lessonsLearned: string | null; records: RecordLesson[] } | null>(null);
  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    const read = async () => {
      const milestones = await listMilestones({ orgId, projectId });
      const ids = milestones.map((m) => m.id).filter(Boolean) as string[];
      const [notes, ll, records] = await Promise.all([
        ids.length ? notesFor(ids) : Promise.resolve([] as MilestoneNote[]),
        supabase.from("projects").select("lessons_learned").eq("id", projectId).maybeSingle().then((r) => ((r.data as { lessons_learned?: string | null } | null)?.lessons_learned ?? null), () => null),
        // Cost, change orders, late work, rejected turnover, missing evidence.
        recordLessons(orgId, projectId).catch(() => [] as RecordLesson[]),
      ]);
      if (alive) setBase({ milestones, notes, lessonsLearned: ll, records });
    };
    void read().catch(() => undefined);
    const on = () => void read().catch(() => undefined);
    window.addEventListener("milestone-notes:changed", on);
    return () => { alive = false; window.removeEventListener("milestone-notes:changed", on); };
  }, [orgId, projectId]);
  const lessons = records.get(CLOSEOUT_KEY)?.lessons;
  const drafts = useMemo(() => (base ? suggestFindings({ milestones: base.milestones, notes: base.notes, lessons, lessonsLearned: base.lessonsLearned, records: base.records, unitCode: unit?.code ?? null }) : []), [base, lessons, unit]);
  const state = useMemo<ReviewState>(() => reviewState(drafts, rows), [drafts, rows]);
  const equipment = useMemo(() => (base ? projectEquipmentList(base.milestones) : []), [base]);
  return { state, missing, ready: !!base && loaded, unit, equipment, milestones: base?.milestones ?? [], reload };
}

/** Before the database update: kept with the close-out's team lessons (a
 *  record that already exists), so nothing typed is lost. It comes into the
 *  Lessons & findings review as a suggestion once the update is run. */
async function saveAsTeamLesson(input: { orgId: string; projectId: string; userId: string | null; userName: string | null; v: FindingFields }): Promise<boolean> {
  if (!input.userId) return false;
  const v = input.v;
  const what = v.appliesTo === "equipment" && v.assetTag ? `${v.assetTag}: ${v.body.trim()}` : v.body.trim();
  const text = [what, v.nextTime.trim() ? `Next time: ${v.nextTime.trim()}` : ""].filter(Boolean).join(". ");
  await saveShiftRecord({
    orgId: input.orgId, projectId: input.projectId, shiftKey: CLOSEOUT_KEY, userId: input.userId,
    change: (r) => ({ ...r, lessons: [...(r.lessons ?? []), { id: newId(), kind: "improve", text, by: input.userName, at: Date.now() }] }),
  });
  return true;
}
const SAVED_AS_LESSON = "Saved with the close-out's team lessons. It joins the Lessons & findings review once the database update is run.";

// ─── The fields ────────────────────────────────────────────────────

function Chips<T extends string>({ value, options, word, onPick, name }: { value: T; options: readonly T[]; word: (t: T) => string; onPick: (t: T) => void; name: string }) {
  return (
    <div role="radiogroup" aria-label={name} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={o === value} onClick={() => onPick(o)}
          className={`min-h-[32px] rounded-lg border px-2.5 text-[12.5px] font-semibold ${o === value
            ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)]"
            : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`}>
          {word(o)}
        </button>
      ))}
    </div>
  );
}

/** Type · Applies to (the equipment) · Topic · What happened · Next time. */
export function FindingEditor({ value, onChange, equipment, unitLabel, autoGuess }: {
  value: FindingFields; onChange: (v: FindingFields) => void; equipment: Equipment[]; unitLabel: string | null;
  /** Type and topic follow the words until picked. */
  autoGuess?: boolean;
}) {
  const [picked, setPicked] = useState({ kind: !autoGuess, topic: !autoGuess });
  const [other, setOther] = useState(() => !!value.assetTag && !equipment.some((e) => tagKey(e.tag) === tagKey(value.assetTag)));
  const set = (patch: Partial<FindingFields>) => onChange({ ...value, ...patch });
  const pickTag = (tag: string) => {
    const e = equipment.find((x) => tagKey(x.tag) === tagKey(tag));
    set({ assetTag: tag || null, assetId: e?.assetId ?? null });
  };
  return (
    <div className="space-y-3">
      <div>
        <span className={label}>Type</span>
        <Chips name="Type" value={value.kind} options={KINDS} word={(k) => KIND_WORD[k]} onPick={(k) => { setPicked((p) => ({ ...p, kind: true })); set({ kind: k }); }} />
      </div>
      <div>
        <span className={label}>Applies to</span>
        <Chips name="Applies to" value={value.appliesTo} options={APPLIES} word={(a) => (a === "unit" && unitLabel ? `Unit (${unitLabel})` : APPLIES_WORD[a])} onPick={(a) => set({ appliesTo: a })} />
        {value.appliesTo === "equipment" && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {!other && equipment.length > 0 ? (
              <select aria-label="Equipment" value={value.assetTag ?? ""} onChange={(e) => { if (e.target.value === "__other__") { setOther(true); set({ assetTag: null, assetId: null }); } else pickTag(e.target.value); }}
                className={`${field} h-9 w-auto min-w-[10rem]`}>
                <option value="">Pick the equipment…</option>
                {equipment.map((e) => <option key={e.tag} value={e.tag}>{e.tag}</option>)}
                <option value="__other__">Another tag…</option>
              </select>
            ) : (
              <input aria-label="Equipment tag" value={value.assetTag ?? ""} onChange={(e) => pickTag(e.target.value)} placeholder="Tag, e.g. E-12" className={`${field} h-9 w-40`} />
            )}
            {other && equipment.length > 0 && <button type="button" onClick={() => { setOther(false); set({ assetTag: null, assetId: null }); }} className="text-[12px] text-[var(--color-text-muted)] underline">Pick from the work orders</button>}
          </div>
        )}
        {value.appliesTo === "unit" && !unitLabel && <div className="mt-1 text-[11.5px] text-amber-700 dark:text-amber-300">Pick the project&apos;s unit in Setup › Unit &amp; equipment first.</div>}
      </div>
      <div>
        <label className={label} htmlFor="finding-topic">Topic</label>
        <select id="finding-topic" value={value.topic} onChange={(e) => { setPicked((p) => ({ ...p, topic: true })); set({ topic: e.target.value as FindingFields["topic"] }); }} className={`${field} h-9 w-auto min-w-[10rem]`}>
          {TOPICS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div>
        <label className={label} htmlFor="finding-body">What happened</label>
        <textarea id="finding-body" rows={2} value={value.body} placeholder="e.g. Only 20 of the 24 seal rings were ordered"
          onChange={(e) => {
            const body = e.target.value;
            set({ body, ...(!picked.kind ? { kind: guessKind(body, "manual") } : {}), ...(!picked.topic ? { topic: guessTopic(body) } : {}) });
          }}
          className={`${field} resize-y`} />
      </div>
      <div>
        <label className={label} htmlFor="finding-next">Next time</label>
        <textarea id="finding-next" rows={2} value={value.nextTime} placeholder="e.g. Order 24 seal rings plus spares" onChange={(e) => set({ nextTime: e.target.value })} className={`${field} resize-y`} />
      </div>
    </div>
  );
}

// ─── + Finding ─────────────────────────────────────────────────────

/** Listens for "+ Finding" on the project's tabs and opens the form, on
 *  the step or work order it was tapped on. */
export function FindingHost({ orgId, projectId, projectType: given, milestones, canEdit }: {
  orgId: string | null | undefined; projectId: string; projectType?: string; milestones: Milestone[]; canEdit: boolean;
}) {
  const ctxType = useProjectTypeCtx().word;
  const projectType = given ?? ctxType;
  const [open, setOpen] = useState<{ milestoneId: string | null; at: number } | null>(null);
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent<{ milestoneId?: string | null; at?: number }>).detail ?? {}; setOpen({ milestoneId: d.milestoneId ?? null, at: d.at ?? Date.now() }); };
    window.addEventListener(NEW_FINDING_EVENT, on);
    return () => window.removeEventListener(NEW_FINDING_EVENT, on);
  }, []);
  if (!open || !orgId) return null;
  return <FindingDialog orgId={orgId} projectId={projectId} projectType={projectType} milestones={milestones} canEdit={canEdit} milestoneId={open.milestoneId} at={open.at} onClose={() => setOpen(null)} />;
}

function FindingDialog({ orgId, projectId, projectType, milestones, canEdit, milestoneId, at, onClose }: {
  orgId: string; projectId: string; projectType: string; milestones: Milestone[]; canEdit: boolean; milestoneId: string | null; at: number; onClose: () => void;
}) {
  const { uid, userEmail } = useRole();
  const unit = useProjectUnit(orgId, projectId);
  const byId = useMemo(() => new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m])), [milestones]);
  const m = milestoneId ? byId.get(milestoneId) : undefined;
  const eq = m ? equipmentOf(m, byId) : null;
  const equipment = useMemo(() => projectEquipmentList(milestones), [milestones]);
  const [v, setV] = useState<FindingFields>(() => ({
    kind: "problem", appliesTo: eq ? "equipment" : "project", topic: "Other", body: "", nextTime: "",
    assetId: eq?.assetId ?? null, assetTag: eq?.tag ?? null, unitCode: null,
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const save = async () => {
    const problem = fieldsProblem({ ...v, unitCode: unit?.code ?? null });
    if (problem) { setErr(problem); return; }
    setBusy(true); setErr(null);
    try {
      await saveFinding({
        ...v, unitCode: unit?.code ?? null, orgId, projectId, projectType,
        milestoneId: m?.id ?? null, workOrderRef: m?.workOrderRef?.trim() || null,
        source: "manual", status: "open", foundAt: at, actor: { id: uid ?? null, name: userEmail ?? null },
      });
      setSaved(true);
      setTimeout(onClose, 900);
    } catch (e) {
      if (e instanceof FindingsMissing && await saveAsTeamLesson({ orgId, projectId, userId: uid ?? null, userName: userEmail ?? null, v }).catch(() => false)) {
        setSaved(true); setNote(SAVED_AS_LESSON); setTimeout(onClose, 3500);
      } else setErr(errText(e));
    } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} size="md">
      <ModalHeader icon={Lightbulb} title="New finding" subtitle={m ? `On ${m.name}` : "A problem, a lesson, a material shortfall or missed scope - for the next job"} onClose={onClose} />
      <ModalBody>
        {!canEdit ? <div className="text-[12.5px] text-[var(--color-text-muted)]">Only the project&apos;s owner, co-owners and editors can add findings.</div> : (
          <>
            <FindingEditor value={v} onChange={setV} equipment={equipment} unitLabel={unit?.label ?? null} autoGuess />
            <p className="mt-3 text-[11.5px] text-[var(--color-text-faint)]">Who and when are saved with it. It&apos;s reviewed with the rest at the close-out.</p>
          </>
        )}
        {err && <div className="mt-2 text-[12px] text-rose-700 dark:text-rose-300">{err}</div>}
        {note && <div role="status" className="mt-2 text-[12px] font-semibold text-emerald-700 dark:text-emerald-400">{note}</div>}
      </ModalBody>
      <ModalFooter>
        <div className="flex w-full items-center justify-end gap-2">
          <button type="button" onClick={onClose} className={quiet}>Cancel</button>
          {canEdit && (
            <button type="button" onClick={save} disabled={busy || saved || !v.body.trim()} className={btn}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />} {saved ? "Saved" : "Add finding"}
            </button>
          )}
        </div>
      </ModalFooter>
    </Modal>
  );
}

/** The "+ Finding" button on a step, a work order, an hour. */
export function AddFindingButton({ milestoneId, at, compact, className = "" }: { milestoneId?: string | null; at?: number; compact?: boolean; className?: string }) {
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); newFinding({ milestoneId, at }); }}
      title="A problem, a lesson, a material shortfall or missed scope - kept for the next job"
      className={`inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] font-semibold text-[var(--color-text)] ${compact ? "text-[11px] px-2 py-1" : "text-[12px] px-2.5 py-1.5"} ${className}`}>
      <Plus className="w-3.5 h-3.5" /> Finding
    </button>
  );
}

// ─── The close-out review ──────────────────────────────────────────

export function FindingsReview({ orgId, projectId, projectType: given, projectName, canEdit, timeZone }: { orgId: string; projectId: string;
  /** The project's type as the schedule reads it; left out (the project's
   *  header), it's read here the same way: Setup, else the name, else the
   *  schedule's group names. */
  projectType?: string; projectName?: string | null; canEdit: boolean; timeZone?: string | null }) {
  const { uid, userEmail } = useRole();
  const [note, setNote] = useState<string | null>(null);
  const ctxTz = useScheduleTz();
  const tz = timeZone ? normalizeTimeZone(timeZone) : ctxTz;
  const r = useFindingsReview(orgId, projectId);
  const groups = useMemo(() => { const parents = new Set(r.milestones.map((m) => m.parentId).filter(Boolean)); return r.milestones.filter((m) => m.isSummary || (m.id && parents.has(m.id))).map((m) => m.name); }, [r.milestones]);
  const readType = useProjectType(projectId, projectName, groups).word;
  const projectType = given ?? readType;
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ key: string; text: string } | null>(null);
  const [showKept, setShowKept] = useState(false);
  const [showDropped, setShowDropped] = useState(false);
  const actor = { id: uid ?? null, name: userEmail ?? null };
  const unitLabel = r.unit?.label ?? null;

  const decide = async (key: string, d: FindingDraft, row: Finding | null, status: "kept" | "dropped" | "open") => {
    const fields: FindingFields = { kind: d.kind, appliesTo: d.appliesTo, topic: d.topic, body: d.body, nextTime: d.nextTime, assetId: d.assetId, assetTag: d.assetTag, unitCode: r.unit?.code ?? d.unitCode };
    if (status === "kept") {
      const p = fieldsProblem(fields);
      if (p) { setErr({ key, text: p }); setEditing(key); return; }
    }
    setBusy(key); setErr(null);
    try {
      await saveFinding({
        ...fields, id: row?.id, orgId, projectId, projectType, milestoneId: d.milestoneId, workOrderRef: d.workOrderRef, hours: d.hours,
        source: d.source, sourceRef: d.sourceRef || null, status, foundAt: d.foundAt, actor,
      });
      setEditing(null);
    } catch (e) { setErr({ key, text: errText(e) }); } finally { setBusy(null); }
  };

  if (!r.ready) return <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Reading the record…</div>;
  const left = r.state.toReview.length;
  return (
    <div className="space-y-3">
      {r.missing && <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-[12.5px] text-amber-900 dark:text-amber-200">{missingMsg}</div>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="text-[12.5px] text-[var(--color-text-muted)]">
          {left ? <><b className="text-[var(--color-text)]">{left} to review</b> · </> : <><b className="text-emerald-700 dark:text-emerald-400">All reviewed</b> · </>}
          {r.state.kept.length} kept · {r.state.dropped.length} dropped
        </div>
        {canEdit && !adding && <button type="button" onClick={() => setAdding(true)} className={`${quiet} ml-auto`}><Plus className="w-3.5 h-3.5" /> Add finding</button>}
      </div>
      <p className="text-[12px] text-[var(--color-text-faint)]">From added scope and discoveries, comments, hold reasons, + Finding and the team&apos;s lessons. Edit any one, then keep it or drop it. Only kept ones go to the Intelligence graph, Ask and the next job&apos;s plan.</p>

      {adding && <AddRow orgId={orgId} projectId={projectId} projectType={projectType} equipment={r.equipment} unit={r.unit} actor={actor} onDone={() => setAdding(false)} onNote={setNote} />}
      {note && <div role="status" className="text-[12px] font-semibold text-emerald-700 dark:text-emerald-400">{note}</div>}

      {left > 0 && (
        <ul className="space-y-2">
          {r.state.toReview.map(({ draft, row }) => {
            const key = row ? `row:${row.id}` : draft.key;
            return (
              <ReviewRow key={key} draft={draft} tz={tz} canEdit={canEdit && !r.missing} editing={editing === key} busy={busy === key} error={err?.key === key ? err.text : null}
                equipment={r.equipment} unitLabel={unitLabel}
                onEdit={() => setEditing(key)} onCancel={() => { setEditing(null); setErr(null); }}
                onKeep={(d) => void decide(key, d, row, "kept")} onDrop={(d) => void decide(key, d, row, "dropped")} />
            );
          })}
        </ul>
      )}

      {r.state.kept.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowKept((x) => !x)} className="inline-flex items-center gap-1 text-[12px] font-bold text-[var(--color-text)]">
            {showKept ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />} Kept · {r.state.kept.length}
          </button>
          {showKept && (
            <ul className="mt-1.5 space-y-2">
              {r.state.kept.map((f) => {
                const key = `row:${f.id}`;
                return (
                  <ReviewRow key={key} draft={{ ...draftFromRow(f) }} tz={tz} canEdit={canEdit} editing={editing === key} busy={busy === key} error={err?.key === key ? err.text : null}
                    equipment={r.equipment} unitLabel={unitLabel} kept
                    onEdit={() => setEditing(key)} onCancel={() => { setEditing(null); setErr(null); }}
                    onKeep={(d) => void decide(key, d, f, "kept")} onDrop={(d) => void decide(key, d, f, "dropped")}
                    onUndo={() => void decide(key, draftFromRow(f), f, "open")} />
                );
              })}
            </ul>
          )}
        </div>
      )}
      {r.state.dropped.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowDropped((x) => !x)} className="inline-flex items-center gap-1 text-[12px] font-bold text-[var(--color-text-muted)]">
            {showDropped ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />} Dropped · {r.state.dropped.length}
          </button>
          {showDropped && (
            <ul className="mt-1.5 space-y-1">
              {r.state.dropped.map((f) => (
                <li key={f.id} className="flex items-start gap-2 rounded-lg border border-dashed border-[var(--color-border)] px-3 py-1.5 text-[12.5px] text-[var(--color-text-muted)]">
                  <span className="flex-1 min-w-0 break-words line-through decoration-[var(--color-text-faint)]">{f.body}</span>
                  {canEdit && <button type="button" disabled={busy === `row:${f.id}`} onClick={() => void decide(`row:${f.id}`, draftFromRow(f), f, "open")} className={quiet}><RotateCcw className="w-3.5 h-3.5" /> Bring back</button>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function draftFromRow(f: Finding): FindingDraft {
  return {
    key: `row:${f.id}`, source: f.source, sourceRef: f.sourceRef ?? "", kind: f.kind, appliesTo: f.appliesTo, topic: f.topic, body: f.body, nextTime: f.nextTime,
    assetId: f.assetId, assetTag: f.assetTag, unitCode: f.unitCode, milestoneId: f.milestoneId, workOrderRef: f.workOrderRef, hours: f.hours,
    foundAt: f.foundAt, by: f.createdByName, on: null, from: f.source === "manual" ? "+ Finding" : "",
  };
}

function ReviewRow({ draft, tz, canEdit, editing, busy, error, equipment, unitLabel, kept, onEdit, onCancel, onKeep, onDrop, onUndo }: {
  draft: FindingDraft; tz: string; canEdit: boolean; editing: boolean; busy: boolean; error: string | null;
  equipment: Equipment[]; unitLabel: string | null; kept?: boolean;
  onEdit: () => void; onCancel: () => void; onKeep: (d: FindingDraft) => void; onDrop: (d: FindingDraft) => void; onUndo?: () => void;
}) {
  const d = draft;
  const applies = d.appliesTo === "equipment" ? d.assetTag ?? "Equipment" : d.appliesTo === "unit" ? (unitLabel ? `Unit (${unitLabel})` : "Unit") : APPLIES_WORD[d.appliesTo];
  const from = [d.from, d.on, Number.isFinite(d.foundAt) ? when(d.foundAt, tz) : null, d.by].filter(Boolean).join(" · ");
  return (
    <li className={`rounded-lg border ${kept ? "border-emerald-200 dark:border-emerald-900/60" : "border-[var(--color-border)]"} bg-[var(--color-surface)] px-3 py-2.5 text-[12.5px]`}>
      {from && <div className="text-[11px] text-[var(--color-text-faint)] break-words">{from}</div>}
      {!editing ? (
        <>
          <div className="mt-1 flex items-start gap-2">
            <KindChip kind={d.kind} />
            <span className="flex-1 min-w-0 break-words text-[var(--color-text)]">{d.body}{d.hours ? <span className="text-[var(--color-text-muted)]"> ({d.hours} h{d.source === "discovery" ? " of work added" : d.source === "hold" ? " on hold" : ""})</span> : null}</span>
          </div>
          {d.nextTime.trim() && <div className="mt-1 text-[var(--color-text)]"><span className="text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Next time </span>{d.nextTime}</div>}
          <div className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">Applies to <b className="text-[var(--color-text)]">{applies}</b> · {d.topic}</div>
          {canEdit && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {!kept && <button type="button" disabled={busy} onClick={() => onKeep(draft)} className={btn}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Keep</button>}
              <button type="button" disabled={busy} onClick={onEdit} className={quiet}><Pencil className="w-3.5 h-3.5" /> Edit</button>
              {!kept && <button type="button" disabled={busy} onClick={() => onDrop(draft)} className={quiet}><X className="w-3.5 h-3.5" /> Drop</button>}
              {kept && onUndo && <button type="button" disabled={busy} onClick={onUndo} className={quiet}><RotateCcw className="w-3.5 h-3.5" /> Back to review</button>}
            </div>
          )}
        </>
      ) : (
        <RowEditor draft={draft} busy={busy} kept={kept} equipment={equipment} unitLabel={unitLabel} onKeep={onKeep} onDrop={onDrop} onCancel={onCancel} />
      )}
      {error && <div className="mt-1.5 text-[12px] text-rose-700 dark:text-rose-300">{error}</div>}
    </li>
  );
}

/** The row's fields, open: a fresh copy of what's saved each time. */
function RowEditor({ draft, busy, kept, equipment, unitLabel, onKeep, onDrop, onCancel }: {
  draft: FindingDraft; busy: boolean; kept?: boolean; equipment: Equipment[]; unitLabel: string | null;
  onKeep: (d: FindingDraft) => void; onDrop: (d: FindingDraft) => void; onCancel: () => void;
}) {
  const [v, setV] = useState<FindingDraft>(draft);
  return (
    <div className="mt-2 space-y-2">
      <FindingEditor value={v} onChange={(x) => setV((p) => ({ ...p, ...x }))} equipment={equipment} unitLabel={unitLabel} />
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={busy || !v.body.trim()} onClick={() => onKeep(v)} className={btn}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {kept ? "Save" : "Keep"}</button>
        {!kept && <button type="button" disabled={busy} onClick={() => onDrop(v)} className={quiet}><X className="w-3.5 h-3.5" /> Drop</button>}
        <button type="button" disabled={busy} onClick={onCancel} className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-1">Cancel</button>
      </div>
    </div>
  );
}

function AddRow({ orgId, projectId, projectType, equipment, unit, actor, onDone, onNote }: {
  orgId: string; projectId: string; projectType: string; equipment: Equipment[]; unit: { code: string; label: string } | null;
  actor: { id: string | null; name: string | null }; onDone: () => void; onNote: (t: string) => void;
}) {
  const [v, setV] = useState<FindingFields>({ kind: "lesson", appliesTo: "all", topic: "Other", body: "", nextTime: "", assetId: null, assetTag: null, unitCode: null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const keep = async () => {
    const f = { ...v, unitCode: unit?.code ?? null };
    const p = fieldsProblem(f);
    if (p) { setErr(p); return; }
    setBusy(true); setErr(null);
    try { await saveFinding({ ...f, orgId, projectId, projectType, source: "manual", status: "kept", actor }); onDone(); }
    catch (e) {
      if (e instanceof FindingsMissing && await saveAsTeamLesson({ orgId, projectId, userId: actor.id, userName: actor.name, v: f }).catch(() => false)) { onNote(SAVED_AS_LESSON); onDone(); }
      else setErr(errText(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="rounded-lg border border-[var(--color-accent)] bg-[var(--color-surface)] px-3 py-2.5 space-y-2">
      <div className="text-[12px] font-bold text-[var(--color-text)]">New finding</div>
      <FindingEditor value={v} onChange={setV} equipment={equipment} unitLabel={unit?.label ?? null} autoGuess />
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={busy || !v.body.trim()} onClick={keep} className={btn}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Keep</button>
        <button type="button" disabled={busy} onClick={onDone} className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-1">Cancel</button>
      </div>
      {err && <div className="text-[12px] text-rose-700 dark:text-rose-300">{err}</div>}
    </div>
  );
}

/** The review in a window of its own (the Complete gate, Reports). */
export function FindingsReviewModal({ orgId, projectId, projectType, projectName, canEdit, timeZone, onClose }: { orgId: string; projectId: string; projectType?: string; projectName?: string | null; canEdit: boolean; timeZone?: string | null; onClose: () => void }) {
  return (
    <Modal onClose={onClose} size="xl">
      <ModalHeader icon={Lightbulb} title="Lessons & findings" subtitle="The close-out review: what this job taught, kept for the next one" onClose={onClose} />
      <ModalBody><FindingsReview orgId={orgId} projectId={projectId} projectType={projectType} projectName={projectName} canEdit={canEdit} timeZone={timeZone} /></ModalBody>
      <ModalFooter><div className="flex w-full justify-end"><button type="button" onClick={onClose} className={quiet}>Done</button></div></ModalFooter>
    </Modal>
  );
}

/** Complete project: how many are left to review, and the way to it. */
export function FindingsGate({ orgId, projectId, onCount, onOpen }: { orgId: string; projectId: string; onCount: (n: number | null) => void; onOpen: () => void }) {
  const r = useFindingsReview(orgId, projectId);
  // Before the database update nothing can be kept: say so, don't hold it up.
  const left = r.ready && !r.missing ? r.state.toReview.length : null;
  useEffect(() => { onCount(left); }, [left, onCount]);
  useEffect(() => () => onCount(null), [onCount]);
  return (
    <div className="px-6 pt-4">
      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5">Lessons &amp; findings</div>
      {r.ready && r.missing ? (
        <div className="text-xs text-amber-800 dark:text-amber-300">{missingMsg} Nothing from this job reaches the next one until then.</div>
      ) : left == null ? (
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading the record…</div>
      ) : left > 0 ? (
        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          <b>Finish the review first: {left} left.</b> What this job taught reaches the next one only once it&apos;s kept.
          <button type="button" onClick={onOpen} className="ml-1 font-bold underline">Open the review</button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs font-bold text-emerald-700 dark:text-emerald-300"><Check className="w-3.5 h-3.5" /> Reviewed · {r.state.kept.length} kept</div>
      )}
    </div>
  );
}

/** Opens the review when asked from anywhere on the page. */
export function FindingsReviewHost(p: { orgId: string | null | undefined; projectId: string; projectType?: string; canEdit: boolean; timeZone?: string | null }) {
  const ctxType = useProjectTypeCtx().word;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPEN_REVIEW_EVENT, on);
    return () => window.removeEventListener(OPEN_REVIEW_EVENT, on);
  }, []);
  if (!open || !p.orgId) return null;
  return <FindingsReviewModal orgId={p.orgId} projectId={p.projectId} projectType={p.projectType ?? ctxType} canEdit={p.canEdit} timeZone={p.timeZone} onClose={() => setOpen(false)} />;
}

// ─── From past jobs ────────────────────────────────────────────────

export interface PastJob { finding: Finding; project: string; at: number; ack: { status: AckStatus; by: string | null; at: number } | null }

/** Kept findings from other projects on this project's equipment, its
 *  unit, and every-job lessons from projects of its kind; with this
 *  project's answer to each. */
export function usePastJobs(orgId: string | null | undefined, projectId: string, projectType: string, milestones: Milestone[]) {
  const unit = useProjectUnit(orgId, projectId);
  const [all, setAll] = useState<{ rows: Finding[]; names: Map<string, string> } | null>(null);
  const [acks, setAcks] = useState<Map<string, { status: AckStatus; by: string | null; at: number }>>(new Map());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    void (async () => {
      const { rows } = await listKeptFindings(orgId);
      const others = rows.filter((f) => f.projectId !== projectId);
      const ids = [...new Set(others.map((f) => f.projectId))];
      const names = new Map<string, string>();
      if (ids.length) {
        const { data } = await supabase.from("projects").select("id, name").in("id", ids);
        for (const p of (data ?? []) as Array<{ id: string; name: string }>) names.set(p.id, p.name);
      }
      const a = await listAcks(projectId);
      if (alive) { setAll({ rows: others, names }); setAcks(a); }
    })().catch(() => undefined);
    return () => { alive = false; };
  }, [orgId, projectId, tick]);
  // An answer given anywhere (the plan, the kick-off on screen) shows in
  // every list, and in the kick-off's print and email.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent).detail?.projectId !== projectId) return;
      void listAcks(projectId).then(setAcks).catch(() => undefined);
    };
    window.addEventListener("findings:acks", on);
    return () => window.removeEventListener("findings:acks", on);
  }, [projectId]);
  const equipment = useMemo(() => projectEquipmentList(milestones), [milestones]);
  const list = useMemo<PastJob[]>(() => (all ? pastJobsFor(all.rows, { projectId, unitCode: unit?.code ?? null, equipment, projectType }).map((f) => ({
    finding: f, project: all.names.get(f.projectId) ?? "Another project", at: f.foundAt, ack: acks.get(f.id) ?? null,
  })) : []), [all, unit, equipment, projectType, projectId, acks]);
  return { list, reload: () => setTick((t) => t + 1), setAcks };
}

/** "From past jobs" on the plan (and the kick-off): each with Planned for
 *  / Not relevant for this project. Nothing to show: nothing on screen. */
export function PastJobsPanel({ orgId, projectId, projectType: given, milestones, canEdit, title = "From past jobs" }: {
  orgId: string | null | undefined; projectId: string; projectType?: string; milestones: Milestone[]; canEdit: boolean; title?: string;
}) {
  const ctxType = useProjectTypeCtx().word;
  const projectType = given ?? ctxType;
  const { uid, userEmail } = useRole();
  const { list, setAcks } = usePastJobs(orgId, projectId, projectType, milestones);
  const tz = useScheduleTz();
  const [open, setOpen] = useState(true);
  const [showAnswered, setShowAnswered] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!orgId || list.length === 0) return null;
  const open_ = list.filter((x) => !x.ack);
  const answered = list.filter((x) => x.ack);
  const answer = async (x: PastJob, status: AckStatus | null) => {
    setErr(null);
    const before = x.ack;
    setAcks((m) => { const n = new Map(m); if (status) n.set(x.finding.id, { status, by: userEmail ?? null, at: Date.now() }); else n.delete(x.finding.id); return n; });
    try { await setAck({ orgId, projectId, findingId: x.finding.id, status, actor: { id: uid ?? null, name: userEmail ?? null } }); }
    catch (e) {
      setErr(errText(e));
      setAcks((m) => { const n = new Map(m); if (before) n.set(x.finding.id, before); else n.delete(x.finding.id); return n; });
    }
  };
  const row = (x: PastJob) => (
    <li key={x.finding.id} className="px-3 py-2 text-[12.5px]">
      <div className="flex items-start gap-2">
        <KindChip kind={x.finding.kind} />
        <div className="flex-1 min-w-0">
          <div className="text-[var(--color-text)] break-words">{x.finding.assetTag ? <b>{x.finding.assetTag} · </b> : null}{x.finding.body}{x.finding.hours ? <span className="text-[var(--color-text-muted)]"> ({x.finding.hours} h{x.finding.source === "discovery" ? " of work added" : x.finding.source === "hold" ? " on hold" : ""})</span> : null}</div>
          {x.finding.nextTime && <div className="text-[var(--color-text)]"><span className="text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Next time </span>{x.finding.nextTime}</div>}
          <div className="text-[11px] text-[var(--color-text-faint)]">{x.project} · {day(x.at, tz)} · {x.finding.topic}</div>
        </div>
      </div>
      {canEdit ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5 pl-0 sm:pl-[5.5rem]">
          {(["planned", "not_relevant"] as AckStatus[]).map((s) => (
            <button key={s} type="button" aria-pressed={x.ack?.status === s} onClick={() => void answer(x, x.ack?.status === s ? null : s)}
              className={`min-h-[30px] rounded-lg border px-2.5 text-[12px] font-semibold ${x.ack?.status === s
                ? s === "planned" ? "border-emerald-500 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" : "border-slate-400 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"
                : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`}>
              {x.ack?.status === s && <Check className="inline w-3.5 h-3.5 mr-0.5 -mt-0.5" />}{ACK_WORD[s]}
            </button>
          ))}
        </div>
      ) : x.ack ? <div className="mt-1 text-[11.5px] text-[var(--color-text-muted)] sm:pl-[5.5rem]">{ACK_WORD[x.ack.status]}{x.ack.by ? ` · ${x.ack.by}` : ""}</div> : null}
    </li>
  );
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left">
        <History className="w-4 h-4 text-[var(--color-text-muted)]" />
        <span className="text-[13px] font-black text-[var(--color-text)]">{title}</span>
        <span className="text-[12px] text-[var(--color-text-muted)]">{open_.length ? `${open_.length} to plan for` : "all answered"}{answered.length ? ` · ${answered.length} answered` : ""}</span>
        <span className="ml-auto">{open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</span>
      </button>
      {open && (
        <div className="border-t border-[var(--color-border)]">
          {open_.length > 0 && <ul className="divide-y divide-[var(--color-border)]">{open_.map(row)}</ul>}
          {answered.length > 0 && (
            <div className="border-t border-[var(--color-border)] px-3 py-1.5">
              <button type="button" onClick={() => setShowAnswered((s) => !s)} className="inline-flex items-center gap-1 text-[12px] font-bold text-[var(--color-text-muted)]">
                {showAnswered ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />} Answered · {answered.length}
              </button>
            </div>
          )}
          {showAnswered && <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">{answered.map(row)}</ul>}
          {err && <div className="px-3 py-1.5 text-[12px] text-rose-700 dark:text-rose-300">{err}</div>}
        </div>
      )}
    </section>
  );
}

/** One line per past job, for the kick-off's print and email. */
export const pastJobLines = (list: PastJob[], tz: string) => list.map((x) => ({ text: findingLine(x.finding), note: `${x.project} · ${day(x.at, tz)}${x.ack ? ` · ${ACK_WORD[x.ack.status]}` : ""}` }));
