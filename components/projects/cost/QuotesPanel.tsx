"use client";

// QuotesPanel — READING inbound money paper, then tabulating it.
//
// The direction the whole cost program runs on: vendors send US documents.
// Quotes arrive two ways — a member drops the PDF here, or the contractor
// submits through a tokened quote link (no account, same portal rails as
// drawings). One click has the AI read the printed pages into numbers;
// competing quotes in an RFQ group tabulate side by side — price, labor
// hours, $/hour, and the EXCLUSIONS that explain why the low bid is low —
// with a weighted best-value score whose math is always shown. Awarding
// posts the commitment to a budget line in the same click. Invoices follow
// the same read-review-post path as actuals.
//
// Trust rules on this screen (projects Round G): ONE number per bid —
// the human-visible total — feeds the table, the score and the award, with
// the model's original kept visible once corrected (BID-1 / GAP-407); every
// row opens its source PDF (BID-2); every figure renders in its own
// currency and a mixed-currency field is not ranked (BID-7); typed-total
// bids sit in the same table, price-normalised, "not scored" where they
// cannot be scored (BID-8); a read total can be corrected, restated in
// another currency or voided — through a status-guarded write, so a stale
// tab cannot touch a document someone has since awarded (BID-9); the
// registry match is normalised, visible and overridable by an explicit
// company link (BID-12). What gates what (MON-12 UI half):
//  · the row's chip is a DISPLAY — the linked company, else any do-not-use
//    row the stored vendor name could be, else one only the letterhead the
//    AI read could be (labelled so);
//  · Award waits for the registry and the links to load, then asks at the
//    click (`awardGateFor`, re-asked after its dialogs) the award's own
//    question: the database's gate once 20261157 is applied (the row's own
//    link to a company of its org, else its contractor's company when
//    flagged, else any do-not-use row the STORED vendor name normalises to,
//    else the company it binds to on its own flag; before it, the client
//    sequence's order) — an answer needs a typed override, recorded as
//    intent and passed to the award, which records it. It names ONE
//    company, the first of that order that answers;
//  · a do-not-use row a name of the bid could be — the LETTERHEAD, or the
//    STORED vendor name behind a flagged contractor that answers first —
//    that the override does not answer for (no link of the org decides; the
//    override is not a do-not-use row with that name's key) stops the award
//    for a typed acknowledgement recorded under its own action, once per
//    name key — never the override: no gate in the lib or the database
//    reads the letterhead, and theirs names only the first answer;
//  · re-linking a bid away from a do-not-use company (its link, or a name —
//    stored or letterhead — it could be) needs a typed, audited reason.
// The barred rows are read in full (never the name list, which is capped)
// and flagging fails toward the flag: two rows normalising alike both
// flag. A truncated read is said out loud and the award total must be
// typed back from the paper (COST-13).

import React, { useMemo, useState } from "react";
import {
  FileText, UploadCloud, Loader2, Sparkles, Trophy, Link2, Copy, AlertTriangle,
  CheckCircle2, ScanSearch, Ban, Receipt, ChevronDown, ChevronRight, ExternalLink, Pencil, RotateCcw, Plus, X as XIcon,
} from "lucide-react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { userFacingError, userFacingReadError, userFacingCaughtError } from "@/lib/userFacingError";
import { useAiReadiness, aiBlocked, AiPreconditionNote } from "@/components/projects/AiPrecondition";
import { saveAccount } from "@/lib/costs";
import { newIntakeToken, intakePortalPath, linkCredentialView, firstReadWithColumns, reissueIntakeLink } from "@/lib/intakeLinks";
import { listCompanies, listBarredCompanies, type Company } from "@/lib/companies";
import { fmtMoney, type CostAccount, type Actor } from "@/lib/costs";
import { getFileUrl } from "@/lib/storage";
import { publicOrigin } from "@/lib/publicOrigin";
import { DECISION_TARGET } from "@/components/projects/decisionTarget";
import {
  type CostDocument, costDocStatusLabel,
  uploadCostDoc, awardQuote, postInvoice, declineQuote, voidCostDoc,
  parsedQuoteFrom, quoteGroups, normalizeCurrency,
} from "@/lib/costDocs";
import {
  computeBidEconomics, scoreBids, effectiveWeights, MANPOWER_MAX_COMPOSITE_SWING, MIN_CORROBORATING_STATEMENTS, HOURS_PLAUSIBILITY_RATIO,
  withHumanTotal, priceOnlyQuote, mergeQuoteGroups, snapRfqGroup, matchCompanyByName, alignGroupSpelling, normalizeCompanyName,
  companyCandidatesByName, barredCompanyFor, UNKNOWN_VENDOR,
  quoteExpired, readExtent, fieldCurrency, bidCurrency, isoCurrency, parseTypedAmount, reconcileQuoteTotal,
  type ParsedQuote, type BidEconomics,
} from "@/lib/bidTab";
import { appConfirm, appPrompt } from "@/components/providers/DialogProvider";
import { isMissingRpc } from "@/lib/costDocs";
import { notifyQuoteOutcome } from "@/lib/intakeOutcomeNotice";

/** Row columns that live beside CostDocument (landed by 20261096) — read
 *  here so the frozen lib/costDocs mapper does not need to change: the
 *  explicit registry link and the read extent. */
interface DocExtras { companyId: string | null; pagesTotal: number | null; pagesRead: number | null }
interface Party { id: string; name: string; companyId: string | null }
type LoadState = "loading" | "ready" | "failed";

/** A column a pending migration adds is not there yet. */
const missingColumn = (e: { code?: string } | null | undefined) => !!e && (e.code === "42703" || e.code === "PGRST204");

/** Statuses a document can still be corrected, voided or re-linked from. */
const OPEN_DOC_STATUSES = ["draft", "parsed"] as const;
const isOpenDoc = (d: Pick<CostDocument, "status">) => (OPEN_DOC_STATUSES as readonly string[]).includes(d.status);

/** Ids per `.in()` request — keeps the request line bounded. */
const ID_CHUNK = 100;

/**
 * Correct, restate or void a document that is still OPEN (BID-9 / MON-3).
 * The status predicate is in the UPDATE itself, so a stale tab can never
 * void or re-total a quote someone has since awarded (its commitment
 * already posted) or an invoice already posted; zero rows matched is a
 * refusal, never a silent success. The audit row (same action names the
 * lib writers use) follows the change and its failure is reported. This
 * is the panel's own guarded path until lib/costDocs' voidCostDoc /
 * setManualTotal carry the guard (PC-7).
 */
export async function guardedCostDocWrite(input: {
  doc: Pick<CostDocument, "id" | "orgId">;
  patch: Record<string, unknown>;
  audit: { action: string; details: Record<string, unknown> };
  actor: Actor;
}): Promise<{ ok: true; auditError: string | null } | { ok: false; error: string }> {
  const { data, error } = await supabase.from("cost_documents").update(input.patch)
    .eq("id", input.doc.id).eq("org_id", input.doc.orgId).in("status", [...OPEN_DOC_STATUSES]).select("id");
  if (error) return { ok: false, error: userFacingError(error) };
  if (!data || (data as unknown[]).length === 0) {
    return { ok: false, error: "Someone else has already awarded, posted or voided this document — refresh to see the latest." };
  }
  const { error: auditErr } = await supabase.from("audit_logs").insert({
    action: input.audit.action, resource_type: "cost", resource_id: input.doc.id,
    org_id: input.doc.orgId, user_id: input.actor.uid, user_email: input.actor.email,
    details: input.audit.details,
  });
  return { ok: true, auditError: auditErr ? userFacingError(auditErr, { embed: true }) : null };
}

/** The registry row an award must answer for (MON-12): what the override
 *  prompt names and the intent row records. */
export interface AwardFlag { id: string; name: string; status: string }

/** A do-not-use registry row a NAME of the bid could be — the stored vendor
 *  name (`onFile`), the letterhead the AI read (`letterhead`), or both — that
 *  the award's override does not answer for: no link of the org decides
 *  (DEC-48), and the override (`companyAwardAnswersFor`, the database's
 *  question) is not a do-not-use row with that name's key. The override
 *  names ONE company, the first its order reaches (the link, a flagged
 *  contractor, the stored name's do-not-use look-alike, the bound company's
 *  own flag), so a flagged contractor hides the stored name's look-alike
 *  from it, and no gate in the lib or the database reads the letterhead at
 *  all. So it is no override: the bid tab stops on it for a typed
 *  acknowledgement recorded under its own action,
 *  `COST_DOC_AWARD_LETTERHEAD_ACK`, for the stored name, the letterhead or
 *  both (`details.matchedOn` says which; the action's name is kept from fix
 *  pass 8, which asked about the letterhead only) — never the override
 *  intent, never `award_quote`'s override reason (J12 review fix passes 8
 *  and 9). */
export interface NameFlag {
  company: AwardFlag;
  /** The stored vendor name — the name the database's question reads. */
  vendorOnFile: string | null;
  /** The stored vendor name could be `company`. */
  onFile: boolean;
  /** The letterhead the AI read, when IT could be `company`; else null. */
  letterhead: string | null;
}

/** What an award of a bid must answer for, asked at the click: the override
 *  the award records, and the acknowledgements it stops for — one per
 *  name key, so a company two names could be is asked about once. */
export interface AwardGate { override: AwardFlag | null; acks: NameFlag[] }

const FLAGGED_COMPANY_STATUSES: readonly string[] = ["do_not_use", "inactive"];

const flagOf = (v: unknown): AwardFlag | null => {
  const c = (v ?? null) as { id?: unknown; name?: unknown; status?: unknown } | null;
  return c && typeof c.id === "string" && typeof c.name === "string" && typeof c.status === "string"
    ? { id: c.id, name: c.name, status: c.status } : null;
};

/** A company OF THE ORG `orgId`, by id — lib/costDocs.ts companyBehind's
 *  org-bound `byId`. Null means no such company in this org (another org's,
 *  whether RLS hides it or not, or gone): the link does not count and the
 *  question falls through, as the lib's and the database's do. A failed
 *  read throws. */
async function orgCompany(id: string, orgId: string): Promise<AwardFlag | null> {
  const { data, error } = await supabase.from("companies").select("id, name, status").eq("id", id).eq("org_id", orgId).maybeSingle();
  if (error) throw new Error(userFacingReadError(error));
  return flagOf(data);
}

/** The bid's row as re-read at the click — the fields an award is judged by. */
interface BidAtClick { orgId: string; companyId: string | null; partyId: string | null; vendorName: string | null }

/**
 * MON-12 / COST-3 — the flagged company an award of the bid must answer for:
 * the OVERRIDE the award records. Asked of the row as re-read at the click
 * (its own registry link, its contractor and its STORED vendor name,
 * `cost_documents.vendor_name` — the read route fills that column from the
 * letterhead only when the row has none).
 * - With 20261157 applied: the database's own gate, `cost_doc_company_barred`
 *   (SECURITY INVOKER, EXECUTE granted to authenticated) — the function
 *   `award_quote` calls under its lock with the same four arguments, as the
 *   same caller — so the prompt and the intent row name the company that
 *   function's `COST_DOC_AWARD_OVERRIDE` row records (an `inactive` one
 *   included).
 * - Before it (the function is absent — `isMissingRpc`, PGRST202 / 42883:
 *   the same test that sends the lib's award down its client sequence): the
 *   client sequence's own order (lib/costDocs.ts `companyBehind`) — the
 *   explicit link to a company of the document's org decides (a link to no
 *   company of the org is skipped, as the lib's org-bound read skips it);
 *   else the contractor's company of the org when it is flagged; else ANY
 *   do-not-use row the stored vendor name normalises to (`barredCompanyFor`
 *   over the org's barred rows, read in full). A flag beyond that (the
 *   bound company's own `inactive`, an `inactive` explicit link) is the
 *   lib's `needsOverride`, which names its own row's company.
 * Null: no override needed. A failed read throws — the award stops.
 */
export async function companyAwardAnswersFor(
  bid: BidAtClick, linkedCompany: () => Promise<AwardFlag | null>, barredRows: () => Promise<Company[]>,
): Promise<AwardFlag | null> {
  const { data, error: rpcErr } = await supabase.rpc("cost_doc_company_barred", {
    p_org: bid.orgId, p_company: bid.companyId, p_party: bid.partyId, p_vendor: bid.vendorName,
  });
  if (!rpcErr) {
    const c = flagOf(data);
    return c && FLAGGED_COMPANY_STATUSES.includes(c.status) ? c : null;
  }
  if (!isMissingRpc(rpcErr)) throw new Error(userFacingReadError(rpcErr));

  if (bid.companyId) {
    const bound = await linkedCompany();
    if (bound) return bound.status === "do_not_use" ? bound : null;
  }
  if (bid.partyId) {
    const { data: party, error: partyErr } = await supabase.from("project_parties").select("company_id").eq("id", bid.partyId).maybeSingle();
    if (partyErr) throw new Error(userFacingReadError(partyErr));
    const partyCompanyId = (party as { company_id?: unknown } | null)?.company_id;
    const contractor = typeof partyCompanyId === "string" && partyCompanyId !== "" ? await orgCompany(partyCompanyId, bid.orgId) : null;
    if (contractor && FLAGGED_COMPANY_STATUSES.includes(contractor.status)) return contractor;
  }
  const hit = barredCompanyFor(bid.vendorName, null, await barredRows());
  return hit ? { id: hit.id, name: hit.name, status: hit.status } : null;
}

/**
 * Everything an award of `doc` must answer for, asked AT THE CLICK of the
 * row as it stands (never the lists the table rendered from); the bid tab
 * asks it again just before `awardQuote`, after its dialogs, and asks again
 * for a reason when the answer moved meanwhile.
 * - `override`: `companyAwardAnswersFor` — the database's question over the
 *   stored vendor name and the row's links; what the award records. It names
 *   one company: the first of its order that answers.
 * - `acks`: when the row has no link to a company of its org (a person's link
 *   decides — DEC-48), the do-not-use row each NAME of the bid could be —
 *   the STORED vendor name, and the re-read row's PARSED vendor name (the
 *   letterhead the AI read — the field the bid tab's gate read through J12
 *   review fix pass 6; the parse's OWN name, never `parsedQuoteFrom`'s
 *   display fallback to the stored name, so a parse that read no vendor
 *   name, `UNKNOWN_VENDOR`, has no letterhead: J12 review fix pass 10) —
 *   unless the override
 *   already answers for that name: it is a do-not-use row with the name's
 *   key, or (the stored name only) there is no override, so the database's
 *   question over that name found no look-alike. A flagged contractor
 *   answers first and hides the stored name's look-alike from the override
 *   (J12 review 9's S1), and nothing reads the letterhead, so each is a STOP
 *   for a typed acknowledgement, not an override (`NameFlag`). A typed-total
 *   bid has no letterhead and is asked about its stored name. One per name
 *   key: a letterhead that normalises as the stored name joins its entry.
 * A failed read throws — the award stops.
 */
