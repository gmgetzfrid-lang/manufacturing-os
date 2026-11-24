// lib/reportExport.ts — a meeting report as plain text and as an email.
//
// The shift report on screen is built for running a meeting; pasted into an
// email it has to survive Outlook, whose editor (Word) ignores flex, grid
// and stylesheet classes. So the report also describes itself as data —
// numbers, tables, lists — and this module writes that data two ways:
//   toPlainText  — lines and indents, for Teams, a text, a plain email;
//   toEmailHtml  — tables with inline styles only, the one HTML every mail
//                  client (Outlook desktop and web, Gmail, Apple Mail) keeps.
// The talk-track parts of a meeting (prompts, sign-off lines) aren't data
// and aren't written: an update to management is the facts.

import { noEmDash } from "@/lib/noEmDash";
import type { FormLine, FormRow, FormRowId, ShiftForm } from "@/lib/shiftForm";

export type Tone = "rose" | "amber" | "emerald" | "slate" | "muted";

export interface ExportTag { t: string; tone: Tone }
export interface ExportStepRow {
  group?: { title: string; crumbs?: string; meta?: string };
  n?: number;
  when: string;
  name: string;
  tags?: ExportTag[];
  who?: string;
  wo?: string;
  right: string;
  note?: string;
}

/** A table cell: plain text, or text with emphasis. "" = left blank. */
export type ExportCell = string | {
  t: string; tone?: Tone; bold?: boolean;
  /** A short comment shown under the value — quiet, one line ("sent out
   *  for calibration"). */
  note?: string;
  /** One entry per line under the value (the steps done this shift), each
   *  with what leads it (its time, its WO) and its own comment. */
  lines?: Array<{ lead?: string; t: string; note?: string; tone?: Tone }>;
  /** Short lines under it all (where the whole task stands, why it's
   *  behind). */
  sub?: Array<{ t: string; tone?: Tone; italic?: boolean }>;
};
const cellText = (c: ExportCell) => (typeof c === "string" ? c : c.t);

export type ExportBlock =
  | { k: "stats"; items: Array<{ label: string; value: string; tone: Tone }>;
    /** Quiet tiles under a status sentence that already gives the answer. */
    small?: boolean }
  | { k: "note"; text: string; tone?: Tone }
  | { k: "sub"; title: string; count: number; tone: Tone }
  /** A small heading inside a section ("Completed"). */
  | { k: "label"; text: string }
  | { k: "steps"; whenHead: string; rightHead: string; flat?: boolean; rows: ExportStepRow[] }
  | {
    k: "table"; head: string[]; rows: ExportCell[][]; align?: Array<"left" | "right">;
    /** Plain text: the word before each column's value ("last step"), "" for
     *  none. Emphasised cells (statuses) always read on their own. */
    textLabels?: string[];
    /** Columns kept on one line ("10:00–12:00" never breaks). */
    nowrap?: number[];
    /** A line under a row, the table's whole width (by row, as `rows`): a
     *  long note that a narrow column would squeeze into a strip. */
    notes?: Array<string | null | undefined>;
    /** In the email and print, drawn as a list read top to bottom (the
     *  posts the owner sent: a heading per group, each row its name in bold
     *  with its tag, its details on lines under it, its value on the
     *  right), not as a grid of narrow columns. By column: `group` heads a
     *  group where filled (the task), `title` names the row, `tag` is set
     *  apart beside it (the WO), each of `lines` is one line under it (its
     *  columns joined with " · ", each with its text label), `right` is the
     *  value on the right with `under` beneath it. Plain text keeps the
     *  table's own lines. */
    list?: { group?: number; title: number; tag?: number; lines?: number[][]; right?: number; under?: number[] };
  }
  /** The numbers, two bars (done and planned, of the whole job) and the
   *  bottom line beside them — the update's first glance. */
  | {
    k: "overview";
    stats: Array<{ label: string; value: string; tone: Tone }>;
    bars?: { done: number; plan: number; from: string; to: string };
    title: string;
    lines: Array<{ label?: string; text: string; tone?: Tone }>;
    /** Quiet tiles (the status sentence above already gives the answer). */
    small?: boolean;
  }
  /** Short labelled boxes side by side ("Crews on day shift" | "Safety
   *  focus"), each a list of lines. */
  | {
    k: "columns";
    cols: Array<{ title: string; tone?: Tone; rows: Array<{ title: string; text?: string; value?: string; note?: string }> }>;
  }
  | { k: "list"; items: Array<{ text: string; note?: string }> }
  /** A written list: "E-17 Exchanger · Pull bundle — 40%, was due 16:00",
   *  under an optional heading. No grid — reads like a note. */
  | { k: "lines"; title?: string; tone?: Tone; items: ExportLine[] }
  /** Things to say out loud (the safety topic): a heading, a line under
   *  it, short bullets, and where they come from. */
  | { k: "bullets"; title: string; lead?: string; tone?: Tone; items: string[]; sources?: Array<{ url: string; label: string }> }
  | { k: "empty"; text: string };

export interface ExportLine {
  /** Bold: what it is ("E-17 Exchanger · Pull bundle"). */
  lead: string;
  /** What about it ("40% done — was due Oct 26 16:00"). */
  text: string;
  tone?: Tone;
  /** Who, or the hours — quiet, after the text. */
  aside?: string;
  /** A comment, on its own line under it. */
  note?: string;
}

export interface ExportSection {
  /** Stable key ("stand", "last") — which sections a person leaves out is remembered by it. */
  id?: string;
  title: string; sub?: string; flag?: "rose" | "amber" | null; blocks: ExportBlock[];
  /** Left out of a copy unless the person ticks it (the safety focus). */
  offByDefault?: boolean;
}

export interface ExportDoc {
  /** The shift update in the plant's required format (lib/shiftForm),
   *  with what to check before it goes ("names carried from …"). */
  form?: import("@/lib/shiftForm").ShiftForm;
  formCheck?: string[];
  kind: string;          // "Shift turnover"
  project: string;
  when: string;          // "Day shift Wed Oct 22 5:30–17:30 → Night shift …"
  asOf: string;
  /** The verdict. With `key` it leads the update as one sentence (`detail`)
   *  beside its one number, big ("43.5 h"); without, a small box. */
  status?: { label: string; tone: Tone; detail?: string; key?: string };
  /** The head count in one line, up top: "38 on site: Schultz 12, Ancon 20".
   *  The names are at the end, with the people. */
  headcount?: string;
  sections: ExportSection[];
  footer?: string;
}

/** Rows under their equipment, each group's rows together in the order
 *  the group first appears — as the report on screen lays them out. A flat
 *  list (a sequence) keeps its order. */
export function groupRows(rows: ExportStepRow[], flat?: boolean): Array<{ group?: ExportStepRow["group"]; rows: ExportStepRow[] }> {
  if (flat) return [{ rows }];
  const out: Array<{ group?: ExportStepRow["group"]; rows: ExportStepRow[] }> = [];
  const at = new Map<string, number>();
  for (const r of rows) {
    const key = r.group?.title ?? "";
    if (!at.has(key)) { at.set(key, out.length); out.push({ group: r.group?.title ? r.group : undefined, rows: [] }); }
    out[at.get(key)!].rows.push(r);
  }
  return out;
}

