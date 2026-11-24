"use client";

// MaterialsRegister: every material and off-site repair an event needs, in
// one list (lib/materials). A line is added the way it is in a spreadsheet:
// item, quantity, work order and need-by in the row under the list (Enter
// adds it; rows copied from Excel are added all at once). Everything else
// about it (spec, supplier, dates, question, note, phase) is filled in on
// the line when it is opened, and the phase comes from the work order.
//
// Each line has two owners: the warehouse (gets it in and checks it) and the
// crew (makes sure it is used on the job). A line missing either needs
// someone, and it is done only when the crew marks it used. A specification
// with something missing can't be ordered, and a question nobody has
// answered in 24 hours shows in red until it is.

import { Card } from "@/components/ui/PageHero";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { SubTabs } from "@/components/projects/SubTabs";
import { ChevronRight, CircleAlert, Loader2, Trash2 } from "lucide-react";
import { phaseIndex, type ProjectPhase } from "@/lib/projectPhases";
import type { Milestone } from "@/types/schema";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAllRows";
import {
  OWNER_WORD, QUESTION_LIMIT_H, STATUSES, STATUS_WORD, ageWord, attention, blankMaterial, closed, deleteMaterial, late, listMaterials, nextStatus,
  parseDay, pastedLines, questionAgeH, questionOpen, saveMaterial, specIncomplete, statusAllowed, summarize, verifyDate, VERIFY_LEAD_DAYS,
  type Material, type MaterialFields, type MaterialKind, type MaterialStatus, type NewLine, type SavedMaterial,
} from "@/lib/materials";
import { appConfirm } from "@/components/providers/DialogProvider";
import { sayError } from "@/components/projects/sayError";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { InlineAddRow, type AddField, type AddResult } from "@/components/ui/InlineAddRow";
import { MoreDetails } from "@/components/ui/MoreDetails";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { controlClass } from "@/components/ui/Field";
import { listMembers } from "@/lib/projects";

const btn = "ui-press inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] whitespace-nowrap disabled:opacity-50";
const pri = "ui-press inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] text-body font-medium whitespace-nowrap disabled:opacity-50";
// A small action on a line or a summary: a link in looks, a full target on touch.
const link = "ui-press inline-flex items-center gap-1.5 min-h-8 pointer-coarse:min-h-11 px-2 -mx-2 rounded-md text-body font-medium text-[var(--color-accent-text)] hover:bg-[var(--color-surface-2)] whitespace-nowrap disabled:opacity-50";
const lab = "block text-caption font-medium text-[var(--color-text-muted)] mb-1";
const groupHead = "text-body font-semibold text-[var(--color-text)]";
const red = "text-[var(--state-overdue-text)]";
const muted = "text-[var(--color-text-muted)]";
// One status vocabulary: red needs someone now, amber on its way, green used on the job.
const statusTone = (s: MaterialStatus) => (s === "to_specify" || s === "short" ? "is-bad" : s === "used" ? "is-good" : s === "cancelled" ? "is-muted" : "is-warn");
const dateWord = (d: string | null) => { if (!d) return ""; const [, m, day] = d.split("-"); return `${Number(m)}/${Number(day)}`; };
const pad2 = (n: number) => String(n).padStart(2, "0");
const todayDay = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const needWordOf = (k: MaterialKind) => (k === "offsite" ? "Needed back by" : "Need-by");
const etaWordOf = (k: MaterialKind) => (k === "offsite" ? "Return date" : "ETA");
const UPDATE_LINE = "Crew owners and “Used on the job” aren’t saved until the database update is applied (20261125_materials_two_owners.sql).";
const VERIFY_LINE = "Verify-by dates picked on a line aren’t saved until the database update is applied (20261126_materials_verify_by.sql); until then each line works to its need-by date less " + VERIFY_LEAD_DAYS + " days.";

type Filter = "all" | "attention" | "offsite" | "received";
type Step = { id: string; name: string; parent_id: string | null; is_summary: boolean | null; cancelled_at?: string | null; attributes?: Record<string, unknown> | null };

