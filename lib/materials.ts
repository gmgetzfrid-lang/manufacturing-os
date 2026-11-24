// materials - the materials register: every material and off-site repair an
// event needs, each with its specification, two owners, a status, a need-by
// date and any question holding it up. Opened at scope freeze, checked at
// every gate.
//
// Two owners per line: the warehouse owner (the `owner` column) gets it in
// and checks it; the crew owner makes sure it is used on the job and marks
// it "Used on the job" after "Received, checked", so done means done. A
// line missing either owner needs someone.
//
// The rules are pure; load and save talk to project_materials
// (20261119_project_materials.sql, then 20261125_materials_two_owners.sql
// for the crew owner and "used") and say plainly when that hasn't been run.

import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { noEmDash } from "@/lib/noEmDash";


export type MaterialKind = "material" | "offsite";
export type MaterialStatus = "to_specify" | "ready" | "ordered" | "at_vendor" | "received" | "checked" | "used" | "short" | "cancelled";
export const STATUSES: MaterialStatus[] = ["to_specify", "ready", "ordered", "at_vendor", "received", "checked", "used", "short", "cancelled"];
export const STATUS_WORD: Record<MaterialStatus, string> = {
  to_specify: "Spec incomplete", ready: "Ready to order", ordered: "Ordered", at_vendor: "At vendor",
  received: "Received", checked: "Received, checked", used: "Used on the job", short: "Short or wrong", cancelled: "Cancelled",
};
/** It is in hand (received, checked, or already used on the job). */
export const arrived = (s: MaterialStatus) => s === "received" || s === "checked" || s === "used";
/** Nothing left to do on it: used on the job, or cancelled. */
export const closed = (s: MaterialStatus) => s === "used" || s === "cancelled";

/** The line's two owners: who gets it in and checks it, and who makes sure it is used on the job. */
export type OwnerRole = "warehouse" | "crew";
export const OWNER_WORD: Record<OwnerRole, string> = { warehouse: "Warehouse", crew: "Crew" };

export interface MaterialFields {
  kind: MaterialKind;
  item: string;
  spec: string;
  /** What the specification still lacks ("length"). Empty: complete. */
  specMissing: string;
  qty: string;
  workOrder: string;
  /** The warehouse owner: gets it in and checks it (column `owner`). */
  owner: string;
  /** The crew owner: makes sure it is used on the job (column `crew_owner`). */
  crewOwner: string;
  vendor: string;
  status: MaterialStatus;
  /** "YYYY-MM-DD". */
  needBy: string | null;
  eta: string | null;
  etaNote: string;
  question: string;
  questionAt: number | null;
  questionBy: string | null;
  answer: string;
  note: string;
  phaseId: string | null;
}
export interface Material extends MaterialFields {
  id: string; orgId: string; projectId: string;
  createdByName: string | null; createdAt: number; updatedByName: string | null; updatedAt: number;
}

export const blankMaterial = (phaseId: string | null): MaterialFields => ({
  kind: "material", item: "", spec: "", specMissing: "", qty: "", workOrder: "", owner: "", crewOwner: "", vendor: "", status: "to_specify",
  needBy: null, eta: null, etaNote: "", question: "", questionAt: null, questionBy: null, answer: "", note: "", phaseId,
});

// ─── The rules ─────────────────────────────────────────────────────

/** The specification can't be ordered from: nothing written, or something
 *  named as missing. */