/** Done and plan bars say something only while one of them is short of
 *  100%: two full bars just repeat "100%" from the tiles. */
/** Two bars are worth drawing only when they tell done and plan apart (10
 *  points or more); two bars near the same length only repeat the numbers. */
export const barsShown = (b: { done: number; plan: number }) => (b.done < 100 || b.plan < 100) && Math.abs(b.plan - b.done) >= 10;

/** "38 on site: Schultz 12, Ancon 20, Brand 6": the head count in one line,
 *  from the counts entered (plant staff are not on the job and not counted).
 *  Undefined when no count was entered: nothing is made up. */
export function headcountLine(rows: Array<{ crew: string; n: number }>): string | undefined {
  const counted = rows.filter((r) => Number.isFinite(r.n));
  if (!counted.length) return undefined;
  const total = counted.reduce((a, r) => a + r.n, 0);
  return `${total} on site: ${counted.map((r) => `${r.crew} ${r.n}`).join(", ")}`;
}

/** The order the turnover goes out in, by section id: the answer (where we
 *  stand), what got done, what is next, problems and follow-ups, safety,
 *  then the people (who was at the meeting) last. */
export const MANAGEMENT_ORDER = ["stand", "done", "next", "after", "carries", "waiting", "discovery", "notes", "incidents", "safety", "hourly", "meetings"];

/** Short section titles for management ("Done", "Next shift"). The shift
 *  and its times move into the line beside the title. */
const SHORT_TITLE: Record<string, string> = { done: "Done", next: "Next shift", after: "Shift after", meetings: "People" };

/** The turnover as management reads it: sections in MANAGEMENT_ORDER (any
 *  other keeps its place after them), short titles with the shift and its
 *  times beside them (`when` per id, else the part of the title after
 *  " - "), quiet tiles under the status sentence, and no bars that only
 *  repeat 100%. Nothing is left out. */
export function forManagement(d: ExportDoc, when: Record<string, string> = {}): ExportDoc {
  const rank = (id?: string) => { const i = id ? MANAGEMENT_ORDER.indexOf(id) : -1; return i < 0 ? MANAGEMENT_ORDER.length : i; };
  const sections = d.sections.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s.id) - rank(b.s.id) || a.i - b.i).map(({ s }) => {
    const cut = s.title.indexOf(" - ");
    const head = cut > 0 ? s.title.slice(0, cut) : s.title;
    const rest = s.id && when[s.id] ? when[s.id] : cut > 0 ? s.title.slice(cut + 3) : "";
    const title = (s.id && SHORT_TITLE[s.id]) || head;
    const blocks = s.blocks.map((b): ExportBlock => (b.k === "overview"
      ? { ...b, small: !!d.status?.key, bars: b.bars && barsShown(b.bars) ? b.bars : undefined }
      : b));
    return { ...s, title, sub: [rest, s.sub].filter(Boolean).join(" · ") || undefined, blocks };
  });
  return { ...d, sections };
}

/** The plant's shift table as management reads it: the same rows and
 *  lines, in the update's order (done, the plan, waiting, follow-ups,
 *  safety, notes, then the people), with short row names; the times a
 *  long name carried ("Work Completed Between 5:30 AM and 6:00 PM") go on
 *  the row's first line. */
export function managementForm(f: ShiftForm, o: { meeting: string; end: string }): ShiftForm {
  const order: FormRowId[] = ["done", "plan", "waiting", "followup", "safety", "notes", "attend", "headcount"];
  const short: Record<FormRowId, { label: string; first?: string }> = {
    done: { label: "Done", first: `${o.meeting} to ${o.end}` },
    // "Plan", "Attendees", "Head count": short, and still the headings a
    // pasted update is read by (lib/emailShifts), so a plan and the people
    // are never read back as progress.
    plan: { label: "Plan", first: `After the ${o.meeting} meeting` },
    waiting: { label: "Waiting and ready" },
    followup: { label: "Follow-ups" },
    safety: { label: "Safety" },
    notes: { label: "Shift notes" },
    attend: { label: "Attendees", first: `At the ${o.meeting} meeting` },
    headcount: { label: "Head count" },
  };
  const rank = (id: FormRowId) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
  const rows: FormRow[] = [...f.rows].sort((a, b) => rank(a.id) - rank(b.id)).map((r) => {
    const s = short[r.id];
    if (!s) return r;
    const lines: FormLine[] = s.first ? [{ k: "text", text: s.first }, ...r.lines] : r.lines;
    return { ...r, label: s.label, lines };
  });
  return { ...f, rows };
}

// ── Plain text ───────────────────────────────────────────────────────

const tagText = (tags?: ExportTag[]) => (tags?.length ? ` [${tags.map((t) => t.t).join(", ")}]` : "");

/** The update as plain text: no em dash in it, whatever the text came from. */
export function toPlainText(d: ExportDoc): string {
  return noEmDash(plainText(d));
}

