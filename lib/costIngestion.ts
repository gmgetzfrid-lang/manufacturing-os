// lib/costIngestion.ts
//
// Document ingestion for cost controls: upload a quote / PO / invoice → the AI
// reads it (multimodal) → we propose how each line maps onto the project's cost
// accounts → the user reviews/edits → confirm posts the ledger entries. Nothing
// is auto-posted; the AI only proposes.
//
// The MAPPING (extraction → draft plan) is pure + unit-tested. The file→base64,
// AI call, and persistence are thin IO around it.

import { getAiProvider } from "@/lib/ai";
import {
  createParty, createAccount, updateAccount, createEntry, createDocument, updateDocument, COST_TYPE_LABEL,
} from "@/lib/costControls";
import type {
  CostExtraction, CostAccount, ProjectParty, CostLineItem, CostType, CostEntryType, CostDocumentKind,
} from "@/types/schema";

/** Which ledger bucket a document kind posts into. An AFE (Authorization for
 *  Expenditure) authorises BUDGET — and typically declares the contractors. */
export const KIND_TO_ENTRY_TYPE: Record<CostDocumentKind, CostEntryType> = {
  afe: "budget",
  quote: "budget",
  estimate: "budget",
  po: "commitment",
  subcontract: "commitment",
  invoice: "actual",
  change_order: "change",
  other: "actual",
};

export interface IngestPlanLine {
  line: CostLineItem;
  /** Resolved existing contractor/party id, or null. */
  partyId: string | null;
  /** When partyId is null and the line names a party, create it. */
  newPartyName?: string | null;
  /** Suggested existing account, or null = create a new account. */
  accountId: string | null;
  /** When accountId is null, the new account to create. */
  newAccount?: { name: string; costType: CostType };
}