export const specIncomplete = (m: Pick<MaterialFields, "spec" | "specMissing" | "kind">) => !!m.specMissing.trim() || (m.kind === "material" && !m.spec.trim());
/** A question asked and not answered. */
export const questionOpen = (m: Pick<MaterialFields, "question" | "answer">) => !!m.question.trim() && !m.answer.trim();
/** Hours a question has stood open (0 when none is). */
export function questionAgeH(m: Pick<MaterialFields, "question" | "answer" | "questionAt">, now: number): number {
  return questionOpen(m) && m.questionAt != null ? Math.max(0, (now - m.questionAt) / 3_600_000) : 0;
}
export const QUESTION_LIMIT_H = 24;
const dayMs = (d: string | null) => (d ? Date.parse(`${d}T23:59:59Z`) : NaN);
/** Not in hand, and its need-by date has passed or its date to arrive is after it. */
export function late(m: Pick<MaterialFields, "status" | "needBy" | "eta">, now: number): boolean {
  if (arrived(m.status) || m.status === "cancelled" || !m.needBy) return false;
  const need = dayMs(m.needBy);
  return now > need || (!!m.eta && dayMs(m.eta) > need);
}
/** A status it may take: an incomplete specification can't move past
 *  "Spec incomplete", and only a line with a crew owner can be marked used
 *  (the crew owner's mark). */
export function statusAllowed(m: Pick<MaterialFields, "spec" | "specMissing" | "kind" | "crewOwner">, s: MaterialStatus): boolean {
  if (s === "used" && !m.crewOwner.trim()) return false;
  return !specIncomplete(m) || s === "to_specify" || s === "cancelled";
}
/** Whose move it is: the warehouse owner's until it is received and
 *  checked, then the crew owner's until it is used. Null when closed. */
export function holder(m: Pick<MaterialFields, "status">): OwnerRole | null {
  if (closed(m.status)) return null;
  return m.status === "checked" ? "crew" : "warehouse";
}
/** The next step for one tap on the line, once it is in hand: received
 *  to checked (the warehouse), checked to used (the crew). */
export function nextStatus(m: Pick<MaterialFields, "status">): MaterialStatus | null {
  return m.status === "received" ? "checked" : m.status === "checked" ? "used" : null;
}
/** The status it holds once its fields are read together. */
export function settle(m: MaterialFields): MaterialFields {
  if (m.status === "cancelled") return m;
  if (specIncomplete(m)) return { ...m, status: "to_specify" };
  if (m.status === "to_specify") return { ...m, status: m.kind === "offsite" ? "at_vendor" : "ready" };
  return m;
}
/** Why a row needs someone, most pressing first; empty when it doesn't. */
export function attention(m: MaterialFields, now: number): string[] {
  if (closed(m.status)) return [];
  const out: string[] = [];
  if (specIncomplete(m)) out.push(m.specMissing.trim() ? `Spec missing: ${m.specMissing.trim()}` : "No specification");
  const age = questionAgeH(m, now);
  if (age >= QUESTION_LIMIT_H) out.push(`Question open ${ageWord(age)}`);
  if (m.status === "short") out.push("Short or wrong");
  if (late(m, now)) out.push("Late against need-by");
  if (!m.owner.trim()) out.push("No warehouse owner");
  if (!m.crewOwner.trim()) out.push("No crew owner");
  if (!m.needBy && !arrived(m.status)) out.push("No need-by date");
  return out;
}
export const ageWord = (h: number) => (h < 1 ? "under 1 h" : h < 48 ? `${Math.round(h)} h` : `${Math.floor(h / 24)} days`);

/** The register in counts. `lines` leaves out cancelled lines; `received`
 *  is in hand and not yet used; `used` is done on the job; `noOwner` is
 *  open lines missing either owner. */
export interface RegisterSummary { lines: number; materials: number; offsite: number; specIncomplete: number; openQuestions: number; late: number; received: number; used: number; noOwner: number; needAttention: number }
export function summarize(rows: MaterialFields[], now: number): RegisterSummary {
  const live = rows.filter((r) => r.status !== "cancelled");
  return {
    lines: live.length, materials: live.filter((r) => r.kind === "material").length, offsite: live.filter((r) => r.kind === "offsite").length,
    specIncomplete: live.filter(specIncomplete).length,
    openQuestions: live.filter((r) => questionAgeH(r, now) >= QUESTION_LIMIT_H).length,
    late: live.filter((r) => late(r, now) || r.status === "short").length,
    received: live.filter((r) => r.status === "received" || r.status === "checked").length,
    used: live.filter((r) => r.status === "used").length,
    noOwner: live.filter((r) => r.status !== "used" && (!r.owner.trim() || !r.crewOwner.trim())).length,
    needAttention: live.filter((r) => attention(r, now).length > 0).length,
  };
}