function plainText(d: ExportDoc): string {
  const out: string[] = [];
  out.push(`${d.kind.toUpperCase()} - ${d.project}`);
  out.push(`${d.when} · as of ${d.asOf}`);
  if (d.status) out.push(`Status: ${d.status.label}${d.status.detail ? ` - ${d.status.detail}` : ""}`);
  if (d.headcount) out.push(d.headcount);
  for (const s of d.sections) {
    out.push("");
    out.push(`${s.title.toUpperCase()}${s.sub ? ` - ${s.sub}` : ""}`);
    for (const b of s.blocks) {
      switch (b.k) {
        case "stats":
          out.push(`   ${b.items.map((x) => `${x.label}: ${x.value}`).join("  |  ")}`);
          break;
        case "note":
          out.push(`   ${b.text}`);
          break;
        case "sub":
          out.push(`   ${b.title.toUpperCase()} (${b.count})`);
          break;
        case "label":
          out.push(`   ${b.text}:`);
          break;
        case "empty":
          out.push(`   ${b.text}`);
          break;
        case "list":
          for (const x of b.items) out.push(`   ✓ ${x.text}${x.note ? ` (${x.note})` : ""}`);
          break;
        case "lines":
          if (b.title) out.push(`   ${b.title}`);
          for (const x of b.items) {
            out.push(`   • ${x.lead} - ${x.text}${x.aside ? ` · ${x.aside}` : ""}`);
            if (x.note) out.push(`       "${x.note}"`);
          }
          break;
        case "bullets":
          out.push(`   ${b.title.toUpperCase()}`);
          if (b.lead) out.push(`   ${b.lead}`);
          for (const x of b.items) out.push(`   • ${x}`);
          if (b.sources?.length) out.push(`   (Sources: ${b.sources.map((x) => x.label).join(", ")})`);
          break;
        case "overview":
          out.push(`   ${b.stats.map((x) => `${x.label}: ${x.value}`).join("  |  ")}`);
          if (b.bars && barsShown(b.bars)) out.push(`   Job progress: ${b.bars.done}% done, ${b.bars.plan}% planned by now`);
          if (b.lines.length) {
            out.push(`   ${b.title.toUpperCase()}`);
            for (const l of b.lines) out.push(`   ${l.label ? `${l.label}: ` : ""}${l.text}`);
          }
          break;
        case "columns":
          for (const c of b.cols) {
            if (c.title) out.push(`   ${c.title.toUpperCase()}`);
            for (const r of c.rows) out.push(`   • ${r.title}${r.value ? ` - ${r.value}` : ""}${r.text ? ` - ${r.text}` : ""}${r.note ? ` (${r.note})` : ""}`);
          }
          break;
        case "table": {
          // What a cell carries besides its value: its comment, its lines
          // (after a heading like "3 steps:" they follow it; after a line of
          // its own, a "; "), and its short lines under it. The first cell's
          // too: a task's "task 40% done" or a note is never dropped.
          const extra = (c: ExportCell, v: string) => {
            if (typeof c === "string") return "";
            const note = c.note ? ` ("${c.note}")` : "";
            const lines = c.lines?.length ? `${/:$/.test(v) ? " " : "; "}${c.lines.map((x) => `${x.lead ? `${x.lead} ` : ""}${x.t}${x.note ? ` ("${x.note}")` : ""}`).join("; ")}` : "";
            const sub = c.sub?.length ? ` (${c.sub.map((x) => x.t).join("; ")})` : "";
            return note + lines + sub;
          };
          // A blank first cell continues the task above: its rows indent
          // under it. Blank cells are skipped, not printed. A row's own
          // note goes on an indented line under it.
          b.rows.forEach((r, i) => {
            const c0 = r[0] ?? "";
            const v0 = cellText(c0);
            const first = v0 ? v0 + extra(c0, v0) : "";
            const tail = r.slice(1).map((c, j) => {
              const v = cellText(c);
              if (!v) return "";
              const label = b.textLabels ? b.textLabels[j + 1] ?? "" : (b.head[j + 1] ?? "").toLowerCase();
              return (label && (typeof c === "string" || (!c.tone && !c.bold)) ? `${label} ${v}` : v) + extra(c, v);
            }).filter(Boolean).join(" · ");
            if (first) out.push(`   • ${first}${tail ? ` - ${tail}` : ""}`);
            else if (tail) out.push(`       ${tail}`);
            const note = b.notes?.[i]?.trim();
            if (note) out.push(`       ${note}`);
          });
          break;
        }
        case "steps": {
          for (const { group, rows } of groupRows(b.rows, b.flat)) {
            if (group) out.push(`   ${group.title}${group.meta ? ` (${group.meta})` : ""}`);
            const indent = group ? "     " : "   ";
            for (const r of rows) {
              const name = b.flat && r.group?.title ? `${r.group.title} › ${r.name}` : r.name;
              // "done 50%", "left 12 h", "due Oct 23 7:00" — a word like
              // "not started" stands on its own.
              const right = b.rightHead && !/^[a-z]/.test(r.right) ? `${b.rightHead.toLowerCase()} ${r.right}` : r.right;
              const bits = [
                `${r.n != null ? `${r.n}. ` : "• "}${name}${tagText(r.tags)}`,
                r.when, right,
                r.who ? `who: ${r.who}` : null,
                r.wo ? `WO ${r.wo}` : null,
              ].filter(Boolean);
              out.push(`${indent}${bits.join(" - ")}`);
              if (r.note) out.push(`${indent}  ${r.note}`);
            }
          }
          break;
        }
      }
    }
  }
  if (d.footer) { out.push(""); out.push(d.footer); }
  return out.join("\n");
}

// ── Email HTML (inline styles, tables only) ──────────────────────────

/** "BEHIND" or "PLAN BY NOW" as a word in a sentence: "Behind", "Plan by now". */
const sentence = (t: string) => (t === t.toUpperCase() ? t.charAt(0) + t.slice(1).toLowerCase() : t);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The app's type scale (docs/design-rules.md TY2, TY3): 12 caption, 14
// body, 16 reading, 20 section, 26 key number; nothing smaller, and no
// tiny capitals (TY8). Radii by size (SP3): 6 small parts, 12 cards.
const FONT = "font-family:Arial,Helvetica,sans-serif;";
const INK = "#0f172a", MUTED = "#64748b", LINE = "#cbd5e1";
const TONE: Record<Tone, { fg: string; bg: string; bd: string }> = {
  rose: { fg: "#9f1239", bg: "#fff1f2", bd: "#fda4af" },
  amber: { fg: "#92400e", bg: "#fffbeb", bd: "#fcd34d" },
  emerald: { fg: "#065f46", bg: "#ecfdf5", bd: "#6ee7b7" },
  slate: { fg: INK, bg: "#f1f5f9", bd: LINE },
  muted: { fg: "#475569", bg: "#f1f5f9", bd: LINE },
};
const SOLID: Record<Tone, string> = { rose: "#e11d48", amber: "#d97706", emerald: "#059669", slate: "#334155", muted: "#64748b" };

const tagHtml = (t: ExportTag) =>
  `<span style="${FONT}font-size:12px;font-weight:600;color:${TONE[t.tone].fg};background-color:${TONE[t.tone].bg};border:1px solid ${TONE[t.tone].bd};padding:0 3px;">${esc(t.t)}</span>`;

const td = (style: string, html: string, attrs = "") => `<td ${attrs}style="${FONT}${style}">${html}</td>`;

const toneFg = (t?: Tone) => (t ? (t === "muted" ? MUTED : TONE[t].fg) : INK);
/** A WO number or tag, set apart: a light chip (its shading survives a
 *  pasted email that drops sizes and colors). */
const chipHtml = (t: string) => `<span style="font-family:Consolas,Menlo,monospace;font-size:12px;font-weight:bold;color:#1e3a8a;background-color:#eef2ff;border-radius:6px;padding:1px 6px;white-space:nowrap;">${esc(t)}</span>`;

/** A table drawn as a list (see `list` on the table block). Rows are
 *  separated by a thin line, a group's heading sits on a light band, and
 *  the value is on the right. Bold, the bands and the lines carry the
 *  structure, so it still reads when a mail app's paste drops the sizes
 *  and colors (Outlook's "merge formatting"). */
