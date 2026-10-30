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
  lines?: Array<{ lead?: string; t: string; note?: string }>;
  /** Short lines under it all (where the whole task stands, why it's
   *  behind). */
  sub?: Array<{ t: string; tone?: Tone; italic?: boolean }>;
};
const cellText = (c: ExportCell) => (typeof c === "string" ? c : c.t);

export type ExportBlock =
  | { k: "stats"; items: Array<{ label: string; value: string; tone: Tone }> }
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
  }
  /** The numbers, two bars (done and planned, of the whole job) and the
   *  bottom line beside them — the update's first glance. */
  | {
    k: "overview";
    stats: Array<{ label: string; value: string; tone: Tone }>;
    bars?: { done: number; plan: number; from: string; to: string };
    title: string;
    lines: Array<{ label?: string; text: string; tone?: Tone }>;
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
  kind: string;          // "Shift turnover"
  project: string;
  when: string;          // "Day shift Wed Oct 22 5:30–17:30 → Night shift …"
  asOf: string;
  status?: { label: string; tone: Tone; detail?: string };
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
          if (b.bars) out.push(`   Job progress: ${b.bars.done}% done, ${b.bars.plan}% planned by now`);
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
          // A blank first cell continues the task above: its rows indent
          // under it. Blank cells are skipped, not printed.
          for (const r of b.rows) {
            const first = cellText(r[0] ?? "");
            const tail = r.slice(1).map((c, j) => {
              const v = cellText(c);
              if (!v) return "";
              const label = b.textLabels ? b.textLabels[j + 1] ?? "" : (b.head[j + 1] ?? "").toLowerCase();
              const note = typeof c !== "string" && c.note ? ` ("${c.note}")` : "";
              const lines = typeof c !== "string" && c.lines?.length ? ` ${c.lines.map((x) => `${x.lead ? `${x.lead} ` : ""}${x.t}${x.note ? ` ("${x.note}")` : ""}`).join("; ")}` : "";
              const sub = typeof c !== "string" && c.sub?.length ? ` (${c.sub.map((x) => x.t).join("; ")})` : "";
              return (label && (typeof c === "string" || (!c.tone && !c.bold)) ? `${label} ${v}` : v) + lines + note + sub;
            }).filter(Boolean).join(" · ");
            if (first) out.push(`   • ${first}${tail ? ` - ${tail}` : ""}`);
            else if (tail) out.push(`       ${tail}`);
          }
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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
  `<span style="${FONT}font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;color:${TONE[t.tone].fg};background-color:${TONE[t.tone].bg};border:1px solid ${TONE[t.tone].bd};padding:0 3px;">${esc(t.t)}</span>`;

const td = (style: string, html: string, attrs = "") => `<td ${attrs}style="${FONT}${style}">${html}</td>`;

function blockHtml(b: ExportBlock): string {
  switch (b.k) {
    case "stats":
      return `<table role="presentation" cellpadding="0" cellspacing="3" border="0" style="border-collapse:separate;margin:2px 0 4px -3px;"><tr>${b.items.map((x) => {
        const t = TONE[x.tone];
        // Narrow enough that four tiles fit a phone screen (375px).
        return td(`border:1px solid ${t.bd};background-color:${t.bg};padding:4px 8px;min-width:60px;`,
          `<div style="${FONT}font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;color:${MUTED};white-space:nowrap;">${esc(x.label)}</div>` +
          `<div style="${FONT}font-size:17px;font-weight:bold;color:${t.fg};white-space:nowrap;">${esc(x.value)}</div>`, `bgcolor="${t.bg}" `);
      }).join("")}</tr></table>`;
    case "note":
      return `<p style="${FONT}font-size:12px;margin:3px 0;color:${b.tone ? TONE[b.tone].fg : INK};${b.tone ? "font-weight:bold;" : ""}">${esc(b.text)}</p>`;
    case "sub":
      return `<p style="${FONT}font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin:8px 0 3px;color:${TONE[b.tone].fg};">${esc(b.title)} (${b.count})</p>`;
    case "label":
      return `<p style="${FONT}font-size:12px;font-weight:bold;margin:10px 0 4px;color:${INK};">${esc(b.text)}</p>`;
    case "empty":
      return `<p style="${FONT}font-size:12px;font-style:italic;margin:3px 0;color:${MUTED};">${esc(b.text)}</p>`;
    case "list":
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${b.items.map((x) =>
        `<tr>${td("font-size:12px;color:#059669;padding:1px 6px 1px 0;vertical-align:top;", "&#10003;")}${td(`font-size:12px;color:${INK};padding:1px 0;`,
          `${esc(x.text)}${x.note ? ` <span style="color:${MUTED};font-size:11px;">${esc(x.note)}</span>` : ""}`)}</tr>`).join("")}</table>`;
    case "lines":
      return (b.title ? `<p style="${FONT}font-size:12px;font-weight:bold;margin:10px 0 3px;color:${b.tone ? TONE[b.tone].fg : INK};">${esc(b.title)}</p>` : "") +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">${b.items.map((x) =>
          `<tr>${td(`font-size:13px;color:${MUTED};padding:3px 6px 3px 2px;vertical-align:top;width:10px;`, "&bull;")}${td(`font-size:13px;color:${INK};padding:3px 0;vertical-align:top;line-height:1.4;`,
            `<b style="color:${INK};">${esc(x.lead)}</b> - <span style="color:${x.tone ? (x.tone === "muted" ? MUTED : TONE[x.tone].fg) : INK};">${esc(x.text)}</span>` +
            (x.aside ? `<span style="color:${MUTED};"> · ${esc(x.aside)}</span>` : "") +
            (x.note ? `<div style="${FONT}font-size:11px;font-style:italic;color:${MUTED};">“${esc(x.note)}”</div>` : ""))}</tr>`).join("")}</table>`;
    case "bullets":
      return `<div style="${FONT}font-size:14px;font-weight:bold;color:${INK};border-bottom:2px solid ${b.tone ? SOLID[b.tone] : INK};padding-bottom:2px;margin-bottom:4px;">${esc(b.title)}</div>` +
        (b.lead ? `<p style="${FONT}font-size:12px;color:${MUTED};margin:0 0 4px;">${esc(b.lead)}</p>` : "") +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">${b.items.map((x) =>
          `<tr>${td(`font-size:14px;color:${MUTED};padding:3px 6px 3px 2px;vertical-align:top;width:10px;`, "&bull;")}${td(`font-size:14px;color:${INK};padding:3px 0;vertical-align:top;line-height:1.4;`, esc(x))}</tr>`).join("")}</table>` +
        (b.sources?.length ? `<p style="${FONT}font-size:10px;color:${MUTED};margin:4px 0 0;">From ${b.sources.map((x) => `<a href="${esc(x.url)}" style="color:${MUTED};">${esc(x.label)}</a>`).join(" · ")}</p>` : "");
    case "table": {
      // A column with nothing in it (no step started yet) isn't drawn.
      const keep = b.head.map((_, j) => j === 0 || b.rows.some((r) => cellText(r[j] ?? "") !== ""));
      const al = (j: number) => b.align?.[j] ?? "left";
      return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${LINE};">` +
        `<tr>${b.head.map((h, j) => !keep[j] ? "" : td(`font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:0.3px;color:${MUTED};background-color:#f8fafc;padding:5px 8px;border-bottom:1px solid ${LINE};text-align:${al(j)};white-space:nowrap;`, esc(h), `bgcolor="#f8fafc" `)).join("")}</tr>` +
        b.rows.map((r) => {
          // A row that continues the task above has no line between them.
          const cont = cellText(r[0] ?? "") === "";
          return `<tr>${r.map((c, j) => {
            if (!keep[j]) return "";
            const o = typeof c === "string" ? { t: c } : c;
            const color = o.tone ? (o.tone === "muted" ? MUTED : TONE[o.tone].fg) : INK;
            const note = "note" in o && o.note ? `<div style="${FONT}font-size:11px;font-style:italic;font-weight:normal;color:${MUTED};margin-top:1px;">“${esc(o.note)}”</div>` : "";
            // One step per line, its time / WO first, its comment under it.
            const lines = "lines" in o && o.lines?.length ? o.lines.map((x) =>
              `<div style="${FONT}font-size:13px;font-weight:normal;color:${INK};margin-top:2px;">${x.lead ? `<span style="font-family:Consolas,Menlo,monospace;font-size:12px;color:#334155;">${esc(x.lead)}</span>&nbsp; ` : ""}${esc(x.t)}</div>` +
              (x.note ? `<div style="${FONT}font-size:11px;font-style:italic;font-weight:normal;color:${MUTED};margin:1px 0 0 ${x.lead ? 12 : 0}px;">“${esc(x.note)}”</div>` : "")).join("") : "";
            const sub = "sub" in o && o.sub?.length ? o.sub.map((x) =>
              `<div style="${FONT}font-size:11px;font-weight:normal;${x.italic ? "font-style:italic;" : ""}color:${x.tone ? (x.tone === "muted" ? MUTED : TONE[x.tone].fg) : MUTED};margin-top:2px;">${esc(x.t)}</div>`).join("") : "";
            const nw = b.nowrap?.includes(j) ? "white-space:nowrap;" : "";
            return td(`font-size:13px;color:${color};padding:5px 8px;${cont ? "" : "border-top:1px solid #e2e8f0;"}text-align:${al(j)};vertical-align:top;${nw}${o.bold ? "font-weight:bold;" : ""}`, esc(o.t) + lines + note + sub);
          }).join("")}</tr>`;
        }).join("") +
        `</table>`;
    }
    case "overview": {
      // Left: the numbers and the two bars. Right: the bottom line.
      const bar = (label: string, pct: number, color: string) => {
        const w = Math.max(0, Math.min(100, Math.round(pct)));
        return `<tr>${td(`font-size:10px;color:${MUTED};padding:1px 6px 1px 0;white-space:nowrap;width:34px;`, esc(label))}` +
          td("padding:1px 0;", `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr>` +
            (w > 0 ? td(`background-color:${color};height:8px;font-size:1px;line-height:1px;`, "&nbsp;", `width="${w}%" bgcolor="${color}" `) : "") +
            (w < 100 ? td("background-color:#e2e8f0;height:8px;font-size:1px;line-height:1px;", "&nbsp;", `bgcolor="#e2e8f0" `) : "") +
            `</tr></table>`) +
          td(`font-size:10px;color:${INK};font-weight:bold;padding:1px 0 1px 6px;white-space:nowrap;width:30px;text-align:right;`, `${w}%`) + `</tr>`;
      };
      const left = blockHtml({ k: "stats", items: b.stats }) + (b.bars
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:4px;">` +
          bar("Done", b.bars.done, "#0f766e") + bar("Plan", b.bars.plan, "#94a3b8") +
          `<tr>${td("", "")}${td(`font-size:9px;color:${MUTED};padding-top:1px;`, `${esc(b.bars.from)} → ${esc(b.bars.to)} · whole job`)}${td("", "")}</tr></table>`
        : "");
      // No lines: the numbers and bars take the whole width.
      if (!b.lines.length) return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr>${td("vertical-align:top;padding:0;", left)}</tr></table>`;
      const right = `<div style="${FONT}font-size:10px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#4338ca;margin-bottom:3px;">${esc(b.title)}</div>` +
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
            : `<tr>${td(`font-size:12px;color:${INK};padding:3px 6px;border:1px solid #e2e8f0;`, `<b>${esc(r.title)}</b>${r.note ? `<div style="${FONT}font-size:11px;color:${MUTED};">${esc(r.note)}</div>` : ""}`)}${td(`font-size:12px;color:${MUTED};padding:3px 6px;border:1px solid #e2e8f0;text-align:right;white-space:nowrap;vertical-align:top;`, esc(r.value ?? "").replace(/ /g, "&nbsp;"))}</tr>`).join("") +
          `</table>`, `width="${w}%" `)).join("") +
        `</tr></table>`;
    }
    case "steps": {
      const hasN = b.rows.some((r) => r.n != null);
      const hasWho = b.rows.some((r) => r.who);
      const hasWo = b.rows.some((r) => r.wo);
      const cols = (hasN ? 1 : 0) + 3 + (hasWho ? 1 : 0) + (hasWo ? 1 : 0);
      const th = (h: string, align = "left") => td(`font-size:9px;font-weight:bold;text-transform:uppercase;color:${MUTED};background-color:#f8fafc;padding:4px 6px;border-bottom:1px solid ${LINE};text-align:${align};`, esc(h), `bgcolor="#f8fafc" `);
      let html = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${LINE};">`;
      html += `<tr>${hasN ? th("#") : ""}${th(b.whenHead)}${th("Step")}${hasWho ? th("Who") : ""}${hasWo ? th("WO") : ""}${th(b.rightHead, "right")}</tr>`;
      for (const { group, rows } of groupRows(b.rows, b.flat)) {
        if (group) {
          html += `<tr>${td(`font-size:12px;color:${INK};background-color:#f1f5f9;padding:4px 6px;border-top:1px solid ${LINE};`,
            `<b>${esc(group.title)}</b>${group.crumbs ? ` <span style="color:${MUTED};">· ${esc(group.crumbs)}</span>` : ""}${group.meta ? ` <span style="color:#475569;font-size:11px;">- ${esc(group.meta)}</span>` : ""}`,
            `colspan="${cols}" bgcolor="#f1f5f9" `)}</tr>`;
        }
        for (const r of rows) {
        const name = `${b.flat && r.group?.title ? `<span style="color:${MUTED};">${esc(r.group.title)} › </span>` : ""}<b>${esc(r.name)}</b>` +
          (r.tags?.length ? ` ${r.tags.map(tagHtml).join(" ")}` : "") +
          (r.note ? `<div style="${FONT}font-size:11px;color:#475569;margin-top:1px;">${esc(r.note)}</div>` : "");
        const cell = `font-size:12px;color:${INK};padding:3px 6px;border-top:1px solid #e2e8f0;vertical-align:top;`;
        html += `<tr>${hasN ? td(cell + "font-weight:bold;", r.n != null ? String(r.n) : "") : ""}` +
          td(cell + "white-space:nowrap;font-size:11px;", esc(r.when)) + td(cell, name) +
          (hasWho ? td(cell + "font-size:11px;color:#475569;", esc(r.who ?? "")) : "") +
          (hasWo ? td(cell + "font-size:11px;color:#475569;white-space:nowrap;", esc(r.wo ?? "")) : "") +
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

function emailHtml(d: ExportDoc): string {
  // No dark blocks with light text anywhere: phone mail apps switching
  // light / dark mode recolor text and backgrounds separately, and white
  // text on a kept-dark background comes out black on navy. Light panels
  // with dark text (every color set on the element itself) flip cleanly.
  const status = d.status
    ? td(`padding:6px 10px;background-color:${TONE[d.status.tone].bg};border:1px solid ${TONE[d.status.tone].bd};border-left:4px solid ${SOLID[d.status.tone]};text-align:right;white-space:nowrap;vertical-align:middle;`,
      `<div style="${FONT}font-size:14px;font-weight:bold;color:${TONE[d.status.tone].fg};">${esc(d.status.label)}</div>` +
      (d.status.detail ? `<div style="${FONT}font-size:10px;color:${TONE[d.status.tone].fg};">${esc(d.status.detail)}</div>` : ""), `bgcolor="${TONE[d.status.tone].bg}" `)
    : "";
  let html = `<div style="${FONT}color:${INK};">`;
  html += `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:820px;"><tr>` +
    td(`padding:8px 12px;background-color:#f8fafc;border-top:4px solid ${INK};border-bottom:1px solid ${LINE};border-left:1px solid ${LINE};`,
      `<div style="${FONT}font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:1.5px;color:${MUTED};">${esc(d.kind)}</div>` +
      `<div style="${FONT}font-size:18px;font-weight:bold;color:${INK};">${esc(d.project)}</div>` +
      `<div style="${FONT}font-size:11px;color:#334155;">${esc(d.when)} · as of ${esc(d.asOf)}</div>`, `bgcolor="#f8fafc" `) +
    status + `</tr></table>`;
  for (const s of d.sections) {
    // A section that needs attention gets a colored rule, not a number.
    const rule = s.flag === "rose" ? SOLID.rose : s.flag === "amber" ? SOLID.amber : INK;
    // data-sec: lets a printed copy put a section on its own page (safety).
    html += `<table data-sec="${esc(s.id ?? "")}" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:820px;margin-top:18px;"><tr>` +
      td(`border-bottom:2px solid ${rule};padding:0 0 3px;`,
        `<span style="${FONT}font-size:15px;font-weight:bold;color:${INK};">${esc(s.title)}</span>` +
        (s.sub ? `<span style="${FONT}font-size:12px;color:${MUTED};">&nbsp;&nbsp;${esc(s.sub)}</span>` : "")) +
      `</tr><tr>${td("padding:6px 0 0;", s.blocks.map(blockHtml).join(""))}</tr></table>`;
  }
  if (d.footer) html += `<p style="${FONT}font-size:10px;color:#94a3b8;margin-top:14px;max-width:820px;">${esc(d.footer)}</p>`;
  return html + `</div>`;
}