// ─── Lines typed or pasted like a spreadsheet ──────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthOf = (w: string) => { const i = MONTHS.indexOf(w.slice(0, 3).toLowerCase()); return i < 0 ? NaN : i + 1; };
/** A date as typed or pasted from a spreadsheet, as "YYYY-MM-DD":
 *  2026-11-30, 11/30/2026, 11/30/26, 11/30 (this year), Nov 30, 2026 and
 *  30-Nov-26. `today` ("YYYY-MM-DD") gives the year when none is written.
 *  Null when it isn't a date. */
export function parseDay(raw: string, today: string): string | null {
  const s = raw.trim().replace(/\.$/, "");
  if (!s) return null;
  const year0 = Number(today.slice(0, 4));
  const yearOf = (y: string | undefined) => (y == null ? year0 : y.length <= 2 ? 2000 + Number(y) : Number(y));
  const day = (y: number, m: number, d: number) => {
    if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    if (new Date(Date.UTC(y, m - 1, d)).getUTCMonth() !== m - 1) return null; // Feb 30
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  let x = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (x) return day(Number(x[1]), Number(x[2]), Number(x[3]));
  x = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(s);
  if (x) return day(yearOf(x[3]), Number(x[1]), Number(x[2]));
  x = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{2}|\d{4}))?$/.exec(s);
  if (x) return day(yearOf(x[3]), monthOf(x[1]), Number(x[2]));
  x = /^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?(?:[\s,-]+(\d{2}|\d{4}))?$/.exec(s);
  if (x) return day(yearOf(x[3]), monthOf(x[2]), Number(x[1]));
  return null;
}

export interface NewLine { item: string; qty: string; workOrder: string; needBy: string | null }
/** Rows pasted from a spreadsheet, in the add row's order: item, quantity,
 *  work order, need-by. A header row is skipped, a row with no item is left
 *  out, and a need-by that isn't a date is left blank and named. */
export function pastedLines(rows: string[][], today: string): { lines: NewLine[]; header: boolean; noItem: number; badDates: string[] } {
  const header = rows.length > 0 && /^(items?|materials?|descriptions?|parts?)$/i.test((rows[0][0] ?? "").trim());
  const lines: NewLine[] = [];
  const badDates: string[] = [];
  let noItem = 0;
  for (const r of header ? rows.slice(1) : rows) {
    const [item = "", qty = "", workOrder = "", need = ""] = r.map((c) => c.trim());
    if (!item) { if (r.some((c) => c.trim())) noItem++; continue; }
    const needBy = need ? parseDay(need, today) : null;
    if (need && !needBy) badDates.push(need);
    lines.push({ item, qty, workOrder, needBy });
  }
  return { lines, header, noItem, badDates };
}

// ─── Load and save ─────────────────────────────────────────────────

type DbError = { code?: string; message?: string; details?: string | null };
const words = (e: DbError) => `${e.message ?? ""} ${e.details ?? ""}`;
/** The database has no crew_owner column yet (20261125 not run). */
const noCrewColumn = (e: DbError) => /crew_owner/i.test(words(e)) && (e.code === "PGRST204" || e.code === "42703" || /column/i.test(words(e)));
/** The database's status check doesn't know "used" yet (20261125 not run). */
const noUsedStatus = (e: DbError) => (e.code === "23514" && /status/i.test(words(e))) || /project_materials_status_check/i.test(words(e));
const missingTable = (e: DbError | null | undefined) =>
  !!e && e.code !== "PGRST204" && e.code !== "42703" && !/\bcolumn\b/i.test(e.message ?? "")
  && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache|could not find the table/i.test(e.message ?? ""));