function listHtml(b: Extract<ExportBlock, { k: "table" }> & { list: NonNullable<Extract<ExportBlock, { k: "table" }>["list"]> }): string {
  const L = b.list;
  const cellOf = (c: ExportCell | undefined) => (c == null ? { t: "" } : typeof c === "string" ? { t: c } : c);
  const label = (j: number) => b.textLabels?.[j] ?? "";
  const subLines = (o: ReturnType<typeof cellOf>) => [
    ...("lines" in o && o.lines?.length ? o.lines.map((x) => ({ t: x.t, tone: x.tone, note: x.note })) : []),
    ...("sub" in o && o.sub?.length ? o.sub.map((x) => ({ t: x.t, tone: x.tone, note: undefined as string | undefined })) : []),
  ];
  const line = (html: string, tone?: Tone, size = 14) => `<div style="${FONT}font-size:${size}px;line-height:1.45;color:${toneFg(tone)};margin-top:2px;">${html}</div>`;
  let html = "", open = false, first = true;
  const close = () => { if (open) { html += `</table>`; open = false; } };
  const start = () => { if (!open) { html += `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;border-spacing:0;border:1px solid ${LINE};border-radius:8px;margin:0 0 8px;">`; open = true; first = true; } };
  b.rows.forEach((r, i) => {
    const g = L.group != null ? cellOf(r[L.group]) : null;
    // "+ 3 more" in the group's column is a row of its own, not a heading.
    if (g && g.t.startsWith("+ ")) { start(); html += `<tr>${td(`padding:8px 12px;font-size:12px;color:${MUTED};${first ? "" : "border-top:1px solid #e2e8f0;"}`, esc(g.t), `colspan="2" `)}</tr>`; first = false; return; }
    if (g && g.t) {
      start();
      // The group's heading: its name bold on a light band, its standing beside it.
      const gsub = subLines(g).map((x) => x.t).join(" · ");
      html += `<tr>${td(`padding:8px 12px;background-color:#f1f5f9;${first ? "border-radius:8px 8px 0 0;" : `border-top:1px solid ${LINE};`}`,
        `<b style="font-size:14px;color:${INK};">${esc(g.t)}</b>${gsub ? `<span style="font-size:12px;color:${MUTED};">&nbsp; ${esc(gsub)}</span>` : ""}`, `colspan="2" bgcolor="#f1f5f9" `)}</tr>`;
      first = false;
    }
    start();
    const t = cellOf(r[L.title]);
    if (!t.t && !(L.right != null && cellText(r[L.right] ?? ""))) return;
    const tag = L.tag != null ? cellText(r[L.tag] ?? "") : "";
    const under = subLines(t);
    const rows = (L.lines ?? []).map((cols) => cols.map((j) => {
      const c = cellOf(r[j]);
      if (!c.t || c.t === "-") return "";
      const lab = label(j);
      // "0% done", "goal 100%", "WO 301859": the label where it reads.
      const word = lab && !c.tone ? (lab === "done" ? `${c.t} ${lab}` : `${lab} ${c.t}`) : c.t;
      return `<span style="color:${toneFg(c.tone)};${c.bold ? "font-weight:bold;" : ""}">${esc(word)}</span>`;
    }).filter(Boolean).join(`<span style="color:${MUTED};"> · </span>`)).filter(Boolean);
    const extra = (L.lines ?? []).flat().flatMap((j) => subLines(cellOf(r[j])));
    const note = "note" in t && t.note ? `<div style="${FONT}font-size:12px;font-style:italic;color:${MUTED};margin-top:2px;">“${esc(t.note)}”</div>` : "";
    // Under the name, one size (12): its flags first (critical path, why
    // behind), then who and when, then the rest (where the task stands).
    const sub = (x: { t: string; tone?: Tone; note?: string }) => line(esc(x.t), x.tone ?? "muted", 12) + (x.note ? `<div style="${FONT}font-size:12px;font-style:italic;color:${MUTED};">“${esc(x.note)}”</div>` : "");
    const flagged = (x: { tone?: Tone }) => !!x.tone && x.tone !== "muted" && x.tone !== "slate";
    // What was written on the step comes right under its name.
    const left = `<div style="${FONT}font-size:14px;line-height:1.4;font-weight:bold;color:${toneFg(t.tone)};">${esc(t.t)}${tag ? `&nbsp; ${chipHtml(tag)}` : ""}</div>` + note +
      under.filter(flagged).map(sub).join("") +
      rows.map((x) => line(x, undefined, 12)).join("") +
      [...under.filter((x) => !flagged(x)), ...extra].map(sub).join("");
    // The value on the right; a long one ("Done late, was due Nov 11
    // 12:00 PM") keeps its first words there and puts the rest under them.
    const rc = L.right != null ? cellOf(r[L.right]) : { t: "" };
    const cut = rc.t.length > 14 ? rc.t.indexOf(", ") : -1;
    const rTop = cut > 0 ? rc.t.slice(0, cut) : rc.t, rRest = cut > 0 ? rc.t.slice(cut + 2) : "";
    const underRight = [rRest, ...(L.under ?? []).map((j) => { const c = cellOf(r[j]); return c.t && c.t !== "-" ? (label(j) && !c.tone ? `${label(j)} ${c.t}` : c.t) : ""; })].filter(Boolean);
    // A bare value ("−1 h") says what it is under it ("vs plan").
    if (!underRight.length && rc.t && L.right != null && label(L.right)) underRight.push(label(L.right));
    const rsub = subLines(rc);
    const right = rc.t || underRight.length
      ? `<div style="${FONT}font-size:14px;font-weight:bold;color:${toneFg(rc.tone)};white-space:nowrap;">${esc(rTop)}</div>` +
        underRight.map((x) => `<div style="${FONT}font-size:12px;color:${MUTED};white-space:nowrap;">${esc(x)}</div>`).join("") +
        rsub.map((x) => `<div style="${FONT}font-size:12px;color:${toneFg(x.tone ?? "muted")};">${esc(x.t)}</div>`).join("")
      : "";
    const top = first ? "" : `border-top:1px solid #e2e8f0;`;
    html += `<tr>${td(`padding:8px 12px;vertical-align:top;${top}`, left)}${td(`padding:8px 12px 8px 0;vertical-align:top;text-align:right;width:1%;${top}`, right)}</tr>`;
    first = false;
    const n = b.notes?.[i]?.trim();
    if (n) html += `<tr>${td(`padding:0 12px 8px;font-size:12px;line-height:1.4;color:#475569;`, esc(n), `colspan="2" `)}</tr>`;
  });
  close();
  return html;
}

