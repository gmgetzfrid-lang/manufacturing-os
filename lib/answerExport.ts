// lib/answerExport.ts — a library answer as something you can SEND.
//
// "Copy for email" and "Print" both start here. The order is the order a
// reader needs it: the verdict as a coloured banner with the answer, then
// THE PROOF straight under it — the deciding passages as quote cards with
// the exact words marked and the document and page on a tag — then what
// would settle it, why, the engineering trail, what to do, what not to
// miss, and the supporting passages last.
//
// Email clients keep very little CSS. Outlook ignores flexbox, margins on
// most elements and background images; Gmail strips <style>. So layout is
// tables and every style is inline. Pure, so it is unit-tested.
//
// The app's type scale (docs/design-rules.md TY2, TY3), as the emailed
// shift update has it (lib/reportExport): 12 caption, 14 body, 16 reading
// and a heading, 20 the verdict; nothing smaller, no tiny capitals (TY8).
// Each part's heading on a light band and the verdict in a shaded box:
// bold, shading and borders carry it when a paste drops sizes and colors.

import {
  hasSource, parseAnswerBlocks, structureAnswer, splitVerdict, quoteWindow, extractCitationNumbers,
  type AnswerBlock, type Verdict,
} from "@/lib/knowledgeText";
import type { KnowledgeAnswer, KnowledgeCitation } from "@/lib/knowledge";

/** The verdict: `text` as the plain text says it, `word` as the page says
 *  it (sentence case), in its tone (the emailed update's tones). */
const GOOD = { fg: "#065f46", bg: "#ecfdf5", edge: "#059669" };
const WARN = { fg: "#92400e", bg: "#fffbeb", edge: "#d97706" };
const BAD = { fg: "#9f1239", bg: "#fff1f2", edge: "#e11d48" };
const OPEN = { fg: "#0f172a", bg: "#f1f5f9", edge: "#64748b" };
const VERDICT_LABEL: Record<Verdict, { text: string; word: string; tone: typeof GOOD }> = {
  yes: { text: "YES", word: "Yes", tone: GOOD },
  conditional: { text: "YES, WITH CONDITIONS", word: "Yes, with conditions", tone: WARN },
  no: { text: "NO", word: "No", tone: BAD },
  unsettled: { text: "NOT SETTLED", word: "Not settled", tone: OPEN },
  complies: { text: "COMPLIES", word: "Complies", tone: GOOD },
  fails: { text: "DOES NOT COMPLY", word: "Does not comply", tone: BAD },
  undetermined: { text: "CAN'T DETERMINE", word: "Can't determine", tone: OPEN },
};

const FONT = "font-family:'Segoe UI',Calibri,Arial,sans-serif";
const INK = "#0f172a";
const MUTED = "#64748b";
const LINE = "#e2e8f0";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Answer markup → email-safe HTML: bold, value chips, citation markers. */
function inlineHtml(text: string): string {
  return esc(text)
    .replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, `<span style="font-family:Consolas,Menlo,monospace;background-color:#fff7ed;color:#9a3412;padding:0 4px;border:1px solid #fed7aa;border-radius:6px">$1</span>`)
    .replace(/\(not from your library[^)]*\)/gi,
      `<span style="background-color:#dbeafe;color:#1e40af;font-size:12px;font-weight:bold;padding:0 6px;border-radius:6px">Not from your library</span>`)
    .replace(/(\[\d{1,3}\])+/g, (run) =>
      `<sup style="color:#c2410c;font-weight:bold;font-size:12px">[${run.match(/\d{1,3}/g)!.join(", ")}]</sup>`);
}

/** A claim with no citation is marked on the page it's sent on, too. */
const NO_SOURCE_HTML = ` <span style="background-color:#ffe4e6;color:#be123c;font-size:12px;font-weight:bold;padding:0 6px;border-radius:6px">No source</span>`;
const claimHtml = (text: string) => inlineHtml(text) + (hasSource(text) ? "" : NO_SOURCE_HTML);
const claimText = (text: string) => inlineText(text) + (hasSource(text) ? "" : " [NO SOURCE]");

/** Answer markup → plain text: markers kept as [n], emphasis dropped. */
function inlineText(text: string): string {
  return text.replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
}

