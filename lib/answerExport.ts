// lib/answerExport.ts — a library answer as something you can SEND.
//
// "Copy for email" and "Print" both start here: the answer in the same
// order the card shows it — verdict, answer, why, the engineering trail,
// what to do — followed by the proof, each passage quoted with its
// document, section and page and the deciding words marked. The HTML uses
// inline styles only, because that is all Outlook and Gmail keep on paste.
// Pure, so it is unit-tested; no DOM, no React.

import {
  parseAnswerBlocks, structureAnswer, splitVerdict, quoteWindow, extractCitationNumbers,
  type AnswerBlock, type Verdict,
} from "@/lib/knowledgeText";
import type { KnowledgeAnswer, KnowledgeCitation } from "@/lib/knowledge";

const VERDICT_LABEL: Record<Verdict, { text: string; color: string }> = {
  yes: { text: "YES", color: "#15803d" },
  conditional: { text: "YES, WITH CONDITIONS", color: "#b45309" },
  no: { text: "NO", color: "#b91c1c" },
  unsettled: { text: "NOT SETTLED", color: "#475569" },
  complies: { text: "COMPLIES", color: "#15803d" },
  fails: { text: "DOES NOT COMPLY", color: "#b91c1c" },
  undetermined: { text: "CAN'T DETERMINE", color: "#475569" },
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Answer markup → email-safe HTML: bold, value chips, citation markers. */
function inlineHtml(text: string): string {
  return esc(text)
    .replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, '<span style="font-family:Consolas,Menlo,monospace;background:#f1f5f9;padding:0 3px;border-radius:3px">$1</span>')
    .replace(/\(not from your library[^)]*\)/gi, '<i style="color:#1d4ed8">(not from your library)</i>')
    .replace(/(\[\d{1,3}\])+/g, (run) =>
      `<sup style="color:#c2410c;font-weight:bold">${run.match(/\d{1,3}/g)!.join(", ")}</sup>`);
}

/** Answer markup → plain text: markers kept as [n], emphasis dropped. */
function inlineText(text: string): string {
  return text.replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
}

function listHtml(blocks: AnswerBlock[], ordered: boolean): string {
  // Markers set explicitly: some mail clients (and reset stylesheets) strip
  // the defaults, and an engineering trail without its step numbers is
  // just a pile of lines.
  const tag = ordered ? "ol" : "ul";
  const open = `<${tag} style="margin:0 0 0 22px;padding:0;list-style:${ordered ? "decimal" : "disc"} outside">`;
  const items = blocks.map((b) => b.type === "label"
    ? `</${tag}><p style="margin:8px 0 2px;font-weight:bold;color:#475569">${inlineHtml(b.text)}</p>${open}`
    : `<li style="margin:0 0 4px;display:list-item">${b.type === "important" ? "<b>MUST:</b> " : ""}${inlineHtml(b.text)}</li>`);
  return `${open}${items.join("")}</${tag}>`.replace(/<(ol|ul)[^>]*><\/\1>/g, "");
}

function listText(blocks: AnswerBlock[], ordered: boolean): string {
  let n = 0;
  return blocks.map((b) => {
    if (b.type === "label") return `\n${inlineText(b.text)}`;
    n += 1;
    return `${ordered ? `${n}.` : "-"} ${b.type === "important" ? "MUST: " : ""}${inlineText(b.text)}`;
  }).join("\n");
}

const section = (title: string, body: string) =>
  `<p style="margin:16px 0 6px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;font-weight:bold">${esc(title)}</p>${body}`;

/** The cited passages in the order the reader needs them: what decides the
 *  answer, then conditions and limits, then the rest. */
function orderedProof(answer: KnowledgeAnswer): KnowledgeCitation[] {
  const lib = answer.citations.filter((c) => !c.url);
  const rank = (c: KnowledgeCitation) => c.role === "decides" ? 0 : c.role === "limits" ? 1 : 2;
  const order = extractCitationNumbers(answer.answer);
  const pos = (c: KnowledgeCitation) => { const i = order.indexOf(c.n); return i < 0 ? 999 : i; };
  return [...lib].sort((a, b) => rank(a) - rank(b) || pos(a) - pos(b));
}

export interface AnswerExport {
  html: string;
  text: string;
}

