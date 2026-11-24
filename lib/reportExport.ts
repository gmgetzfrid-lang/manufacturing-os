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
// tiny capitals (TY8). Panels round at 8 px (SP3).
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
      return `<p style="${FONT}font-size:12px;margin:3px 0;color:${b.tone ? TONE[b.tone].fg : INK};${b.tone ? "font-weight:bold;" : ""}">${esc(b.text)}</p>`;
    case "sub":
      return `<p style="${FONT}font-size:12px;font-weight:600;margin:8px 0 3px;color:${TONE[b.tone].fg};">${esc(b.title)} (${b.count})</p>`;
    case "label":
      return `<p style="${FONT}font-size:12px;font-weight:bold;margin:10px 0 4px;color:${INK};">${esc(b.text)}</p>`;
    case "empty":
      return `<p style="${FONT}font-size:12px;font-style:italic;margin:3px 0;color:${MUTED};">${esc(b.text)}</p>`;
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
        `<tr>${b.head.map((h, j) => !keep[j] ? "" : td(`font-size:12px;font-weight:600;color:${MUTED};background-color:#f8fafc;padding:5px 8px;border-bottom:1px solid ${LINE};text-align:${al(j)};white-space:nowrap;`, esc(h), `bgcolor="#f8fafc" `)).join("")}</tr>` +
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
      const bar = (label: string, pct: number, color: string) => {
        const w = Math.max(0, Math.min(100, Math.round(pct)));
        return `<tr>${td(`font-size:12px;color:${MUTED};padding:1px 6px 1px 0;white-space:nowrap;width:34px;`, esc(label))}` +
          td("padding:1px 0;", `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr>` +
            (w > 0 ? td(`background-color:${color};height:8px;font-size:1px;line-height:1px;`, "&nbsp;", `width="${w}%" bgcolor="${color}" `) : "") +
            (w < 100 ? td("background-color:#e2e8f0;height:8px;font-size:1px;line-height:1px;", "&nbsp;", `bgcolor="#e2e8f0" `) : "") +
            `</tr></table>`) +
          td(`font-size:12px;color:${INK};font-weight:bold;padding:1px 0 1px 6px;white-space:nowrap;width:30px;text-align:right;`, `${w}%`) + `</tr>`;
      };
      const left = blockHtml({ k: "stats", items: b.stats, small: b.small }) + (b.bars && barsShown(b.bars)
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:4px;">` +
          bar("Done", b.bars.done, "#0f766e") + bar("Plan", b.bars.plan, "#94a3b8") +
          `<tr>${td("", "")}${td(`font-size:12px;color:${MUTED};padding-top:1px;`, `${esc(b.bars.from)} → ${esc(b.bars.to)} · whole job`)}${td("", "")}</tr></table>`
        : "");
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

/** The masthead with the pieces left on: what it is, the project, the
 *  shifts and time, and the verdict box. Empty when every piece is off. */
function mastheadHtml(d: ExportDoc, off: ReadonlySet<HeaderPart> = new Set()): string {
  // No dark blocks with light text anywhere: phone mail apps switching
  // light / dark mode recolor text and backgrounds separately, and white
  // text on a kept-dark background comes out black on navy. Light panels
  // with dark text (every color set on the element itself) flip cleanly.
  // A status with its key number leads the update as a sentence of its own
  // (leadHtml, under this); without one, the verdict is a small box here.
  const status = d.status && !d.status.key && !off.has("status")
    ? td(`padding:6px 10px;background-color:${TONE[d.status.tone].bg};border:1px solid ${TONE[d.status.tone].bd};border-left:4px solid ${SOLID[d.status.tone]};text-align:right;white-space:nowrap;vertical-align:middle;`,
      `<div style="${FONT}font-size:14px;font-weight:bold;color:${TONE[d.status.tone].fg};"><span style="color:${SOLID[d.status.tone]};">&#9679;</span>&nbsp;${esc(sentence(d.status.label))}</div>` +
      (d.status.detail ? `<div style="${FONT}font-size:12px;color:${TONE[d.status.tone].fg};">${esc(d.status.detail)}</div>` : ""), `bgcolor="${TONE[d.status.tone].bg}" `)
    : "";
  const whenLine = [off.has("when") ? "" : d.when, off.has("asof") ? "" : `as of ${d.asOf}`].filter(Boolean).join(" · ");
  const left = (off.has("kind") ? "" : `<div style="${FONT}font-size:12px;font-weight:600;color:${MUTED};">${esc(d.kind)}</div>`) +
    (off.has("project") ? "" : `<div style="${FONT}font-size:20px;font-weight:bold;color:${INK};">${esc(d.project)}</div>`) +
    (whenLine ? `<div style="${FONT}font-size:12px;color:#334155;">${esc(whenLine)}</div>` : "");
  const lead = leadHtml(d, off);
  if (!left && !status) return lead;
  return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:820px;"><tr>` +
    (left ? td(`padding:10px 14px;background-color:#f8fafc;border:1px solid ${LINE};border-radius:8px;`, left, `bgcolor="#f8fafc" `) : "") +
    status + `</tr></table>` + lead;
}

