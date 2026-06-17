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
  createAccount, createEntry, createDocument, updateDocument, COST_TYPE_LABEL,
} from "@/lib/costControls";
import type {
  CostExtraction, CostAccount, CostLineItem, CostType, CostEntryType, CostDocumentKind,
} from "@/types/schema";

/** Which ledger bucket a document kind posts into. */
export const KIND_TO_ENTRY_TYPE: Record<CostDocumentKind, CostEntryType> = {
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
  /** Distinct new accounts the plan would create (deduped). */
  newAccounts: Array<{ name: string; costType: CostType }>;
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

/**
 * Propose how an extraction maps onto the project's cost accounts. For each
 * line we prefer an existing account with the SAME cost type (and party, when
 * the doc is tied to one), breaking ties by name similarity; failing that we
 * suggest a new account named after its cost type. Pure + deterministic.
 */
export function planFromExtraction(
  ext: CostExtraction,
  accounts: CostAccount[],
  opts?: { partyId?: string | null },
): IngestPlan {
  const entryType = KIND_TO_ENTRY_TYPE[ext.kind] ?? "actual";
  const partyId = opts?.partyId ?? null;

  const lines: IngestPlanLine[] = (ext.lineItems ?? []).map((line) => {
    const ct: CostType = line.costType ?? "odc";
    // Candidate accounts: same cost type; prefer the doc's party when set.
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
    // Use an existing account whenever the cost type matches (the name score
    // only orders ties); only propose a NEW account when nothing matches type.
    if (best) return { line, accountId: best.id ?? null };
    return { line, accountId: null, newAccount: { name: COST_TYPE_LABEL[ct], costType: ct } };
  });

  // Dedupe the new accounts the plan implies (one per cost type).
  const seen = new Set<string>();
  const newAccounts: Array<{ name: string; costType: CostType }> = [];
  for (const l of lines) {
    if (l.newAccount && !seen.has(l.newAccount.costType)) {
      seen.add(l.newAccount.costType);
      newAccounts.push(l.newAccount);
    }
  }

  const total = lines.reduce((s, l) => s + (Number.isFinite(l.line.amount) ? l.line.amount : 0), 0);
  return { entryType, lines, total: Math.round(total * 100) / 100, newAccounts };
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
  /** The reviewed plan (line → account or new account), as edited by the user. */
  plan: IngestPlan;
  actorUserId: string;
  actorEmail?: string;
}

export interface PostIngestResult {
  documentId: string;
  createdAccounts: number;
  postedEntries: number;
  postedTotal: number;
}

/**
 * Persist a reviewed ingestion: record the source document, create any new
 * accounts the user accepted, then post one ledger entry per line. Returns a
 * summary. The cost document is marked 'posted' and linked to every entry.
 */
export async function postIngestPlan(input: PostIngestInput): Promise<PostIngestResult> {
  const { extraction, plan } = input;

  const doc = await createDocument({
    orgId: input.orgId, projectId: input.projectId, partyId: input.partyId ?? null,
    kind: input.kind, fileUrl: input.fileUrl ?? null, fileName: input.fileName ?? null,
    mimeType: input.mimeType ?? null, docNumber: extraction.docNumber ?? null,
    docDate: extraction.docDate ?? null, vendorName: extraction.vendorName ?? null,
    currency: extraction.currency ?? null, totalAmount: extraction.totalAmount ?? plan.total,
    status: "parsed", parsed: extraction, actorUserId: input.actorUserId,
  });

  // Create accounts for any new ones the plan implies, keyed by cost type.
  const newAcctByType = new Map<CostType, string>();
  let createdAccounts = 0;
  for (const na of plan.newAccounts) {
    const acct = await createAccount({
      orgId: input.orgId, projectId: input.projectId, partyId: input.partyId ?? null,
      name: na.name, costType: na.costType, budget: 0, currency: extraction.currency ?? "USD",
      actorUserId: input.actorUserId,
    });
    if (acct.id) newAcctByType.set(na.costType, acct.id);
    createdAccounts++;
  }

  let postedEntries = 0;
  let postedTotal = 0;
  for (const l of plan.lines) {
    const accountId = l.accountId ?? (l.newAccount ? newAcctByType.get(l.newAccount.costType) : undefined);
    if (!accountId) continue;
    await createEntry({
      orgId: input.orgId, projectId: input.projectId, costAccountId: accountId,
      partyId: input.partyId ?? null, entryType: plan.entryType, amount: l.line.amount,
      entryDate: extraction.docDate ?? null, description: l.line.description,
      reference: extraction.docNumber ?? null, sourceDocumentId: doc.id ?? null,
      status: "posted", actorUserId: input.actorUserId,
    });
    postedEntries++;
    postedTotal += l.line.amount;
  }

  await updateDocument(doc.id!, { status: "posted", postedBy: input.actorUserId, postedAt: new Date().toISOString() });

  return { documentId: doc.id!, createdAccounts, postedEntries, postedTotal: Math.round(postedTotal * 100) / 100 };
}