/** A section heading on a light band (the emailed update's section band). */
const heading = (title: string) =>
  `<tr><td style="padding:20px 0 8px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>` +
  `<td bgcolor="#f1f5f9" style="background-color:#f1f5f9;border-radius:8px;padding:8px 12px;${FONT};font-size:16px;font-weight:bold;color:${INK}">${esc(title)}</td>` +
  `</tr></table></td></tr>`;

/** Numbered steps: a filled circle per step, the step beside it. */
function stepsHtml(blocks: AnswerBlock[], color = "#334155"): string {
  let n = 0;
  const rows = blocks.map((b) => {
    if (b.type === "label") {
      return `<tr><td colspan="2" style="padding:8px 0 4px;${FONT};font-size:14px;font-weight:bold;color:${MUTED}">${inlineHtml(b.text)}</td></tr>`;
    }
    n += 1;
    return `<tr><td valign="top" style="width:30px;padding:3px 0">` +
      `<div style="width:22px;height:22px;line-height:22px;border-radius:11px;background:${color};color:#fff;text-align:center;${FONT};font-size:12px;font-weight:bold">${n}</div></td>` +
      `<td style="padding:3px 0 7px;${FONT};font-size:14px;line-height:1.5;color:${INK}">${claimHtml(b.text)}</td></tr>`;
  });
  return `<tr><td><table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows.join("")}</table></td></tr>`;
}

/** Checklist rows: a box per item; "!" MUSTs in red. */
function checklistHtml(blocks: AnswerBlock[]): string {
  const rows = blocks.filter((b) => b.type !== "label").map((b) => {
    const must = b.type === "important";
    return `<tr><td valign="top" style="width:26px;padding:3px 0;${FONT};font-size:16px;color:${must ? "#b91c1c" : "#475569"}">${must ? "&#9888;" : "&#9744;"}</td>` +
      `<td style="padding:3px 0 7px;${FONT};font-size:14px;line-height:1.5;color:${must ? "#7f1d1d" : INK};${must ? "font-weight:bold" : ""}">${claimHtml(b.text)}</td></tr>`;
  });
  return `<tr><td><table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows.join("")}</table></td></tr>`;
}

/** A tinted callout box (settle-this, don't-miss). */
function calloutHtml(title: string, blocks: AnswerBlock[], tone: { bg: string; border: string; ink: string }, claims = false): string {
  const rows = blocks.filter((b) => b.type !== "label").map((b) =>
    `<tr><td valign="top" style="width:16px;padding:3px 0;${FONT};font-size:14px;color:${tone.ink}">&#8226;</td>` +
    `<td style="padding:3px 0 6px;${FONT};font-size:14px;line-height:1.5;color:${INK}">${claims ? claimHtml(b.text) : inlineHtml(b.text)}</td></tr>`);
  return `<tr><td style="padding-top:16px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" bgcolor="${tone.bg}" style="border-collapse:separate;background-color:${tone.bg};border:1px solid ${tone.border};border-left:4px solid ${tone.ink};border-radius:8px">` +
    `<tr><td style="padding:12px 16px">` +
    `<div style="${FONT};font-size:16px;font-weight:bold;color:${tone.ink};padding-bottom:6px">${esc(title)}</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows.join("")}</table>` +
    `</td></tr></table></td></tr>`;
}

const docName = (c: KnowledgeCitation) => (c.documentName ?? "Document").replace(/\.pdf$/i, "");
const where = (c: KnowledgeCitation) => `${docName(c)}${c.section ? ` · ${c.section}` : ""} · p.${c.page}`;

/** One proof card: claim, a dark tag with document and page, and the quote
 *  with the deciding words highlighted. `strong` cards lead the email. */