export default function MaterialsRegister({ orgId, projectId, phases, canManage, actor }: {
  orgId: string; projectId: string; phases: ProjectPhase[];
  canManage: boolean; actor: { uid: string; email: string | null };
}) {
  // The work orders to pick from (the tasks the schedule's steps sit under),
  // and the phase each is in, so a line's phase fills itself.
  const [steps, setSteps] = useState<Step[]>([]);
  useEffect(() => {
    let live = true;
    void fetchAllRows<Step>((from, to) => supabase.from("milestones").select("id, name, parent_id, is_summary, cancelled_at, attributes").eq("project_id", projectId).order("id").range(from, to) as unknown as PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>)
      .then(({ rows }) => { if (live) setSteps(rows); }).catch(() => {});
    return () => { live = false; };
  }, [projectId]);
  const { workOrders, woPhase } = useMemo(() => {
    const parents = new Set(steps.filter((m) => !m.is_summary && m.parent_id && !m.cancelled_at).map((m) => m.parent_id!));
    const wos = steps.filter((m) => parents.has(m.id) && (m.name ?? "").trim());
    const idx = phaseIndex(steps.map((m) => ({ id: m.id, parentId: m.parent_id, attributes: m.attributes ?? null }) as unknown as Milestone), phases);
    // The same name in two phases: no guess.
    const byName = new Map<string, string | null>();
    for (const m of wos) {
      const k = m.name.trim().toLowerCase(), ph = idx.get(m.id) ?? null;
      byName.set(k, byName.has(k) && byName.get(k) !== ph ? null : ph);
    }
    return { workOrders: [...new Set(wos.map((m) => m.name.trim()))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), woPhase: byName };
  }, [steps, phases]);
  const phaseOf = useCallback((wo: string) => woPhase.get(wo.trim().toLowerCase()) ?? null, [woPhase]);

  const [rows, setRows] = useState<Material[] | null>(null);
  // The table has no crew owner column yet (false), or a save left the crew owner or "used" out.
  const [crewColumn, setCrewColumn] = useState<boolean | null>(null);
  const [heldBack, setHeldBack] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lineErr, setLineErr] = useState<{ id: string; text: string } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [phaseId, setPhaseId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [kind, setKind] = useState<MaterialKind>("material");
  const [showDone, setShowDone] = useState(false);
  const [stepping, setStepping] = useState<string | null>(null);
  // One "now" per load, so ages and lateness agree across the page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [rows]);
  const me = useMemo(() => ({ id: actor.uid, name: actor.email }), [actor.uid, actor.email]);

  const load = useCallback(() => {
    listMaterials(projectId).then((r) => { setRows(r.rows); setCrewColumn(r.crewColumn); }).catch((e) => { setErr(sayError(e)); setRows((o) => o ?? []); });
  }, [projectId]);
  useEffect(() => { load(); }, [load]);
  const saved = (s: SavedMaterial) => {
    if (s.heldBack.some((h) => h !== "verifyBy")) setHeldBack(true);
    if (s.heldBack.includes("verifyBy")) setVerifyHeld(true);
  };

  const scoped = useMemo(() => (rows ?? []).filter((r) => !phaseId || r.phaseId === phaseId), [rows, phaseId]);
  const sum = useMemo(() => summarize(scoped, now), [scoped, now]);
  // What needs someone first, then by need-by; used and cancelled lines fold under the rest.
  const { open, done } = useMemo(() => {
    const pick = scoped.filter((r) => filter === "all" ? true : filter === "attention" ? attention(r, now).length > 0 : filter === "offsite" ? r.kind === "offsite" : r.status === "received" || r.status === "checked");
    const order = (a: Material, b: Material) => Number(attention(b, now).length > 0) - Number(attention(a, now).length > 0) || (a.needBy ?? "9").localeCompare(b.needBy ?? "9") || a.item.localeCompare(b.item);
    return { open: pick.filter((r) => !closed(r.status)).sort(order), done: pick.filter((r) => closed(r.status)).sort(order) };
  }, [scoped, filter, now]);
  // The project's people, to pick an owner from (no typing); a name already
  // on a line stays a choice. Reminders reach an owner who is one of them.
  const [people, setPeople] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    listMembers(projectId).then((ms) => { if (live) setPeople([...new Set(ms.map((m) => (m.userName || m.userEmail || "").trim()).filter(Boolean))]); }).catch(() => { /* typed names still work */ });
    return () => { live = false; };
  }, [projectId]);
  const owners = useMemo(() => [...new Set([...people, ...(rows ?? []).flatMap((r) => [r.owner.trim(), r.crewOwner.trim()]).filter(Boolean)])].sort((a, b) => a.localeCompare(b)), [rows, people]);
  const [verifyHeld, setVerifyHeld] = useState(false);

  // ── Adding, like a spreadsheet ──
  const addOne = async (l: NewLine) => {
    saved(await saveMaterial({ orgId, projectId, actor: me, fields: { ...blankMaterial(phaseOf(l.workOrder) ?? phaseId), kind, item: l.item, qty: l.qty, workOrder: l.workOrder, needBy: l.needBy } }));
  };
  const onAdd = async (v: Record<string, string>): Promise<string | undefined> => {
    const needBy = v.needBy ? parseDay(v.needBy, todayDay()) : null;
    if (v.needBy && !needBy) return `Pick the ${needWordOf(kind).toLowerCase()} on the calendar.`;
    const verifyBy = v.verifyBy ? parseDay(v.verifyBy, todayDay()) : null;
    if (v.verifyBy && !verifyBy) return "Pick the verify-by date on the calendar.";
    const wo = v.workOrder ?? "";
    try {
      saved(await saveMaterial({ orgId, projectId, actor: me, fields: {
        ...blankMaterial(v.phase || phaseOf(wo) || phaseId), kind, item: v.item, spec: v.spec ?? "", qty: v.qty ?? "", workOrder: wo,
        needBy, verifyBy, owner: v.owner ?? "", crewOwner: v.crewOwner ?? "",
      } }));
    } catch (e) { return sayError(e); }
    load();
    return undefined;
  };
  const onPasteRows = async (cells: string[][]): Promise<AddResult> => {
    const { lines, header, noItem, badDates } = pastedLines(cells, todayDay());
    if (!lines.length) return "Nothing added: the item goes in the first column, and it was empty.";
    let added = 0;
    try { for (const l of lines) { await addOne(l); added++; } }
    catch (e) { load(); return `Added ${added} of ${lines.length} lines. The rest weren't added: ${sayError(e)}`; }
    load();
    if (!header && !noItem && !badDates.length) return undefined; // the row says "Added n lines."
    const say = [`Added ${added} line${added === 1 ? "" : "s"}${header ? " and skipped the header row" : ""}.`];
    if (noItem) say.push(`Left out ${noItem} row${noItem === 1 ? "" : "s"} with no item.`);
    if (badDates.length) say.push(badDates.length === 1 ? `“${badDates[0]}” isn't a date: set it on its line.` : `${badDates.length} need-by dates weren't dates: set them on their lines.`);
    return { ok: true, text: say.join(" ") };
  };

  // ── One tap on a line: received to checked, checked to used ──
  const step = async (r: Material, to: MaterialStatus) => {
    setStepping(r.id); setLineErr(null);
    try { saved(await saveMaterial({ id: r.id, orgId, projectId, fields: { ...r, status: to }, was: r, actor: me })); load(); }
    catch (e) { setLineErr({ id: r.id, text: sayError(e) }); }
    finally { setStepping(null); }
  };

  if (!rows) return <SkeletonRows rows={6} cols={3} what="the materials register" />;

  const toggle = (id: string) => { if (canManage) setOpenId((o) => (o === id ? null : id)); };
  const counts = ([
    [sum.specIncomplete, "spec incomplete"],
    [sum.openQuestions, `question${sum.openQuestions === 1 ? "" : "s"} open over ${QUESTION_LIMIT_H} h`],
    [sum.late, "short or late"],
    [sum.noOwner, `missing an owner`],
  ] as Array<[number, string]>).filter(([n]) => n > 0);
  const doneWords = [done.filter((r) => r.status === "used").length, done.filter((r) => r.status === "cancelled").length];

  // ── The cells of a line ──
  const question = (r: Material) => {
    if (!r.question.trim()) return null;
    if (!questionOpen(r)) return <span className={muted}>&ldquo;{r.question}&rdquo; Answered: {r.answer}</span>;
    const age = questionAgeH(r, now);
    return <span className={`ui-pill ${age >= QUESTION_LIMIT_H ? "is-bad" : "is-warn"} !whitespace-normal`}>&ldquo;{r.question}&rdquo; · open {ageWord(age)}{r.questionBy ? ` · asked by ${r.questionBy}` : ""}</span>;
  };
  const specCell = (r: Material) => <>
    {r.spec || <span className={r.kind === "material" && !closed(r.status) ? `font-medium ${red}` : muted}>None written</span>}
    {r.specMissing.trim() ? <> <span className="ui-pill is-bad !whitespace-normal">Missing: {r.specMissing}</span></> : null}
  </>;
  const ownerCell = (r: Material, k: "warehouse" | "crew") => {
    const name = k === "warehouse" ? r.owner : r.crewOwner;
    return <><span className={muted}>{OWNER_WORD[k]}: </span>{name || <span className={closed(r.status) ? muted : `font-medium ${red}`}>none</span>}</>;
  };
  // Late is one of two things, each shown where it is: the need-by date has
  // passed, or the date it comes is after the need-by date.
  const pastNeed = (r: Material) => late(r, now) && !!r.needBy && now > Date.parse(`${r.needBy}T23:59:59Z`);
  const etaAfter = (r: Material) => late(r, now) && !!r.eta && !!r.needBy && r.eta > r.needBy;
  const needCell = (r: Material) => r.needBy
    ? <span className={pastNeed(r) ? `font-medium ${red}` : ""}>{dateWord(r.needBy)}{pastNeed(r) ? " · late" : ""}</span>
    : <span className={closed(r.status) || r.status === "received" || r.status === "checked" ? muted : `font-medium ${red}`}>Not set</span>;
  const etaCell = (r: Material) => <>
    {r.eta ? <span className={etaAfter(r) ? `font-medium ${red}` : ""}>{dateWord(r.eta)}{etaAfter(r) ? " · after need-by" : ""}</span> : null}
    {r.etaNote ? <span className={muted}>{r.eta ? " · " : ""}{r.etaNote}</span> : null}
  </>;
  const itemSub = (r: Material) => [r.qty ? `qty ${r.qty}` : null, r.kind === "offsite" ? "Off-site repair" : null, r.vendor || null].filter(Boolean).join(" · ");
  const phaseName = (id: string | null) => (phases.length > 1 && id ? phases.find((p) => p.id === id)?.name ?? null : null);
  const stepButton = (r: Material) => {
    const to = nextStatus(r);
    if (!canManage || !to) return null;
    const needCrew = to === "used" && !r.crewOwner.trim();
    return (
      <button type="button" disabled={stepping === r.id}
        onClick={(e) => { e.stopPropagation(); if (needCrew) setOpenId(r.id); else void step(r, to); }}
        className={link}>
        {stepping === r.id ? <><Loader2 aria-hidden className="w-4 h-4 animate-spin" /> Saving</> : needCrew ? "Name the crew owner" : to === "used" ? "Mark used" : "Mark checked"}
      </button>
    );
  };
  const panel = (r: Material) => (
    <LinePanel key={r.id} row={r} orgId={orgId} projectId={projectId} actor={me} phases={phases} workOrders={workOrders} owners={owners} phaseOf={phaseOf}
      noCrewColumn={crewColumn === false}
      onClose={() => setOpenId(null)}
      onSaved={(s) => { saved(s); setOpenId(null); load(); }}
      onRemoved={() => { setOpenId(null); load(); }} />
  );
  const lineNote = (r: Material) => lineErr?.id === r.id
    ? <div role="alert" className={`mt-1 text-body font-medium ${red} flex items-start gap-1.5`}><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-0.5" /><span>{lineErr.text}</span></div>
    : null;

  const foldRow = done.length > 0 && (
    <button type="button" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone} className={`${link} !text-[var(--color-text-muted)]`}>
      <ChevronRight aria-hidden className={`w-4 h-4 transition-transform ${showDone ? "rotate-90" : ""}`} />
      {[doneWords[0] ? `${doneWords[0]} used on the job` : null, doneWords[1] ? `${doneWords[1]} cancelled` : null].filter(Boolean).join(", ")}
    </button>
  );
  const listed = [...open, ...(showDone ? done : [])];
  const lineRow = (r: Material) => {
    const isOpen = openId === r.id;
    return (
      <React.Fragment key={r.id}>
        <tr onClick={() => toggle(r.id)} title={attention(r, now).join(" · ") || undefined}
          className={`border-b border-[var(--color-border)] align-top ${canManage ? "cursor-pointer hover:bg-[var(--color-surface-2)]" : ""} ${isOpen ? "bg-[var(--color-surface-2)]" : ""} ${closed(r.status) ? muted : "text-[var(--color-text)]"}`}>
          <td className="px-3 py-2.5 min-w-40">
            {canManage
              ? <button type="button" aria-expanded={isOpen} onClick={(e) => { e.stopPropagation(); toggle(r.id); }} className="text-left font-semibold hover:underline underline-offset-2">{r.item}</button>
              : <b className="font-semibold">{r.item}</b>}
            {itemSub(r) && <div className={`text-caption ${muted}`}>{itemSub(r)}</div>}
          </td>
          <td className="px-3 py-2.5">{specCell(r)}</td>
          <td className="px-3 py-2.5">{r.workOrder}{phaseName(r.phaseId) && <div className={`text-caption ${muted}`}>{phaseName(r.phaseId)}</div>}</td>
          <td className="px-3 py-2.5 whitespace-nowrap"><div>{ownerCell(r, "warehouse")}</div><div>{ownerCell(r, "crew")}</div></td>
          <td className="px-3 py-2.5"><span className={`ui-pill ${statusTone(r.status)}`}>{STATUS_WORD[r.status]}</span><div>{stepButton(r)}</div>{lineNote(r)}</td>
          <td className="px-3 py-2.5 whitespace-nowrap">{needCell(r)}</td>
          <td className="px-3 py-2.5">{etaCell(r)}</td>
          <td className="px-3 py-2.5">{question(r)}</td>
        </tr>
        {isOpen && <tr><td colSpan={8} className="p-0 border-b border-[var(--color-border)]">{panel(r)}</td></tr>}
      </React.Fragment>
    );
  };
  const lineCard = (r: Material) => {
    const isOpen = openId === r.id;
    const next = stepButton(r);
    return (
      <li key={r.id} className={isOpen ? "bg-[var(--color-surface-2)]" : ""}>
        <div className="px-4 py-3">
          <button type="button" disabled={!canManage} onClick={() => toggle(r.id)} aria-expanded={canManage ? isOpen : undefined} className={`w-full text-left text-body disabled:cursor-default ${closed(r.status) ? muted : "text-[var(--color-text)]"}`}>
            <span className="flex items-start gap-2"><span className="min-w-0 flex-1 text-reading font-semibold">{r.item}</span><span className={`ui-pill ${statusTone(r.status)}`}>{STATUS_WORD[r.status]}</span></span>
            {(itemSub(r) || r.workOrder) && <span className={`block ${muted}`}>{[itemSub(r), r.workOrder, phaseName(r.phaseId)].filter(Boolean).join(" · ")}</span>}
            <span className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <span className={muted}>Spec</span><span className="min-w-0">{specCell(r)}</span>
              <span className={muted}>Owners</span><span className="min-w-0">{ownerCell(r, "warehouse")} · {ownerCell(r, "crew")}</span>
              <span className={muted}>{needWordOf(r.kind)}</span><span>{needCell(r)}</span>
              {(r.eta || r.etaNote) && <><span className={muted}>{etaWordOf(r.kind)}</span><span className="min-w-0">{etaCell(r)}</span></>}
              {r.question.trim() && <><span className={muted}>Question</span><span className="min-w-0">{question(r)}</span></>}
            </span>
          </button>
          {next && <div className="mt-1">{next}</div>}
          {lineNote(r)}
        </div>
        {isOpen && <div className="border-t border-[var(--color-border)]">{panel(r)}</div>}
      </li>
    );
  };

  // The add row's boxes: stacked on a phone, side by side from a small
  // tablet up (even widths), item widest from md up.
  // What a line needs, picked rather than typed where it can be: the work
  // order and owners from lists, dates on the calendar, the phase from the
  // work order unless picked.
  const pick = (none: string, xs: Array<{ value: string; label: string }>) => [{ value: "", label: none }, ...xs];
  const addFields: AddField[] = [
    { key: "item", label: "Item", required: true, width: "w-full sm:min-w-0 md:flex-1 md:min-w-[14rem]" },
    { key: "spec", label: kind === "material" ? "Spec" : "What to do", placeholder: kind === "material" ? "Size, rating, material" : "Repair, test, calibrate", width: "w-full sm:min-w-0 md:w-56 md:shrink-0" },
    { key: "qty", label: "Qty", placeholder: "Qty", width: "w-full sm:min-w-0 md:w-20 md:shrink-0" },
    workOrders.length
      ? { key: "workOrder", label: "Work order", type: "select", options: pick("None", workOrders.map((w) => ({ value: w, label: w }))), width: "w-full sm:min-w-0 md:w-56 md:shrink-0" }
      : { key: "workOrder", label: "Work order", width: "w-full sm:min-w-0 md:w-40 md:shrink-0" },
    ...(phases.length ? [{ key: "phase", label: "Phase", type: "select" as const, options: pick("From the work order", phases.map((p) => ({ value: p.id, label: p.name }))), width: "w-full sm:min-w-0 md:w-44 md:shrink-0" }] : []),
    { key: "needBy", label: needWordOf(kind), type: "date", width: "w-full sm:min-w-0 md:w-40 md:shrink-0" },
    { key: "verifyBy", label: "Verify by", type: "date", width: "w-full sm:min-w-0 md:w-40 md:shrink-0" },
    // From the project's people; with none listed yet, a name is typed.
    ...(["owner", "crewOwner"] as const).map((k): AddField => (owners.length
      ? { key: k, label: k === "owner" ? "Warehouse owner" : "Crew owner", type: "select", options: pick("Not set", owners.map((o) => ({ value: o, label: o }))), width: "w-full sm:min-w-0 md:w-48 md:shrink-0" }
      : { key: k, label: k === "owner" ? "Warehouse owner" : "Crew owner", placeholder: "Name", width: "w-full sm:min-w-0 md:w-48 md:shrink-0" })),
  ];

  return (
    <div data-materials-register>
    <Card pad={false} className="overflow-hidden" label={<span className="inline-flex items-center gap-1.5">Materials register <HelpTooltip><span className="font-normal">
      Each material to order and each item sent out for repair, with its two owners: the warehouse owner gets it in and checks it; the crew owner makes sure it is used on the job and marks it used. A line needs someone when its specification isn&rsquo;t complete, a question is open over {QUESTION_LIMIT_H} hours, it is short or late against its need-by date, or it is missing an owner. A line with something missing from its specification stays at &ldquo;Spec incomplete&rdquo; until that is filled in.
    </span></HelpTooltip></span>}>

      {/* The answer: how many lines need someone, out of how many. */}
      <div className="px-4 sm:px-5 pt-4 pb-3 space-y-1">
        {sum.lines === 0 ? (
          <p className="text-reading text-[var(--color-text)]">{!rows.length ? "Nothing on the register yet. Open it at scope freeze." : !scoped.length ? "Nothing in this phase yet." : "Every line is cancelled."}</p>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-reading text-[var(--color-text)]">
              {sum.needAttention ? <><b className={`font-display text-title leading-none font-bold tabular-nums ${red}`}>{sum.needAttention}</b> of {sum.lines} line{sum.lines === 1 ? "" : "s"} need{sum.needAttention === 1 ? "s" : ""} someone</>
                : <>Every line is on track.</>}
            </p>
            {sum.needAttention > 0 && filter !== "attention" && <button type="button" onClick={() => setFilter("attention")} className={link}>Show {sum.needAttention === 1 ? "it" : "them"}</button>}
          </div>
        )}
        {sum.lines > 0 && (
          <p className="text-body text-[var(--color-text-muted)]">
            {counts.map(([n, w], i) => <React.Fragment key={w}>{i > 0 && " · "}<b className="font-semibold tabular-nums text-[var(--color-text)]">{n}</b> {w}</React.Fragment>)}
            {counts.length > 0 && " · "}<b className="font-semibold tabular-nums text-[var(--color-text)]">{sum.used}</b> of {sum.lines} used on the job
          </p>
        )}
        {err && <div role="alert" className={`text-body font-medium ${red} flex items-start gap-1.5`}><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-0.5" /><span>{err}</span></div>}
        {(heldBack || crewColumn === false) && <p role="status" className="text-body text-[var(--state-held-text)]">{UPDATE_LINE}</p>}
        {verifyHeld && <p role="status" className="text-body text-[var(--state-held-text)]">{VERIFY_LINE}</p>}
      </div>

      {/* Filters only when there is something to filter (L5). */}
      {rows.length > 0 && (
        <div className="px-4 sm:px-5 pb-2 flex gap-2 flex-wrap items-center">
          <SubTabs label="Show" value={filter} onChange={setFilter} size="sm"
            items={[
              { id: "all" as Filter, label: "All", count: scoped.length },
              { id: "attention" as Filter, label: "Needs someone", count: sum.needAttention, dot: sum.needAttention ? "warn" as const : undefined },
              { id: "offsite" as Filter, label: "Off-site repairs", count: sum.offsite },
              { id: "received" as Filter, label: "Received, not used", count: sum.received },
            ]} />
          {phases.length > 0 && <select aria-label="Phase" value={phaseId ?? ""} onChange={(e) => setPhaseId(e.target.value || null)} className={`${controlClass} !w-auto ml-auto`}><option value="">All phases</option>{phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
        </div>
      )}

      {scoped.length > 0 && listed.length === 0 && !foldRow && (
        <p className="px-4 sm:px-5 py-3 border-t border-[var(--color-border)] text-reading text-[var(--color-text-muted)]">Nothing under this filter. <button type="button" onClick={() => setFilter("all")} className={link}>Show all {scoped.length}</button></p>
      )}

      {(listed.length > 0 || foldRow) && <>
        {/* Wide screens: one row per line. */}
        <div className="hidden lg:block overflow-x-auto border-t border-[var(--color-border)]">
          <table className="w-full text-body border-collapse">
            <thead><tr>{["Item", "Spec", "Work order", "Owners", "Status", "Need-by", "ETA / return", "Open question"].map((h) => <th key={h} scope="col" className="text-left px-3 py-2 bg-[var(--color-surface-2)] text-caption font-medium text-[var(--color-text-muted)] border-b border-[var(--color-border)] whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {open.map(lineRow)}
              {foldRow && <tr><td colSpan={8} className="px-3 py-1.5 border-b border-[var(--color-border)]">{foldRow}</td></tr>}
              {showDone && done.map(lineRow)}
            </tbody>
          </table>
        </div>

        {/* Phones and tablets: one card per line, its status on top. */}
        <ul className="lg:hidden border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
          {open.map(lineCard)}
          {foldRow && <li className="px-4 py-1.5">{foldRow}</li>}
          {showDone && done.map(lineCard)}
        </ul>
      </>}

      {/* Add a line the way it's done in a spreadsheet. */}
      {canManage && (
        <div className="px-4 sm:px-5 pt-3 pb-1 border-t border-[var(--color-border)]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2">
            <h3 className={groupHead}>Add a line</h3>
            <KindSwitch value={kind} onChange={setKind} />
          </div>
          <InlineAddRow wrap fields={addFields} onAdd={onAdd} onPasteRows={onPasteRows} what="line" draftKey={`materials-add:${projectId}`} />
          <p className="mt-1 text-caption text-[var(--color-text-muted)]">
            Verify by: when it is to be in hand and checked. Left blank, it is the need-by date less {VERIFY_LEAD_DAYS} days, a default until your turnaround book&apos;s number is in. The warehouse owner gets a reminder in the app from 3 days before it until the line is checked.
          </p>
        </div>
      )}
    </Card>
    </div>
  );
}

/** Material or off-site repair: the two kinds of line. */
function KindSwitch({ value, onChange }: { value: MaterialKind; onChange: (k: MaterialKind) => void }) {
  return (
    <span role="group" aria-label="Kind of line" className="inline-flex rounded-lg border border-[var(--color-border-strong)] overflow-hidden">
      {(["material", "offsite"] as const).map((k) => (
        <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)}
          className={`ui-press h-8 pointer-coarse:h-11 px-3 text-body font-medium ${k === "offsite" ? "border-l border-[var(--color-border-strong)]" : ""} ${value === k ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
          {k === "material" ? "Material" : "Off-site repair"}
        </button>
      ))}
    </span>
  );
}

/** The opened line: every field of the record, grouped, changed in place. */
function LinePanel({ row, orgId, projectId, actor, phases, workOrders, owners, phaseOf, noCrewColumn, onClose, onSaved, onRemoved }: {
  row: Material; orgId: string; projectId: string; actor: { id: string; name: string | null };
  phases: ProjectPhase[]; workOrders: string[]; owners: string[]; phaseOf: (wo: string) => string | null;
  noCrewColumn: boolean;
  onClose: () => void; onSaved: (s: SavedMaterial) => void; onRemoved: () => void;
}) {
  const [f, setF] = useState<MaterialFields>(() => ({ ...row }));
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<MaterialFields>) => { setF((o) => ({ ...o, ...patch })); setErr(null); };
  const incomplete = specIncomplete(f);
  const id = React.useId();
  const listWo = `${id}-wo`, listOwners = `${id}-owners`;

  const save = async () => {
    if (!f.item.trim()) { setErr("Name the item."); return; }
    setBusy("save"); setErr(null);
    try { onSaved(await saveMaterial({ id: row.id, orgId, projectId, fields: f, was: row, actor })); }
    catch (e) { setErr(sayError(e)); setBusy(null); }
  };
  const remove = async () => {
    if (!(await appConfirm({ title: `Remove “${row.item}” from the register?`, message: "You can't undo this.", tone: "danger", confirmLabel: "Remove line" }))) return;
    setBusy("remove"); setErr(null);
    try { await deleteMaterial(row.id, projectId); onRemoved(); }
    catch (e) { setErr(sayError(e)); setBusy(null); }
  };
  // A work order picked fills the phase, unless the phase was set by hand.
  const pickWorkOrder = (wo: string) => {
    const ph = phaseOf(wo);
    set({ workOrder: wo, ...(ph && (!f.phaseId || f.phaseId === phaseOf(f.workOrder)) ? { phaseId: ph } : {}) });
  };
  const text = (k: "item" | "spec" | "specMissing" | "qty" | "owner" | "crewOwner" | "vendor" | "etaNote" | "question" | "answer" | "note", name: React.ReactNode, list?: string) => (
    <label className="block min-w-0"><span className={lab}>{name}</span><input list={list} value={f[k]} onChange={(e) => set({ [k]: e.target.value })} disabled={busy !== null} className={controlClass} /></label>
  );
  const date = (k: "needBy" | "eta" | "verifyBy", name: string, hint?: string) => (
    <label className="block min-w-0"><span className={lab}>{name}</span><input type="date" value={f[k] ?? ""} placeholder={hint}
      onClick={(e) => { try { (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.(); } catch { /* the browser's own way */ } }}
      onChange={(e) => set(k === "needBy" ? { needBy: e.target.value || null } : k === "verifyBy" ? { verifyBy: e.target.value || null } : { eta: e.target.value || null })} disabled={busy !== null} className={controlClass} />
      {k === "verifyBy" && !f.verifyBy && verifyDate(f) && <span className="block mt-0.5 text-caption text-[var(--color-text-muted)]">{verifyDate(f)} from the need-by date</span>}
    </label>
  );
  const folded = [f.question, f.answer, f.note].filter((x) => x.trim()).length;
  const changedAt = Number.isFinite(row.updatedAt) ? new Date(row.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;

  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="px-4 sm:px-5 py-4 space-y-5 bg-[var(--color-surface-2)] text-body text-[var(--color-text)]" aria-label={`Change ${row.item}`}>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {text("item", "Item")}
        {text("qty", "Quantity")}
        <label className="block min-w-0"><span className={lab}>Work order or equipment</span><input list={listWo} value={f.workOrder} onChange={(e) => pickWorkOrder(e.target.value)} disabled={busy !== null} className={controlClass} /></label>
        <div className="min-w-0"><span className={lab}>Kind</span><KindSwitch value={f.kind} onChange={(k) => set({ kind: k })} /></div>
        {phases.length > 0 && (
          <label className="block min-w-0"><span className={lab}>Phase</span>
            <select value={f.phaseId ?? ""} onChange={(e) => set({ phaseId: e.target.value || null })} disabled={busy !== null} className={controlClass}><option value="">Whole project</option>{phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </label>
        )}
      </div>
      <datalist id={listWo}>{workOrders.map((w) => <option key={w} value={w} />)}</datalist>
      <datalist id={listOwners}>{owners.map((w) => <option key={w} value={w} />)}</datalist>

      <fieldset className="space-y-2">
        <legend className={`${groupHead} mb-2`}>Specification</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {text("spec", "Specification")}
          {text("specMissing", "Missing from the spec")}
        </div>
        {incomplete && <p className={`text-body font-medium ${red}`}>{f.specMissing.trim() ? `It stays at “Spec incomplete” until “${f.specMissing.trim()}” is written into the spec and that box is cleared.` : "Write the specification to move it to Ready to order."}</p>}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className={`${groupHead} mb-2`}>Owners</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {text("owner", <>Warehouse <span className="font-normal">· gets it in and checks it</span></>, listOwners)}
          {text("crewOwner", <>Crew <span className="font-normal">· makes sure it is used on the job</span></>, listOwners)}
        </div>
        {noCrewColumn && <p className="text-body text-[var(--state-held-text)]">{UPDATE_LINE}</p>}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className={`${groupHead} mb-2`}>Status and dates</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block min-w-0"><span className={lab}>Status</span>
            <select value={incomplete && f.status !== "cancelled" ? "to_specify" : f.status} onChange={(e) => set({ status: e.target.value as MaterialStatus })} disabled={busy !== null} className={controlClass}>
              {STATUSES.map((s) => <option key={s} value={s} disabled={!statusAllowed(f, s) || (!incomplete && s === "to_specify")}>{STATUS_WORD[s]}{s === "used" && !f.crewOwner.trim() ? " (name the crew owner first)" : ""}</option>)}
            </select>
          </label>
          {date("needBy", needWordOf(f.kind))}
          {date("eta", etaWordOf(f.kind))}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {date("verifyBy", "Verify by")}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {text("vendor", f.kind === "material" ? "Supplier" : "Shop")}
          {text("etaNote", "About the date")}
        </div>
      </fieldset>

      <MoreDetails label="Question and note" filled={folded} total={3}>
        <div className="grid gap-3 sm:grid-cols-2">
          {text("question", "Open question")}
          {text("answer", "Answer")}
        </div>
        {text("note", "Note")}
      </MoreDetails>

      {err && <div role="alert" className={`text-body font-medium ${red} flex items-start gap-1.5`}><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-0.5" /><span>{err}</span></div>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy !== null} onClick={() => void remove()} className={`${btn} mr-auto`}>
          {busy === "remove" ? <Loader2 aria-hidden className="w-4 h-4 animate-spin" /> : <Trash2 aria-hidden className="w-4 h-4" />} {busy === "remove" ? "Removing" : "Remove"}
        </button>
        {changedAt && <span className={`basis-full sm:basis-auto order-last sm:order-none text-caption ${muted}`}>Last changed{row.updatedByName ? ` by ${row.updatedByName}` : ""} {changedAt}</span>}
        <button type="button" disabled={busy !== null} onClick={onClose} className={btn}>Cancel</button>
        <button type="submit" disabled={busy !== null} className={pri}>{busy === "save" ? <Loader2 aria-hidden className="w-4 h-4 animate-spin" /> : null} {busy === "save" ? "Saving" : "Save"}</button>
      </div>
    </form>
  );
}
