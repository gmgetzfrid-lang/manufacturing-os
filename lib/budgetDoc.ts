// lib/budgetDoc.ts — the BUDGET BASIS of a project, read from paper.
//
// Every company budgets on its own form — an AFE, a capital request, an
// estimate spreadsheet, a cost sheet in a Word doc. This module is the one
// shape all of them read into: header facts (number, charge account,
// authorized amount, approvals), the cost lines with their suppliers, the
// budget references the request draws on, and any dates and outcomes the
// paper commits to. The AI route fills it from whatever format arrived;
// everything here is pure so the normalization and the matching are tested.
//
// Two jobs downstream:
//   1. SETUP — prefill the project wizard (or an existing project's budget)
//      so a project starts from its authorization, not from a blank form.
//   2. MATCHING — once the cost model exists, an incoming invoice finds its
//      vendor and budget line by itself (suggestAccountForInvoice), and a
//      re-sent invoice is caught before it double-posts.

export const COST_TYPES = ["labor", "material", "equipment", "subcontract", "other"] as const;
export type CostType = (typeof COST_TYPES)[number];

export interface BudgetLine {
  name: string;
  amount: number | null;
  supplier: string | null;
  costType: CostType;
  note: string | null;
}

export interface BudgetReference {
  label: string;
  amount: number | null;
}

export interface BudgetApproval {
  role: string;
  name: string | null;
  date: string | null;
}

export interface ParsedBudgetDoc {
  /** What the paper calls itself — "AFE", "Capital request", "Estimate"… */
  docType: string | null;
  docNumber: string | null;
  /** The charge / GL / cost-center code the spend books to. */
  chargeAccount: string | null;
  docDate: string | null;
  title: string | null;
  authorizedAmount: number | null;
  currency: string | null;
  description: string | null;
  justification: string | null;
  goals: string[];
  successCriteria: string | null;
  preparedBy: string | null;
  approvals: BudgetApproval[];
  budgetReferences: BudgetReference[];
  varianceNote: string | null;
  lines: BudgetLine[];
  milestones: Array<{ name: string; date: string }>;
  targetCompletionDate: string | null;
  mocReference: string | null;
}

// ── normalization ───────────────────────────────────────────────────────

const str = (v: unknown, max = 2000): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/** Money as printed → number. Accepts 1250000, "1,250,000", "$1.25M",
 *  "(5,000)" (accounting negative). Anything else is null — never guessed. */
export function parseMoney(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[()\-\s$€£,]|USD|CAD|EUR|GBP/gi, "");
  const m = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(s);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[2]) n *= m[2].toLowerCase() === "k" ? 1_000 : 1_000_000;
  return negative ? -n : n;
}

const isoDate = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
};

const PLACEHOLDER_SUPPLIER = /^(various|var\.?|tbd|tba|n\/?a|none|-+|multiple|misc\.?|unknown|internal)$/i;