function proofCardHtml(c: KnowledgeCitation, strong: boolean): string {
  const win = c.highlight ? quoteWindow(c.quote ?? "", c.highlight, strong ? 200 : 140) : null;
  const quote = win
    ? `${win.clippedStart ? "… " : ""}${esc(win.before)}<span style="background:#fde047;color:#0f172a;font-weight:bold;padding:0 2px">${esc(win.hit)}</span>${esc(win.after)}${win.clippedEnd ? " …" : ""}`
    : esc((c.quote ?? "").slice(0, 420)) + ((c.quote ?? "").length > 420 ? " …" : "");
  const accent = c.role === "decides" ? "#15803d" : c.role === "limits" ? "#d97706" : "#94a3b8";
  return `<tr><td style="padding-bottom:12px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" bgcolor="#ffffff" style="border-collapse:separate;border:1px solid ${LINE};border-left:4px solid ${accent};border-radius:8px;background-color:#ffffff">` +
    `<tr><td style="padding:12px 16px 4px;${FONT}">` +
    `<span style="font-family:Consolas,Menlo,monospace;background-color:#eef2ff;color:#1e3a8a;font-size:12px;font-weight:bold;padding:1px 6px;border-radius:6px">[${c.n}] ${esc(docName(c))} · p.${c.page}</span>` +
    (c.section ? `<span style="color:${MUTED};font-size:12px;padding-left:8px">${esc(c.section)}</span>` : "") +
    `</td></tr>` +
    (c.claim ? `<tr><td style="padding:4px 16px 2px;${FONT};font-size:${strong ? 16 : 14}px;font-weight:bold;color:${INK}">${esc(c.claim)}</td></tr>` : "") +
    (c.quote ? `<tr><td style="padding:4px 16px 12px"><div style="${FONT};font-size:14px;line-height:1.55;color:#334155;background-color:#f8fafc;border-left:3px solid #cbd5e1;border-radius:6px;padding:8px 12px;font-style:italic">&ldquo;${quote}&rdquo;</div></td></tr>` : "") +
    `</table></td></tr>`;
}

export interface AnswerExport {
  /** Formatted — pastes into Outlook, Gmail or Word looking like the card. */
  html: string;
  /** The whole answer and its proof as plain text. */
  text: string;
  /** The same, in Markdown — Teams, Slack, notes, tickets. */
  markdown: string;
  /** Just the answer (and what it's answering for) — no proof. */
  answerOnly: string;
  /** Just the references: each cited document, page and quote. */
  references: string;
}

/** Section titles the plain-text export writes in capitals. */
const TEXT_SECTIONS = new Set([
  "THE PROOF", "TO SETTLE THIS, I NEED", "WHY", "FINDINGS", "ENGINEERING TRAIL", "BEFORE YOU ACT",
  "REQUIRED CORRECTIONS", "DON'T MISS", "SUPPORTING PASSAGES",
]);

/** The plain-text export, as Markdown: headings, quotes, the question in bold. */
export function textToMarkdown(text: string): string {
  return text.split("\n").map((line) => {
    if (line.startsWith("QUESTION: ")) return `**Question:** ${line.slice(10)}`;
    if (TEXT_SECTIONS.has(line.trim()) || line.startsWith("FROM THE WEB")) {
      const t = line.trim();
      return `### ${t.charAt(0)}${t.slice(1).toLowerCase()}`;
    }
    const quote = line.match(/^ {4}"(.*)"$/);
    if (quote) return `> ${quote[1]}`;
    if (line.startsWith("Answered from the indexed")) return `_${line}_`;
    return line;
  }).join("\n");
}