function blockHtml(b: ExportBlock): string {
  switch (b.k) {
    case "stats":
      // Under the status sentence (which has the key number), the rest is
      // one line of facts, never a row of equal tiles (rule N6).
      if (b.small) return `<p style="${FONT}font-size:14px;line-height:1.5;margin:2px 0 4px;color:${MUTED};">${b.items.map((x) =>
        `${esc(sentence(x.label))} <b style="color:${x.tone === "rose" ? TONE.rose.fg : INK};white-space:nowrap;">${esc(x.value).replace(/ /g, "&nbsp;")}</b>`).join(" &middot; ")}</p>`;
      return `<table role="presentation" cellpadding="0" cellspacing="3" border="0" style="border-collapse:separate;margin:2px 0 4px -3px;"><tr>${b.items.map((x) => {
        const t = TONE[x.tone];
        // Narrow enough that four tiles fit a phone screen (375px). Under a
        // status sentence the tiles are quiet: the sentence has the answer.
        return td(`border:1px solid ${t.bd};background-color:${t.bg};padding:${b.small ? "3px 6px" : "4px 8px"};min-width:60px;`,
          `<div style="${FONT}font-size:12px;font-weight:600;color:${MUTED};white-space:nowrap;">${esc(x.label)}</div>` +
          `<div style="${FONT}font-size:${b.small ? 14 : 20}px;font-weight:bold;color:${t.fg};white-space:nowrap;">${esc(x.value)}</div>`, `bgcolor="${t.bg}" `);
      }).join("")}</tr></table>`;
    case "note":
      // A line that is good or bad news is one tinted line with its mark
      // (a single line, never a list: rule S1).
      if (b.tone && b.tone !== "muted" && b.tone !== "slate") {
        const t = TONE[b.tone];
        return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:4px 0;"><tr>` +
          td(`font-size:14px;line-height:1.45;font-weight:bold;color:${t.fg};background-color:${t.bg};border-radius:6px;padding:6px 12px;`,
            `<span style="color:${SOLID[b.tone]};">${b.tone === "emerald" ? "&#10003;" : "!"}</span>&nbsp;&nbsp;${esc(b.text)}`, `bgcolor="${t.bg}" `) + `</tr></table>`;
      }
      return `<p style="${FONT}font-size:14px;line-height:1.45;margin:3px 0;color:${b.tone ? TONE[b.tone].fg : INK};">${esc(b.text)}</p>`;
    case "sub":
      return `<p style="${FONT}font-size:12px;font-weight:600;margin:8px 0 3px;color:${TONE[b.tone].fg};">${esc(b.title)} (${b.count})</p>`;
    case "label":
      return `<p style="${FONT}font-size:14px;font-weight:bold;margin:12px 0 6px;color:${INK};">${esc(b.text)}</p>`;
    case "empty":
      return `<p style="${FONT}font-size:14px;line-height:1.45;margin:3px 0;color:${MUTED};">${esc(b.text)}</p>`;
    case "list":
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${b.items.map((x) =>
        `<tr>${td("font-size:12px;color:#059669;padding:1px 6px 1px 0;vertical-align:top;", "&#10003;")}${td(`font-size:12px;color:${INK};padding:1px 0;`,
          `${esc(x.text)}${x.note ? ` <span style="color:${MUTED};font-size:12px;">${esc(x.note)}</span>` : ""}`)}</tr>`).join("")}</table>`;
    case "lines":
      return (b.title ? `<p style="${FONT}font-size:12px;font-weight:bold;margin:10px 0 3px;color:${b.tone ? TONE[b.tone].fg : INK};">${esc(b.title)}</p>` : "") +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">${b.items.map((x) =>
          `<tr>${td(`font-size:14px;color:${MUTED};padding:3px 6px 3px 2px;vertical-align:top;width:10px;`, "&bull;")}${td(`font-size:14px;color:${INK};padding:3px 0;vertical-align:top;line-height:1.4;`,
            `<b style="color:${INK};">${esc(x.lead)}</b> - <span style="color:${x.tone ? (x.tone === "muted" ? MUTED : TONE[x.tone].fg) : INK};">${esc(x.text)}</span>` +
            (x.aside ? `<span style="color:${MUTED};"> · ${esc(x.aside)}</span>` : "") +
            (x.note ? `<div style="${FONT}font-size:12px;font-style:italic;color:${MUTED};">“${esc(x.note)}”</div>` : ""))}</tr>`).join("")}</table>`;
    case "bullets":
      return `<div style="${FONT}font-size:14px;font-weight:bold;color:${INK};border-bottom:2px solid ${b.tone ? SOLID[b.tone] : INK};padding-bottom:2px;margin-bottom:4px;">${esc(b.title)}</div>` +
        (b.lead ? `<p style="${FONT}font-size:12px;color:${MUTED};margin:0 0 4px;">${esc(b.lead)}</p>` : "") +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">${b.items.map((x) =>
          `<tr>${td(`font-size:14px;color:${MUTED};padding:3px 6px 3px 2px;vertical-align:top;width:10px;`, "&bull;")}${td(`font-size:14px;color:${INK};padding:3px 0;vertical-align:top;line-height:1.4;`, esc(x))}</tr>`).join("")}</table>` +
        (b.sources?.length ? `<p style="${FONT}font-size:12px;color:${MUTED};margin:4px 0 0;">From ${b.sources.map((x) => `<a href="${esc(x.url)}" style="color:${MUTED};">${esc(x.label)}</a>`).join(" · ")}</p>` : "");
    case "table": {
      if (b.list) return listHtml(b as Extract<ExportBlock, { k: "table" }> & { list: NonNullable<Extract<ExportBlock, { k: "table" }>["list"]> });
      // A column with nothing in it (no step started yet) isn't drawn.
      const keep = b.head.map((_, j) => j === 0 || b.rows.some((r) => cellText(r[j] ?? "") !== ""));
      const al = (j: number) => b.align?.[j] ?? "left";
      // A row's own note: a second row across every column, no rule
      // between them, so a long note reads as one line under its row.
      const noteRow = (i: number) => {
        const n = b.notes?.[i]?.trim();
        return n ? `<tr>${td(`font-size:12px;line-height:1.4;color:#475569;padding:0 8px 6px;text-align:left;vertical-align:top;`, esc(n), `colspan="${keep.filter(Boolean).length}" `)}</tr>` : "";
      };
      return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${LINE};">` +
        // A column that never wraps (times, WO numbers) takes only the
        // width it needs; the words get the rest.
        `<tr>${b.head.map((h, j) => !keep[j] ? "" : td(`font-size:12px;font-weight:600;color:${MUTED};background-color:#f8fafc;padding:5px 8px;border-bottom:1px solid ${LINE};text-align:${al(j)};white-space:nowrap;${b.nowrap?.includes(j) ? "width:1%;" : ""}`, esc(h), `bgcolor="#f8fafc" `)).join("")}</tr>` +
        b.rows.map((r, i) => {
          // A row that continues the task above has no line between them.
          const cont = cellText(r[0] ?? "") === "";
          return `<tr>${r.map((c, j) => {
            if (!keep[j]) return "";
            const o = typeof c === "string" ? { t: c } : c;
            const color = o.tone ? (o.tone === "muted" ? MUTED : TONE[o.tone].fg) : INK;
            const note = "note" in o && o.note ? `<div style="${FONT}font-size:12px;font-style:italic;font-weight:normal;color:${MUTED};margin-top:1px;">“${esc(o.note)}”</div>` : "";
            // One step per line, its time / WO first, its comment under it.
            const lines = "lines" in o && o.lines?.length ? o.lines.map((x) =>
              `<div style="${FONT}font-size:14px;font-weight:normal;color:${x.tone ? (x.tone === "muted" ? MUTED : TONE[x.tone].fg) : INK};margin-top:2px;">${x.lead ? `<span style="font-family:Consolas,Menlo,monospace;font-size:12px;color:#334155;">${esc(x.lead)}</span>&nbsp; ` : ""}${esc(x.t)}</div>` +
              (x.note ? `<div style="${FONT}font-size:12px;font-style:italic;font-weight:normal;color:${MUTED};margin:1px 0 0 ${x.lead ? 12 : 0}px;">“${esc(x.note)}”</div>` : "")).join("") : "";
            const sub = "sub" in o && o.sub?.length ? o.sub.map((x) =>
              `<div style="${FONT}font-size:12px;font-weight:normal;${x.italic ? "font-style:italic;" : ""}color:${x.tone ? (x.tone === "muted" ? MUTED : TONE[x.tone].fg) : MUTED};margin-top:2px;">${esc(x.t)}</div>`).join("") : "";
            const nw = b.nowrap?.includes(j) ? "white-space:nowrap;" : "";
            return td(`font-size:14px;color:${color};padding:5px 8px;${cont ? "" : "border-top:1px solid #e2e8f0;"}text-align:${al(j)};vertical-align:top;${nw}${o.bold ? "font-weight:bold;" : ""}`, esc(o.t) + lines + note + sub);
          }).join("")}</tr>` + noteRow(i);
        }).join("") +
        `</table>`;
    }
    case "overview": {
      // Left: the numbers and the two bars. Right: the bottom line.
      const left = blockHtml({ k: "stats", items: b.stats, small: b.small }) + (b.bars && barsShown(b.bars) ? barsHtml(b.bars) : "");
      // No lines: the numbers and bars take the whole width.
      if (!b.lines.length) return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr>${td("vertical-align:top;padding:0;", left)}</tr></table>`;
      const right = `<div style="${FONT}font-size:12px;font-weight:600;color:#4338ca;margin-bottom:3px;">${esc(b.title)}</div>` +
        b.lines.map((l, i) => `<div style="${FONT}font-size:12px;line-height:1.4;margin-top:${i ? 3 : 0}px;color:${l.tone ? TONE[l.tone].fg : INK};">${l.label ? `<b>${esc(l.label)}:</b> ` : ""}${i === 0 && !l.label ? `<b>${esc(l.text)}</b>` : esc(l.text)}</div>`).join("");
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr>` +
        td("vertical-align:top;padding:0 10px 0 0;width:330px;", left, `width="330" `) +
        // min-width: on a phone the row scrolls sideways instead of squeezing the
        // bottom line into a word-per-line column (Outlook desktop ignores it).
        td("vertical-align:top;padding:7px 10px;background-color:#eef2ff;border:1px solid #c7d2fe;min-width:240px;", right, `bgcolor="#eef2ff" `) +
        `</tr></table>`;
    }
    case "columns": {
      const w = Math.floor(100 / Math.max(1, b.cols.length));
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr>` +
        b.cols.map((c, i) => td(`vertical-align:top;padding:0 ${i < b.cols.length - 1 ? 10 : 0}px 0 0;`,
          (c.title ? `<div style="${FONT}font-size:14px;font-weight:bold;color:${INK};border-bottom:2px solid ${c.tone ? SOLID[c.tone] : INK};padding-bottom:2px;margin-bottom:4px;">${esc(c.title)}</div>` : "") +
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">` +
          c.rows.map((r) => r.text != null
            ? `<tr>${td(`font-size:12px;line-height:1.4;color:${INK};padding:2px 0 4px;`, `<b>${esc(r.title)}</b>${r.text ? `<br><span style="color:#475569;">${esc(r.text)}</span>` : ""}`)}</tr>`
            // The value never wraps — non-breaking spaces too, for mail apps
            // that ignore nowrap on a phone. A note goes under the name.
            : `<tr>${td(`font-size:12px;color:${INK};padding:3px 6px;border:1px solid #e2e8f0;`, `<b>${esc(r.title)}</b>${r.note ? `<div style="${FONT}font-size:12px;color:${MUTED};">${esc(r.note)}</div>` : ""}`)}${td(`font-size:12px;color:${MUTED};padding:3px 6px;border:1px solid #e2e8f0;text-align:right;white-space:nowrap;vertical-align:top;`, esc(r.value ?? "").replace(/ /g, "&nbsp;"))}</tr>`).join("") +
          `</table>`, `width="${w}%" `)).join("") +
        `</tr></table>`;
    }
    case "steps": {
      const hasN = b.rows.some((r) => r.n != null);
      const hasWho = b.rows.some((r) => r.who);
      const hasWo = b.rows.some((r) => r.wo);
      const cols = (hasN ? 1 : 0) + 3 + (hasWho ? 1 : 0) + (hasWo ? 1 : 0);
      const th = (h: string, align = "left") => td(`font-size:12px;font-weight:bold;color:${MUTED};background-color:#f8fafc;padding:4px 6px;border-bottom:1px solid ${LINE};text-align:${align};`, esc(h), `bgcolor="#f8fafc" `);
      let html = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${LINE};">`;
      html += `<tr>${hasN ? th("#") : ""}${th(b.whenHead)}${th("Step")}${hasWho ? th("Who") : ""}${hasWo ? th("WO") : ""}${th(b.rightHead, "right")}</tr>`;
      for (const { group, rows } of groupRows(b.rows, b.flat)) {
        if (group) {
          html += `<tr>${td(`font-size:12px;color:${INK};background-color:#f1f5f9;padding:4px 6px;border-top:1px solid ${LINE};`,
            `<b>${esc(group.title)}</b>${group.crumbs ? ` <span style="color:${MUTED};">· ${esc(group.crumbs)}</span>` : ""}${group.meta ? ` <span style="color:#475569;font-size:12px;">- ${esc(group.meta)}</span>` : ""}`,
            `colspan="${cols}" bgcolor="#f1f5f9" `)}</tr>`;
        }
        for (const r of rows) {
        const name = `${b.flat && r.group?.title ? `<span style="color:${MUTED};">${esc(r.group.title)} › </span>` : ""}<b>${esc(r.name)}</b>` +
          (r.tags?.length ? ` ${r.tags.map(tagHtml).join(" ")}` : "") +
          (r.note ? `<div style="${FONT}font-size:12px;color:#475569;margin-top:1px;">${esc(r.note)}</div>` : "");
        const cell = `font-size:12px;color:${INK};padding:3px 6px;border-top:1px solid #e2e8f0;vertical-align:top;`;
        html += `<tr>${hasN ? td(cell + "font-weight:bold;", r.n != null ? String(r.n) : "") : ""}` +
          td(cell + "white-space:nowrap;font-size:12px;", esc(r.when)) + td(cell, name) +
          (hasWho ? td(cell + "font-size:12px;color:#475569;", esc(r.who ?? "")) : "") +
          (hasWo ? td(cell + "font-size:12px;color:#475569;white-space:nowrap;", esc(r.wo ?? "")) : "") +
          td(cell + "text-align:right;white-space:nowrap;font-weight:bold;", esc(r.right)) + `</tr>`;
        }
      }
      return html + `</table>`;
    }
  }
}

