// lib/eval/checks.ts — scoring an answer against what an engineer said a
// right answer must do. Fixed rules, no AI: the same answer always gets the
// same score, and every failure says exactly what it saw.
//
// The checks are named for the ways answers to a standards library go wrong
// — any company's library — so a failing run reads as a diagnosis ("cited a
// Class 1500 page for a Class 150 question"), not a number.

import { pressureClassesOf } from "@/lib/pressureClass";
import { leadsFor, questionWords } from "@/lib/searchLeads";
import { settleItems } from "@/lib/ask/settleItems";
import { docsNamedIn, docsTitledIn } from "@/lib/ask/designations";
import type { Funnel } from "@/lib/ask/askTrace";

export type CheckCode =
  | "class_mixup"        // a different pressure class offered as the answer
  | "unproven_link"      // two terms treated as the same with no passage saying so
  | "asks_for_held"      // asks the user for a document the library holds
  | "missed_page"        // an expected page was not cited
  | "missing_fact"       // a required fact is absent
  | "forbidden"          // something the answer must never say, said
  | "unverified_quote"   // decisive evidence whose quote isn't in its passage
  | "no_citations";      // an answer with nothing cited

export const CHECK_LABEL: Record<CheckCode, string> = {
  class_mixup: "Mixed up the pressure class",
  unproven_link: "Treated two terms as the same without proof",
  asks_for_held: "Asked for a document the library holds",
  missed_page: "Didn't cite the right page",
  missing_fact: "Left out a required fact",
  forbidden: "Said something it must not",
  unverified_quote: "Quoted evidence that isn't on the page",
  no_citations: "Cited nothing",
};

/** What an engineer marked as right for a question. Pages are named by the
 *  document's name or number, because re-indexing changes ids. */
export interface CaseExpect {
  mustCite?: Array<{ document: string; page: number; tolerance?: number }>;
  /** Each entry is a fact; "a | b" accepts either wording. */
  mustContain?: string[];
  /** Phrases the answer must never contain. */
  mustNot?: string[];
  /** Overrides the class read from the question. */
  askedClass?: string;
  /** Terms the answer must not equate without a passage that does. Leads for
   *  the question's own words are always checked; these add to them. */
  termRules?: Array<{ term: string; mustNotEquate: string[] }>;
  /** Checks this case doesn't apply (e.g. a question about Class 150 vs 300). */
  skip?: CheckCode[];
}

export interface AnswerUnderTest {
  question: string;
  answer: string;
  citations: Array<{ n: number; documentName: string; page: number; quote?: string; highlight?: string; role?: string }>;
  /** Names of every document the asker could reach. */
  libraryDocNames: string[];
  /** Where each expected page dropped out, when a research record exists. */
  funnel?: Array<Funnel>;
}

export interface CheckResult {
  code: CheckCode;
  pass: boolean;
  /** What was seen — shown to the person reading the result. */
  detail: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim();

/** Ratings written in an answer, in any notation. */
function classesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const n of ["150", "300", "400", "600", "900", "1500", "2500"]) {
    // pressureClassOf returns the first class it finds; each is tested alone.
    const alone = new RegExp(`(?:class|cl\\.?|ansi|asme)\\s*#?\\s*${n}(?![0-9])|(?<![0-9.])${n}\\s*(?:#|lbs?\\b|pound|class\\b)|#\\s*${n}(?![0-9])`, "i");
    if (alone.test(text)) out.add(n);
  }
  return out;
}

/** The decision part of an answer: the Answer and Use this lines. */
function verdictOf(answer: string): string {
  const lines = answer.split("\n").filter((l) => /^\*\*(Answer|Use this):\*\*/i.test(l.trim()));
  return lines.join("\n") || answer.split("\n\n")[0] || "";
}

const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const citedIn = (s: string) => [...s.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(/\s*,\s*/).map(Number));
const EQUATES = /\b(is|are|means|meaning|i\.e\.|equals?|equivalent|same as|considered|counts as|qualif(?:y|ies) as|treated as|=|aka|also called|also known as)\b|=/i;