export async function awardGateFor(doc: CostDocument): Promise<AwardGate> {
  const { data: row, error } = await supabase.from("cost_documents").select("*").eq("id", doc.id).maybeSingle();
  if (error) throw new Error(userFacingReadError(error));
  const raw = (row ?? null) as Record<string, unknown> | null;
  const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const orgId = text(raw?.org_id) ?? doc.orgId;
  const companyId = text(raw?.company_id);          // absent before 20261096: no link can exist
  const partyId = raw ? text(raw.party_id) : doc.partyId;
  const vendorName = raw ? text(raw.vendor_name) : doc.vendorName;
  // The letterhead is the name the AI READ: parsed with no stored name to
  // fall back on (parsedQuoteFrom shows the stored name where the parse read
  // none), and the placeholder for "read none" is no letterhead.
  const read = parsedQuoteFrom({ ...doc, parsed: raw ? raw.parsed ?? null : doc.parsed, vendorName: null })?.vendorName ?? null;
  const letterhead = read !== UNKNOWN_VENDOR ? read : null;

  // One read of the linked company and one of the org's barred rows, shared by both questions.
  let linked: Promise<AwardFlag | null> | null = null;
  const linkedCompany = () => (linked ??= companyId ? orgCompany(companyId, orgId) : Promise.resolve(null));
  let barred: Promise<Company[]> | null = null;
  const barredRows = () => (barred ??= listBarredCompanies(orgId));

  const override = await companyAwardAnswersFor({ orgId, companyId, partyId, vendorName }, linkedCompany, barredRows);

  // The override answers for a name when it is a do-not-use row with that
  // name's key; for the stored name also when there is none (the database's
  // question over it found no look-alike).
  const overrideKey = override?.status === "do_not_use" ? normalizeCompanyName(override.name) : null;
  const storedKey = vendorName ? normalizeCompanyName(vendorName) : "";
  const letterKey = letterhead ? normalizeCompanyName(letterhead) : "";
  const asks: Array<{ name: string; onFile: boolean; letterhead: string | null }> = [];
  if (vendorName && storedKey && override && storedKey !== overrideKey) {
    asks.push({ name: vendorName, onFile: true, letterhead: letterKey === storedKey ? letterhead : null });
  }
  if (letterhead && letterKey && letterKey !== storedKey && letterKey !== overrideKey) {
    asks.push({ name: letterhead, onFile: false, letterhead });
  }
  if (!asks.length) return { override, acks: [] };
  if (companyId && (await linkedCompany())) return { override, acks: [] };
  const acks: NameFlag[] = [];
  for (const a of asks) {
    const hit = barredCompanyFor(a.name, null, await barredRows());
    if (hit && hit.id !== override?.id) {
      acks.push({ company: { id: hit.id, name: hit.name, status: hit.status }, vendorOnFile: vendorName, onFile: a.onFile, letterhead: a.letterhead });
    }
  }
  return { override, acks };
}

/** Which names of the bid an acknowledgement is for — its audit rows' `matchedOn`. */
const ackMatchedOn = (ack: NameFlag): string[] =>
  [ack.onFile ? "vendorOnFile" : null, ack.letterhead ? "letterhead" : null].filter((m): m is string => !!m);
/** "vendor-name" for the stored vendor name's look-alike (the letterhead may also be it), else "letterhead". */
const ackKind = (ack: NameFlag) => (ack.onFile ? "vendor-name" : "letterhead");
const ackSubject = (ack: NameFlag) => (ack.onFile ? `the vendor on file "${ack.vendorOnFile}"` : `the letterhead "${ack.letterhead}"`);
const ackTitle = (ack: NameFlag) => `The ${ack.onFile ? "vendor on file" : "letterhead"} could be ${ack.company.name} — flagged DO NOT USE`;
/** The vendor on file as a letterhead prompt names it: quoted, or "not set"
 *  when the stored name is empty or blank. */
const onFileShown = (ack: NameFlag) => (ack.vendorOnFile?.trim() ? `"${ack.vendorOnFile.trim()}"` : "not set");
/** The acknowledgement prompt's text: which name could be the company, why
 *  no override for it is recorded, and what to do instead. */
function ackMessage(ack: NameFlag, override: AwardFlag | null): string {
  const c = ack.company.name;
  const what = "To award it as it stands, state why — the acknowledgement is recorded against this award.";
  if (!ack.onFile) {
    return `The AI read the letterhead as "${ack.letterhead}", which could be ${c}, flagged DO NOT USE in the registry. The vendor on file is ${onFileShown(ack)}; the award is checked against that name and this bid's links, so no override for ${c} is recorded. If ${c} sent this bid, cancel and link the bidder to it; if the vendor on file did, cancel and link the bidder to that company. ${what}`;
  }
  const names = ack.letterhead
    ? `The vendor on file, "${ack.vendorOnFile}", and the letterhead the AI read, "${ack.letterhead}",`
    : `The vendor on file "${ack.vendorOnFile}"`;
  const why = override
    ? `The award's override names one company — the first flagged one it reaches through this bid's company link, its contractor and then its vendor name — and here that is ${override.name}, ${override.status === "inactive" ? "marked inactive" : "flagged do-not-use"}`
    : "The award's override does not name it";
  return `${names} could be ${c}, flagged DO NOT USE in the registry. ${why}, so no override for ${c} is recorded. If ${c} sent this bid, cancel and link the bidder to it; if another company did, cancel and link the bidder to that company. ${what}`;
}
/** The acknowledgement's line in the award's confirm (or check-the-paper prompt). */
function ackWarning(ack: NameFlag, override: AwardFlag | null): string {
  const c = ack.company.name;
  if (!ack.onFile) {
    return `The letterhead the AI read ("${ack.letterhead}") could be ${c}, flagged DO NOT USE — the vendor on file is ${onFileShown(ack)}, and your acknowledgement is recorded with this award.`;
  }
  return `The vendor on file ("${ack.vendorOnFile}")${ack.letterhead ? ` and the letterhead the AI read ("${ack.letterhead}")` : ""} could be ${c}, flagged DO NOT USE — the award's override ${override ? `names ${override.name}` : "does not name it"}, and your acknowledgement is recorded with this award.`;
}

/** MON-10 (projects Round G J14): the outcomes of a quote's notice that say
 *  nothing went wrong — told before, no contact on the link, email not set
 *  up here, a send already under way, or (a rival the award did not
 *  decline) not decided. The portal shows the outcome in every case. */
const QUIET_NOTICE_REASONS: readonly string[] = ["already", "no_contact", "not_configured", "in_progress", "undecided"];

/**
 * MON-10: tell each quote's contractor how it was decided — J12's notice
 * route (`/api/intake/outcome-notice`, `notifyQuoteOutcome`), which reads
 * the outcome from the quote's stored status and emails only the contact
 * the org entered on the quote link it came through (DEC-56), once. Only
 * quotes that came through a link are asked. Returns one sentence naming
 * the notices that failed, or null.
 */
export async function noticeQuoteOutcomes(orgId: string, docs: CostDocument[]): Promise<string | null> {
  const linked = docs.filter((d) => d.kind === "quote" && !!d.intakeLinkId);
  const answers = await Promise.all(linked.map(async (d) => ({ d, res: await notifyQuoteOutcome(orgId, d.id) })));
  const failed = answers.filter(({ res }) => !res.sent && !QUIET_NOTICE_REASONS.includes(res.reason));
  if (!failed.length) return null;
  const names = failed.map(({ d, res }) => `${d.vendorName ?? d.fileName ?? "a bidder"} (${res.sent ? "" : res.reason})`);
  return `The email telling ${failed.length === 1 ? "the bidder" : `${failed.length} bidders`} the outcome could not be sent: ${names.join(", ")} — their portal still shows it.`;
}

const QUOTE_LINK_DEFAULT_DAYS = 90;
const isoDateInDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