/** The update as email HTML: no em dash in it, whatever the text came from. */
export function toEmailHtml(d: ExportDoc): string {
  return noEmDash(emailHtml(d));
}

/** The pieces of the update's header, each one on or off for the email and
 *  the export: the masthead's lines, its verdict, and Where we stand's
 *  line, numbers and bars. */
export type HeaderPart = "kind" | "project" | "when" | "asof" | "status" | "headcount" | "standLine" | "complete" | "plan" | "gap" | "steps" | "bars";
export const HEADER_PARTS: Array<{ id: HeaderPart; word: string }> = [
  { id: "kind", word: "Shift turnover" }, { id: "project", word: "Project name" }, { id: "when", word: "Shifts" }, { id: "asof", word: "As of" },
  { id: "status", word: "Status" }, { id: "headcount", word: "Head count" }, { id: "standLine", word: "Day, finish dates" }, { id: "complete", word: "Complete" },
  { id: "plan", word: "Plan by now" }, { id: "gap", word: "Work ahead / behind" }, { id: "steps", word: "Steps done" }, { id: "bars", word: "Done / plan bars" },
];
/** Which piece a Where we stand number is. */
export function tilePart(label: string): HeaderPart | null {
  if (/^complete/i.test(label)) return "complete";
  if (/^plan by now/i.test(label)) return "plan";
  if (/^(work ahead|work behind|gap)/i.test(label)) return "gap";
  if (/^steps done/i.test(label)) return "steps";
  return null;
}

