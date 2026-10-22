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

export type ExportBlock =
  | { k: "stats"; items: Array<{ label: string; value: string; tone: Tone }> }
  | { k: "note"; text: string; tone?: Tone }
  | { k: "sub"; title: string; count: number; tone: Tone }
  | { k: "steps"; whenHead: string; rightHead: string; flat?: boolean; rows: ExportStepRow[] }
  | { k: "table"; head: string[]; rows: string[][] }
  | { k: "list"; items: Array<{ text: string; note?: string }> }
  | { k: "empty"; text: string };

export interface ExportSection { title: string; sub?: string; flag?: "rose" | "amber" | null; blocks: ExportBlock[] }

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

export function toPlainText(d: ExportDoc): string {
  const out: string[] = [];
  out.push(`${d.kind.toUpperCase()} — ${d.project}`);
  out.push(`${d.when} · as of ${d.asOf}`);
  if (d.status) out.push(`Status: ${d.status.label}${d.status.detail ? ` — ${d.status.detail}` : ""}`);
  d.sections.forEach((s, i) => {
    out.push("");
    out.push(`${i + 1}. ${s.title.toUpperCase()}${s.sub ? ` — ${s.sub}` : ""}`);
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
        case "empty":
          out.push(`   ${b.text}`);
          break;
        case "list":
          for (const x of b.items) out.push(`   ✓ ${x.text}${x.note ? ` (${x.note})` : ""}`);
          break;
        case "table":
          for (const r of b.rows) out.push(`   • ${r.map((c, j) => (j === 0 ? c : `${b.head[j]}: ${c}`)).join(" — ")}`);
          break;
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
              out.push(`${indent}${bits.join(" — ")}`);
              if (r.note) out.push(`${indent}  ${r.note}`);
            }
          }
          break;
        }
      }
    }
  });
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
      return `<table role="presentation" cellpadding="0" cellspacing="4" border="0" style="border-collapse:separate;margin:2px 0 4px -4px;"><tr>${b.items.map((x) => {
        const t = TONE[x.tone];
        return td(`border:1px solid ${t.bd};background-color:${t.bg};padding:4px 10px;min-width:80px;`,
          `<div style="${FONT}font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;color:${MUTED};">${esc(x.label)}</div>` +
          `<div style="${FONT}font-size:18px;font-weight:bold;color:${t.fg};">${esc(x.value)}</div>`, `bgcolor="${t.bg}" `);
      }).join("")}</tr></table>`;
    case "note":
      return `<p style="${FONT}font-size:12px;margin:3px 0;color:${b.tone ? TONE[b.tone].fg : INK};${b.tone ? "font-weight:bold;" : ""}">${esc(b.text)}</p>`;
    case "sub":
      return `<p style="${FONT}font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin:8px 0 3px;color:${TONE[b.tone].fg};">${esc(b.title)} (${b.count})</p>`;
    case "empty":
      return `<p style="${FONT}font-size:12px;font-style:italic;margin:3px 0;color:${MUTED};">${esc(b.text)}</p>`;
    case "list":
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${b.items.map((x) =>
        `<tr>${td("font-size:12px;color:#059669;padding:1px 6px 1px 0;vertical-align:top;", "&#10003;")}${td(`font-size:12px;color:${INK};padding:1px 0;`,
          `${esc(x.text)}${x.note ? ` <span style="color:${MUTED};font-size:11px;">${esc(x.note)}</span>` : ""}`)}</tr>`).join("")}</table>`;
    case "table":
      return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${LINE};">` +
        `<tr>${b.head.map((h) => td(`font-size:9px;font-weight:bold;text-transform:uppercase;color:${MUTED};background-color:#f8fafc;padding:4px 6px;border-bottom:1px solid ${LINE};text-align:left;`, esc(h), `bgcolor="#f8fafc" `)).join("")}</tr>` +
        b.rows.map((r) => `<tr>${r.map((c, j) => td(`font-size:12px;color:${INK};padding:3px 6px;border-top:1px solid #e2e8f0;${j === 0 ? "font-weight:bold;" : "white-space:nowrap;"}`, esc(c))).join("")}</tr>`).join("") +
        `</table>`;
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
            `<b>${esc(group.title)}</b>${group.crumbs ? ` <span style="color:${MUTED};">· ${esc(group.crumbs)}</span>` : ""}${group.meta ? ` <span style="color:#475569;font-size:11px;">— ${esc(group.meta)}</span>` : ""}`,
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

export function toEmailHtml(d: ExportDoc): string {
  const status = d.status
    ? td(`padding:6px 10px;background-color:${SOLID[d.status.tone]};color:#ffffff;text-align:right;white-space:nowrap;`,
      `<div style="${FONT}font-size:14px;font-weight:bold;color:#ffffff;">${esc(d.status.label)}</div>` +
      (d.status.detail ? `<div style="${FONT}font-size:10px;color:#ffffff;">${esc(d.status.detail)}</div>` : ""), `bgcolor="${SOLID[d.status.tone]}" `)
    : "";
  let html = `<div style="${FONT}color:${INK};">`;
  html += `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:820px;"><tr>` +
    td(`padding:8px 12px;background-color:#0f172a;color:#ffffff;`,
      `<div style="${FONT}font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:1.5px;color:#94a3b8;">${esc(d.kind)}</div>` +
      `<div style="${FONT}font-size:18px;font-weight:bold;color:#ffffff;">${esc(d.project)}</div>` +
      `<div style="${FONT}font-size:11px;color:#cbd5e1;">${esc(d.when)} · as of ${esc(d.asOf)}</div>`, `bgcolor="#0f172a" `) +
    status + `</tr></table>`;
  d.sections.forEach((s, i) => {
    const ring = s.flag === "rose" ? SOLID.rose : s.flag === "amber" ? SOLID.amber : INK;
    html += `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:820px;margin-top:14px;"><tr>` +
      td(`border-bottom:2px solid ${INK};padding:0 0 3px;`,
        `<span style="${FONT}display:inline-block;background-color:${ring};color:#ffffff;font-size:11px;font-weight:bold;padding:1px 6px;">${i + 1}</span> ` +
        `<span style="${FONT}font-size:14px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;color:${INK};">${esc(s.title)}</span>` +
        (s.sub ? ` <span style="${FONT}font-size:11px;color:${MUTED};">— ${esc(s.sub)}</span>` : "")) +
      `</tr><tr>${td("padding:4px 0 0;", s.blocks.map(blockHtml).join(""))}</tr></table>`;
  });
  if (d.footer) html += `<p style="${FONT}font-size:10px;color:#94a3b8;margin-top:14px;max-width:820px;">${esc(d.footer)}</p>`;
  return html + `</div>`;
}