interface Row {
  id: string; org_id: string; project_id: string; phase_id: string | null; kind: string; item: string; spec: string | null; spec_missing: string | null;
  qty: string | null; work_order: string | null; owner: string | null; crew_owner?: string | null; vendor: string | null; status: string; need_by: string | null; eta: string | null; eta_note: string | null;
  question: string | null; question_at: string | null; question_by: string | null; answer: string | null; note: string | null;
  created_by_name: string | null; created_at: string; updated_by_name: string | null; updated_at: string;
}
export function materialFromRow(r: Row): Material {
  return {
    id: r.id, orgId: r.org_id, projectId: r.project_id, phaseId: r.phase_id, kind: r.kind === "offsite" ? "offsite" : "material",
    item: r.item ?? "", spec: r.spec ?? "", specMissing: r.spec_missing ?? "", qty: r.qty ?? "", workOrder: r.work_order ?? "", owner: r.owner ?? "", crewOwner: r.crew_owner ?? "", vendor: r.vendor ?? "",
    status: (STATUSES as string[]).includes(r.status) ? (r.status as MaterialStatus) : "to_specify",
    needBy: r.need_by, eta: r.eta, etaNote: r.eta_note ?? "", question: r.question ?? "", questionAt: r.question_at ? Date.parse(r.question_at) : null, questionBy: r.question_by,
    answer: r.answer ?? "", note: r.note ?? "",
    createdByName: r.created_by_name, createdAt: Date.parse(r.created_at), updatedByName: r.updated_by_name, updatedAt: Date.parse(r.updated_at),
  };
}

type Page = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;