/** A Where we stand line's pieces the verdict already says ("43.5 h late",
 *  "forecast finish Tue, Nov 17 8:30 PM" beside "finished Tue, Nov 17
 *  8:30 PM ...") are left out: each fact once. */
function notSaid(sub: string, s?: ExportDoc["status"] | null): string {
  const said = `${s?.key ?? ""} ${s?.detail ?? ""}`;
  const fresh = (seg: string) => { const core = seg.replace(/^[a-z ]+?(?=[A-Z0-9])/, "").trim(); return !(core && said.includes(core)); };
  return sub.split(" · ").map((seg) => seg.split(" - ").filter(fresh).join(" - ")).filter(Boolean).join(" · ");
}

const isOverview = (b: ExportBlock): b is Extract<ExportBlock, { k: "overview" }> => b.k === "overview";

/** Done and plan as two thin bars, over the whole job. */
function barsHtml(b: { done: number; plan: number; from: string; to: string }): string {
  const bar = (label: string, pct: number, color: string) => {
    const w = Math.max(0, Math.min(100, Math.round(pct)));
    return `<tr>${td(`font-size:12px;color:${MUTED};padding:1px 6px 1px 0;white-space:nowrap;width:34px;`, esc(label))}` +
      td("padding:1px 0;", `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr>` +
        (w > 0 ? td(`background-color:${color};height:8px;font-size:1px;line-height:1px;`, "&nbsp;", `width="${w}%" bgcolor="${color}" `) : "") +
        (w < 100 ? td("background-color:#e2e8f0;height:8px;font-size:1px;line-height:1px;", "&nbsp;", `bgcolor="#e2e8f0" `) : "") +
        `</tr></table>`) +
      td(`font-size:12px;color:${INK};font-weight:bold;padding:1px 0 1px 6px;white-space:nowrap;width:30px;text-align:right;`, `${w}%`) + `</tr>`;
  };
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:6px;max-width:420px;">` +
    bar("Done", b.done, "#0f766e") + bar("Plan", b.plan, "#94a3b8") +
    `<tr>${td("", "")}${td(`font-size:12px;color:${MUTED};padding-top:1px;`, `${esc(b.from)} → ${esc(b.to)} · whole job`)}${td("", "")}</tr></table>`;
}

/** The update's card, read in one look (the pattern from the posts the
 *  owner sent: one card, the key number big, the numbers under it each a
 *  small label over its value). What and when; the verdict with its key
 *  number and one sentence; the numbers in one row that wraps on a phone;
 *  the phase line and the crews on site small at the foot. Every piece can
 *  be left out. White card, dark text, every color on the element itself
 *  (phone mail apps in dark mode recolor text and backgrounds separately;
 *  rule S1: the verdict's color is a rule down the side, never the fill). */