export interface IngestPlan {
  /** The ledger bucket every posted line lands in. */
  entryType: CostEntryType;
  lines: IngestPlanLine[];
  total: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Token-overlap score between a line description and an account name. */
function nameScore(lineDesc: string, accountName: string): number {
  const a = new Set(norm(lineDesc).split(" ").filter((w) => w.length > 2));
  const b = norm(accountName).split(" ").filter((w) => w.length > 2);
  if (a.size === 0 || b.length === 0) return 0;
  let hits = 0;
  for (const w of b) if (a.has(w)) hits++;
  return hits / b.length;
}

/** Find an existing party whose name matches (case/space-insensitive). */
function matchParty(name: string | null | undefined, parties: ProjectParty[]): ProjectParty | null {
  if (!name) return null;
  const n = norm(name);
  return parties.find((p) => norm(p.name) === n)
    ?? parties.find((p) => norm(p.name).includes(n) || n.includes(norm(p.name)))
    ?? null;
}

/**
 * Propose how an extraction maps onto the project's contractors + cost accounts.
 *
 * Each line resolves a CONTRACTOR first (the line's own party for an AFE, else
 * the document's party): an existing one, or a new one to create. Then a cost
 * account: for BUDGET documents (AFE / quote / estimate) we default to a NEW,
 * scope-named account per line under that contractor — that's how an AFE sets
 * up the structure; for commitments/actuals we match an existing account of the
 * same type (and party), creating one only if none fits. Pure + deterministic.
 */
export function planFromExtraction(
  ext: CostExtraction,
  accounts: CostAccount[],
  opts?: { partyId?: string | null; parties?: ProjectParty[] },
): IngestPlan {
  const entryType = KIND_TO_ENTRY_TYPE[ext.kind] ?? "actual";
  const docPartyId = opts?.partyId ?? null;
  const parties = opts?.parties ?? [];
  const isBudget = entryType === "budget";

  const lines: IngestPlanLine[] = (ext.lineItems ?? []).map((line) => {
    const ct: CostType = line.costType ?? "odc";

    // 1. Resolve the contractor for this line.
    let partyId: string | null = docPartyId;
    let newPartyName: string | null = null;
    if (line.party) {
      const existing = matchParty(line.party, parties);
      if (existing) partyId = existing.id ?? null;
      else { partyId = null; newPartyName = line.party.trim(); }
    }

    // 2. Resolve the account.
    const newAccount = { name: line.description?.trim() || COST_TYPE_LABEL[ct], costType: ct };
    if (isBudget) {
      // AFE / quote: a new scope-named account per line builds the structure.
      return { line, partyId, newPartyName, accountId: null, newAccount };
    }
    // Commitment / actual: reuse an existing account of the same type (+party).
    let candidates = accounts.filter((a) => a.costType === ct);
    if (partyId) {
      const sameParty = candidates.filter((a) => a.partyId === partyId);
      if (sameParty.length > 0) candidates = sameParty;
    }
    let best: CostAccount | null = null;
    let bestScore = -1;
    for (const a of candidates) {
      const s = nameScore(line.description, a.name);
      if (s > bestScore) { bestScore = s; best = a; }
    }
    if (best) return { line, partyId, newPartyName, accountId: best.id ?? null };
    return { line, partyId, newPartyName, accountId: null, newAccount: { name: COST_TYPE_LABEL[ct], costType: ct } };
  });

  const total = lines.reduce((s, l) => s + (Number.isFinite(l.line.amount) ? l.line.amount : 0), 0);
  return { entryType, lines, total: Math.round(total * 100) / 100 };
}

// ─── IO: file → base64 → AI extraction ───────────────────────────

/** Read a browser File as base64 (no data: prefix) for the multimodal call. */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = reader.result as string;
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/** Run the multimodal extraction on an uploaded file. */
export async function extractCostFromFile(
  file: File,
  opts?: { kindHint?: CostDocumentKind; accountHints?: string[] },
): Promise<CostExtraction> {
  const dataBase64 = await fileToBase64(file);
  const ai = getAiProvider();
  return ai.extractCostDocument({
    dataBase64,
    mimeType: file.type || "application/octet-stream",
    kindHint: opts?.kindHint,
    accountHints: opts?.accountHints,
  });
}

// ─── IO: post a reviewed plan to the ledger ──────────────────────

export interface PostIngestInput {
  orgId: string;
  projectId: string;
  partyId?: string | null;
  kind: CostDocumentKind;
  fileUrl?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  extraction: CostExtraction;
  /** The reviewed plan, as edited by the user. */
  plan: IngestPlan;
  /** Existing accounts — needed to add to a budget on an existing account. */
  accounts: CostAccount[];
  actorUserId: string;
  actorEmail?: string;
}

export interface PostIngestResult {
  documentId: string;
  createdParties: number;
  createdAccounts: number;
  postedEntries: number;
  postedTotal: number;
  /** For budget docs: the total BAC the document set across accounts. */
  budgetSet: number;
}

/**
 * Persist a reviewed ingestion. The key behaviour by ledger bucket:
 *   - BUDGET (AFE / quote / estimate): create the contractors and set each
 *     account's BUDGET (BAC) — this is what makes the rollup reflect the AFE.
 *   - COMMITMENT / ACTUAL: post a ledger entry against the account (the rollup
 *     reads committed / actual from entries).
 * Either way a 'budget'/commitment/actual entry is written for the audit trail
 * and linked to the stored source document.
 */
export async function postIngestPlan(input: PostIngestInput): Promise<PostIngestResult> {
  const { extraction, plan } = input;
  const isBudget = plan.entryType === "budget";
  const currency = extraction.currency ?? "USD";

  const doc = await createDocument({
    orgId: input.orgId, projectId: input.projectId, partyId: input.partyId ?? null,
    kind: input.kind, fileUrl: input.fileUrl ?? null, fileName: input.fileName ?? null,
    mimeType: input.mimeType ?? null, docNumber: extraction.docNumber ?? null,
    docDate: extraction.docDate ?? null, vendorName: extraction.vendorName ?? null,
    currency, totalAmount: extraction.totalAmount ?? plan.total,
    status: "parsed", parsed: extraction, actorUserId: input.actorUserId,
  });

  // 1. Create any new contractors the plan names (dedupe by lowercased name).
  const partyIdByName = new Map<string, string>();
  let createdParties = 0;
  for (const l of plan.lines) {
    if (l.partyId || !l.newPartyName) continue;
    const key = l.newPartyName.toLowerCase();
    if (partyIdByName.has(key)) continue;
    const p = await createParty({
      orgId: input.orgId, projectId: input.projectId, name: l.newPartyName,
      kind: "contractor", status: "active", actorUserId: input.actorUserId,
    });
    if (p.id) { partyIdByName.set(key, p.id); createdParties++; }
  }
  const resolveParty = (l: IngestPlanLine): string | null =>
    l.partyId ?? (l.newPartyName ? partyIdByName.get(l.newPartyName.toLowerCase()) ?? null : null);

  // Track running budget for accounts we touch (existing start at current).
  const budgetByAcct = new Map<string, number>();
  for (const a of input.accounts) if (a.id) budgetByAcct.set(a.id, a.budget ?? 0);
  // Dedupe new commitment/actual accounts by (party, cost type).
  const reuseAcct = new Map<string, string>();

  let createdAccounts = 0, postedEntries = 0, postedTotal = 0, budgetSet = 0;

  for (const l of plan.lines) {
    const partyId = resolveParty(l);
    const ct: CostType = l.line.costType ?? "odc";
    let accountId = l.accountId;

    if (!accountId) {
      if (isBudget) {
        // A new scope-named account per budget line, BAC = the line amount.
        const acct = await createAccount({
          orgId: input.orgId, projectId: input.projectId, partyId, name: l.newAccount?.name || l.line.description?.trim() || COST_TYPE_LABEL[ct],
          costType: ct, budget: l.line.amount, currency, actorUserId: input.actorUserId,
        });
        accountId = acct.id ?? null;
        if (accountId) { budgetByAcct.set(accountId, l.line.amount); budgetSet += l.line.amount; createdAccounts++; }
      } else {
        const key = `${partyId ?? ""}:${ct}`;
        accountId = reuseAcct.get(key) ?? null;
        if (!accountId) {
          const acct = await createAccount({
            orgId: input.orgId, projectId: input.projectId, partyId, name: l.newAccount?.name || COST_TYPE_LABEL[ct],
            costType: ct, budget: 0, currency, actorUserId: input.actorUserId,
          });
          accountId = acct.id ?? null;
          if (accountId) { reuseAcct.set(key, accountId); createdAccounts++; }
        }
      }
    } else if (isBudget) {
      // Existing account chosen for a budget line → add to its BAC.
      const next = (budgetByAcct.get(accountId) ?? 0) + l.line.amount;
      budgetByAcct.set(accountId, next);
      await updateAccount(accountId, { budget: next }, input.actorUserId);
      budgetSet += l.line.amount;
    }

    if (!accountId) continue;
    await createEntry({
      orgId: input.orgId, projectId: input.projectId, costAccountId: accountId,
      partyId, entryType: plan.entryType, amount: l.line.amount,
      entryDate: extraction.docDate ?? null, description: l.line.description,
      reference: extraction.docNumber ?? null, sourceDocumentId: doc.id ?? null,
      status: "posted", actorUserId: input.actorUserId,
    });
    postedEntries++; postedTotal += l.line.amount;
  }

  await updateDocument(doc.id!, { status: "posted", postedBy: input.actorUserId, postedAt: new Date().toISOString() });

  return {
    documentId: doc.id!, createdParties, createdAccounts, postedEntries,
    postedTotal: Math.round(postedTotal * 100) / 100, budgetSet: Math.round(budgetSet * 100) / 100,
  };
}