/** The answer first: the status as one sentence with its key number big
 *  beside it (never wrapped), the verdict's word over the sentence; then
 *  the head count in one line. A light panel with dark text, its color set
 *  on the cell itself (mail apps in dark mode recolor safely). */
function leadHtml(d: ExportDoc, off: ReadonlySet<HeaderPart>): string {
  const s = d.status && d.status.key && !off.has("status") ? d.status : null;
  const head = d.headcount && !off.has("headcount") ? d.headcount : "";
  if (!s && !head) return "";
  const t = s ? TONE[s.tone] : null;
  // The verdict on white (rule S1: color never fills the box): a rule in
  // its color down the left, the key number big, its word with a dot.
  const row = s && t
    ? `<tr>${td(`padding:10px 14px;background-color:#ffffff;border:1px solid ${LINE};border-left:4px solid ${SOLID[s.tone]};border-radius:8px 0 0 8px;border-right:0;vertical-align:middle;white-space:nowrap;width:1%;`,
      `<div style="${FONT}font-size:26px;font-weight:bold;color:${t.fg};white-space:nowrap;">${esc(s.key!).replace(/ /g, "&nbsp;")}</div>`, `bgcolor="#ffffff" `)}` +
      td(`padding:10px 14px 10px 6px;background-color:#ffffff;border:1px solid ${LINE};border-left:0;border-radius:0 8px 8px 0;vertical-align:middle;`,
        `<div style="${FONT}font-size:14px;font-weight:bold;color:${t.fg};"><span style="color:${SOLID[s.tone]};">&#9679;</span>&nbsp;${esc(sentence(s.label))}</div>` +
        (s.detail ? `<div style="${FONT}font-size:14px;line-height:1.45;color:${INK};margin-top:2px;">${esc(s.detail)}</div>` : ""), `bgcolor="#ffffff" `) + `</tr>`
    : "";
  const count = head ? `<tr>${td(`padding:${s ? 6 : 0}px 0 0;font-size:12px;color:#334155;`, esc(head), s ? `colspan="2" ` : "")}</tr>` : "";
  return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:820px;margin-top:8px;">${row}${count}</table>`;
}

/** The header as picked: the masthead, then Where we stand's line,
 *  numbers and bars (only the pieces left on), for the required format. */
export function headerHtml(d: ExportDoc, off: ReadonlySet<HeaderPart>): string {
  let html = mastheadHtml(d, off);
  const stand = d.sections.find((s) => s.id === "stand");
  const ov = stand?.blocks.find((b): b is Extract<ExportBlock, { k: "overview" }> => b.k === "overview");
  const stats = (ov?.stats ?? []).filter((x) => { const p = tilePart(x.label); return !p || !off.has(p); });
  const bars = ov?.bars && barsShown(ov.bars) && !off.has("bars") ? ov.bars : undefined;
  const line = stand && !off.has("standLine");
  if (line || stats.length || bars) {
    html += `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:820px;margin-top:${html ? 14 : 0}px;">` +
      (line ? `<tr>${td(`border-bottom:2px solid ${stand!.flag === "rose" ? SOLID.rose : INK};padding:0 0 3px;`,
        `<span style="${FONT}font-size:16px;font-weight:bold;color:${INK};">${esc(stand!.title)}</span>` + (stand!.sub ? `<span style="${FONT}font-size:12px;color:${MUTED};">&nbsp;&nbsp;${esc(stand!.sub)}</span>` : ""))}</tr>` : "") +
      (stats.length || bars ? `<tr>${td("padding:6px 0 0;", blockHtml({ k: "overview", stats, bars, title: "", lines: [], small: !!d.status?.key || ov?.small }))}</tr>` : "") +
      `</table>`;
  }
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
  html += mastheadHtml(d);
  for (const s of d.sections) {
    // A section that needs attention gets a colored rule, not a number.
    const rule = s.flag === "rose" ? SOLID.rose : s.flag === "amber" ? SOLID.amber : INK;
    // data-sec: lets a printed copy put a section on its own page (safety).
    html += `<table data-sec="${esc(s.id ?? "")}" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:820px;margin-top:18px;"><tr>` +
      td(`border-bottom:2px solid ${rule};padding:0 0 3px;`,
        `<span style="${FONT}font-size:16px;font-weight:bold;color:${INK};">${esc(s.title)}</span>` +
        (s.sub ? `<span style="${FONT}font-size:12px;color:${MUTED};">&nbsp;&nbsp;${esc(s.sub)}</span>` : "")) +
      `</tr><tr>${td("padding:6px 0 0;", s.blocks.map(blockHtml).join(""))}</tr></table>`;
  }
  if (d.footer) html += `<p style="${FONT}font-size:12px;color:#94a3b8;margin-top:14px;max-width:820px;">${esc(d.footer)}</p>`;
  return html + `</div>`;
}