export function runChecks(a: AnswerUnderTest, expect: CaseExpect): CheckResult[] {
  const out: CheckResult[] = [];
  const skip = new Set(expect.skip ?? []);
  const add = (r: CheckResult) => { if (!skip.has(r.code)) out.push(r); };
  const answer = a.answer ?? "";
  const nothingFound = /^\*\*Answer:\*\*\s*Nothing (in|is indexed)/m.test(answer);

  // Citations at all.
  add({ code: "no_citations", pass: nothingFound || a.citations.length > 0, detail: a.citations.length > 0 ? `${a.citations.length} cited` : "the answer cites no page" });

  // Pressure class: the decision must stay on the classes the question
  // names — one ("150 class sour gas"), or two ("300 class flanges in a 150
  // class line"). A class it never named (1500) is a mix-up.
  const askedAll = expect.askedClass ? [expect.askedClass] : pressureClassesOf(a.question);
  if (askedAll.length > 0) {
    const named = new Set(askedAll);
    const inVerdict = [...classesIn(verdictOf(answer))].filter((c) => !named.has(c));
    const decisive = a.citations.filter((c) => c.role === "decides" && c.quote);
    const wrongPages = decisive.filter((c) => {
      const seen = classesIn(c.quote ?? "");
      return seen.size > 0 && ![...seen].some((x) => named.has(x));
    });
    const problems = [
      ...inVerdict.map((c) => `the answer line names Class ${c}`),
      ...wrongPages.map((c) => `decisive evidence ${c.documentName} p.${c.page} is about Class ${[...classesIn(c.quote ?? "")].join("/")}`),
    ];
    const asked = askedAll.map((c) => `Class ${c}`).join(" and ");
    add({ code: "class_mixup", pass: problems.length === 0, detail: problems.length ? `asked ${asked}; ${problems.join("; ")}` : `stayed on ${asked}` });
  }

  // Unproven links: the question's own words vs related terms (and any the
  // engineer named). A sentence that ties them together must cite a passage
  // whose text holds both.
  const STOP = new Set(["what", "which", "should", "use", "for", "the", "and", "with", "can", "does", "how", "class", "spec", "piping", "pipe", "line", "stream", "service"]);
  const words = questionWords(a.question, STOP);
  const pairs: Array<[string, string]> = [];
  for (const w of words) for (const t of leadsFor([w])) pairs.push([w, t]);
  for (const r of expect.termRules ?? []) for (const t of r.mustNotEquate) pairs.push([norm(r.term), norm(t)]);
  const quoteOf = new Map(a.citations.map((c) => [c.n, norm(c.quote ?? "")]));
  const unproven: string[] = [];
  for (const s of sentences(answer)) {
    const ls = norm(s);
    for (const [term, other] of pairs) {
      const hasTerm = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(ls);
      const hasOther = new RegExp(`(^|[^a-z0-9])${other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(ls);
      if (!hasTerm || !hasOther || !EQUATES.test(s)) continue;
      // "not the same as", "is not", "does not mean" — a distinction, not a link.
      if (/\b(not|isn't|doesn't|differs?|different|unless|only if|if)\b/i.test(s)) continue;
      const proven = citedIn(s).some((n) => { const q = quoteOf.get(n) ?? ""; return q.includes(term) && q.includes(other); });
      if (!proven) unproven.push(`"${s.slice(0, 140)}" ties "${term}" to "${other}" with no cited passage that mentions both`);
    }
  }
  add({ code: "unproven_link", pass: unproven.length === 0, detail: unproven.length ? [...new Set(unproven)].slice(0, 3).join("; ") : "no term was tied to another without a passage" });

  // Asking for what the library holds.
  const docs = a.libraryDocNames.map((name) => ({ name }));
  const asks = settleItems(answer).filter((l) => !/Searched the library/i.test(l));
  const held = asks.flatMap((l) => [...docsNamedIn(l, docs, 1), ...docsTitledIn(l, docs, 1)].slice(0, 1).map((d) => `asks for "${d.name}" - in the library`));
  add({ code: "asks_for_held", pass: held.length === 0, detail: held.length ? held.slice(0, 3).join("; ") : asks.length ? `${asks.length} ask(s), none for a held document` : "asks for nothing" });

  // Expected pages.
  (expect.mustCite ?? []).forEach((want, i) => {
    const tol = want.tolerance ?? 1;
    const matchDoc = (name: string) => {
      const byNumber = docsNamedIn(want.document, [{ name }], 1).length > 0;
      return byNumber || norm(name).includes(norm(want.document));
    };
    const hit = a.citations.find((c) => matchDoc(c.documentName) && Math.abs(c.page - want.page) <= tol);
    const where = a.funnel?.[i];
    const why = where === "never_found" ? " - no search ever returned it"
      : where === "found_not_given" ? " - found by a search, then ranked out before the answer"
      : where === "given_not_cited" ? " - it was in front of the model, which didn't use it" : "";
    add({ code: "missed_page", pass: !!hit, detail: hit ? `cited ${want.document} p.${want.page}` : `expected ${want.document} p.${want.page}${why}` });
  });

  // Required facts.
  for (const fact of expect.mustContain ?? []) {
    const options = fact.split("|").map(norm).filter(Boolean);
    const ok = options.some((o) => norm(answer).includes(o));
    add({ code: "missing_fact", pass: ok, detail: ok ? `contains "${fact}"` : `missing "${fact}"` });
  }

  // Forbidden phrases.
  for (const phrase of expect.mustNot ?? []) {
    const said = norm(answer).includes(norm(phrase));
    add({ code: "forbidden", pass: !said, detail: said ? `says "${phrase}"` : `never says "${phrase}"` });
  }

  // Decisive evidence must be on its page.
  const unverified = a.citations.filter((c) => c.role === "decides" && !c.highlight);
  add({ code: "unverified_quote", pass: unverified.length === 0, detail: unverified.length ? `${unverified.length} decisive quote(s) not found on their pages: ${unverified.map((c) => `${c.documentName} p.${c.page}`).slice(0, 3).join(", ")}` : "decisive quotes found on their pages" });

  return out;
}

export const passed = (results: CheckResult[]) => results.every((r) => r.pass);