export function buildAnswerExport(question: string, answer: KnowledgeAnswer): AnswerExport {
  const parts = structureAnswer(parseAnswerBlocks(answer.answer), answer.answerMode ?? null);
  const hero = parts.hero !== null ? splitVerdict(parts.hero) : null;
  const v = hero?.verdict ? VERDICT_LABEL[hero.verdict] : null;
  const proof = orderedProof(answer);

  const html: string[] = [];
  const text: string[] = [];

  html.push(`<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:720px">`);
  html.push(`<p style="margin:0 0 4px;color:#64748b;font-size:12px">Question</p><p style="margin:0 0 12px"><b>${esc(question)}</b></p>`);
  text.push(`QUESTION: ${question}`, "");
  if ((answer.answeringFor ?? []).length > 0) {
    html.push(`<p style="margin:0 0 12px;color:#475569;font-size:12px">Answering for: ${answer.answeringFor!.map(esc).join(" · ")}</p>`);
    text.push(`Answering for: ${answer.answeringFor!.join(" · ")}`, "");
  }

  if (hero) {
    html.push(`<div style="border:1px solid #e2e8f0;border-left:4px solid ${v?.color ?? "#ea580c"};border-radius:6px;padding:10px 14px;margin:0 0 4px">` +
      (v ? `<p style="margin:0 0 4px;font-weight:bold;color:${v.color};letter-spacing:0.5px">${v.text}</p>` : "") +
      `<p style="margin:0;font-size:15px;font-weight:600">${inlineHtml(hero.text)}</p></div>`);
    text.push(`${v ? `${v.text} — ` : "ANSWER: "}${inlineText(hero.text)}`, "");
  } else {
    html.push(`<p>${inlineHtml(answer.answer)}</p>`);
    text.push(inlineText(answer.answer), "");
  }

  const add = (title: string, blocks: AnswerBlock[], ordered: boolean) => {
    if (blocks.length === 0) return;
    html.push(section(title, listHtml(blocks, ordered)));
    text.push(title.toUpperCase(), listText(blocks, ordered), "");
  };
  add("To settle this", parts.settle, false);
  add("Why", parts.why, true);
  add("Engineering trail", parts.trail, true);
  add("Before you act", parts.before, false);
  add("Don't miss", parts.dontMiss, false);

  if (proof.length > 0) {
    const cards = proof.map((c) => {
      const where = `${(c.documentName ?? "Document").replace(/\.pdf$/i, "")}${c.section ? ` · ${c.section}` : ""} · p.${c.page}`;
      const win = c.highlight ? quoteWindow(c.quote ?? "", c.highlight, 260) : null;
      const quoteHtml = win
        ? `${win.clippedStart ? "… " : ""}${esc(win.before)}<b style="background:#fef08a">${esc(win.hit)}</b>${esc(win.after)}${win.clippedEnd ? " …" : ""}`
        : esc((c.quote ?? "").slice(0, 600)) + ((c.quote ?? "").length > 600 ? " …" : "");
      return `<div style="margin:0 0 10px"><p style="margin:0"><sup style="color:#c2410c;font-weight:bold">${c.n}</sup> <b>${esc(c.claim || where)}</b></p>` +
        `<p style="margin:0 0 4px;color:#64748b;font-size:12px">${esc(where)}</p>` +
        (c.quote ? `<blockquote style="margin:0;padding:6px 10px;border-left:3px solid #cbd5e1;background:#f8fafc;color:#334155;font-size:13px">${quoteHtml}</blockquote>` : "") +
        `</div>`;
    });
    html.push(section("Proof", cards.join("")));
    text.push("PROOF");
    for (const c of proof) {
      const where = `${(c.documentName ?? "Document").replace(/\.pdf$/i, "")}${c.section ? ` · ${c.section}` : ""} · p.${c.page}`;
      text.push(`[${c.n}] ${c.claim ? `${c.claim} — ` : ""}${where}`);
      const q = c.highlight ?? (c.quote ?? "").slice(0, 400);
      if (q) text.push(`    "${q.trim()}"`);
    }
    text.push("");
  }

  html.push(`<p style="margin:16px 0 0;color:#94a3b8;font-size:11px">From Manufacturing OS — answered from the indexed documents, cited to the page. Verify on the cited pages before acting.</p></div>`);
  text.push("From Manufacturing OS — answered from the indexed documents, cited to the page. Verify on the cited pages before acting.");
  return { html: html.join(""), text: text.join("\n") };
}

/** A full printable page around the export. */
export function printableDocument(question: string, exp: AnswerExport): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(question.slice(0, 80))}</title>` +
    `<style>@page{margin:18mm}body{margin:0}blockquote,div{break-inside:avoid}</style></head>` +
    `<body>${exp.html}</body></html>`;
}