// Until the project_materials table is in the database, the register lives
// in the project's settings (projects.shift_times.materials), each line in
// the table's own row shape with an id starting "s-". Those lines stay there;
// once the table exists, new lines go to it and both are listed.
const SETTINGS_KEY = "materials";
export const inSettings = (id: string) => id.startsWith("s-");
async function readSettings(projectId: string): Promise<{ st: Record<string, unknown>; rows: Row[] }> {
  const { data, error } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  if (error) throw new Error(error.message);
  const st = { ...(((data as { shift_times?: Record<string, unknown> | null } | null)?.shift_times) ?? {}) };
  const rows = Array.isArray(st[SETTINGS_KEY]) ? (st[SETTINGS_KEY] as Row[]).filter((r) => r && typeof r.id === "string" && typeof r.item === "string") : [];
  return { st, rows };
}
async function writeSettings(projectId: string, st: Record<string, unknown>, rows: Row[]): Promise<void> {
  const { data, error } = await supabase.from("projects").update({ shift_times: { ...st, [SETTINGS_KEY]: rows } }).eq("id", projectId).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Not saved - only the project's owner, a co-owner, an editor or an admin can change this.");
}
const newId = () => `s-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

/** The project's register: the table's lines (when the table is there) and
 *  the settings' lines. `crewColumn` says whether the table has the crew
 *  owner column (false: 20261125 not run), null when there is no table
 *  line to tell by. */
export async function listMaterials(projectId: string): Promise<{ rows: Material[]; crewColumn: boolean | null }> {
  const [{ rows, error }, kept] = await Promise.all([
    fetchAllRows<Row>((from, to) => supabase.from("project_materials").select("*").eq("project_id", projectId).order("created_at").order("id").range(from, to) as unknown as Page),
    readSettings(projectId),
  ]);
  if (error && !missingTable({ message: error })) throw new Error(error);
  const table = error ? [] : rows;
  const all = [...table, ...kept.rows].map(materialFromRow);
  return {
    rows: all.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    crewColumn: table.length ? table.some((r) => "crew_owner" in r) : null,
  };
}

const t = (s: string) => noEmDash(s.trim()) || null;
/** What a save left out because the database is older than this code: the
 *  crew owner (no crew_owner column) and "Used on the job" (a status check
 *  without 'used'). Empty when everything was saved. */
export type HeldBack = Array<"crewOwner" | "used">;
export interface SavedMaterial extends Material { heldBack: HeldBack }

export async function saveMaterial(input: { id?: string; orgId: string; projectId: string; fields: MaterialFields; was?: MaterialFields | null; actor: { id: string | null; name: string | null } }): Promise<SavedMaterial> {
  const f = settle(input.fields);
  if (f.status === "used" && !f.crewOwner.trim()) throw new Error("Name the crew owner before marking it used on the job.");
  const now = new Date().toISOString();
  // A new question starts its clock; an answer stops it.
  const asked = f.question.trim() && f.question.trim() !== (input.was?.question ?? "").trim();
  const answered = f.answer.trim() && f.answer.trim() !== (input.was?.answer ?? "").trim();
  const row: Record<string, unknown> = {
    org_id: input.orgId, project_id: input.projectId, phase_id: f.phaseId, kind: f.kind, item: noEmDash(f.item.trim()), spec: t(f.spec), spec_missing: t(f.specMissing), qty: t(f.qty),
    work_order: t(f.workOrder), owner: t(f.owner), crew_owner: t(f.crewOwner), vendor: t(f.vendor), status: f.status, need_by: f.needBy || null, eta: f.eta || null, eta_note: t(f.etaNote),
    question: t(f.question), answer: t(f.answer), note: t(f.note), updated_by_name: input.actor.name, updated_at: now,
    ...(asked ? { question_at: now, question_by: input.actor.name } : !f.question.trim() ? { question_at: null, question_by: null } : {}),
    ...(answered ? { answered_at: now } : !f.answer.trim() ? { answered_at: null } : {}),
  };
  if (!String(row.item)) throw new Error("Name the item.");
  // A line kept in the project's settings is changed there (both owners and
  // every status are kept there as they are).
  if (input.id && inSettings(input.id)) return { ...(await saveInSettings(input.projectId, input.id, row, input.actor)), heldBack: [] };
  // A database without 20261125 turns down the crew owner or "used": the
  // line is saved without them, and the caller says so.
  const heldBack: HeldBack = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const q = input.id
      ? supabase.from("project_materials").update(row).eq("id", input.id).select("*").single()
      : supabase.from("project_materials").insert({ ...row, created_by: input.actor.id, created_by_name: input.actor.name }).select("*").single();
    const { data, error } = await q;
    if (!error) return { ...materialFromRow(data as Row), heldBack };
    if ("crew_owner" in row && noCrewColumn(error)) {
      delete row.crew_owner;
      if (f.crewOwner.trim()) heldBack.push("crewOwner");
      continue;
    }
    if (row.status === "used" && noUsedStatus(error)) {
      row.status = input.was && input.was.status !== "used" ? input.was.status : "checked";
      heldBack.push("used");
      continue;
    }
    // No table yet: a new line goes to the project's settings.
    if (missingTable(error) && !input.id) return { ...(await saveInSettings(input.projectId, null, row, input.actor)), heldBack: [] };
    throw new Error(error.message);
  }
  throw new Error("The line wasn't saved. Try again.");
}

async function saveInSettings(projectId: string, id: string | null, row: Record<string, unknown>, actor: { id: string | null; name: string | null }): Promise<Material> {
  const { st, rows } = await readSettings(projectId);
  const at = rows.findIndex((r) => r.id === id);
  if (id && at < 0) throw new Error("That line is no longer there. Reload the register.");
  const base = at >= 0 ? rows[at] : ({ id: newId(), created_by: actor.id, created_by_name: actor.name, created_at: String(row.updated_at) } as unknown as Row);
  const next = { ...base, ...row } as Row;
  const out = at >= 0 ? rows.map((r, i) => (i === at ? next : r)) : [...rows, next];
  await writeSettings(projectId, st, out);
  return materialFromRow(next);
}

export async function deleteMaterial(id: string, projectId: string): Promise<void> {
  if (inSettings(id)) {
    const { st, rows } = await readSettings(projectId);
    await writeSettings(projectId, st, rows.filter((r) => r.id !== id));
    return;
  }
  const { data, error } = await supabase.from("project_materials").delete().eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Not removed - only someone who can change the project can.");
}