export function buildAnswerExport(question: string, answer: KnowledgeAnswer): AnswerExport {
  const parts = structureAnswer(parseAnswerBlocks(answer.answer), answer.answerMode ?? null);
  const hero = parts.hero !== null ? splitVerdict(parts.hero) : null;
  const v = hero?.verdict ? VERDICT_LABEL[hero.verdict] : null;
  const compliance = answer.answerMode === "compliance";

  // The proof, in the order the reader needs it.
  const lib = answer.citations.filter((c) => !c.url);
  const order = extractCitationNumbers(answer.answer);
  const pos = (c: KnowledgeCitation) => { const i = order.indexOf(c.n); return i < 0 ? 999 : i; };
  const byUse = [...lib].sort((a, b) => pos(a) - pos(b));
  const hasRoles = lib.some((c) => c.role);
  const lead = hasRoles ? byUse.filter((c) => c.role === "decides") : byUse.slice(0, 2);
  const support = byUse.filter((c) => !lead.includes(c));

  const rows: string[] = [];
  const text: string[] = [];

  // Header + question
  rows.push(`<tr><td style="padding-bottom:8px;${FONT};font-size:12px;color:${MUTED}">Engineering answer · Manufacturing OS</td></tr>`);
  rows.push(`<tr><td style="padding-bottom:12px;${FONT};font-size:16px;line-height:1.45;color:${INK}"><span style="color:${MUTED}">Question:</span> <b>${esc(question)}</b></td></tr>`);
  text.push(`QUESTION: ${question}`, "");

  // Verdict banner + the answer
  const answerHtml = hero ? inlineHtml(hero.text) : inlineHtml(answer.answer);
  // The verdict in a shaded box, its word in its color, the answer under
  // it; the verdict's color is the box's edge, never the whole card.
  const tone = v?.tone ?? OPEN;
  rows.push(`<tr><td><table role="presentation" cellpadding="0" cellspacing="0" width="100%" bgcolor="#ffffff" style="border-collapse:separate;background-color:#ffffff;border:1px solid ${LINE};border-left:4px solid ${tone.edge};border-radius:12px">` +
    (v ? `<tr><td style="padding:12px 16px 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="${tone.bg}" style="background-color:${tone.bg};border-radius:8px;padding:6px 12px;${FONT};font-size:20px;font-weight:bold;color:${tone.fg}">${esc(v.word)}</td></tr></table></td></tr>` : "") +
    `<tr><td style="padding:12px 16px;${FONT};font-size:16px;line-height:1.5;font-weight:600;color:${INK}">${answerHtml}</td></tr>` +
    `</table></td></tr>`);
  if ((answer.answeringFor ?? []).length > 0) {
    rows.push(`<tr><td style="padding-top:6px;${FONT};font-size:12px;color:${MUTED}">Answering for: ${answer.answeringFor!.map(esc).join(" &middot; ")}</td></tr>`);
  }
  text.push(`${v ? `${v.text} - ` : "ANSWER: "}${inlineText(hero ? hero.text : answer.answer)}`);
  if ((answer.answeringFor ?? []).length > 0) text.push(`Answering for: ${answer.answeringFor!.join(" · ")}`);
  text.push("");

  // THE PROOF — right under the answer
  if (lead.length > 0) {
    rows.push(heading(compliance ? "The requirement - quoted" : "The proof"));
    for (const c of lead) rows.push(proofCardHtml(c, true));
    text.push("THE PROOF");
    for (const c of lead) {
      text.push(`[${c.n}] ${c.claim ? `${c.claim} - ` : ""}${where(c)}`);
      const q = c.highlight ?? (c.quote ?? "").slice(0, 400);
      if (q) text.push(`    "${q.trim()}"`);
    }
    text.push("");
  }

  const listText = (title: string, blocks: AnswerBlock[], numbered: boolean, claims = true) => {
    const items = blocks.filter((b) => b.type !== "label");
    if (items.length === 0) return;
    text.push(title.toUpperCase());
    items.forEach((b, i) => text.push(`${numbered ? `${i + 1}.` : "-"} ${b.type === "important" ? "MUST: " : ""}${claims ? claimText(b.text) : inlineText(b.text)}`));
    text.push("");
  };

  if (parts.settle.length > 0) {
    rows.push(calloutHtml("To settle this, I need", parts.settle, { bg: "#fffbeb", border: "#fde68a", ink: "#b45309" }));
    listText("To settle this, I need", parts.settle, false, false);
  }
  if (parts.why.length > 0) {
    rows.push(heading(compliance ? "Findings" : "Why"));
    rows.push(stepsHtml(parts.why));
    listText(compliance ? "Findings" : "Why", parts.why, true);
  }
  if (parts.trail.length > 0) {
    rows.push(heading("Engineering trail"));
    rows.push(stepsHtml(parts.trail, "#64748b"));
    listText("Engineering trail", parts.trail, true);
  }
  if (parts.before.length > 0) {
    rows.push(heading(compliance ? "Required corrections" : "Before you act"));
    rows.push(checklistHtml(parts.before));
    listText(compliance ? "Required corrections" : "Before you act", parts.before, false);
  }
  if (parts.dontMiss.length > 0) {
    rows.push(calloutHtml("Don't miss", parts.dontMiss, { bg: "#fef2f2", border: "#fecaca", ink: "#b91c1c" }, true));
    listText("Don't miss", parts.dontMiss, false);
  }
  if (support.length > 0) {
    rows.push(heading("Supporting passages"));
    for (const c of support) rows.push(proofCardHtml(c, false));
    text.push("SUPPORTING PASSAGES");
    for (const c of support) {
      text.push(`[${c.n}] ${c.claim ? `${c.claim} - ` : ""}${where(c)}`);
      const q = c.highlight ?? (c.quote ?? "").slice(0, 300);
      if (q) text.push(`    "${q.trim()}"`);
    }
    text.push("");
  }

  // Web sources (only when the Web switch was on): kept apart from the
  // documents, each with its page and the text it relied on.
  // Past jobs (a link inside the app) are listed on their own, below.
  const web = answer.citations.filter((c) => !!c.url && !c.url.startsWith("/"));
  if (web.length > 0) {
    rows.push(heading("From the web - not your controlled documents"));
    rows.push(`<tr><td style="padding-bottom:8px;${FONT};font-size:12px;color:${MUTED}">A web page about a code is not the code - verify against the publication.</td></tr>`);
    text.push("FROM THE WEB - not your controlled documents; verify against the publication");
    for (const c of web) {
      rows.push(`<tr><td style="padding-bottom:12px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" bgcolor="#ffffff" style="border-collapse:separate;border:1px solid ${LINE};border-left:4px solid #0284c7;border-radius:8px;background-color:#ffffff">` +
        `<tr><td style="padding:12px 16px 4px;${FONT};font-size:14px;font-weight:bold;color:${INK}"><sup style="color:#0284c7;font-size:12px">[${c.n}]</sup> ${esc(c.title ?? c.url ?? "")}</td></tr>` +
        `<tr><td style="padding:0 16px 4px;${FONT};font-size:12px"><a href="${esc(c.url ?? "")}" style="color:#0369a1">${esc(c.url ?? "")}</a></td></tr>` +
        (c.quote ? `<tr><td style="padding:4px 16px 12px"><div style="${FONT};font-size:14px;line-height:1.55;color:#334155;background-color:#f8fafc;border-left:3px solid #bae6fd;border-radius:6px;padding:8px 12px;font-style:italic">&ldquo;${esc(c.quote)}&rdquo;</div></td></tr>` : "") +
        `</table></td></tr>`);
      text.push(`[${c.n}] ${c.title ?? c.url} - ${c.url}`);
      if (c.quote) text.push(`    "${c.quote.trim()}"`);
    }
    text.push("");
  }

  // Past jobs: findings kept at earlier close-out reviews, with the project
  // and date in their own words (the link only works inside the app).
  const jobs = answer.citations.filter((c) => !!c.url && c.url.startsWith("/"));
  if (jobs.length > 0) {
    rows.push(heading("From past jobs"));
    text.push("FROM PAST JOBS - kept at the close-out reviews of earlier projects");
    for (const c of jobs) {
      rows.push(`<tr><td style="padding-bottom:8px;${FONT};font-size:14px;line-height:1.55;color:#334155"><sup style="color:#c2410c;font-size:12px">[${c.n}]</sup> ${esc(c.quote ?? c.title ?? "")}</td></tr>`);
      text.push(`[${c.n}] ${c.quote ?? c.title ?? ""}`);
    }
    text.push("");
  }

  rows.push(`<tr><td style="padding-top:16px;border-top:1px solid ${LINE};${FONT};font-size:12px;color:${MUTED}">Answered from the indexed engineering standards, cited to the page. Verify on the cited pages before acting.</td></tr>`);
  text.push("Answered from the indexed engineering standards, cited to the page. Verify on the cited pages before acting.");

  const html = `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:720px;${FONT};color:${INK}">${rows.join("")}</table>`;
  const plain = text.join("\n");
  const answerOnly = [
    `${v ? `${v.text} - ` : ""}${inlineText(hero ? hero.text : answer.answer)}`,
    ...((answer.answeringFor ?? []).length > 0 ? [`Answering for: ${answer.answeringFor!.join(" · ")}`] : []),
  ].join("\n");
  const references = [...byUse, ...web].map((c) => {
    const q = c.url ? c.quote : (c.highlight ?? c.quote ?? "").slice(0, 300);
    return `[${c.n}] ${c.url ? `${c.title ?? c.url} - ${c.url}` : where(c)}${q ? `\n    "${q.trim()}"` : ""}`;
  }).join("\n");
  return { html, text: plain, markdown: textToMarkdown(plain), answerOnly, references };
}

/** A full printable page around the export. */
export function printableDocument(question: string, exp: AnswerExport): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(question.slice(0, 80))}</title>` +
    `<style>@page{margin:16mm}body{margin:0;padding:24px;-webkit-print-color-adjust:exact;print-color-adjust:exact}` +
    `table{border-collapse:separate}tr{break-inside:avoid}</style></head>` +
    `<body>${exp.html}</body></html>`;
}