function heroHtml(d: ExportDoc, off: ReadonlySet<HeaderPart> = new Set(), o: { crews?: boolean } = {}): string {
  const s = d.status && !off.has("status") ? d.status : null;
  const t = s ? TONE[s.tone] : null;
  const project = off.has("project") ? "" : d.project;
  const stand = d.sections.find((x) => x.id === "stand");
  const ov = stand?.blocks.find(isOverview);
  const stats = (ov?.stats ?? []).filter((x) => { const p = tilePart(x.label); return !p || !off.has(p); });
  const head = d.headcount && !off.has("headcount") ? d.headcount : "";
  const onSite = head.match(/^(\d+) on site(?::\s*(.+))?$/);
  const metrics = [...stats.map((x) => ({ label: sentence(x.label), value: x.value, tone: x.tone })),
    ...(onSite ? [{ label: "On site", value: onSite[1], tone: "slate" as Tone }] : [])];
  const bars = ov?.bars && barsShown(ov.bars) && !off.has("bars") ? ov.bars : undefined;
  const standLine = stand?.sub && !off.has("standLine") ? notSaid(stand.sub, s) : "";
  // The crews' counts, unless the shift table under the card lists them.
  const crews = o.crews === false ? "" : onSite ? (onSite[2] ? `On site: ${onSite[2]}` : "") : head;
  const rows: string[] = [];
  // What and when, in pieces, never one run-on line: the kind small with
  // the as-of time on the right, the project, then each shift as a small
  // label over its value ("This shift" / "Day shift Mon, Nov 16 6:00 AM–6:00
  // PM"). Notes on the as-of time ("progress as recorded by …") go to the foot.
  const [asOfTime, ...asOfNotes] = off.has("asof") ? [""] : d.asOf.split(" · ");
  const shifts = off.has("when") ? [] : d.when.split(" → ");
  const pair = (label: string, value: string) => `<div style="display:inline-block;vertical-align:top;margin:0 28px 4px 0;">` +
    `<div style="${FONT}font-size:12px;color:${MUTED};">${esc(label)}</div><div style="${FONT}font-size:14px;font-weight:bold;color:${INK};">${esc(value)}</div></div>`;
  const shiftPairs = shifts.length > 1 ? pair("This shift", shifts[0]) + pair("Next shift", shifts.slice(1).join(" → ")) : shifts.length ? pair("Shift", shifts[0]) : "";
  const kind = off.has("kind") ? "" : d.kind;
  if (kind || asOfTime || project || shiftPairs) rows.push(td("padding:12px 16px 0;",
    (kind || asOfTime ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr>` +
      td(`font-size:12px;color:${MUTED};`, esc(kind)) + td(`font-size:12px;color:${MUTED};text-align:right;white-space:nowrap;`, asOfTime ? `As of ${esc(asOfTime)}` : "") + `</tr></table>` : "") +
    (project ? `<div style="${FONT}font-size:20px;line-height:1.3;font-weight:bold;color:${INK};margin-top:2px;">${esc(project)}</div>` : "") +
    (shiftPairs ? `<div style="margin-top:8px;">${shiftPairs}</div>` : "")));
  if (s && t) {
    // The verdict in a shaded box: its key number and word. The shading and
    // bold survive a paste that drops sizes and colors, so the answer still
    // stands out; the sentence beside it says the rest.
    // The shaded box sits in its own table, so it is only as tall as what's
    // in it, whatever the sentence beside it wraps to.
    const box = td("padding:0;vertical-align:top;width:1%;", `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:0;"><tr>` +
      td(`padding:8px 14px;background-color:${t.bg};border-radius:8px;white-space:nowrap;`,
        (s.key ? `<div style="${FONT}font-size:26px;line-height:1.1;font-weight:bold;color:${t.fg};white-space:nowrap;">${esc(s.key).replace(/ /g, "&nbsp;")}</div>` : "") +
        `<div style="${FONT}font-size:${s.key ? 12 : 16}px;font-weight:bold;color:${t.fg};">${esc(sentence(s.label))}</div>`, `bgcolor="${t.bg}" `) + `</tr></table>`);
    rows.push(td("padding:12px 16px;", `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;border-spacing:0;"><tr>` +
      box + td("padding:0 0 0 14px;vertical-align:top;", s.detail ? `<div style="${FONT}font-size:14px;line-height:1.45;color:${INK};">${esc(s.detail)}</div>` : "") + `</tr></table>`));
  }
  const foot = [standLine, ...asOfNotes].filter(Boolean).join(" · ");
  if (metrics.length || bars || foot || crews) rows.push(td(`padding:10px 16px 10px;border-top:1px solid #e2e8f0;`,
    // Inline blocks, not cells: on a phone the numbers wrap to a second
    // line instead of squeezing (Outlook desktop stacks them, still read).
    metrics.map((m) => `<div style="display:inline-block;vertical-align:top;margin:0 24px 4px 0;">` +
      `<div style="${FONT}font-size:12px;color:${MUTED};white-space:nowrap;">${esc(m.label)}</div>` +
      `<div style="${FONT}font-size:16px;font-weight:bold;color:${m.tone === "rose" || m.tone === "amber" || m.tone === "emerald" ? TONE[m.tone].fg : INK};white-space:nowrap;">${esc(m.value).replace(/ /g, "&nbsp;")}</div></div>`).join("") +
    (bars ? barsHtml(bars) : "") +
    (foot ? `<div style="${FONT}font-size:12px;line-height:1.4;color:${MUTED};margin-top:4px;">${esc(foot)}</div>` : "") +
    (crews ? `<div style="${FONT}font-size:12px;line-height:1.4;color:#334155;margin-top:2px;">${esc(crews)}</div>` : "")));
  if (!rows.length) return "";
  const edge = s ? SOLID[s.tone] : LINE;
  return `<table data-hero="1" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#ffffff" style="border-collapse:separate;border-spacing:0;max-width:820px;background-color:#ffffff;border:1px solid ${LINE};border-left:4px solid ${edge};border-radius:12px;">` +
    rows.map((r) => `<tr>${r}</tr>`).join("") + `</table>`;
}

/** The header as picked, for the required format: the card. `crews:
 *  false` when the table under it has the head count by crew. */
export function headerHtml(d: ExportDoc, off: ReadonlySet<HeaderPart>, o: { crews?: boolean } = {}): string {
  const html = heroHtml(d, off, o);
  return html ? `<div style="${FONT}color:${INK};max-width:820px;margin-bottom:14px;">${html}</div>` : "";
}

/** The header as text, the same pieces. */
export function headerText(d: ExportDoc, off: ReadonlySet<HeaderPart>): string {
  const out: string[] = [];
  if (!off.has("kind")) out.push(d.kind.toUpperCase());
  if (!off.has("project")) out.push(d.project);
  const whenLine = [off.has("when") ? "" : d.when, off.has("asof") ? "" : `as of ${d.asOf}`].filter(Boolean).join(" · ");
  if (whenLine) out.push(whenLine);
  if (d.status && !off.has("status")) out.push(`${d.status.label}${d.status.detail ? ` - ${d.status.detail}` : ""}`);
  if (d.headcount && !off.has("headcount")) out.push(d.headcount);
  const stand = d.sections.find((s) => s.id === "stand");
  const ov = stand?.blocks.find((b): b is Extract<ExportBlock, { k: "overview" }> => b.k === "overview");
  if (stand && !off.has("standLine")) out.push(`Where we stand${stand.sub ? ` - ${stand.sub}` : ""}`);
  const stats = (ov?.stats ?? []).filter((x) => { const p = tilePart(x.label); return !p || !off.has(p); });
  if (stats.length) out.push(stats.map((x) => `${x.label}: ${x.value}`).join(" · "));
  if (ov?.bars && barsShown(ov.bars) && !off.has("bars")) out.push(`Done ${ov.bars.done}% · Plan ${ov.bars.plan}% (${ov.bars.from} to ${ov.bars.to})`);
  return noEmDash(out.join("\n"));
}

function emailHtml(d: ExportDoc): string {
  let html = `<div style="${FONT}color:${INK};">`;
  html += heroHtml(d);
  for (const sec of d.sections) {
    // Where we stand's numbers and line are in the card; what's left of it
    // (why behind) stays as a section, without the line said twice.
    // (why behind) stays as a section, its own heading for a title ("Why
    // we're behind", "15 h of work behind plan" under it).
    const left = sec.blocks.filter((b) => !isOverview(b));
    const lead = left[0]?.k === "label" ? left[0].text : "";
    const cut = lead.indexOf(" - ");
    const s = sec.id === "stand" && sec.blocks.some(isOverview)
      ? lead ? { ...sec, title: cut > 0 ? lead.slice(0, cut) : lead, sub: cut > 0 ? lead.slice(cut + 3) : undefined, blocks: left.slice(1) } : { ...sec, sub: undefined, blocks: left }
      : sec;
    if (!s.blocks.length) continue;
    // The section's heading on a light band (it survives a pasted email that
    // drops sizes and colors, so the sections still stand apart). The title
    // bold with its count beside it ("Done · 6 finished"); the shift and
    // anything else on a line under it, never one run-on line. A section
    // that needs attention gets a rule down its left in its color.
    const segs = (s.sub ?? "").split(" · ").filter(Boolean);
    const counts = segs.filter((x) => /^[+\d]/.test(x));
    const rest = segs.filter((x) => !/^[+\d]/.test(x));
    const edge = s.flag === "rose" ? SOLID.rose : s.flag === "amber" ? SOLID.amber : "#f1f5f9";
    // data-sec: lets a printed copy put a section on its own page (safety).
    html += `<table data-sec="${esc(s.id ?? "")}" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:820px;margin-top:20px;"><tr>` +
      td(`padding:8px 12px;background-color:#f1f5f9;border-left:4px solid ${edge};border-radius:8px;`,
        `<div style="${FONT}font-size:16px;line-height:1.3;color:${INK};"><b>${esc(s.title)}</b>${counts.length ? `<span style="color:#334155;"> · ${esc(counts.join(" · "))}</span>` : ""}</div>` +
        (rest.length ? `<div style="${FONT}font-size:12px;line-height:1.4;color:${MUTED};margin-top:1px;">${esc(rest.join(" · "))}</div>` : ""), `bgcolor="#f1f5f9" `) +
      `</tr><tr>${td("padding:8px 0 0;", s.blocks.map(blockHtml).join(""))}</tr></table>`;
  }
  if (d.footer) html += `<p style="${FONT}font-size:12px;color:#94a3b8;margin-top:14px;max-width:820px;">${esc(d.footer)}</p>`;
  return html + `</div>`;
}