export default function QuotesPanel({ orgId, projectId, canManage, actor, accounts, docs, onChanged, setErr }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  accounts: CostAccount[];
  docs: CostDocument[];
  onChanged: () => void;
  setErr: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [showLinks, setShowLinks] = useState(false);
  // UX-13: the AI read's precondition, read once for the panel; the budget
  // line an award or a post needs, creatable where the need shows.
  const ai = useAiReadiness(orgId);
  const budgetLineCtx = useMemo(() => ({ orgId, projectId, actor, onCreated: onChanged }), [orgId, projectId, actor, onChanged]);
  // Known Companies registry — matched to bidders by normalised name (or
  // an explicit link) so their record (quality-manual coverage, do-not-use
  // flags) sits beside every price. A FAILED load is said out loud: an
  // empty list would silently remove the do-not-use flag from every bidder.
  // The name list is capped (listCompanies); the do-not-use flag reads the
  // org's barred rows IN FULL, so a large registry never drops it.
  const [companies, setCompanies] = useState<Company[]>([]);
  const [barredList, setBarredList] = useState<Company[]>([]);
  const [companiesState, setCompaniesState] = useState<"loading" | "ready" | "failed">("loading");
  React.useEffect(() => {
    let cancelled = false;
    setCompaniesState("loading");
    Promise.all([listCompanies(orgId), listBarredCompanies(orgId)])
      .then(([list, barred]) => { if (!cancelled) { setCompanies(list); setBarredList(barred); setCompaniesState("ready"); } })
      .catch(() => { if (!cancelled) { setCompanies([]); setBarredList([]); setCompaniesState("failed"); } });
    return () => { cancelled = true; };
  }, [orgId]);
  // Explicit registry links + read extent per row (20261096 columns), read
  // for exactly the documents this panel renders (by id, in bounded
  // chunks) — never an arbitrary subset of a large project's rows. Pre-
  // migration the columns are absent and every row reads "unknown", never
  // "complete".
  // A FAILED read is tracked (not swallowed): explicit links drive the
  // do-not-use flag, so Award waits for this read to succeed. Before
  // 20261096 the columns are absent — no link can exist yet, so that case
  // is "ready" with every extent unknown.
  const [extras, setExtras] = useState<Map<string, DocExtras>>(new Map());
  const [extrasState, setExtrasState] = useState<LoadState>("loading");
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ids = docs.map((d) => d.id);
      const parts = await Promise.all(Array.from({ length: Math.ceil(ids.length / ID_CHUNK) }, (_, i) => ids.slice(i * ID_CHUNK, (i + 1) * ID_CHUNK))
        .map((chunk) => supabase.from("cost_documents").select("id, company_id, pages_total, pages_read")
          .eq("org_id", orgId).eq("project_id", projectId).in("id", chunk)));
      if (cancelled) return;
      const error = parts.find((p) => p.error)?.error ?? null;
      if (error) {
        if (missingColumn(error)) { setExtras(new Map()); setExtrasState("ready"); } else setExtrasState("failed");
        return;
      }
      setExtras(new Map(parts.flatMap((p) => (p.data ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.id), {
        companyId: (r.company_id as string | null) ?? null,
        pagesTotal: r.pages_total == null ? null : Number(r.pages_total),
        pagesRead: r.pages_read == null ? null : Number(r.pages_read),
      }])));
      setExtrasState("ready");
    })();
    return () => { cancelled = true; };
  }, [orgId, projectId, docs]);
  // Project parties, so an upload can name the party it came from (the
  // link the company scorecard hangs off — COST-12).
  const [parties, setParties] = useState<Party[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.from("project_parties").select("id, name, company_id")
        .eq("project_id", projectId).order("name").limit(200);
      if (cancelled || error) return;
      setParties((((data ?? []) as Array<Record<string, unknown>>)).map((r) => ({
        id: String(r.id), name: String(r.name ?? ""), companyId: (r.company_id as string | null) ?? null,
      })));
    })();
    return () => { cancelled = true; };
  }, [projectId, docs]);
  // Case/whitespace variants of a group name are ONE bid field here (BID-10
  // client half); lib/costDocs keys the award's rival-decline on the exact
  // string, so the award below hands it the merged field's rivals under
  // one spelling (the server-side lower(trim) is P3's one-line limb).
  const groups = useMemo(() => mergeQuoteGroups(quoteGroups(docs)), [docs]);
  const invoices = useMemo(() => docs.filter((d) => d.kind !== "quote" && d.status !== "void"), [docs]);
  const existingGroups = useMemo(
    () => [...new Set(docs.map((d) => d.rfqGroup).filter((g): g is string => !!g))], [docs]);

  /** Bind (or unbind) a bidder to a registry row — only while the document
   *  is still open: a decided bid's link is its evidence on a company's
   *  record ("won" / "not selected") and never moves from this screen.
   *  Moving a bidder AWAY from a do-not-use company — its explicit link or
   *  a name it could be — is an override like awarding it: a typed reason
   *  is required, and the change is undone if its audit row cannot be
   *  written (MON-12). */
  const linkCompany = async (doc: CostDocument, companyId: string | null, current: Company | null) => {
    setErr(null);
    if (!isOpenDoc(doc)) { setErr("A decided bid keeps its company link — it is evidence on that company's record."); return; }
    const previousLink = extras.get(doc.id)?.companyId ?? null;
    const leavingBarred = current?.status === "do_not_use" && companyId !== current.id;
    let reason: string | null = null;
    if (leavingBarred) {
      reason = (await appPrompt({
        title: `${current!.name} is flagged DO NOT USE`,
        message: `This bidder is ${previousLink ? "linked" : "matched by name"} to a barred company${!previousLink ? " (or its name could be one)" : ""}. Linking it elsewhere removes the flag from this bid — state why; the reason is recorded.`,
        placeholder: "Reason (required)",
      }))?.trim() || null;
      if (!reason) { setErr(`Link unchanged — ${current!.name} is flagged do-not-use and no reason was given.`); return; }
    }
    const { data, error } = await supabase.from("cost_documents").update({ company_id: companyId })
      .eq("id", doc.id).eq("org_id", orgId).in("status", [...OPEN_DOC_STATUSES]).select("id");
    if (error) {
      setErr(missingColumn(error)
        ? "Linking a bidder to the registry needs migration 20261096 applied."
        : `Couldn't link the company: ${userFacingError(error)}`);
      return;
    }
    if (!data || (data as unknown[]).length === 0) { setErr("Couldn't link the company — the document was decided (awarded, not selected or voided) or removed since this table loaded. Refresh to see the latest."); return; }
    const { error: auditErr } = await supabase.from("audit_logs").insert({
      action: "COST_DOC_COMPANY_LINKED", resource_type: "cost", resource_id: doc.id,
      org_id: orgId, user_id: actor.uid, user_email: actor.email,
      details: {
        companyId, previousCompanyId: previousLink, vendor: doc.vendorName,
        ...(leavingBarred ? { overrideDoNotUse: { companyId: current!.id, company: current!.name, reason } } : {}),
      },
    });
    if (auditErr) {
      if (leavingBarred) {
        // An un-audited move away from a barred company must not stand.
        const { data: reverted, error: revertErr } = await supabase.from("cost_documents").update({ company_id: previousLink })
          .eq("id", doc.id).eq("org_id", orgId).select("id");
        const undone = !revertErr && !!reverted && (reverted as unknown[]).length > 0;
        setErr(undone
          ? `The override could not be recorded (${userFacingError(auditErr, { clause: true })}) — the link was put back.`
          : `The link changed but its override record failed (${userFacingError(auditErr, { clause: true })}) and it could not be undone (${revertErr ? userFacingError(revertErr, { clause: true }) : "no row was updated"}) — relink it by hand.`);
        if (!undone) setExtras((prev) => new Map(prev).set(doc.id, { ...(prev.get(doc.id) ?? { pagesTotal: null, pagesRead: null }), companyId }));
        return;
      }
      setErr(`The company was linked but its audit record failed: ${userFacingError(auditErr, { embed: true })}`);
    }
    setExtras((prev) => new Map(prev).set(doc.id, { ...(prev.get(doc.id) ?? { pagesTotal: null, pagesRead: null }), companyId }));
  };

  const readDoc = async (doc: CostDocument) => {
    setBusy(doc.id); setErr(null);
    try {
      const res = await fetch("/api/projects/cost-docs", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ orgId, projectId, costDocId: doc.id }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      onChanged();
    } catch (e) {
      setErr(userFacingCaughtError(e, { context: "QuotesPanel read" }));
    } finally { setBusy(null); }
  };

  /** Record a human total — and, when a currency code is typed with it,
   *  restate the document in that currency (BID-7). Guarded: only a
   *  document that is still open can be changed. */
  const saveTotal = async (doc: CostDocument, amount: number, currency: string | null): Promise<boolean> => {
    const readQuote = parsedQuoteFrom(doc);
    const rowCurrency = isoCurrency(doc.currency) ?? isoCurrency(readQuote?.currency);
    const restate = currency != null && currency !== rowCurrency;
    setBusy(doc.id);
    const res = await guardedCostDocWrite({
      doc, actor,
      patch: { total_amount: amount, ...(doc.status === "draft" ? { status: "parsed" } : {}), ...(restate ? { currency } : {}) },
      audit: {
        action: "COST_DOC_MANUAL_TOTAL",
        details: {
          total: amount, currency: currency ?? rowCurrency, previousTotal: doc.totalAmount,
          ...(readQuote ? { extractedTotal: readQuote.total } : {}),
          ...(restate ? { restatedFrom: rowCurrency } : {}),
        },
      },
    });
    setBusy(null);
    if (!res.ok) { setErr(res.error); return false; }
    if (res.auditError) setErr(`The total was saved but its audit record failed: ${res.auditError}`);
    onChanged();
    return true;
  };

  // Works for an unread scan AND a read quote whose AI total is wrong
  // (BID-9): the typed number becomes the one authoritative total; the
  // model's original stays visible on the row. A currency code typed with
  // the figure restates the bid in that currency (BID-7).
  const typeTotal = async (doc: CostDocument) => {
    const readQuote = parsedQuoteFrom(doc);
    const extracted = readQuote?.total ?? null;
    const readCur = isoCurrency(doc.currency) ?? isoCurrency(readQuote?.currency);
    const v = await appPrompt({
      title: extracted != null ? "Correct the total" : "Type the total from the paper",
      message: (
        <>
          {extracted != null
            ? `The AI read ${fmtMoney(extracted, readCur ?? "USD")} from ${doc.fileName ?? "this document"}. Enter the bottom-line total printed on the paper; it becomes the number the table scores and the award posts, and the AI's reading stays on the row for the record.`
            : `The AI couldn't read (or hasn't read) ${doc.fileName ?? "this document"}. Enter its bottom-line total and it becomes the awardable number.`}
          {" "}To restate it in another currency, type the code after the figure (e.g. 162000 USD).
          <OpenPdfButton doc={doc} setErr={setErr} />
        </>
      ),
      placeholder: "e.g. 182000 or 162000 USD",
    });
    if (!v) return;
    const typed = parseTypedAmount(String(v));
    if (typed.badCurrency) { setErr(`"${typed.badCurrency}" isn't an ISO currency code — use e.g. USD, EUR, GBP.`); return; }
    // A figure that could be read two ways ("162.000", "162 000,50", "182k")
    // is refused, never guessed: it becomes the one authoritative total.
    if (typed.problem) { setErr(`Nothing was saved — ${typed.problem}`); return; }
    if (typed.amount == null) { setErr("That didn't read as a positive number."); return; }
    await saveTotal(doc, typed.amount, typed.currency);
  };

  /** COST-13: a total from a truncated (or unknown-extent) read is typed
   *  back from the PAPER before money moves. The prompt never prints the
   *  expected figure — the point is to look at the document, not to copy
   *  the screen — and a mismatch offers to record the paper's figure as
   *  the corrected total instead (the money then waits for a fresh click). */
  // Returns the figure typed from the paper when it matches the row's total
  // (the lib requires it as `confirmedTotal` on a truncated or unknown-extent
  // read — COST-13), or null when nothing may be posted.
  const confirmFromPaper = async (doc: CostDocument, total: number, cur: string, lead: string, what: string): Promise<number | null> => {
    const typed = await appPrompt({
      title: `Check the total on the paper — ${doc.vendorName ?? doc.fileName ?? "this document"}`,
      message: (
        <>
          {lead ? `${lead} ` : ""}Open the PDF, find the bottom-line total printed on it, and type that figure to {what}.
          <OpenPdfButton doc={doc} setErr={setErr} />
        </>
      ),
      placeholder: "Total as printed on the paper",
    });
    if (typed == null) return null;
    const parsed = parseTypedAmount(String(typed));
    if (parsed.problem) { setErr(`Nothing was posted — ${parsed.problem}`); return null; }
    if (parsed.amount == null) { setErr("That didn't read as a number — nothing was posted."); return null; }
    if (Math.round(parsed.amount) === Math.round(total) && (!parsed.currency || parsed.currency === cur)) return parsed.amount;
    const paper = fmtMoney(parsed.amount, parsed.currency ?? cur);
    const fix = await appConfirm({
      message: `The figure you typed (${paper}) doesn't match this row's total. Record ${paper} as the corrected total now? Nothing is posted — check the row, then try again.`,
      confirmLabel: "Record as corrected total",
      tone: "danger",
    });
    if (fix) await saveTotal(doc, parsed.amount, parsed.currency);
    else setErr("Nothing was posted — the figure typed from the paper didn't match this row's total.");
    return null;
  };

  return (
    <AiReadinessContext.Provider value={ai}>
    <BudgetLineContext.Provider value={budgetLineCtx}>
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <ScanSearch className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Quotes &amp; bid tabulation</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">
          Drop bidders&apos; quote PDFs — the system reads them and compares price, manpower, and scope.
        </span>
        {canManage && (
          <button onClick={() => setShowLinks((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
            <Link2 className="w-3 h-3" /> Quote links for contractors
          </button>
        )}
      </div>

      {showLinks && canManage && (
        <QuoteLinksSection orgId={orgId} projectId={projectId} actor={actor} existingGroups={existingGroups} setErr={setErr} />
      )}

      {(companiesState === "failed" || extrasState === "failed") && (
        <div role="alert" className="px-4 py-2 border-b border-amber-500/40 bg-amber-500/[0.07] text-[11px] font-bold text-amber-800 dark:text-amber-300 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {companiesState === "failed" ? "The Known Companies registry" : "This project's bidder-to-company links"} couldn&apos;t be loaded — &quot;known&quot; and &quot;do not use&quot; flags may be missing from this table, so Award is withheld. Reload to try again.
        </div>
      )}

      {/* UX-13: what reading and awarding need, said before the upload — not
          discovered after the PDF, the vendor name and an AI call. */}
      {canManage && (ai.message || accounts.length === 0) && (
        <div id="quotes-ai-precondition" className="px-4 pt-2.5 flex flex-col gap-1">
          <AiPreconditionNote readiness={ai} />
          {accounts.length === 0 && <CreateBudgetLineInline label="Awarding a quote or posting an invoice" />}
        </div>
      )}

      {canManage && (
        <UploadRow orgId={orgId} projectId={projectId} actor={actor} kind="quote"
          existingGroups={existingGroups} parties={parties} onDone={onChanged} setErr={setErr} />
      )}

      {groups.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <FileText className="w-7 h-7 mx-auto text-[var(--color-text-faint)] mb-2" />
          <div className="text-sm font-bold text-[var(--color-text)]">No quotes yet</div>
          <div className="text-xs text-[var(--color-text-muted)] mt-1 max-w-lg mx-auto">
            Upload the PDFs bidders sent you (same RFQ group name = compared side by side), or send
            contractors a quote link and their submissions land here on their own.
          </div>
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {groups.map(({ group, docs: groupDocs }) => (
            <BidGroup key={group} group={group} docs={groupDocs} allDocs={docs}
              accounts={accounts} companies={companies} barredList={barredList} companiesState={companiesState} extras={extras} extrasState={extrasState}
              canManage={canManage} actor={actor} orgId={orgId}
              busy={busy} setBusy={setBusy} readDoc={readDoc} typeTotal={typeTotal} linkCompany={linkCompany}
              confirmFromPaper={confirmFromPaper} onChanged={onChanged} setErr={setErr} />
          ))}
        </div>
      )}

      {/* ── Invoices ── */}
      <div className="border-t border-[var(--color-border)]">
        <div className="px-4 py-2.5 flex items-center gap-2">
          <Receipt className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-sm font-bold text-[var(--color-text)]">Invoices</span>
          <span className="text-[10px] text-[var(--color-text-muted)]">Read → review → post as actual.</span>
        </div>
        {canManage && (
          <UploadRow orgId={orgId} projectId={projectId} actor={actor} kind="invoice"
            existingGroups={[]} parties={parties} onDone={onChanged} setErr={setErr} />
        )}
        {invoices.length === 0 ? (
          <div className="px-4 pb-4 text-[11px] italic text-[var(--color-text-faint)]">No invoices uploaded yet.</div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
            {invoices.map((doc) => (
              <li key={doc.id} className="px-4 py-2.5 flex items-center gap-2 flex-wrap text-xs">
                <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                <span className="font-bold text-[var(--color-text)] truncate">{doc.vendorName ?? doc.fileName ?? "Invoice"}</span>
                {doc.docNumber && <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{doc.docNumber}</span>}
                {doc.totalAmount != null && <span className="font-black tabular-nums text-[var(--color-text)]">{fmtMoney(doc.totalAmount, isoCurrency(doc.currency) ?? "USD")}</span>}
                <OpenPdfButton doc={doc} setErr={setErr} />
                <ReadExtentChip extras={extras.get(doc.id) ?? null} status={doc.status} />
                <StatusChip status={doc.status} />
                {canManage && doc.status === "draft" && (
                  <>
                    <ReadButton busy={busy === doc.id} onClick={() => void readDoc(doc)} />
                    <button onClick={() => void typeTotal(doc)}
                      className={`${DECISION_TARGET} text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]`}>type total</button>
                  </>
                )}
                {canManage && doc.status === "parsed" && (
                  <PostControls accounts={accounts} busy={busy === doc.id}
                    onPost={async (accountId) => {
                      // COST-13: an actual posted from a truncated (or
                      // unknown-extent) read needs the amount typed back
                      // from the paper — never copied from the screen.
                      const ext = readExtent(extras.get(doc.id)?.pagesRead, extras.get(doc.id)?.pagesTotal);
                      const total = doc.totalAmount ?? 0;
                      let confirmedTotal: number | null = null;
                      if (ext.truncated || !ext.known) {
                        const lead = `${ext.truncated ? `The AI ${ext.label}` : "The read extent of this invoice is unknown"} — the amount may come from an incomplete read.`;
                        confirmedTotal = await confirmFromPaper(doc, total, isoCurrency(doc.currency) ?? "USD", lead, "post it as an actual");
                        if (confirmedTotal == null) return;
                      }
                      setBusy(doc.id);
                      const res = await postInvoice({ doc, costAccountId: accountId, actor, confirmedTotal });
                      setBusy(null);
                      if (!res.ok) setErr(res.error ?? "Couldn't post."); else onChanged();
                    }} label="Post as actual" currency={doc.currency} costType="material" />
                )}
                {canManage && typedTotalUnread(doc) && (
                  <ReadButton busy={busy === doc.id} onClick={() => void readDoc(doc)} />
                )}
                {canManage && doc.status === "parsed" && (
                  <button onClick={() => void typeTotal(doc)} title="Correct the amount by hand"
                    className={`${DECISION_TARGET} inline-flex items-center gap-0.5 text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]`}>
                    <Pencil className="w-3 h-3" /> correct total
                  </button>
                )}
                {canManage && (doc.status === "draft" || doc.status === "parsed") && (
                  <VoidButton doc={doc} actor={actor} busy={busy === doc.id} setBusy={setBusy} onChanged={onChanged} setErr={setErr} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
    </BudgetLineContext.Provider>
    </AiReadinessContext.Provider>
  );
}

// ── One RFQ group: the tabulation ────────────────────────────────────────

function BidGroup({ group, docs: groupDocs, allDocs, accounts, companies, barredList, companiesState, extras, extrasState, canManage, actor, orgId, busy, setBusy, readDoc, typeTotal, linkCompany, confirmFromPaper, onChanged, setErr }: {
  group: string; docs: CostDocument[]; allDocs: CostDocument[];
  accounts: CostAccount[]; companies: Company[]; barredList: Company[]; companiesState: LoadState;
  extras: Map<string, DocExtras>; extrasState: LoadState;
  canManage: boolean; actor: Actor; orgId: string;
  busy: string | null; setBusy: (v: string | null) => void;
  readDoc: (d: CostDocument) => Promise<void>;
  typeTotal: (d: CostDocument) => Promise<void>;
  linkCompany: (d: CostDocument, companyId: string | null, current: Company | null) => Promise<void>;
  confirmFromPaper: (doc: CostDocument, total: number, cur: string, lead: string, what: string) => Promise<number | null>;
  onChanged: () => void; setErr: (m: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  // ONE number per bid: the row's human-visible total overlays the
  // extraction (BID-1). Typed-total bids with no readable detail join the
  // same field as price-only rows (BID-8).
  const entries = useMemo(() => {
    const out: Array<{ doc: CostDocument; quote: ParsedQuote }> = [];
    for (const d of groupDocs) {
      if (d.status === "void" || d.status === "draft") continue;
      const q = parsedQuoteFrom(d);
      if (q) out.push({ doc: d, quote: bidFromRow(d, q) });
      else if ((d.totalAmount ?? 0) > 0) {
        out.push({ doc: d, quote: priceOnlyQuote({ id: d.id, vendorName: d.vendorName ?? d.fileName ?? "Bid", total: d.totalAmount!, currency: d.currency }) });
      }
    }
    return out;
  }, [groupDocs]);
  const econ = useMemo(() => computeBidEconomics(entries.map((p) => p.quote)), [entries]);
  const scores = useMemo(() => new Map(scoreBids(econ).map((s) => [s.quoteId, s])), [econ]);
  const currency = useMemo(() => fieldCurrency(econ), [econ]);
  const awarded = groupDocs.find((d) => d.status === "awarded");
  const unread = groupDocs.filter((d) => d.status === "draft");
  const weights = effectiveWeights();
  const scoredCount = [...scores.values()].filter((s) => s.score != null).length;
  // Manpower is scored for every bid or for none (COST-5): only once at
  // least three bids in the field state plausible hours. Until then every
  // bid — typed totals included — is scored on price alone.
  const manpowerScored = [...scores.values()].some((s) => s.parts.manpower != null);
  const hasTypedTotal = econ.some((e) => e.priceOnly);
  // What stating plausible hours is worth over silence, in composite points
  // (DEC-48): the 5-point cap binds hours against hours only.
  const silenceGap = Math.round(weights.manpower * 1000) / 10;
  const notCorroborated = currency.mixed
    ? "this field mixes currencies, so no bid is scored"
    : `fewer than ${MIN_CORROBORATING_STATEMENTS} bids in this field state hours in line with one another, so nobody's manpower is scored and every bid compares on price`;
  // Award waits for the registry AND the explicit-link read: an empty or
  // failed list would silently drop the do-not-use flag (MON-12).
  const registryGate: LoadState = companiesState === "failed" || extrasState === "failed" ? "failed"
    : companiesState === "ready" && extrasState === "ready" ? "ready" : "loading";

  /** The registry row for a bid: the explicit link wins; otherwise a
   *  name match (exact, else unique normalised), shown as a suggestion the
   *  human can change. BINDING refuses ambiguity; flagging does not:
   *  `barred` is the do-not-use row the row's CHIP shows — the linked
   *  company, or ANY row the vendor name ON FILE could be (two rows
   *  normalising alike included; `doc.vendorName`, the name the database's
   *  gate reads), else a row only the letterhead the AI read could be
   *  (`letterheadOnly`) — read from the org's full barred list, never the
   *  capped name list. The chip is a display, not the award's gate, and it
   *  does not always name the company the award's prompt names: the award
   *  asks `awardGateFor` at the click, whose override also answers for the
   *  contractor's flagged company and for an inactive one (this chip reads
   *  neither), and whose acknowledgement stops (the letterhead's look-alike,
   *  and the stored name's when a flagged contractor answers first) ask for
   *  a recorded acknowledgement, never an override. */
  const registryFor = (doc: CostDocument, e: BidEconomics): { known: Company | null; bound: boolean; barred: Company | null; letterheadOnly: boolean; candidates: Company[] } => {
    const boundId = extras.get(doc.id)?.companyId ?? null;
    const flags = [...barredList, ...companies];
    if (boundId) {
      const known = companies.find((c) => c.id === boundId) ?? barredList.find((c) => c.id === boundId) ?? null;
      return { known, bound: true, barred: barredCompanyFor(null, boundId, flags), letterheadOnly: false, candidates: [] };
    }
    const onFile = barredCompanyFor(doc.vendorName, null, flags);
    const letterhead = !onFile && !e.priceOnly && e.vendorName !== doc.vendorName ? barredCompanyFor(e.vendorName, null, flags) : null;
    return {
      known: matchCompanyByName(e.vendorName, companies), bound: false,
      barred: onFile ?? letterhead, letterheadOnly: !!letterhead,
      candidates: companyCandidatesByName(e.vendorName, companies),
    };
  };

  const award = async (doc: CostDocument, accountId: string) => {
    const e = econ.find((x) => x.quoteId === doc.id);
    const total = e?.total ?? doc.totalAmount ?? parsedQuoteFrom(doc)?.total ?? 0;
    const bc = bidCurrency(e?.currency ?? doc.currency, currency);
    const cur = bc.code;
    const account = accounts.find((a) => a.id === accountId);
    const budgetCur = isoCurrency(account?.currency) ?? "USD";
    const quote = entries.find((p) => p.doc.id === doc.id)?.quote ?? null;
    const extent = readExtent(extras.get(doc.id)?.pagesRead, extras.get(doc.id)?.pagesTotal);
    const expired = quoteExpired(quote?.validUntil);

    // BID-7: a mixed field is not commensurate. A bid already in the budget
    // line's currency can be awarded; a foreign (or unprinted) one is
    // restated first — the posting-side refusal is lib/costDocs' (P3/PC-7).
    if (currency.mixed && (!bc.known || bc.code !== budgetCur)) {
      setErr(`Award stopped — this field mixes ${currency.currencies.join(" and ")} and "${account?.name ?? "the budget line"}" is kept in ${budgetCur}. ${bc.known ? `Restate this ${bc.code} bid in ${budgetCur}` : "This bid's currency isn't printed — restate it"} with "correct total" (e.g. 162000 ${budgetCur}), then award.`);
      return;
    }
    // No bid in the field prints a currency: the figure is only SHOWN as
    // USD, so it never posts into a line kept in another currency unread.
    if (!bc.known && bc.code !== budgetCur) {
      setErr(`Award stopped — this bid's currency isn't printed and "${account?.name ?? "the budget line"}" is kept in ${budgetCur}. Check the paper and restate it with "correct total" (e.g. 162000 ${budgetCur}), then award.`);
      return;
    }

    // MON-12 / COST-3: what the award must answer for is asked at the click
    // (awardGateFor — never the lists this table rendered from): the
    // OVERRIDE the award records (the database's own gate once 20261157 is
    // applied, over the stored vendor name and the row's links) and every
    // do-not-use row a name of the bid could be that the override does not
    // answer for — the letterhead's, or the stored name's behind a flagged
    // contractor (a STOP for a recorded acknowledgement, never the
    // override). A failed read stops the award.
    const ask = async (): Promise<AwardGate | null> => {
      try {
        return await awardGateFor(doc);
      } catch (err) {
        setErr(`Award stopped — the Known Companies registry couldn't be checked (${userFacingCaughtError(err, { action: "read", context: "QuotesPanel registry" }).replace(/\.$/, "")}). Reload and try again.`);
        return null;
      }
    };
    const sameFlag = (a: AwardFlag | null, b: AwardFlag | null) => (a?.id ?? null) === (b?.id ?? null) && (a?.status ?? null) === (b?.status ?? null);
    const sameAck = (a: NameFlag, b: NameFlag) =>
      a.company.id === b.company.id && a.onFile === b.onFile && a.letterhead === b.letterhead && a.vendorOnFile === b.vendorOnFile;
    const sameAcks = (a: NameFlag[], b: NameFlag[]) => a.length === b.length && a.every((x, i) => sameAck(x, b[i]));
    // The answer the reasons in hand were typed for, and those reasons.
    let held: AwardGate = { override: null, acks: [] };
    let overrideReason: string | null = null;
    let ackReasons: Array<{ ack: NameFlag; reason: string }> = [];
    /** Ask for a reason for every part of `gate` that has none yet; false
     *  when one was refused (the award stops). `moved`: the answer changed
     *  while the dialogs were open — the prompt says so. */
    const answer = async (gate: AwardGate, moved: boolean): Promise<boolean> => {
      const was = held;
      if (!gate.override) overrideReason = null;
      else if (!sameFlag(gate.override, was.override)) {
        const flag = gate.override;
        const inactive = flag.status === "inactive";
        const movedNote = !moved ? "" : was.override
          ? `This bid's company link, contractor or vendor name changed while the award was being confirmed — it answered for ${was.override.name}; the award now answers for ${flag.name}. `
          : `This bid's company link, contractor or vendor name changed while the award was being confirmed; the award now answers for ${flag.name}. `;
        overrideReason = (await appPrompt({
          title: `${flag.name} is ${inactive ? "marked INACTIVE" : "flagged DO NOT USE"}`,
          message: `${movedNote}The registry flags the company this award answers for — this bidder is linked to it, its contractor is, or its name matches it (if the name matches more than one registry record, link the bidder to the right one). To award anyway, state the reason — it is recorded against this award and the company's record.`,
          placeholder: "Override reason (required)",
        }))?.trim() || null;
        if (!overrideReason) { setErr(`Award stopped — ${flag.name} is ${inactive ? "marked inactive" : "flagged do-not-use"} and no override reason was given.`); return false; }
      }
      const kept: typeof ackReasons = [];
      for (const ack of gate.acks) {
        const prior = ackReasons.find((r) => sameAck(r.ack, ack));
        if (prior) { kept.push(prior); continue; }
        const reason = (await appPrompt({
          title: ackTitle(ack),
          message: `${moved ? "This bid's company link, contractor, vendor name or letterhead changed while the award was being confirmed. " : ""}${ackMessage(ack, gate.override)}`,
          placeholder: "Acknowledgement reason (required)",
          tone: "danger",
          required: true,
        }))?.trim() || null;
        if (!reason) { setErr(`Award stopped — ${ackSubject(ack)} could be ${ack.company.name} (flagged do-not-use) and no acknowledgement was given.`); return false; }
        kept.push({ ack, reason });
      }
      ackReasons = kept;
      held = gate;
      return true;
    };
    const first = await ask();
    if (!first || !(await answer(first, false))) return;

    const warnings = [
      ...held.acks.map((ack) => ackWarning(ack, held.override)),
      expired ? `This quote's validity date (${quote?.validUntil}) has PASSED — confirm the price with the bidder.` : null,
      extent.truncated ? `The AI ${extent.label} — the total may come from an incomplete read.` : null,
      !extent.known && quote && !quote.priceOnly ? "The read extent of this document is unknown — the total may come from an incomplete read." : null,
      quote?.totalSource === "human" && quote.extractedTotal != null ? `Total corrected by hand from the AI's ${fmtMoney(quote.extractedTotal, isoCurrency(quote.extractedCurrency) ?? cur)}.` : null,
      bc.note ? `The ${bc.note}.` : null,
      !currency.mixed && bc.known && bc.code !== budgetCur ? `This bid is in ${bc.code} but "${account?.name ?? "the budget line"}" is kept in ${budgetCur} — the commitment posts the ${bc.code} figure as-is unless you restate it first.` : null,
    ].filter((w): w is string => !!w);

    // COST-13: a truncated (or unknown-extent) read requires the total to
    // be typed back from the paper, not just clicked through.
    let confirmedTotal: number | null = null;
    if (extent.truncated || (!extent.known && quote && !quote.priceOnly)) {
      confirmedTotal = await confirmFromPaper(doc, total, cur, warnings.join(" "), `award "${group}" on "${account?.name ?? "the budget line"}"`);
      if (confirmedTotal == null) return;
    } else if (!(await appConfirm({
      // MON-10: only a GROUPED award declines its rivals (the other open bids
      // in its RFQ group); an ungrouped quote's award declines nothing, so it
      // promises nothing of the kind.
      message: `${warnings.length ? warnings.join(" ") + " " : ""}Award "${group}" to ${doc.vendorName ?? "this bidder"} for ${fmtMoney(total, cur)}? This posts a commitment on "${account?.name ?? "the budget line"}"${doc.rfqGroup?.trim()
        ? " and marks the other open bids in this RFQ group not selected."
        : ". This quote has no RFQ group, so no other bid is marked not selected — decline any that competed for this scope."}`,
      tone: warnings.length ? "danger" : undefined,
    }))) return;

    // The row's link, contractor, vendor name or letterhead may have moved
    // while the dialogs were open: ask again just before the award, and ask
    // for a reason for whatever the answer now names (a reason typed for X
    // never goes with an award that answers for Y). What can still move
    // between this read and award_quote's lock is J14's (MON-12).
    for (let tries = 0; ; tries++) {
      const again = await ask();
      if (!again) return;
      if (sameFlag(again.override, held.override) && sameAcks(again.acks, held.acks)) break;
      if (tries === 2) { setErr("Award stopped — this bid's company link, contractor, vendor name or letterhead kept changing while the award was being confirmed. Reload and try again."); return; }
      if (!(await answer(again, true))) return;
    }

    // The acknowledgements, and the override's INTENT, are
    // recorded once every confirmation has passed and BEFORE money moves
    // (fail-closed); an award that then fails closes each with an explicit
    // abandonment row. The lib records the completed override
    // (COST_DOC_AWARD_OVERRIDE) after the commitment posts, so the trail
    // reads intent → completed, or intent → abandoned; an acknowledgement
    // is followed by the award's own COST_DOC_AWARDED, or by its
    // abandonment. The acknowledgement is never the override.
    const recordIntent = async (who: { id: string; name: string }, reason: string, status: string): Promise<string | null> => {
      const { error } = await supabase.from("audit_logs").insert({
        action: "COST_DOC_AWARD_OVERRIDE_DO_NOT_USE", resource_type: "cost", resource_id: doc.id,
        org_id: orgId, user_id: actor.uid, user_email: actor.email,
        details: { companyId: who.id, company: who.name, companyStatus: status, reason, total, currency: cur, rfqGroup: group, costAccountId: accountId },
      });
      return error ? `The override could not be recorded (${userFacingError(error, { clause: true })}) — award stopped.` : null;
    };
    const acked: NameFlag[] = [];
    /** Close every recorded acknowledgement whose award did not happen; the
     *  sentence to add when a closing row could not be written. */
    const closeAck = async (why: string): Promise<string | null> => {
      const unclosed: string[] = [];
      for (const ack of acked) {
        const { error } = await supabase.from("audit_logs").insert({
          action: "COST_DOC_AWARD_LETTERHEAD_ACK_ABANDONED", resource_type: "cost", resource_id: doc.id,
          org_id: orgId, user_id: actor.uid, user_email: actor.email,
          details: { matchedOn: ackMatchedOn(ack), letterhead: ack.letterhead, vendorOnFile: ack.vendorOnFile, companyId: ack.company.id, company: ack.company.name, why },
        });
        if (error) unclosed.push(`The ${ackKind(ack)} acknowledgement for ${ack.company.name} was recorded but could not be closed: ${userFacingError(error, { embed: true })}`);
      }
      return unclosed.length ? unclosed.join("; ") : null;
    };
    for (const { ack, reason } of ackReasons) {
      const { error } = await supabase.from("audit_logs").insert({
        action: "COST_DOC_AWARD_LETTERHEAD_ACK", resource_type: "cost", resource_id: doc.id,
        org_id: orgId, user_id: actor.uid, user_email: actor.email,
        details: {
          matchedOn: ackMatchedOn(ack), letterhead: ack.letterhead, vendorOnFile: ack.vendorOnFile,
          companyId: ack.company.id, company: ack.company.name, companyStatus: ack.company.status,
          // The click gate's override — null when it asked none, even if the lib's
          // needsOverride asks one later (that intent row names its own company).
          overrideCompanyId: held.override?.id ?? null, overrideCompany: held.override?.name ?? null,
          reason, total, currency: cur, rfqGroup: group, costAccountId: accountId,
        },
      });
      if (error) {
        const failed = `The ${ackKind(ack)} acknowledgement could not be recorded (${userFacingError(error, { clause: true })}) — award stopped.`;
        const unclosed = await closeAck(failed);
        setErr(unclosed ? `${failed} (${unclosed})` : failed);
        return;
      }
      acked.push(ack);
    }
    let overridden: { id: string; name: string } | null = null;
    if (held.override && overrideReason) {
      const failed = await recordIntent(held.override, overrideReason, held.override.status);
      if (failed) {
        const unclosed = await closeAck(failed);
        setErr(unclosed ? `${failed} (${unclosed})` : failed);
        return;
      }
      overridden = { id: held.override.id, name: held.override.name };
    }

    // BID-10: every spelling of this merged field is one field, so its
    // rivals are handed to the award under one spelling and all decline.
    const siblings = alignGroupSpelling(allDocs, doc.rfqGroup);

    setBusy(doc.id);
    let failure: string | null = null;
    // MON-10: an award that posted can still carry a warning — rivals that
    // could not be marked not selected, or ungrouped quotes left open.
    let warning: string | null = null;
    try {
      // overrideReason only — the letterhead's acknowledgement is never an override reason.
      let res = await awardQuote({ doc, siblings, costAccountId: accountId, actor, overrideReason, confirmedTotal });
      // The lib found a flag this table did not (an inactive company, or a
      // registry link read differently): ask for the reason, record the
      // intent, and try once more with it. A refusal here stops the award
      // as a failed result, so a recorded acknowledgement is closed.
      if (!res.ok && res.needsOverride && !overrideReason) {
        const flag = res.needsOverride;
        setBusy(null);
        const reason = (await appPrompt({
          title: `${flag.companyName} is ${flag.status === "inactive" ? "marked INACTIVE" : "flagged DO NOT USE"}`,
          message: "The company registry flags the company behind this quote. To award anyway, state the reason — it is recorded against this award and the company's record.",
          placeholder: "Override reason (required)",
        }))?.trim() || null;
        const failed = reason ? await recordIntent({ id: flag.companyId, name: flag.companyName }, reason, flag.status) : null;
        if (!reason) res = { ok: false, error: `Award stopped — ${flag.companyName} is flagged and no override reason was given.` };
        else if (failed) res = { ok: false, error: failed };
        else {
          overridden = { id: flag.companyId, name: flag.companyName };
          setBusy(doc.id);
          res = await awardQuote({ doc, siblings, costAccountId: accountId, actor, overrideReason: reason, confirmedTotal });
        }
      }
      if (!res.ok) failure = res.error ?? "Couldn't award.";
      else warning = res.warning ?? null;
    } catch (err) {
      failure = userFacingCaughtError(err, { context: "QuotesPanel award" });
    } finally { setBusy(null); }
    // The warning is said AFTER onChanged: the tab's re-read clears its
    // banner first, so the warning is what stays on screen.
    if (failure == null) {
      onChanged();
      // MON-10: the awarded bidder and every open rival of its RFQ group
      // (the ones the award declines) are told — the route reads each
      // quote's stored status, so a rival the award did not decline is
      // skipped, and only a quote that came through a link is asked.
      const key = (g: string | null | undefined) => (g ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      const rivals = key(doc.rfqGroup)
        ? siblings.filter((d) => d.id !== doc.id && d.kind === "quote" && isOpenDoc(d) && key(d.rfqGroup) === key(doc.rfqGroup))
        : [];
      const noticeNote = await noticeQuoteOutcomes(orgId, [doc, ...rivals]);
      const said = [warning, noticeNote].filter((x): x is string => !!x).join(" ");
      if (said) setErr(said);
      return;
    }
    if (overridden) {
      const { error } = await supabase.from("audit_logs").insert({
        action: "COST_DOC_AWARD_OVERRIDE_ABANDONED", resource_type: "cost", resource_id: doc.id,
        org_id: orgId, user_id: actor.uid, user_email: actor.email,
        details: { companyId: overridden.id, company: overridden.name, why: failure },
      });
      if (error) failure = `${failure} (The do-not-use override was recorded but could not be closed: ${userFacingError(error, { embed: true })})`;
    }
    const unclosed = await closeAck(failure);
    if (unclosed) failure = `${failure} (${unclosed})`;
    setErr(failure);
  };

  /** MON-10: the explicit, audited "not selected" for a bid that competed
   *  with an award and is still open — an ungrouped quote (an ungrouped
   *  award declines nothing on its own, DEC-50 rule 8, and the award's
   *  warning names the quotes left open), or any open quote in a group that
   *  already holds an award (a grouped rival whose automatic decline failed
   *  — the warning says to decline it by hand — or a second quote that
   *  tabulates under the same "Ungrouped — <vendor>" heading). The reason is
   *  optional and recorded. */
  const decline = async (doc: CostDocument) => {
    const reason = await appPrompt({
      title: `Decline ${doc.vendorName ?? doc.fileName ?? "this quote"}?`,
      message: "It is marked not selected — the contractor's portal shows that — and it can no longer be awarded. A reason (optional) is recorded with it.",
      placeholder: "Reason (optional) — e.g. awarded to another bidder",
      confirmLabel: "Decline",
    });
    if (reason == null) return;
    setBusy(doc.id); setErr(null);
    let failure: string | null = null;
    try {
      const res = await declineQuote({ doc, actor, reason: reason.trim() || null });
      if (!res.ok) failure = res.error ?? "Couldn't decline the quote.";
    } catch (err) {
      failure = userFacingCaughtError(err, { context: "QuotesPanel decline" });
    } finally { setBusy(null); }
    if (failure) { setErr(failure); return; }
    onChanged();
    // MON-10: the declined bidder is told, when its quote came through a link.
    const noticeNote = await noticeQuoteOutcomes(orgId, [doc]);
    if (noticeNote) setErr(noticeNote);
  };

  // MON-10: who is declined by hand — an open UNGROUPED quote (an award
  // declines only its own RFQ group, DEC-50 rule 8), and ANY open quote once
  // its group holds an award (a grouped rival whose automatic decline
  // failed, or a second quote under the same "Ungrouped — <vendor>"
  // heading). Gated apart from the award (rowActions): the award's warning
  // is what sends the user here.
  const mayDecline = (d: CostDocument) =>
    canManage && d.kind === "quote" && (d.status === "parsed" || d.status === "draft") && (!d.rfqGroup?.trim() || !!awarded);
  // MON-10: the actions column stays while an awarded group still has a row
  // with an action — a declined bid keeps its Void, an open quote its
  // Decline and Void. Award and correct-total stay award-gated (rowActions).
  const showActions = canManage && (!awarded || entries.some(({ doc: d }) => d.status === "declined" || mayDecline(d)));
  const colCount = 7 + (showActions ? 1 : 0);

  return (
    <div>
      <button onClick={() => setOpen((v) => !v)} className="w-full px-4 py-2.5 flex items-center gap-2 text-left hover:bg-[var(--color-surface-2)]/40 transition-colors">
        {open ? <ChevronDown className="w-4 h-4 text-[var(--color-text-faint)]" /> : <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)]" />}
        <span className="text-xs font-black text-[var(--color-text)]">{group}</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">{groupDocs.length} bid{groupDocs.length === 1 ? "" : "s"}</span>
        {awarded && (
          <span className="inline-flex items-center gap-1 text-[10px] font-black text-emerald-700 dark:text-emerald-300">
            <Trophy className="w-3 h-3" /> Awarded to {awarded.vendorName ?? "vendor"}
          </span>
        )}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-2">
          {unread.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap text-[11px] text-[var(--color-text-muted)]">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
              {unread.length} quote{unread.length === 1 ? "" : "s"} not read yet:
              {unread.map((d) => (
                <span key={d.id} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] px-2 py-1">
                  <span className="font-bold text-[var(--color-text)] max-w-40 truncate">{d.vendorName ?? d.fileName}</span>
                  <OpenPdfButton doc={d} setErr={setErr} />
                  {canManage && <ReadButton busy={busy === d.id} onClick={() => void readDoc(d)} />}
                  {canManage && <button onClick={() => void typeTotal(d)} className={`${DECISION_TARGET} text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]`}>type total</button>}
                  {/* MON-10: an unread quote the award's warning names is declined here — no read first. */}
                  {mayDecline(d) && (
                    <button onClick={() => void decline(d)} disabled={busy === d.id}
                      title="Mark this bid not selected — for a quote that competed with one awarded elsewhere. Audited; the contractor's portal shows it."
                      className={`${DECISION_TARGET} inline-flex items-center gap-0.5 text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50`}>
                      <XIcon className="w-3 h-3" /> decline
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}

          {currency.mixed && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/[0.07] px-3 py-2 text-[11px] font-bold text-amber-800 dark:text-amber-300">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>This field mixes {currency.currencies.join(" and ")}. Each price is shown in its own currency and the bids are NOT ranked against each other. Award a bid already in the budget line&apos;s currency, or restate a foreign bid first: &quot;correct total&quot; with the currency code (e.g. 162000 USD).</span>
            </div>
          )}

          {econ.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[9px] font-black uppercase tracking-wider text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                    <th className="px-3 py-2">Bidder</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right" title="Labor hours the bid offers — bidder-stated, AI-extracted">Labor hrs</th>
                    <th className="px-3 py-2 text-right" title="Total price ÷ labor hours — lower buys more hands">Price / hr</th>
                    <th className="px-3 py-2 text-right" title="Largest crew size stated">Peak crew</th>
                    <th className="px-3 py-2" title="Quote validity date as printed">Valid until</th>
                    <th className="px-3 py-2 text-right" title={`${manpowerScored
                      ? `Value score = ${Math.round(weights.price * 100)}% price + ${Math.round(weights.manpower * 100)}% manpower (between bids that state plausible hours, at most ${MANPOWER_MAX_COMPOSITE_SWING} points apart on manpower; a bid stating none scores 0 there).`
                      : currency.mixed ? "Not ranked — this field mixes currencies." : `Value score = price alone here — ${notCorroborated}.`} Scope coverage is not scored — exclusions and check prompts are shown for your judgement.`}>Value score</th>
                    {showActions && <th className="px-3 py-2" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {econ.map((e) => {
                    const s = scores.get(e.quoteId);
                    const doc = groupDocs.find((d) => d.id === e.quoteId);
                    const quote = entries.find((p) => p.doc.id === e.quoteId)?.quote;
                    const isAwarded = doc?.status === "awarded";
                    const isDeclined = doc?.status === "declined";
                    const bc = bidCurrency(e.currency, currency);
                    const cur = bc.code;
                    const { known, bound, barred, letterheadOnly, candidates } = doc ? registryFor(doc, e) : { known: null, bound: false, barred: null, letterheadOnly: false, candidates: [] as Company[] };
                    const qmExtent = known ? readExtent(known.qualityManualPagesRead, known.qualityManualPagesTotal) : null;
                    const ext = doc ? extras.get(doc.id) ?? null : null;
                    const expired = quoteExpired(quote?.validUntil);
                    const rowActions = doc && canManage && !awarded && (doc.status === "parsed" || doc.status === "draft");
                    const rowDecline = doc && mayDecline(doc);
                    const totalNote = quote ? quoteTotalNote(quote) : null;
                    return (
                      <React.Fragment key={e.quoteId}>
                        <tr className={isAwarded ? "bg-emerald-500/[0.05]" : isDeclined ? "opacity-55" : undefined}>
                          <td className="px-3 py-2">
                            <span className="font-bold text-[var(--color-text)]">{e.vendorName}</span>
                            {doc && <OpenPdfButton doc={doc} setErr={setErr} />}
                            {known && (
                              <Link href={`/companies/${known.id}`}
                                className="ml-1.5 inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent-ring)] transition-colors"
                                title={`${bound ? "Linked to this Known Companies record — open it" : `Matched to "${known.name}" by name — use "change" if that is wrong`}${known.qualityManualScore != null && qmExtent ? ` · quality manual ${Math.round(known.qualityManualScore)}% coverage, ${qmExtent.label}` : ""}`}
                                onClick={(ev) => ev.stopPropagation()}>
                                {bound ? "known" : `matched to ${known.name}`}{known.qualityManualScore != null ? ` · QM ${Math.round(known.qualityManualScore)}%${qmExtent && (!qmExtent.known || qmExtent.truncated) ? ` (${qmExtent.label})` : ""}` : ""}
                              </Link>
                            )}
                            {barred && (
                              <span className="ml-1.5 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-rose-500/50 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                                title={letterheadOnly
                                  ? `The letterhead the AI read ("${e.vendorName}") could be "${barred.name}", flagged DO NOT USE in the registry. The award's override is checked against the vendor name on file${doc?.vendorName ? ` ("${doc.vendorName}")` : " (none yet)"}, which no barred record matches — so Award stops for a typed acknowledgement, recorded with the award. If ${barred.name} sent this bid, link the bidder to it; if the vendor on file did, link the bidder to that company.`
                                  : barred.id === known?.id
                                  ? "Flagged in the registry — an award needs a typed, recorded override"
                                  : `This bidder's name could be "${barred.name}", flagged DO NOT USE in the registry — link the bidder to the right record; until then an award needs a typed, recorded override`}>
                                {letterheadOnly ? `letterhead: do not use? · ${barred.name}` : barred.id === known?.id ? "do not use" : `do not use? · ${barred.name}`}
                              </span>
                            )}
                            {!bound && !known && candidates.length > 1 && (
                              <span className="ml-1.5 text-[9px] font-bold text-amber-700 dark:text-amber-300"
                                title={`The name matches ${candidates.map((c) => `"${c.name}"`).join(", ")} in the registry — nothing binds automatically; pick the right one`}>
                                ambiguous — link to registry
                              </span>
                            )}
                            {known?.status === "inactive" && (
                              <span className="ml-1.5 text-[9px] font-bold uppercase text-[var(--color-text-faint)]">inactive</span>
                            )}
                            {!known && companiesState === "failed" && (
                              <span className="ml-1.5 text-[9px] font-bold text-amber-700 dark:text-amber-300" title="The registry failed to load — flags unknown">registry unavailable</span>
                            )}
                            {doc && canManage && companiesState === "ready" && isOpenDoc(doc) && (
                              <CompanyPicker companies={companies} value={ext?.companyId ?? null} suggestion={!bound ? known : null}
                                onChange={(id) => void linkCompany(doc, id, barred ?? known)} />
                            )}
                            {s?.best && !awarded && (
                              <span className="ml-1.5 text-[9px] font-black uppercase text-[var(--color-accent)]"
                                title={`Highest value score on ${manpowerScored ? "price and manpower" : "price alone (manpower isn't scored in this field)"} — not automatically the winner; you decide.${e.exclusionCount > 0 ? ` This bid EXCLUDES ${e.exclusionCount} item${e.exclusionCount === 1 ? "" : "s"} — scope you must buy elsewhere is not priced into the score.` : ""}`}>best value</span>
                            )}
                            {s?.tied && !awarded && (
                              <span className="ml-1.5 text-[9px] font-black uppercase text-[var(--color-text-muted)]" title="Shares the top value score — no bid is badged; you decide.">tied</span>
                            )}
                            {isAwarded && <span className="ml-1.5 inline-flex items-center gap-0.5 text-[9px] font-black uppercase text-emerald-700 dark:text-emerald-300"><Trophy className="w-2.5 h-2.5" /> awarded</span>}
                            {isDeclined && <span className="ml-1.5 text-[9px] font-bold uppercase text-[var(--color-text-faint)]">not selected</span>}
                          </td>
                          <td className="px-3 py-2 text-right font-black tabular-nums text-[var(--color-text)]">
                            {fmtMoney(e.total, cur)}
                            {e.totalSource === "human" && (
                              <div className="text-[9px] font-bold text-amber-700 dark:text-amber-300" title="A human corrected this total; the AI's reading is kept for the record">
                                corrected{e.extractedTotal != null ? ` · AI read ${fmtMoney(e.extractedTotal, e.extractedCurrency ?? cur)}` : ""}
                              </div>
                            )}
                            {bc.note && (
                              <div className="text-[9px] font-bold text-amber-700 dark:text-amber-300" title="The quote prints no currency — restate it with a currency code (correct total) if the assumption is wrong">{bc.note}</div>
                            )}
                            {/* PR-2: the lines do not add up to the total — a flag, never a block (the full sentence is under the row). */}
                            {totalNote && (
                              <div className="text-[9px] font-bold text-amber-700 dark:text-amber-300" title={totalNote}>lines ≠ total — check the PDF</div>
                            )}
                            {e.priceOnly && (
                              <div className="text-[9px] font-bold text-[var(--color-text-muted)]" title={manpowerScored
                                ? "The AI couldn't read line detail from this file — price only: not scored on manpower, so it carries no value score while this field scores manpower (its price still sets every rival's price part)."
                                : currency.mixed
                                  ? "The AI couldn't read line detail from this file — a typed total, shown in its own currency."
                                  : "The AI couldn't read line detail from this file — this field compares every bid on price alone, so it is scored and ranked like the others."}>typed total — price only</div>
                            )}
                            {/* COST-15: a total typed before any read can still have its
                                line items read — the extraction lands BESIDE the typed
                                total, which stays the scored and awarded number (a
                                differing read shows as "AI read …"). */}
                            {doc && canManage && !awarded && typedTotalUnread(doc) && (
                              <div className="mt-0.5"><ReadButton busy={busy === doc.id} onClick={() => void readDoc(doc)} /></div>
                            )}
                            <ReadExtentChip extras={ext} status={doc?.status ?? "parsed"} />
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {e.priceOnly ? <span className="text-[var(--color-text-faint)]">not scored</span>
                              : e.laborHours > 0 ? (
                                <span title={manpowerScored ? "Bidder-stated, AI-extracted" : `Bidder-stated, AI-extracted — shown, not scored: ${notCorroborated}.`}>
                                  {e.laborHours.toLocaleString()}
                                  {e.implausibleHours && (
                                    <span className="block text-[9px] font-bold text-amber-700 dark:text-amber-300"
                                      title={`${e.implausibleHours}. ${manpowerScored ? "Scored as not stated (manpower 0)" : "Not scored"} — check the hours against the PDF.`}>
                                      implausible hours — check
                                    </span>
                                  )}
                                </span>
                              )
                              : <span className="text-[var(--color-text-faint)]" title={manpowerScored
                                ? `This bid doesn't state labor hours — its manpower part is 0 (the RFQ asks for hours), so a bid that states plausible hours can score up to ${silenceGap} points higher on that alone.`
                                : `This bid doesn't state labor hours. Manpower isn't scored in this field — ${notCorroborated}.`}>not stated</span>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{e.priceOnly ? <span className="text-[var(--color-text-faint)]">not scored</span> : e.dollarsPerHour != null ? fmtMoney(e.dollarsPerHour, cur) : "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{e.priceOnly ? <span className="text-[var(--color-text-faint)]">—</span> : e.peakHeadcount ?? "—"}</td>
                          <td className="px-3 py-2 tabular-nums">
                            {quote?.validUntil
                              ? <span className={expired ? "font-black text-rose-700 dark:text-rose-300" : ""} title={expired ? "This quote's validity date has passed" : "Bidder-stated validity date"}>{quote.validUntil}{expired ? " · expired" : ""}</span>
                              : <span className="text-[var(--color-text-faint)]">—</span>}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {s && s.score != null && (
                              <span className="font-black tabular-nums text-[var(--color-text)]" title={s.parts.manpower != null
                                ? `Price ${s.parts.price} · Manpower ${s.parts.manpower} (each 0–100 vs the field) · Coverage not scored`
                                : `Price ${s.parts.price} (0–100 vs the field) · Manpower not scored — ${notCorroborated} · Coverage not scored`}>
                                {s.score}
                              </span>
                            )}
                            {s && s.score == null && (
                              <span className="text-[10px] text-[var(--color-text-faint)]" title={s.unscored === "mixed-currency" ? "Mixed-currency field — not ranked" : `Price only — not scored on manpower: this field scores manpower and a typed total has no hours to score. Price ${s.parts.price} (0–100 vs the field).`}>
                                {s.unscored === "mixed-currency" ? "not ranked" : "not scored"}
                              </span>
                            )}
                          </td>
                          {showActions && (
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              {rowActions && registryGate === "ready" && (
                                <PostControls accounts={accounts} busy={busy === doc.id}
                                  onPost={(accountId) => award(doc, accountId)} label="Award" currency={doc.currency} />
                              )}
                              {rowActions && registryGate === "loading" && (
                                <span className="text-[10px] text-[var(--color-text-muted)]" title="Award waits until the Known Companies registry and this bid's company link have loaded — the do-not-use check needs both">checking the registry…</span>
                              )}
                              {rowActions && registryGate === "failed" && (
                                <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300" title="The registry or the company links failed to load — a do-not-use flag could be missing, so Award is withheld. Reload the page.">registry unavailable — reload to award</span>
                              )}
                              {rowActions && (
                                <button onClick={() => void typeTotal(doc)} title="Correct the total by hand — the AI's reading stays on the record"
                                  className={`${DECISION_TARGET} ml-2 inline-flex items-center gap-0.5 text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]`}>
                                  <Pencil className="w-3 h-3" /> correct total
                                </button>
                              )}
                              {/* MON-10: declined by hand — an ungrouped bid (an award declines only its own RFQ group), or any bid still open in an awarded group. */}
                              {rowDecline && (
                                <button onClick={() => void decline(doc)} disabled={busy === doc.id}
                                  title="Mark this bid not selected — for a quote that competed with one awarded elsewhere. Audited; the contractor's portal shows it."
                                  className={`${DECISION_TARGET} ml-2 inline-flex items-center gap-0.5 text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50`}>
                                  <XIcon className="w-3 h-3" /> Decline
                                </button>
                              )}
                              {(rowActions || rowDecline) && (
                                <VoidButton doc={doc} actor={actor} busy={busy === doc.id} setBusy={setBusy} onChanged={onChanged} setErr={setErr} />
                              )}
                              {/* MON-10 / MON-3: a declined bid moved no money — it can still be voided (junk, or declined in error). */}
                              {doc && canManage && doc.status === "declined" && (
                                <VoidButton doc={doc} actor={actor} busy={busy === doc.id} setBusy={setBusy} onChanged={onChanged} setErr={setErr} />
                              )}
                            </td>
                          )}
                        </tr>
                        {((quote?.exclusions.length ?? 0) > 0 || e.missingScope.length > 0 || quote?.notes || totalNote) && (
                          <tr className={isDeclined ? "opacity-55" : undefined}>
                            <td colSpan={colCount} className="px-3 pb-2 pt-0">
                              <div className="flex flex-wrap gap-1">
                                {totalNote && (
                                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/[0.07] text-amber-800 dark:text-amber-300" title="The priced lines read from this quote do not add up to its total — flagged for your check, never corrected or blocked">
                                    total check: {totalNote}
                                  </span>
                                )}
                                {quote?.notes && (
                                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-sky-500/40 bg-sky-500/[0.07] text-sky-800 dark:text-sky-300" title="Bidder's note printed on the quote">
                                    note: {quote.notes}
                                  </span>
                                )}
                                {quote?.exclusions.map((x) => (
                                  <span key={x} className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/[0.07] text-amber-800 dark:text-amber-300" title="Scope this bid explicitly does NOT include — declared, so it never lowers the score; it is scope you must buy elsewhere">
                                    excludes: {x}
                                  </span>
                                ))}
                                {e.missingScope.slice(0, 4).map((x) => (
                                  <span key={x} className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-[var(--color-border-strong)] text-[var(--color-text-muted)]" title="Another bidder priced this and this bid's wording doesn't obviously cover it — check the PDF. A prompt, not a finding; it does not affect the score.">
                                    check: {x}
                                  </span>
                                ))}
                                {e.missingScope.length > 4 && (
                                  <span className="text-[9px] font-bold text-[var(--color-text-muted)]">+{e.missingScope.length - 4} more to check</span>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {econ.length > 0 && (
            <div className="text-[10px] text-[var(--color-text-muted)]">
              {currency.mixed ? (
                <>This field mixes currencies, so no bid is scored or ranked — each price is shown in its own currency.</>
              ) : manpowerScored ? (
                <>Value score = {Math.round(weights.price * 100)}% price + {Math.round(weights.manpower * 100)}% manpower-for-the-money, each measured against this field; labor hours are bidder-stated and AI-extracted and, between bids that state plausible hours, move the score by at most {MANPOWER_MAX_COMPOSITE_SWING} points — a bid that states none scores 0 on manpower, up to {silenceGap} points below one that does. A bid whose price per stated hour is more than {HOURS_PLAUSIBILITY_RATIO}× off this field&apos;s median is flagged and scored as not stated.{hasTypedTotal ? " A typed-total bid (price only) has no hours, so it is not scored on manpower and carries no value score here — its price still counts against every rival's." : ""}</>
              ) : (
                <>Value score = price alone: labor hours are bidder-stated and AI-extracted, and are scored only once at least {MIN_CORROBORATING_STATEMENTS} bids in the field state hours in line with one another — here fewer do, so the hours are shown, nobody&apos;s manpower is scored, and every bid{hasTypedTotal ? " — typed totals included —" : ""} is scored on price.</>
              )}
              {" "}Scope coverage is not scored: declared exclusions never lower a score (as the RFQ letter promises) and &quot;check&quot; prompts are for you to verify against the PDF.
              {scoredCount < 2 ? " With fewer than two scored bids there is no field to rank, so no bid is badged." : manpowerScored ? " The cheapest bid doesn't automatically win — manpower counts too, and the exclusions are yours to weigh. You make the call." : " On price alone the cheapest bid ranks first — its exclusions and check prompts are yours to weigh. You make the call."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────

function StatusChip({ status }: { status: CostDocument["status"] }) {
  const tone = status === "awarded" || status === "posted"
    ? "border-emerald-500/40 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300"
    : status === "parsed" ? "border-sky-500/40 bg-sky-500/[0.07] text-sky-700 dark:text-sky-300"
    : status === "declined" || status === "void" ? "border-[var(--color-border)] text-[var(--color-text-faint)]"
    : "border-amber-500/40 bg-amber-500/[0.07] text-amber-700 dark:text-amber-300";
  return (
    <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${tone}`}>
      {costDocStatusLabel(status)}
    </span>
  );
}

/** Every row opens its source PDF (BID-2) through the existing presigned
 *  download path — no new egress. Works for read and typed-total rows. */
function OpenPdfButton({ doc, setErr }: { doc: CostDocument; setErr: (m: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  if (!doc.fileUrl) return <span className="ml-1.5 text-[9px] text-[var(--color-text-faint)]" title="No stored file on this row">no file</span>;
  return (
    <button type="button" disabled={busy}
      onClick={async (ev) => {
        ev.stopPropagation();
        setBusy(true);
        try {
          const url = await getFileUrl(doc.fileUrl!);
          window.open(url, "_blank", "noopener,noreferrer");
        } catch (e) {
          setErr(`Couldn't open ${doc.fileName ?? "the PDF"}: ${userFacingCaughtError(e, { action: "read", context: "QuotesPanel PDF" })}`);
        } finally { setBusy(false); }
      }}
      title={`Open ${doc.fileName ?? "the source PDF"} — review the paper before you award on the number`}
      className="ml-1.5 inline-flex items-center gap-0.5 text-[9px] font-bold text-[var(--color-accent)] hover:underline disabled:opacity-50">
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <ExternalLink className="w-3 h-3" />} PDF
    </button>
  );
}

/** "read pages 1–8 of N" beside a partially read document (COST-13). */
function ReadExtentChip({ extras, status }: { extras: DocExtras | null; status: CostDocument["status"] }) {
  if (status === "draft") return null;
  const ext = readExtent(extras?.pagesRead, extras?.pagesTotal);
  if (ext.known && !ext.truncated) return null;
  return (
    <span className={`ml-1.5 inline-flex items-center gap-0.5 text-[9px] font-bold ${ext.truncated ? "text-amber-700 dark:text-amber-300" : "text-[var(--color-text-faint)]"}`}
      title={ext.truncated ? "The AI did not see every page — the total may be incomplete. Open the PDF and check the last pages." : "Recorded before the read extent was tracked — how many pages the AI saw is unknown."}>
      <AlertTriangle className="w-3 h-3" /> {ext.label}
    </span>
  );
}

/** Bind a bidder to a registry company explicitly (BID-12 / COST-3). The
 *  suggestion (normalised-name match) is shown as the default and can be
 *  changed; nothing binds on its own. */
function CompanyPicker({ companies, value, suggestion, onChange }: {
  companies: Company[]; value: string | null; suggestion: Company | null; onChange: (id: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button type="button" onClick={(ev) => { ev.stopPropagation(); setEditing(true); }}
        className="ml-1 text-[9px] font-bold text-[var(--color-text-faint)] hover:text-[var(--color-accent)]"
        title="Link this bidder to a Known Companies record">
        {value ? "change" : suggestion ? "change" : "link to registry"}
      </button>
    );
  }
  return (
    <select autoFocus value={value ?? ""} aria-label="Registry company for this bidder"
      onChange={(ev) => { onChange(ev.target.value || null); setEditing(false); }}
      onBlur={() => setEditing(false)}
      onClick={(ev) => ev.stopPropagation()}
      className="ml-1 h-5 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1 text-[10px] max-w-44">
      <option value="">— not linked —</option>
      {companies.map((c) => (
        <option key={c.id} value={c.id}>{c.name}{c.status === "do_not_use" ? " (do not use)" : ""}{suggestion?.id === c.id ? " (name match)" : ""}</option>
      ))}
    </select>
  );
}

/** PR-2 (DEC-72 item 5): what the reviewer is told when a bid's priced lines
 *  do not add up to its total — a flag beside the number, never a block.
 *  The stored check describes the EXTRACTION (the total the AI read against
 *  the lines it read); once a person restated the total, the number on
 *  screen is reconciled instead (lib/bidTab reconcileQuoteTotal) — never the
 *  stored note beside a corrected total. A total restated into ANOTHER
 *  currency is not compared with the lines at all: they stay in the currency
 *  the AI read, so any sum would be a false mismatch. Only a relabel (the
 *  same figure, the currency corrected) keeps the extraction's own check —
 *  the lines and the total are still the numbers printed together. A
 *  price-only bid has no lines. */
export function quoteTotalNote(q: ParsedQuote): string | null {
  if (q.priceOnly) return null;
  if (q.totalSource === "human") {
    const shown = isoCurrency(q.currency);
    const read = isoCurrency(q.extractedCurrency);
    if (shown != null && read != null && shown !== read) {
      return q.total === q.extractedTotal && q.totalCheck?.mismatch ? q.totalCheck.note : null;
    }
    const onScreen = reconcileQuoteTotal(q.total, q.lineItems);
    return onScreen?.mismatch ? onScreen.note : null;
  }
  return q.totalCheck?.mismatch ? q.totalCheck.note : null;
}

/** COST-15: a document whose total was typed before any read — `parsed`
 *  with no extraction. The route reads it and saves the extraction beside
 *  the typed total (never replacing it). */
function typedTotalUnread(doc: CostDocument): boolean {
  return doc.status === "parsed" && doc.parsed == null;
}

/** ONE number per bid (BID-1): the row's human-visible total overlays the
 *  extraction. COST-15: a read saved BESIDE a total typed before any read
 *  leaves the row's currency as the person left it — and a row with no
 *  currency whose extraction names one is exactly that case (an ordinary
 *  read writes its currency to the row, a correction keeps or restates it).
 *  The typed figure's currency stays UNKNOWN, as it was before the read and
 *  as posting sees it: the read's currency never becomes the bid's, and the
 *  read stays on the bid as what the AI read. */
function bidFromRow(d: CostDocument, q: ParsedQuote): ParsedQuote {
  const bid = withHumanTotal(q, d.totalAmount, d.currency);
  const readCurrency = isoCurrency(q.currency);
  if (isoCurrency(d.currency) != null || readCurrency == null || !((d.totalAmount ?? 0) > 0)) return bid;
  return {
    ...bid, total: d.totalAmount!, currency: null, totalSource: "human",
    extractedTotal: bid.extractedTotal ?? q.total, extractedCurrency: bid.extractedCurrency ?? readCurrency,
  };
}

/** UX-13: the panel's AI readiness, read once for every Read button in it. */
const AiReadinessContext = React.createContext<ReturnType<typeof useAiReadiness> | null>(null);
/** UX-13: what the "needs a budget line" fix-in-place needs to create one. */
const BudgetLineContext = React.createContext<{ orgId: string; projectId: string; actor: Actor; onCreated: () => void } | null>(null);

function ReadButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  const ai = React.useContext(AiReadinessContext);
  const blocked = !!ai && aiBlocked(ai);
  return (
    <button onClick={onClick} disabled={busy || blocked} aria-describedby={blocked ? "quotes-ai-precondition" : undefined}
      className={`${DECISION_TARGET} inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[10px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors`}
      title="AI reads the printed pages into numbers — on your own AI key. You review before anything posts.">
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} Read
    </button>
  );
}

function PostControls({ accounts, busy, onPost, label, currency, costType }: {
  accounts: CostAccount[]; busy: boolean;
  onPost: (accountId: string) => void | Promise<void>; label: string;
  /** The document's currency and the cost type its line should carry — the
   *  in-place budget line is made to take this post (COST-15 refuses a
   *  line in another currency). */
  currency?: string | null; costType?: string;
}) {
  const [picked, setAccountId] = useState("");
  // A single line is the obvious target — also once it was just created here.
  const accountId = picked || (accounts.length === 1 ? accounts[0].id : "");
  if (accounts.length === 0) return <CreateBudgetLineInline label={label} currency={currency} costType={costType} />;
  return (
    <span className="inline-flex items-center gap-2">
      <select value={accountId} onChange={(e) => setAccountId(e.target.value)}
        className="h-6 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1 text-[10px] max-w-36">
        <option value="">Budget line…</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.code ? `${a.code} ` : ""}{a.name}</option>)}
      </select>
      <button onClick={() => accountId && void onPost(accountId)} disabled={busy || !accountId}
        className={`${DECISION_TARGET} inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[10px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors`}>
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />} {label}
      </button>
    </span>
  );
}

/** The cost types a budget line takes (the Costs tab's own list). */
const INLINE_COST_TYPES = ["labor", "material", "equipment", "subcontract", "other"] as const;

/** UX-13: "needs a budget line" offers the fix where the need is met — a
 *  name and an optional budget, created right here — instead of a hover
 *  title sending the user past the change-orders panel and back. The line
 *  is made to TAKE the post: in the document's currency (COST-15 refuses a
 *  line in another one — an account with no currency is USD) and with the
 *  cost type the caller names (a subcontract for an award; an invoice picks
 *  its own), both shown and changeable. */
function CreateBudgetLineInline({ label, currency, costType = "subcontract" }: { label: string; currency?: string | null; costType?: string }) {
  const ctx = React.useContext(BudgetLineContext);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("");
  const [cur, setCur] = useState(() => normalizeCurrency(currency) ?? "USD");
  const [type, setType] = useState(costType);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ctx) return <span className="text-[10px] text-[var(--color-text-muted)]">needs a budget line — create one in the accounts below</span>;
  if (!open) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
        {label} needs a budget line —
        <button type="button" onClick={() => setOpen(true)} className="font-black text-[var(--color-accent)] underline">Create budget line</button>
      </span>
    );
  }
  const create = async () => {
    if (!name.trim()) { setError("Name the budget line."); return; }
    const b = budget.trim() ? Number(budget.replace(/[,$\s]/g, "")) : 0;
    if (!Number.isFinite(b) || b < 0) { setError("Budget must be a non-negative number."); return; }
    const code = normalizeCurrency(cur);
    if (!code) { setError(`"${cur.trim()}" is not a currency code — use a three-letter code such as USD, CAD or EUR.`); return; }
    setSaving(true); setError(null);
    const res = await saveAccount({ orgId: ctx.orgId, projectId: ctx.projectId, patch: { name: name.trim(), budget: b, costType: type, currency: code }, actor: ctx.actor });
    setSaving(false);
    if (!res.ok) { setError(res.error ?? "Couldn't create the budget line."); return; }
    setOpen(false); setName(""); setBudget("");
    ctx.onCreated();
  };
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Budget line name" aria-label="New budget line name" autoFocus
        className="h-6 w-36 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-[10px]" />
      <input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="Budget (optional)" aria-label="New budget line budget" inputMode="decimal"
        className="h-6 w-24 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-[10px] font-mono" />
      <input value={cur} onChange={(e) => setCur(e.target.value)} aria-label="New budget line currency" maxLength={4}
        className="h-6 w-12 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-[10px] font-mono uppercase" />
      <select value={type} onChange={(e) => setType(e.target.value)} aria-label="New budget line cost type"
        className="h-6 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1 text-[10px]">
        {INLINE_COST_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <button type="button" onClick={() => void create()} disabled={saving}
        className={`${DECISION_TARGET} inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[10px] font-black disabled:opacity-50`}>
        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Create
      </button>
      <button type="button" onClick={() => { setOpen(false); setError(null); }} className="text-[10px] font-bold text-[var(--color-text-muted)]">Cancel</button>
      {error && <span role="alert" className="text-[10px] font-bold text-rose-700 dark:text-rose-300">{error}</span>}
    </span>
  );
}

function VoidButton({ doc, actor, busy, setBusy, onChanged, setErr }: {
  doc: CostDocument; actor: Actor; busy: boolean;
  setBusy: (v: string | null) => void; onChanged: () => void; setErr: (m: string | null) => void;
}) {
  return (
    <button
      onClick={async () => {
        if (!(await appConfirm({ message: `Void ${doc.fileName ?? "this document"}? It stays on the record but leaves every list.`, tone: "danger" }))) return;
        setBusy(doc.id);
        // Guarded: only a still-open document voids — never one a stale tab
        // shows as open after someone awarded or posted it (BID-9 / MON-3).
        // A DECLINED bid (MON-10) moved no money either: lib/costDocs
        // voidCostDoc admits it through the same compare-and-swap claim.
        const res: { ok: true; auditError: string | null } | { ok: false; error: string } = doc.status === "declined"
          ? await voidCostDoc({ doc, actor }).then((r) => (r.ok ? { ok: true as const, auditError: null } : { ok: false as const, error: r.error ?? "Couldn't void." }))
          : await guardedCostDocWrite({
            doc, actor, patch: { status: "void" },
            audit: { action: "COST_DOC_VOIDED", details: { fileName: doc.fileName, vendor: doc.vendorName } },
          });
        setBusy(null);
        if (!res.ok) { setErr(res.error); return; }
        if (res.auditError) setErr(`Voided, but its audit record failed: ${res.auditError}`);
        onChanged();
      }}
      disabled={busy}
      className={`${DECISION_TARGET} ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-faint)] hover:text-rose-600 dark:hover:text-rose-300 hover:bg-rose-500/10 transition-colors`}>
      <Ban className="w-3 h-3" /> Void
    </button>
  );
}

function UploadRow({ orgId, projectId, actor, kind, existingGroups, parties, onDone, setErr }: {
  orgId: string; projectId: string; actor: Actor;
  kind: "quote" | "invoice";
  existingGroups: string[];
  parties: Party[];
  onDone: () => void; setErr: (m: string | null) => void;
}) {
  const [vendor, setVendor] = useState("");
  const [group, setGroup] = useState("");
  const [partyId, setPartyId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!file) { setErr("Choose the PDF first."); return; }
    setSaving(true); setErr(null);
    const party = parties.find((p) => p.id === partyId) ?? null;
    const res = await uploadCostDoc({
      orgId, projectId, kind, file,
      vendorName: vendor || party?.name || null,
      // Case/whitespace variants snap onto the existing spelling (BID-10).
      rfqGroup: kind === "quote" ? (snapRfqGroup(group, existingGroups) || null) : null,
      partyId: party?.id ?? null,
      actor,
    });
    setSaving(false);
    if (!res.ok) { setErr(res.error ?? "Upload failed."); return; }
    setVendor(""); setGroup(""); setPartyId(""); setFile(null);
    onDone();
  };

  return (
    <div className="px-4 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface-2)]/30 flex items-center gap-2 flex-wrap">
      {/* A11Y-1: the input is visually hidden but stays in the tab order
          (sr-only, never display:none); the label shows its focus ring. */}
      <label className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--color-border-strong)] px-2.5 py-1.5 cursor-pointer hover:border-[var(--color-accent-ring)] focus-within:ring-2 focus-within:ring-[var(--color-accent-ring)] text-xs">
        <UploadCloud className="w-3.5 h-3.5 text-[var(--color-accent)]" />
        <span className="text-[var(--color-text-muted)] max-w-48 truncate">{file ? file.name : `${kind === "quote" ? "Quote" : "Invoice"} PDF…`}</span>
        <input type="file" accept=".pdf,application/pdf" className="sr-only"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Company name (or let the AI read it)"
        className="h-8 w-52 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
      {parties.length > 0 && (
        <select value={partyId} onChange={(e) => setPartyId(e.target.value)} aria-label="Contractor this document came from"
          title="Which of this project's contractors sent this — the link that lets it reach their company scorecard"
          className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs max-w-48">
          <option value="">Contractor (optional)…</option>
          {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      {kind === "quote" && (
        <>
          <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="RFQ group — the scope being bid" list="rfq-groups"
            className="h-8 w-56 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs"
            title="Quotes sharing a group name tabulate side by side." />
          <datalist id="rfq-groups">
            {existingGroups.map((g) => <option key={g} value={g} />)}
          </datalist>
        </>
      )}
      <button onClick={() => void submit()} disabled={saving || !file}
        className={`${DECISION_TARGET} h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors`}>
        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <UploadCloud className="w-3 h-3" />} Upload
      </button>
    </div>
  );
}

// ── Quote links: the contractor door for prices ──────────────────────────

interface QuoteLink {
  /** SEC-19: the full token only before 20261141; then null — the address
   *  is known only right after a mint or a re-issue (`freshUrls`). */
  id: string; token: string | null; tokenPrefix: string | null; companyName: string; rfqGroup: string | null;
  revokedAt: string | null; expiresAt: string | null; submissionCount: number;
}

function QuoteLinksSection({ orgId, projectId, actor, existingGroups, setErr }: {
  orgId: string; projectId: string; actor: Actor;
  existingGroups: string[]; setErr: (m: string | null) => void;
}) {
  const [links, setLinks] = useState<QuoteLink[] | null>(null);
  const [company, setCompany] = useState("");
  const [group, setGroup] = useState("");
  // A quote link is a bearer credential: it always expires (SEC-5 /
  // INTK-12) — 90 days by default, editable, never blank.
  const [expires, setExpires] = useState(() => isoDateInDays(QUOTE_LINK_DEFAULT_DAYS));
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /** SEC-19: link id → the address minted or re-issued in THIS session — the
   *  only time it is known (the database keeps its SHA-256, 20261141). */
  const [freshUrls, setFreshUrls] = useState<Map<string, string>>(new Map());
  const [reissuing, setReissuing] = useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    // SEC-19: the token's prefix, never the token; the plain column only
    // before 20261141.
    const read = (cred: "token_prefix" | "token") => supabase.from("project_intake_links")
      .select(`id, ${cred}, company_name, rfq_group, revoked_at, expires_at, submission_count, purpose`)
      .eq("project_id", projectId).eq("purpose", "quote")
      .order("created_at", { ascending: false });
    const { data, error } = await firstReadWithColumns<Array<Record<string, unknown>>>([() => read("token_prefix"), () => read("token")]);
    if (error) { setLinks([]); return; } // pre-migration: purpose column absent
    setLinks((((data ?? []) as Array<Record<string, unknown>>)).map((r) => ({
      id: String(r.id), token: linkCredentialView(r).token, tokenPrefix: linkCredentialView(r).prefix,
      companyName: String(r.company_name ?? ""),
      rfqGroup: (r.rfq_group as string | null) ?? null,
      revokedAt: (r.revoked_at as string | null) ?? null,
      expiresAt: (r.expires_at as string | null) ?? null,
      submissionCount: Number(r.submission_count ?? 0),
    })));
  }, [projectId]);
  React.useEffect(() => { void refresh(); }, [refresh]);
  // A typed group snaps onto an existing spelling — the documents' groups
  // AND the groups existing links already carry (BID-10): two links minted
  // before any quote arrives must never split one field.
  const snapTargets = useMemo(
    () => [...new Set([...existingGroups, ...(links ?? []).map((l) => l.rfqGroup).filter((g): g is string => !!g)])],
    [existingGroups, links]);

  const create = async () => {
    if (!company.trim()) { setErr("Name the company the link is for."); return; }
    const expiresAt = expires ? new Date(`${expires}T23:59:59`) : null;
    if (!expiresAt || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      setErr("Give the link an expiry date in the future — a quote link never lives forever."); return;
    }
    setSaving(true); setErr(null);
    try {
      // SEC-19: the database stores only the token's SHA-256 (20261141) —
      // the address exists in full only now, and is kept for this session.
      const token = newIntakeToken();
      const { data: created, error } = await supabase.from("project_intake_links").insert({
        org_id: orgId, project_id: projectId, token,
        company_name: company.trim(),
        purpose: "quote", rfq_group: snapRfqGroup(group, snapTargets) || null,
        expires_at: expiresAt.toISOString(),
        created_by: actor.uid,
      }).select("id").single();
      if (error) throw new Error(/purpose/.test(error.message) ? "Quote links need the latest database migration (20261013) applied." : userFacingError(error));
      // The audit row names the LINK (its id) — never token material — and
      // a failed audit of minting an external credential is visible.
      const { error: auditErr } = await supabase.from("audit_logs").insert({
        action: "INTAKE_QUOTE_LINK_CREATED", resource_type: "project_intake_link", resource_id: String((created as { id: string }).id),
        org_id: orgId, user_id: actor.uid, user_email: actor.email,
        details: { company: company.trim(), rfqGroup: snapRfqGroup(group, snapTargets) || null, projectId, expiresAt: expiresAt.toISOString() },
      });
      if (auditErr) setErr(`The link was created but its audit record failed: ${userFacingError(auditErr, { embed: true })}`);
      setFreshUrls((prev) => new Map(prev).set(String((created as { id: string }).id), portalUrl(token)));
      setCompany(""); setGroup(""); setExpires(isoDateInDays(QUOTE_LINK_DEFAULT_DAYS));
      await refresh();
    } catch (e) {
      setErr(userFacingCaughtError(e, { context: "QuotesPanel quote link" }));
    } finally { setSaving(false); }
  };

  const revoke = async (l: QuoteLink) => {
    if (!(await appConfirm({ message: `Revoke ${l.companyName}'s quote link? They lose access immediately; quotes already submitted stay.`, tone: "danger" }))) return;
    setRevoking(l.id); setErr(null);
    try {
      const { data: revoked, error } = await supabase.from("project_intake_links").update({ revoked_at: new Date().toISOString() })
        .eq("id", l.id).eq("project_id", projectId).is("revoked_at", null).select("id");
      if (error) { setErr(`Couldn't revoke: ${userFacingError(error)}`); return; }
      // Zero rows = nothing was revoked (already revoked, or not permitted):
      // never audit a revocation that did not happen.
      if (!revoked || (revoked as unknown[]).length === 0) { setErr(`${l.companyName}'s link was not revoked — it may already be revoked, or you may not have permission. Refresh to see its state.`); await refresh(); return; }
      const { error: auditErr } = await supabase.from("audit_logs").insert({
        action: "INTAKE_QUOTE_LINK_REVOKED", resource_type: "project_intake_link", resource_id: l.id,
        org_id: orgId, user_id: actor.uid, user_email: actor.email,
        details: { company: l.companyName, rfqGroup: l.rfqGroup, projectId },
      });
      if (auditErr) setErr(`The link was revoked but its audit record failed: ${userFacingError(auditErr, { embed: true })}`);
      await refresh();
    } finally { setRevoking(null); }
  };

  // XEDGE-5 / PHYS-13: a contractor's quote link (copied, or printed in the
  // starter RFQ) is built on the app's public origin (lib/publicOrigin),
  // never the page's own host.
  const portalUrl = (token: string) => `${publicOrigin()}${intakePortalPath(token)}`;
  /** The address a row can copy or put in an RFQ: minted / re-issued this
   *  session, or a token the database still stores (before 20261141). */
  const knownUrl = (l: QuoteLink): string | null => freshUrls.get(l.id) ?? (l.token ? portalUrl(l.token) : null);
  /** An expired link answers "This link has expired." — so it offers no
   *  RFQ, Copy link or Re-issue (the Intake tab's gate): a new link is made
   *  instead. */
  const linkLive = (l: QuoteLink): boolean => !l.expiresAt || Date.parse(l.expiresAt) > Date.now();

  /** SEC-19: a lost address is re-issued (a new token on the same link),
   *  never read back. The old address stops working. */
  const reissue = async (l: QuoteLink) => {
    if (!(await appConfirm({ message: `Re-issue ${l.companyName}'s quote link? The address they have stops working; you get a new one to send (Copy link / RFQ). Quotes already submitted stay.` }))) return;
    setReissuing(l.id); setErr(null);
    try {
      const res = await reissueIntakeLink({ linkId: l.id, orgId, projectId, company: l.companyName, actorId: actor.uid, actorEmail: actor.email });
      if (!res.ok) { setErr(res.error); await refresh(); return; }
      setFreshUrls((prev) => new Map(prev).set(l.id, portalUrl(res.token)));
      if (res.auditError) setErr(`The link was re-issued but its audit record failed: ${res.auditError}`);
      await refresh();
    } finally { setReissuing(null); }
  };

  const copy = async (l: QuoteLink) => {
    const url = knownUrl(l);
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setCopied(l.id); setTimeout(() => setCopied(null), 1500); }
    catch { setErr("Couldn't copy — your browser blocked clipboard access."); }
  };

  // Starter RFQ: a real .docx assembled from the project's own data — the
  // outbound ask that makes inbound quotes comparable. The zip library
  // loads at the click (PERF-9), never in the project route's bundle.
  const makeRfq = async (l: QuoteLink) => {
    const quoteUrl = knownUrl(l);
    if (!quoteUrl) return;
    try {
      const { downloadStarterRfq } = await import("@/lib/rfqDocx");
      const { data: proj } = await supabase
        .from("projects").select("*").eq("id", projectId).maybeSingle();
      const p = (proj ?? {}) as Record<string, unknown>;
      let sowLabel: string | null = null;
      if (p.sow_document_id) {
        const { data: d } = await supabase.from("documents").select("document_number, title, name")
          .eq("id", String(p.sow_document_id)).maybeSingle();
        if (d) sowLabel = String((d as Record<string, unknown>).document_number || (d as Record<string, unknown>).title || (d as Record<string, unknown>).name || "") || null;
      }
      const { data: to } = await supabase.from("turnover_items")
        .select("name").eq("project_id", projectId).eq("required", true).limit(30);
      const { data: org } = await supabase.from("orgs").select("name").eq("id", orgId).maybeSingle();
      downloadStarterRfq({
        projectName: String(p.name ?? "Project"),
        orgName: (org?.name as string | null) ?? null,
        companyName: l.companyName,
        rfqGroup: l.rfqGroup,
        purpose: (p.purpose as string | null) ?? null,
        sowLabel,
        quoteUrl,
        dueDate: null,
        turnoverItems: (((to ?? []) as Array<{ name: string }>)).map((t) => t.name),
      });
    } catch (e) {
      setErr(userFacingCaughtError(e, { context: "QuotesPanel starter RFQ" }));
    }
  };

  return (
    <div className="px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-accent-soft)]/30 space-y-2">
      {/* A11Y-6: "Copied!" on the button is also said to a screen reader. */}
      <span role="status" className="sr-only">{copied ? `Link copied for ${links?.find((x) => x.id === copied)?.companyName ?? "the contractor"}.` : ""}</span>
      <div className="text-[11px] text-[var(--color-text-muted)]">
        Send a contractor their own tokened link — no account needed. Their quote PDF lands here, the
        system reads it, and it joins the tabulation on its own.
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company name"
          className="h-8 w-48 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
        <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="RFQ group (optional)" list="rfq-groups-link"
          className="h-8 w-56 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
        <datalist id="rfq-groups-link">
          {snapTargets.map((g) => <option key={g} value={g} />)}
        </datalist>
        <label className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]" title="The link stops accepting quotes after this date. Default 90 days.">
          expires
          <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} required aria-label="Quote link expiry date"
            className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs [color-scheme:light] dark:[color-scheme:dark]" />
        </label>
        <button onClick={() => void create()} disabled={saving}
          className={`${DECISION_TARGET} h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors`}>
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />} Create link
        </button>
      </div>
      {(links ?? []).filter((l) => !l.revokedAt).length > 0 && (
        <ul className="space-y-1">
          {(links ?? []).filter((l) => !l.revokedAt).map((l) => (
            <li key={l.id} className="flex items-center gap-2 text-[11px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5">
              <span className="font-bold text-[var(--color-text)]">{l.companyName}</span>
              {l.rfqGroup && <span className="text-[var(--color-text-muted)]">· {l.rfqGroup}</span>}
              <span className="text-[10px] text-[var(--color-text-faint)]">{l.submissionCount} submission{l.submissionCount === 1 ? "" : "s"}</span>
              {l.expiresAt
                ? <span className={`text-[10px] ${Date.parse(l.expiresAt) < Date.now() ? "font-bold text-rose-700 dark:text-rose-300" : "text-[var(--color-text-faint)]"}`}>
                    {Date.parse(l.expiresAt) < Date.now() ? "expired" : "expires"} {new Date(l.expiresAt).toLocaleDateString()}
                  </span>
                : <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300" title="Created before expiry was required — revoke it when the bidding closes">no expiry</span>}
              {l.tokenPrefix && <span className="font-mono text-[10px] text-[var(--color-text-faint)]" title="The first characters of this link's address — the full address is shown only when the link is created or re-issued">{l.tokenPrefix}…</span>}
              <span className="ml-auto flex items-center gap-2">
                {linkLive(l) && (knownUrl(l) ? (
                  <>
                    <button onClick={() => void makeRfq(l)}
                      title="Download a ready-to-send Request For Quote (.docx) built from this project's scope, purpose, and turnover requirements — with this company's submission link inside."
                      className={`${DECISION_TARGET} inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--color-border-strong)] text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors`}>
                      <FileText className="w-3 h-3" /> RFQ (.docx)
                    </button>
                    <button onClick={() => void copy(l)}
                      className={`${DECISION_TARGET} inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--color-border-strong)] text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors`}>
                      <Copy className="w-3 h-3" /> {copied === l.id ? "Copied!" : "Copy link"}
                    </button>
                  </>
                ) : (
                  <button onClick={() => void reissue(l)} disabled={reissuing === l.id}
                    title="The address is not stored (only its fingerprint is). Re-issue to get a new one for Copy link and the RFQ — the old one stops working."
                    className={`${DECISION_TARGET} inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--color-border-strong)] text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors disabled:opacity-50`}>
                    {reissuing === l.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Re-issue
                  </button>
                ))}
                <button onClick={() => void revoke(l)} disabled={revoking === l.id}
                  className={`${DECISION_TARGET} inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-rose-500/40 text-[10px] font-bold text-rose-700 dark:text-rose-300 hover:bg-rose-500/10 transition-colors disabled:opacity-50`}>
                  {revoking === l.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />} Revoke
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