/** "{SWAT}" → "SWAT"; "Various"/"TBD" → null (no single company to create). */
export function cleanSupplier(v: unknown): string | null {
  const s = str(v, 200);
  if (!s) return null;
  const bare = s.replace(/^[{[(<"']+|[}\])>"']+$/g, "").trim();
  if (!bare || PLACEHOLDER_SUPPLIER.test(bare)) return null;
  return bare;
}

const TOTAL_ROW = /^(sub-?\s*)?totals?\b|^grand total|^total (cost|amount|project)/i;

/** Best-guess cost type from a line's own words. Order matters: "Chem Clean
 *  Equipment" is equipment, not a cleaning subcontract. */
export function inferCostType(name: string, supplier?: string | null): CostType {
  const n = name.toLowerCase();
  if (/\b(labor|labour|manpower|craft|crew|man-?hours?|timesheet|staffing|overtime)\b/.test(n)) return "labor";
  if (/\b(rental|rentals|crane|equipment|boxes|lift|manlift|generator|compressor|tools?|trailer|frac tank)\b/.test(n)) return "equipment";
  if (/\b(material|materials|parts|supplies|consumables?|gaskets?|valves?|pipe|piping material|steel|catalyst|chemicals?)\b/.test(n)) return "material";
  if (/(servic|rescue|blast|clean|inspect|retube|scaffold|insulat|paint|test|ndt|subcontract|repair|machin|haul|disposal|engineering)/.test(n)) return "subcontract";
  return supplier ? "subcontract" : "other";
}

/** Validate and normalize a model's raw extraction. Throws only when there
 *  is nothing usable at all — a document with neither lines nor a total. */
export function validateParsedBudgetDoc(raw: unknown): ParsedBudgetDoc {
  if (!raw || typeof raw !== "object") throw new Error("The extraction was empty.");
  const r = raw as Record<string, unknown>;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  const lines: BudgetLine[] = [];
  for (const item of arr(r.lines)) {
    if (!item || typeof item !== "object") continue;
    const l = item as Record<string, unknown>;
    const name = str(l.name ?? l.description, 200);
    if (!name || TOTAL_ROW.test(name)) continue;
    const supplier = cleanSupplier(l.supplier ?? l.vendor);
    const ct = typeof l.costType === "string" && (COST_TYPES as readonly string[]).includes(l.costType)
      ? (l.costType as CostType)
      : inferCostType(name, supplier);
    lines.push({ name, amount: parseMoney(l.amount), supplier, costType: ct, note: str(l.note, 500) });
  }

  const budgetReferences: BudgetReference[] = arr(r.budgetReferences)
    .map((b) => (b && typeof b === "object" ? b as Record<string, unknown> : null))
    .filter((b): b is Record<string, unknown> => !!b)
    .map((b) => ({ label: str(b.label, 300) ?? "", amount: parseMoney(b.amount) }))
    .filter((b) => b.label);

  const approvals: BudgetApproval[] = arr(r.approvals)
    .map((a) => (a && typeof a === "object" ? a as Record<string, unknown> : null))
    .filter((a): a is Record<string, unknown> => !!a)
    .map((a) => ({ role: str(a.role, 120) ?? "", name: str(a.name, 120), date: isoDate(a.date) }))
    .filter((a) => a.role);

  const milestones = arr(r.milestones)
    .map((m) => (m && typeof m === "object" ? m as Record<string, unknown> : null))
    .filter((m): m is Record<string, unknown> => !!m)
    .map((m) => ({ name: str(m.name, 200) ?? "", date: isoDate(m.date) ?? "" }))
    .filter((m) => m.name && m.date);

  const goals = arr(r.goals).map((g) => str(g, 300)).filter((g): g is string => !!g).slice(0, 10);

  const out: ParsedBudgetDoc = {
    docType: str(r.docType, 80),
    docNumber: str(r.docNumber, 60),
    chargeAccount: str(r.chargeAccount, 120),
    docDate: isoDate(r.docDate),
    title: str(r.title, 300),
    authorizedAmount: parseMoney(r.authorizedAmount),
    currency: (str(r.currency, 3) ?? "").toUpperCase() || null,
    description: str(r.description, 4000),
    justification: str(r.justification, 6000),
    goals,
    successCriteria: str(r.successCriteria, 1000),
    preparedBy: str(r.preparedBy, 120),
    approvals,
    budgetReferences,
    varianceNote: str(r.varianceNote, 2000),
    lines,
    milestones,
    targetCompletionDate: isoDate(r.targetCompletionDate),
    mocReference: str(r.mocReference, 60),
  };
  if (out.lines.length === 0 && out.authorizedAmount == null) {
    throw new Error("No cost lines or authorized amount could be read from this document.");
  }
  return out;
}

// ── reconciliation ──────────────────────────────────────────────────────

export interface BudgetReconciliation {
  linesTotal: number;
  authorized: number | null;
  /** authorized − linesTotal; null without an authorized amount. */
  unallocated: number | null;
  /** Lines add up to the authorized amount (within rounding). */
  balanced: boolean;
  /** Sum of the budget references the request draws on (null if none). */
  budgeted: number | null;
  /** authorized − budgeted: how far the request runs over (+) or under (−)
   *  the budget it cites. */
  overBudgetBy: number | null;
}

export function reconcileBudget(doc: Pick<ParsedBudgetDoc, "lines" | "authorizedAmount" | "budgetReferences">): BudgetReconciliation {
  const linesTotal = doc.lines.reduce((s, l) => s + (l.amount ?? 0), 0);
  const authorized = doc.authorizedAmount;
  const unallocated = authorized == null ? null : authorized - linesTotal;
  const tolerance = authorized == null ? 0 : Math.max(1, Math.abs(authorized) * 0.005);
  const refs = doc.budgetReferences.filter((b) => b.amount != null);
  const budgeted = refs.length ? refs.reduce((s, b) => s + (b.amount ?? 0), 0) : null;
  return {
    linesTotal,
    authorized,
    unallocated,
    balanced: unallocated == null ? true : Math.abs(unallocated) <= tolerance,
    budgeted,
    overBudgetBy: authorized != null && budgeted != null ? authorized - budgeted : null,
  };
}

// ── name matching (suppliers ↔ parties ↔ invoices) ──────────────────────

const CORP_SUFFIX = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|co|corp|corporation|company|lp|llp|plc|group|holdings|the)\b/g;

/** Comparable company name: lowercase, no punctuation, no corporate suffix. */
export function normalizeCompany(name: string): string {
  return name.toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(CORP_SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same company? Exact after normalization, or one name is the other's
 *  leading words ("Pro Safety" ↔ "Pro Safety Services"). Single short
 *  tokens must match exactly — "Co" must never match "Coastal". */
export function sameCompany(a: string, b: string): boolean {
  const x = normalizeCompany(a), y = normalizeCompany(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 3) return false;
  return long.startsWith(`${short} `);
}

export function matchParty<P extends { id: string; name: string }>(name: string | null | undefined, parties: P[]): P | null {
  if (!name) return null;
  return parties.find((p) => sameCompany(p.name, name)) ?? null;
}

/** Distinct suppliers across lines, first spelling wins. */
export function uniqueSuppliers(lines: Array<Pick<BudgetLine, "supplier">>): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (l.supplier && !out.some((s) => sameCompany(s, l.supplier!))) out.push(l.supplier);
  }
  return out;
}

const STOP = new Set(["and", "the", "for", "of", "to", "in", "on", "with", "a", "an", "per", "no", "unit", "service", "services", "work"]);
const tokens = (s: string): Set<string> =>
  new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t)));

// ── applying a budget to a project ──────────────────────────────────────

export interface BudgetApplyPlan {
  partiesToCreate: string[];
  accountsToCreate: Array<{ name: string; budget: number; costType: CostType; supplier: string | null; note: string | null }>;
  /** Lines whose budget line already exists by name — left untouched; the
   *  existing line's budget changes only through a change order. */
  accountsSkipped: Array<{ name: string; existingBudget: number }>;
}

export function planBudgetApply(
  lines: BudgetLine[],
  existingAccounts: Array<{ name: string; budget: number }>,
  existingParties: Array<{ id: string; name: string }>,
): BudgetApplyPlan {
  const plan: BudgetApplyPlan = { partiesToCreate: [], accountsToCreate: [], accountsSkipped: [] };
  const seen = new Set<string>();
  for (const l of lines) {
    const key = l.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const existing = existingAccounts.find((a) => a.name.trim().toLowerCase() === key);
    if (existing) { plan.accountsSkipped.push({ name: l.name, existingBudget: existing.budget }); continue; }
    plan.accountsToCreate.push({
      name: l.name.trim(), budget: Math.max(0, l.amount ?? 0), costType: l.costType,
      supplier: l.supplier, note: l.note,
    });
    if (l.supplier && !matchParty(l.supplier, existingParties)
      && !plan.partiesToCreate.some((p) => sameCompany(p, l.supplier!))) {
      plan.partiesToCreate.push(l.supplier);
    }
  }
  return plan;
}

// ── invoices: where does this money go? ─────────────────────────────────

export interface AccountSuggestion {
  accountId: string;
  confidence: "high" | "medium" | "low";
  reason: string;
}

/**
 * Suggest the budget line an invoice belongs on. Vendor first — the
 * company named on the invoice is the company the line was budgeted for —
 * then the billed line descriptions against budget-line names. Returns
 * null rather than a coin flip: a wrong suggestion costs more than none.
 */
export function suggestAccountForInvoice(
  invoice: { vendorName: string | null; partyId?: string | null; lineDescriptions?: string[] },
  accounts: Array<{ id: string; name: string; partyId: string | null; status?: string }>,
  parties: Array<{ id: string; name: string }>,
): AccountSuggestion | null {
  const live = accounts.filter((a) => a.status !== "closed");
  if (live.length === 0) return null;

  const party = invoice.partyId
    ? parties.find((p) => p.id === invoice.partyId) ?? null
    : matchParty(invoice.vendorName, parties);
  const words = tokens((invoice.lineDescriptions ?? []).join(" "));
  const overlap = (name: string) => [...tokens(name)].filter((t) => words.has(t)).length;

  if (party) {
    const theirs = live.filter((a) => a.partyId === party.id);
    if (theirs.length === 1) {
      return { accountId: theirs[0].id, confidence: "high", reason: `${party.name}'s budget line` };
    }
    if (theirs.length > 1) {
      const ranked = theirs.map((a) => ({ a, s: overlap(a.name) })).sort((x, y) => y.s - x.s);
      const best = ranked[0];
      if (best.s > 0 && best.s > (ranked[1]?.s ?? 0)) {
        return { accountId: best.a.id, confidence: "high", reason: `${party.name} — matches "${best.a.name}"` };
      }
      return { accountId: best.a.id, confidence: "medium", reason: `${party.name} has ${theirs.length} lines — check this one` };
    }
  }

  if (words.size > 0) {
    const ranked = live.map((a) => ({ a, s: overlap(a.name) })).sort((x, y) => y.s - x.s);
    if (ranked[0].s > 0 && ranked[0].s > (ranked[1]?.s ?? 0)) {
      return { accountId: ranked[0].a.id, confidence: "low", reason: `billed work reads like "${ranked[0].a.name}"` };
    }
  }
  return null;
}

/**
 * An invoice that's already on the books: same vendor and same invoice
 * number, or — when either has no number — same vendor, same total, same
 * date. Vendors re-send; the second copy must never post twice.
 */
export function findDuplicateInvoice<D extends {
  id: string; kind: string; status: string;
  vendorName: string | null; docNumber: string | null; totalAmount: number | null; docDate: string | null;
}>(doc: D, others: D[]): D | null {
  if (!doc.vendorName) return null;
  for (const o of others) {
    if (o.id === doc.id || o.kind !== doc.kind || o.status === "void" || !o.vendorName) continue;
    if (!sameCompany(o.vendorName, doc.vendorName)) continue;
    if (doc.docNumber && o.docNumber) {
      if (doc.docNumber.replace(/\W/g, "").toLowerCase() === o.docNumber.replace(/\W/g, "").toLowerCase()) return o;
      continue;
    }
    if (doc.totalAmount != null && doc.totalAmount === o.totalAmount && doc.docDate && doc.docDate === o.docDate) return o;
  }
  return null;
}

// ── setup prefill ───────────────────────────────────────────────────────

/** The project fields a budget document can fill — used by the wizard. */
export function projectPrefillFrom(doc: ParsedBudgetDoc): {
  name: string; description: string; purpose: string; goals: string[]; successCriteria: string;
  mocReference: string; targetDate: string;
} {
  const label = doc.docType && doc.docNumber ? `${doc.docType} ${doc.docNumber}` : doc.docNumber ?? "";
  return {
    name: doc.title ?? label,
    description: doc.description ?? "",
    purpose: doc.justification ?? "",
    goals: doc.goals,
    successCriteria: doc.successCriteria ?? "",
    mocReference: doc.mocReference ?? "",
    targetDate: doc.targetCompletionDate ?? "",
  };
}

// ── source formats ──────────────────────────────────────────────────────

export type BudgetSourceFormat = "pdf" | "image" | "sheet" | "docx" | "text" | "unsupported";

/** Which reader a budget document needs, from its name and type. */
export function budgetSourceFormat(fileName: string, mimeType: string | null): BudgetSourceFormat {
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName)?.[1] ?? "").toLowerCase();
  const mt = (mimeType ?? "").toLowerCase();
  if (ext === "pdf" || mt.includes("pdf")) return "pdf";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext) || /^image\/(png|jpe?g|webp|gif)$/.test(mt)) return "image";
  if (["xlsx", "xlsm", "xls", "csv", "ods"].includes(ext) || mt.includes("spreadsheet") || mt.includes("excel") || mt === "text/csv") return "sheet";
  if (ext === "docx" || mt.includes("wordprocessingml")) return "docx";
  if (["txt", "md", "eml"].includes(ext) || mt.startsWith("text/")) return "text";
  return "unsupported";
}

/** File-picker accept list matching budgetSourceFormat. */
export const BUDGET_DOC_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xlsm,.xls,.csv,.ods,.docx,.txt,.md,.eml";
