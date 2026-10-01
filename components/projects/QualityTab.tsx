"use client";

// QualityTab — PSSR / MI / QA-QC checklists, the turnover package, and the
// punch list. The promise on the wall: "the checklist tells the system
// what's needed; the system tells you what's missing."
//
//   Checklists: point at the checklist document → the AI segments it into
//   items (YOU review before anything saves) → the AI proposes what applies
//   to THIS job, grounded on the project's purpose/SOW/schedule — and you
//   review the proposals ONE BY ONE before any of them is written; a
//   proposal that would N/A an item already satisfied is listed but never
//   applied by the assessment → the deterministic evidence sweep greens
//   items the platform can PROVE (accepted turnover on the same subject,
//   an MI checklist completed on human sign-off, Issued documents on file)
//   with the citation attached — and withdraws a green whose proof is gone
//   — and marks the rest needs_evidence, which feeds the coach.
//   A human override always wins and is never touched again. Every
//   decision needs a typed reason; a machine-verified item is labelled as
//   such, separately from a human decision, and a person can Verify it (and
//   Confirm an N/A the assessment proposed) — only a checklist where a person
//   stands behind every green and every N/A is citable (QUAL-2). Mark
//   complete re-checks the evidence first (QUAL-1).
//
//   Turnover: the quality-package contents this job requires, seeded by job
//   size, each tracked open → received → accepted/rejected/waived with the
//   reviewer's name and the reviewed document on the record; the history
//   is kept, a rejection is a nonconformance event, and an acceptance can
//   be reopened with a reason.
//
//   Punch list: the closeout snag list, visible until it's empty — each
//   closure records who closed it and what closed it; done and void differ.
//
//   Sign-off authority (QUAL-4): every write control here is drawn from the
//   database's decision for THIS project (quality_signoff_status, 20261136 —
//   a controller, the owner, or a quality.sign_off holder for the project),
//   never from a role list. "Mark complete" and turnover "Accept" / "Waive"
//   are signed with the e-signature ceremony, and the author of a checklist
//   (or the creator of a turnover item) sees why a second person signs it off
//   rather than a missing button (DEC-12); a lone signer's sign-off is
//   marked. Until the database says how many others could sign, the author's
//   sign-off waits (and says why) — never a guessed "nobody else".

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ClipboardCheck, FileText, Loader2, Sparkles, Search, X, Plus, Check,
  ChevronDown, ChevronRight, AlertTriangle, ShieldCheck, PackageCheck,
  ListChecks, Ban, Wand2, Info, CheckCircle2, RotateCcw,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { userFacingCaughtError, asClause } from "@/lib/userFacingError";
import { listParties, type Actor, type CostParty } from "@/lib/costs";
import {
  type Checklist, type ChecklistItem, type ChecklistKind, type AssessmentProposal, CHECKLIST_KIND_LABEL,
  listChecklists, listChecklistItems, createChecklist, applyAssessment,
  updateChecklistItem, setChecklistStatus, runAutoEvidence, computeChecklistProgress,
  loadSignoffAuthority, signoffSeparation, type SignoffAuthority, type SignoffInput,
  describeProjectSweep, type ProjectSweepOutcome,
} from "@/lib/checklists";
import SignatureCeremony from "@/components/signatures/SignatureCeremony";
import { useRole } from "@/components/providers/RoleContext";
import {
  type TurnoverItem, type PunchItem, type TurnoverReviewEvent, TURNOVER_STATUS_LABEL,
  listTurnoverItems, listTurnoverReviewEvents, seedTurnoverItems, addTurnoverItem, reviewTurnoverItem, reopenTurnoverItem,
  listPunchItems, addPunchItem, setPunchStatus, computeTurnoverProgress,
  assignTurnoverContractor, assignPunchContractor,
} from "@/lib/turnover";
import { type SegmentedItem, isAutoOnlyGreen, isHumanGreen, isUnreasonedNa, isMachineActorName, reasonProblem, REASON_MIN_LENGTH } from "@/lib/checklistEngine";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import { appPrompt, appConfirm } from "@/components/providers/DialogProvider";
import { getCompany } from "@/lib/companies";
import HelpTooltip from "@/components/ui/HelpTooltip";
import Link from "next/link";
import { useAiReadiness, aiBlocked, AiPreconditionNote } from "@/components/projects/AiPrecondition";
import { StatusMark, StatusLegend, CHECKLIST_STATUS_MARKS, PUNCH_STATUS_MARKS } from "@/components/projects/StatusMark";
import { TURNOVER_STATUS_MEANING } from "@/lib/projectVocabulary";
import { invalidateProjectSnapshot } from "@/lib/projectSnapshot";
import { isControllerPrincipal } from "@/lib/permissions";
import { DECISION_TARGET } from "@/components/projects/decisionTarget";

/** A11Y-8 / A11Y-14: a decision control is never under 24 px, and on a
 *  coarse pointer (a tablet, a gloved hand) it is 44 px — set on the button,
 *  never by a bare element rule in the shared stylesheet. One constant for
 *  every Projects surface (components/projects/decisionTarget.ts). */

/** PERF-10: ONE date formatter for every row of the tab — a checklist's
 *  sign-off, an item's machine verification, a turnover review and its
 *  history, a punch item's due date and closure — created on first use,
 *  never `toLocaleDateString()` per row per render. The same output: the
 *  default numeric date in the viewer's locale (an unreadable date still
 *  reads "Invalid Date", as before — formatting it would throw). */
let dayFormatter: Intl.DateTimeFormat | null = null;
function fmtDay(d: Date): string {
  if (!Number.isFinite(d.getTime())) return d.toLocaleDateString();
  dayFormatter ??= new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric" });
  return dayFormatter.format(d);
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

// ── Notices (UX-7 / UX-8): a tone per outcome, rendered beside the control ──

export type NoticeTone = "error" | "success" | "info";
export interface NoticeState { tone: NoticeTone; text: string }
type Notify = (n: NoticeState | null) => void;

const failure = (text: string): NoticeState => ({ tone: "error", text });
const success = (text: string): NoticeState => ({ tone: "success", text });
const info = (text: string): NoticeState => ({ tone: "info", text });

function Notice({ notice, onClose, action }: { notice: NoticeState | null; onClose?: () => void; action?: React.ReactNode }) {
  if (!notice) return null;
  const tone = notice.tone === "error"
    ? "border-rose-500/50 bg-rose-500/[0.08] text-rose-700 dark:text-rose-300"
    : notice.tone === "success"
      ? "border-emerald-500/50 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300"
      : "border-sky-500/50 bg-sky-500/[0.08] text-sky-700 dark:text-sky-300";
  const Icon = notice.tone === "error" ? AlertTriangle : notice.tone === "success" ? CheckCircle2 : Info;
  return (
    <div role={notice.tone === "error" ? "alert" : "status"}
      className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold ${tone}`}>
      <Icon className="w-4 h-4 shrink-0" /> <span className="min-w-0 flex-1">{notice.text}</span>
      {action}
      {onClose && <button type="button" onClick={onClose} aria-label="Dismiss" className="opacity-70 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>}
    </div>
  );
}

/** Prompt for a reason that meets the record's bar — a blank cannot settle
 *  it (SAF-4); the server enforces the same bar. */
const promptReason = (title: string, message: string, placeholder = "Why? (at least 10 characters)") =>
  appPrompt({ title, message, placeholder, required: true, minLength: REASON_MIN_LENGTH });

/** QUAL-4: what a sign-off control needs beside the write decision — how
 *  many others could sign off on this project (the separation-of-duties
 *  count; NULL while it loads or when it cannot be read), what the author is
 *  told meanwhile, and the name the ceremony asks the signer to confirm. */
interface SignoffContext { otherSigners: number | null; pendingReason: string; signerName: string }

export default function QualityTab({ orgId, projectId, canManage, uid, userEmail, jobKind, onDataChanged }: {
  orgId: string; projectId: string; canManage: boolean;
  uid: string; userEmail?: string | null;
  jobKind: string | null;
  /** Fires after each WRITE on this tab (once its re-read has landed) so the
   *  page's coach/health re-gathers — never on mount or a read retry
   *  (PERF-3 / PERF-4). */
  onDataChanged?: () => void;
}) {
  const actor: Actor = useMemo(() => ({ uid, email: userEmail ?? null }), [uid, userEmail]);
  const { member, activeRole, roles } = useRole();
  /** REL-9: voiding a checklist is the controller tier's — held anywhere in
   *  the role collection, lib/permissions isControllerPrincipal, which
   *  mirrors is_org_controller: the database's project_checklists_signoff_rail
   *  (20261136, QUAL-15) refuses anyone else, so nobody else is offered the
   *  control. */
  const mayVoidChecklist = isControllerPrincipal({ role: activeRole, roles });
  /** QUAL-4: the database's sign-off decision for this project — read with
   *  the lists on every refresh (mount, Retry, after each change), so a grant,
   *  a revocation or a new eligible signer is seen without a page reload. */
  const [authority, setAuthority] = useState<SignoffAuthority | null>(null);
  /** Only the newest read may land: an older answer never overwrites it. */
  const authoritySeq = useRef(0);
  const loadAuthority = useCallback((): Promise<void> => {
    const seq = ++authoritySeq.current;
    // Lands in the settled callback, never synchronously in the load effect
    // that calls this (react-hooks/set-state-in-effect).
    return loadSignoffAuthority(orgId, projectId, actor).then((a) => {
      if (seq === authoritySeq.current) setAuthority(a);
    });
  }, [orgId, projectId, actor]);
  // QUAL-4 done-when 4: the write controls follow the decision the policies
  // apply. Until it answers — or when it cannot be read — they follow the
  // controller / owner rule the page computed (people the policies always
  // admit), and the failure is said. The separation count is never guessed:
  // while it is unknown the author's own sign-off waits (signoffSeparation
  // reads NULL as pending), so nobody is told they are the only signer.
  const canSignOff = authority && !authority.error ? authority.maySign : canManage;
  const signoff: SignoffContext = {
    otherSigners: authority && !authority.error ? authority.otherSigners : null,
    pendingReason: authority?.error
      ? `You created this record, so whether a second person must sign it off depends on who else can — and that couldn't be read (${asClause(authority.error)}). Reload to try again.`
      : "Checking who else on this project can sign this off — you created it, so that decides whether a second person must.",
    signerName: (member?.displayName ?? "").trim() || (userEmail?.split("@")[0] ?? "").trim() || "user",
  };
  /** Per read: each section shows its own data or its own failure (UX-10). */
  const [loadErrors, setLoadErrors] = useState<{ checklists?: string; turnover?: string; history?: string; punch?: string }>({});
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [turnover, setTurnover] = useState<TurnoverItem[]>([]);
  const [events, setEvents] = useState<TurnoverReviewEvent[]>([]);
  const [punch, setPunch] = useState<PunchItem[]>([]);
  const [loading, setLoading] = useState(true);
  /** UX-16: bumped when a turnover acceptance swept the checklists, so their
   *  cards re-read the items the sweep changed. */
  const [sweepTick, setSweepTick] = useState(0);
  /** COST-12 / MON-7: the project's contractors, for the turnover and punch
   *  add rows — read on its own, so a failure never hides the lists (an
   *  item is still added, unassigned). EVERY contractor is kept (J10 third
   *  fix): an item assigned to one later set inactive still names it; only
   *  the pickers that choose a new one leave inactive contractors out
   *  (`pickableContractors`). */
  const [contractors, setContractors] = useState<CostParty[]>([]);
  /** UX-10 (final review): a failed contractors read is said, with Retry —
   *  never shown as data. Until the list answers, an assigned item's
   *  contractor is "not loaded", never "not on this project's list", and
   *  each picker says why it is not there. */
  const [contractorsError, setContractorsError] = useState<string | null>(null);
  const [contractorsState, setContractorsState] = useState<ContractorsState>("loading");
  const [contractorsTry, setContractorsTry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    listParties(orgId, projectId)
      .then((ps) => { if (!cancelled) { setContractors(ps); setContractorsError(null); setContractorsState("ready"); } })
      .catch((e: unknown) => {
        if (cancelled) return;
        // listParties says "Couldn't load the contractors: <reason>" — the
        // note below says the first half itself.
        const why = userFacingCaughtError(e, { action: "read", context: "QualityTab.contractors" }).replace(/^Couldn't load the contractors:\s*/, "");
        setContractors([]); setContractorsError(why); setContractorsState("failed");
      });
    return () => { cancelled = true; };
  }, [orgId, projectId, contractorsTry]);

  const refresh = useCallback((): Promise<void> => {
    // The sign-off decision is re-read beside the lists (it never throws:
    // a failed read comes back as authority.error and the controls fall back).
    void loadAuthority();
    // allSettled: one failing read never hides the three that answered, and
    // a denied policy or a missing migration is a failure to load — never
    // "No checklists yet" (UX-10).
    // The lists land in the settled callback — never synchronously in the
    // load effect that calls this (react-hooks/set-state-in-effect).
    return Promise.allSettled([
      listChecklists(orgId, projectId),
      listTurnoverItems(orgId, projectId),
      listTurnoverReviewEvents(orgId, projectId),
      listPunchItems(orgId, projectId),
    ]).then(([cl, to, ev, pu]) => {
      const why = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? String((r.reason as Error)?.message ?? r.reason) : undefined);
      setChecklists(cl.status === "fulfilled" ? cl.value : []);
      setTurnover(to.status === "fulfilled" ? to.value : []);
      setEvents(ev.status === "fulfilled" ? ev.value : []);
      setPunch(pu.status === "fulfilled" ? pu.value : []);
      setLoadErrors({ checklists: why(cl), turnover: why(to), history: why(ev), punch: why(pu) });
      setLoading(false);
    });
  }, [orgId, projectId, loadAuthority]);
  useEffect(() => { void refresh(); }, [refresh]);
  /** PERF-4 / PERF-3: after a WRITE on this tab — re-read, drop any snapshot
   *  round issued before the write, then tell the page, so the coach
   *  re-gathers from a fresh round. The load effect never calls the page:
   *  the coach gathers its own round when it mounts (a tab mount costs no
   *  second round), and no callback identity can re-fire the load — the
   *  loop the old eslint suppression held back cannot form. */
  const afterWrite = useCallback(() => {
    void refresh().then(() => {
      invalidateProjectSnapshot(orgId, projectId);
      onDataChanged?.();
    });
  }, [refresh, orgId, projectId, onDataChanged]);

  if (loading) return <div className="py-12 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" /></div>;

  const retry = () => void refresh();
  return (
    <div className="space-y-4">
      {authority?.error && (
        <Notice notice={info(`Couldn't read who may sign off on this project (${asClause(authority.error)}) — the controls shown are the ones the project owner, Admin and Document Control always have.`)} />
      )}
      {contractorsError && (
        <Notice notice={failure(`The project's contractors couldn't be loaded — ${asClause(contractorsError)}. Each item keeps its contractor, but it can't be shown or changed until the list loads.`)}
          action={<button type="button" onClick={() => setContractorsTry((n) => n + 1)} className="underline">Retry</button>} />
      )}
      <ChecklistsSection key={sweepTick} orgId={orgId} projectId={projectId} canManage={canSignOff} actor={actor} signoff={signoff} mayVoid={mayVoidChecklist}
        checklists={checklists} loadError={loadErrors.checklists} onRetry={retry} onChanged={afterWrite} />
      <TurnoverSection orgId={orgId} projectId={projectId} canManage={canSignOff} actor={actor} signoff={signoff}
        items={turnover} events={events} loadError={loadErrors.turnover} historyError={loadErrors.history} onRetry={retry}
        jobKind={jobKind} onChanged={afterWrite} onEvidenceSwept={() => setSweepTick((t) => t + 1)} contractors={contractors} contractorsState={contractorsState} />
      <PunchSection orgId={orgId} projectId={projectId} canManage={canSignOff} actor={actor}
        items={punch} loadError={loadErrors.punch} onRetry={retry} onChanged={afterWrite} contractors={contractors} contractorsState={contractorsState} />
    </div>
  );
}

/** A section whose read failed: the failure, a Retry — never the empty
 *  state, and no add / seed control over a list nobody could see (UX-10). */
function LoadFailed({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) {
  return (
    <div className="px-4 py-3">
      <Notice notice={failure(`${what} couldn't be loaded — ${error}`)}
        action={<button type="button" onClick={onRetry} className="underline">Retry</button>} />
    </div>
  );
}

// ── Checklists ───────────────────────────────────────────────────────────

function ChecklistsSection({ orgId, projectId, canManage, actor, signoff, mayVoid = false, checklists, loadError, onRetry, onChanged }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor; signoff: SignoffContext;
  /** REL-9: the viewer may void a checklist (the controller tier). */
  mayVoid?: boolean;
  checklists: Checklist[]; loadError?: string; onRetry: () => void; onChanged: () => void;
}) {
  const [showNew, setShowNew] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <ClipboardCheck className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Checklists — PSSR, MI, QA/QC</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">The system reads them, works out what applies, and tracks the gaps.</span>
        {canManage && !loadError && (
          <button onClick={() => setShowNew((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] transition-colors">
            <Plus className="w-3 h-3" /> New from document
          </button>
        )}
      </div>

      {notice && <div className="px-4 pt-3"><Notice notice={notice} onClose={() => setNotice(null)} /></div>}

      {showNew && canManage && !loadError && (
        <NewChecklistFlow orgId={orgId} projectId={projectId} actor={actor}
          onDone={() => { setShowNew(false); onChanged(); }} onCancel={() => setShowNew(false)} notify={setNotice} />
      )}

      {loadError ? (
        <LoadFailed what="The checklists" error={loadError} onRetry={onRetry} />
      ) : checklists.filter((c) => c.status !== "void").length === 0 ? (
        <div className="px-4 py-8 text-center">
          <ClipboardCheck className="w-7 h-7 mx-auto text-[var(--color-text-faint)] mb-2" />
          <div className="text-sm font-bold text-[var(--color-text)]">No checklists yet</div>
          <div className="text-xs text-[var(--color-text-muted)] mt-1 max-w-lg mx-auto">
            Upload your PSSR or QA/QC checklist to document control, then point at it here — the AI
            splits it into items, judges what applies to this job, and finds the evidence you already have.
          </div>
          {/* UX-13: the way to do that, here — not a direction to another page. */}
          <div className="mt-3 flex items-center justify-center gap-3 text-xs font-bold">
            <Link href="/documents" className="underline text-[var(--color-accent)]">Upload it in document control</Link>
            {canManage && (
              <button type="button" onClick={() => setShowNew(true)} className="underline text-[var(--color-accent)]">Point at one already uploaded</button>
            )}
          </div>
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {checklists.filter((c) => c.status !== "void").map((c) => (
            <ChecklistCard key={c.id} orgId={orgId} projectId={projectId} checklist={c}
              canManage={canManage} actor={actor} signoff={signoff} mayVoid={mayVoid} onChanged={onChanged} />
          ))}
        </div>
      )}
    </div>
  );
}

function NewChecklistFlow({ orgId, projectId, actor, onDone, onCancel, notify }: {
  orgId: string; projectId: string; actor: Actor;
  onDone: () => void; onCancel: () => void; notify: Notify;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; label: string }>>([]);
  const [doc, setDoc] = useState<{ id: string; label: string } | null>(null);
  const [kind, setKind] = useState<ChecklistKind>("pssr");
  const [reading, setReading] = useState(false);
  const [proposed, setProposed] = useState<SegmentedItem[] | null>(null);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  // UX-13: whether the AI read can run is said before the search, not after the click.
  const ai = useAiReadiness(orgId);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || doc) { setResults([]); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from("documents").select("id, document_number, title, name")
        .eq("org_id", orgId)
        .or(`document_number.ilike.%${q}%,title.ilike.%${q}%,name.ilike.%${q}%`)
        .limit(8);
      setResults((((data ?? []) as Array<Record<string, unknown>>)).map((d) => ({
        id: String(d.id), label: String(d.document_number || d.title || d.name || "Document"),
      })));
    }, 250);
    return () => clearTimeout(t);
  }, [query, orgId, doc]);

  const read = async () => {
    if (!doc) return;
    setReading(true); notify(null);
    try {
      const res = await fetch("/api/projects/checklist", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ orgId, projectId, action: "segment", documentId: doc.id }),
      });
      const body = (await res.json().catch(() => null)) as { items?: SegmentedItem[]; sourceLabel?: string; error?: string } | null;
      if (!res.ok || !body?.items) throw new Error(body?.error || `HTTP ${res.status}`);
      setProposed(body.items);
      setTitle(body.sourceLabel ?? doc.label);
    } catch (e) {
      notify(failure(userFacingCaughtError(e, { context: "QualityTab" })));
    } finally { setReading(false); }
  };

  const save = async () => {
    if (!proposed || !doc) return;
    setSaving(true); notify(null);
    const res = await createChecklist({
      orgId, projectId, title: title || doc.label, kind,
      sourceDocumentId: doc.id,
      items: proposed.map((p, i) => ({ ...p, seq: i + 1 })),
      actor,
    });
    setSaving(false);
    if (!res.ok) { notify(failure(res.error ?? "Couldn't save.")); return; }
    onDone();
  };

  return (
    <div className="px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-accent-soft)]/30 space-y-2">
      {!proposed ? (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            {doc ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs font-bold text-[var(--color-text)]">
                <FileText className="w-3.5 h-3.5 text-[var(--color-accent)]" /> {doc.label}
                <button onClick={() => setDoc(null)} className="text-[var(--color-text-faint)] hover:text-rose-600"><X className="w-3 h-3" /></button>
              </span>
            ) : (
              <span className="relative flex-1 min-w-64">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-faint)]" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
                  placeholder="Find the checklist document (by number or title)…"
                  className="w-full h-8 pl-8 pr-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-xs" />
              </span>
            )}
            <select value={kind} onChange={(e) => setKind(e.target.value as ChecklistKind)}
              className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
              {(Object.keys(CHECKLIST_KIND_LABEL) as ChecklistKind[]).map((k) => (
                <option key={k} value={k}>{CHECKLIST_KIND_LABEL[k]}</option>
              ))}
            </select>
            <button onClick={() => void read()} disabled={!doc || reading || aiBlocked(ai)}
              className={`${DECISION_TARGET} h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors`}
              title="AI reads the printed pages and splits them into checkable items — you review before anything saves.">
              {reading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} Read it
            </button>
            <button onClick={onCancel} className="text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
            <AiPreconditionNote readiness={ai} className="basis-full" />
          </div>
          {results.length > 0 && !doc && (
            <ul className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] overflow-hidden">
              {results.map((d) => (
                <li key={d.id}>
                  <button onClick={() => setDoc(d)} className="w-full px-3 py-1.5 text-left text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> {d.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <input value={title} onChange={(e) => setTitle(e.target.value)}
              className="h-8 flex-1 min-w-48 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs font-bold" />
            <span className="text-[11px] text-[var(--color-text-muted)]">{proposed.length} items read — remove any that aren&apos;t real items, then save.</span>
            <button onClick={() => void save()} disabled={saving || proposed.length === 0}
              className={`${DECISION_TARGET} h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50`}>
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save checklist
            </button>
            <button onClick={() => setProposed(null)} className="text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Back</button>
          </div>
          <ul className="max-h-72 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)]">
            {proposed.map((p, i) => (
              <li key={i} className="px-3 py-1.5 flex items-start gap-2 text-xs">
                {p.section && <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-faint)] mt-0.5">{p.section}</span>}
                <span className="flex-1 text-[var(--color-text)]">{p.text}</span>
                <button onClick={() => setProposed(proposed.filter((_, j) => j !== i))}
                  className="shrink-0 text-[var(--color-text-faint)] hover:text-rose-600"><X className="w-3 h-3" /></button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** A proposal as the assess route returns it — with the item's current state. */
type ReviewProposal = AssessmentProposal & {
  current: { text: string; section: string | null; status: string; hasEvidence: boolean; humanDecided: boolean; protectedFromDowngrade: boolean };
};

/** The cited document's current standing, for the evidence chip (SAF-1 / QUAL-1). */
type DocStanding = { status: string | null; rev: string | null; label: string };

function ChecklistCard({ orgId, projectId, checklist, canManage, actor, signoff, mayVoid = false, onChanged }: {
  orgId: string; projectId: string; checklist: Checklist;
  canManage: boolean; actor: Actor; signoff: SignoffContext;
  mayVoid?: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  /** QUAL-4: the signing ceremony is open for "Mark complete". */
  const [signing, setSigning] = useState(false);
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [docs, setDocs] = useState<Record<string, DocStanding>>({});
  /** The cited-document lookup answered (an error leaves chips without a standing). */
  const [docsChecked, setDocsChecked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ai = useAiReadiness(orgId);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [review, setReview] = useState<{ proposals: ReviewProposal[]; ticked: Set<string> } | null>(null);

  const loadItems = useCallback(async () => {
    try {
      const rows = await listChecklistItems(checklist.id);
      setItems(rows); setItemsError(null);
      // The cited documents' CURRENT status, so a Void/Superseded citation is visible.
      const ids = [...new Set(rows.flatMap((r) => r.evidence.map((e) => e.documentId).filter((x): x is string => Boolean(x))))];
      if (ids.length > 0) {
        // Through the caller's RLS: a document the viewer may not read (an
        // ACL-restricted one) comes back absent — the chip says so, never
        // "not found" (SEC-10 keeps the service-role read out of here).
        const { data, error } = await supabase.from("documents").select("id, status, rev, document_number, title, name").in("id", ids).limit(200);
        const map: Record<string, DocStanding> = {};
        for (const d of ((data ?? []) as Array<Record<string, unknown>>)) {
          map[String(d.id)] = {
            status: (d.status as string | null) ?? null, rev: (d.rev as string | null) ?? null,
            label: String(d.document_number || d.title || d.name || ""),
          };
        }
        setDocs(map); setDocsChecked(!error);
      } else {
        setDocs({}); setDocsChecked(true);
      }
    } catch (e) {
      setItems([]); setItemsError(userFacingCaughtError(e, { action: "read", context: "QualityTab" }));
    }
  }, [checklist.id]);
  useEffect(() => { if (open && items == null) void loadItems(); }, [open, items, loadItems]);

  const progress = useMemo(() => (items ? computeChecklistProgress(items) : null), [items]);
  const blocking = progress ? progress.applicable - progress.satisfied : 0;
  /** Greens no person gave a reason for (the sweep's, or a chip with no
   *  note) — each one makes the completion 'auto' (not citable) until a
   *  person verifies it (QUAL-2). */
  const autoGreens = useMemo(() => (items ?? []).filter(isAutoOnlyGreen).length, [items]);
  /** N/As no person gave a reason for (the assessment's) — each keeps the
   *  completion 'auto' until a person confirms it (QUAL-2). */
  const unreasonedNa = useMemo(() => (items ?? []).filter(isUnreasonedNa).length, [items]);
  const humanGreens = useMemo(() => (items ?? []).filter(isHumanGreen).length, [items]);
  /** Sweep greens whose cited document has left Issued / Locked (or can no
   *  longer be read) — Mark complete refuses them (QUAL-1); mirrored here so
   *  the button says why before the server does. */
  const staleGreens = useMemo(() => (items ?? []).filter((it) => isAutoOnlyGreen(it) && it.evidence.some((e) => {
    if (e.source !== "auto" || !e.documentId) return false;
    const d = docs[e.documentId];
    return d ? NOT_CURRENT_STATUSES.has(d.status ?? "") || d.status === "Draft" : docsChecked;
  })).length, [items, docs, docsChecked]);

  const assess = async () => {
    setBusy("assess"); setNotice(null);
    try {
      const res = await fetch("/api/projects/checklist", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ orgId, projectId, action: "assess", checklistId: checklist.id }),
      });
      const body = (await res.json().catch(() => null)) as { proposals?: ReviewProposal[]; error?: string } | null;
      if (!res.ok || !body?.proposals) throw new Error(body?.error || `HTTP ${res.status}`);
      // SAF-2 / GAP-404: every proposal is shown and starts UNTICKED — nothing
      // is applied that the reviewer has not seen and chosen.
      setReview({ proposals: body.proposals, ticked: new Set() });
    } catch (e) {
      setNotice(failure(userFacingCaughtError(e, { context: "QualityTab" })));
    } finally { setBusy(null); }
  };

  const applyReview = async () => {
    if (!review) return;
    setBusy("apply"); setNotice(null);
    try {
      const out = await applyAssessment({
        orgId, projectId, checklistId: checklist.id,
        proposals: review.proposals.map(({ itemId, applicability, rationale }) => ({ itemId, applicability, rationale })),
        confirmedItemIds: [...review.ticked],
        actor,
      });
      await loadItems(); onChanged();
      if (out.error) { setNotice(failure(out.error)); return; }
      setReview(null);
      const parts = [`Applied ${out.applied}`];
      if (out.skippedHuman > 0) parts.push(`left ${out.skippedHuman} alone because a person already decided them`);
      if (out.skippedProtected > 0) parts.push(`did not change ${out.skippedProtected} already-satisfied item${out.skippedProtected === 1 ? "" : "s"} (use the item's own N/A with a reason)`);
      if (out.skippedUnconfirmed > 0) parts.push(`${out.skippedUnconfirmed} unticked`);
      setNotice(success(`${parts.join("; ")}.`));
    } catch (e) {
      setNotice(failure(userFacingCaughtError(e, { context: "QualityTab" })));
    } finally { setBusy(null); }
  };

  const sweep = async () => {
    setBusy("sweep"); setNotice(null);
    try {
      const res = await runAutoEvidence({ orgId, projectId, checklistId: checklist.id, actor });
      await loadItems(); onChanged();
      if (res.error) { setNotice(failure(res.error)); return; }
      if (res.satisfied + res.needsEvidence + res.retracted === 0) {
        setNotice(info("Evidence sweep: nothing new to prove or demand — items are either done, human-decided, or not evidence-shaped."));
      } else {
        const parts = [];
        if (res.satisfied > 0) parts.push(`${res.satisfied} proven`);
        if (res.needsEvidence > 0) parts.push(`${res.needsEvidence} need evidence`);
        if (res.retracted > 0) parts.push(`${res.retracted} withdrawn — the cited document is no longer current`);
        setNotice(success(`Evidence sweep: ${parts.join(", ")}.`));
      }
    } catch (e) {
      setNotice(failure(userFacingCaughtError(e, { context: "QualityTab" })));
    } finally { setBusy(null); }
  };

  // QUAL-4: "Mark complete" is a signed sign-off — the ceremony collects the
  // statement and the re-authentication; the lib mints the signature through
  // the signing route and the database binds it to the completion.
  const complete = async (signed: SignoffInput) => {
    setBusy("complete"); setNotice(null);
    const res = await setChecklistStatus({ orgId, projectId, checklist, status: "complete", actor, signoff: signed });
    setBusy(null);
    setSigning(false);
    if (!res.ok) { setNotice(failure(res.error ?? "Couldn't complete.")); return; }
    onChanged();
  };
  /** REL-9: a checklist created by mistake (or one that should not count)
   *  is voided — the controller's act the database rail admits (QUAL-15,
   *  20261136): it leaves the project's checklists and every count closeout
   *  reads; its items, any sign-off signature and the audit row stay. The
   *  write is checked (lib/checklists setChecklistStatus → checkedWrite): a
   *  refusal or a row that did not change is said, never a silent success. */
  const voidChecklist = async () => {
    const ok = await appConfirm({
      title: `Void the checklist “${checklist.title}”?`,
      message: `${checklist.status === "complete"
        ? `It was signed off${checklist.completedByName ? ` by ${checklist.completedByName}` : ""}. Voiding withdraws it from`
        : "Use this for a checklist created by mistake. Voiding takes it out of"} this project's checklists and every closeout count. Its items${checklist.status === "complete" ? " and its signature" : ""} stay on the record, and the void is recorded under your name. Only Admin / Document Control can void a checklist.`,
      confirmLabel: "Void checklist",
      tone: "danger",
    });
    if (!ok) return;
    setBusy("void"); setNotice(null);
    const res = await setChecklistStatus({ orgId, projectId, checklist, status: "void", actor });
    setBusy(null);
    if (!res.ok) { setNotice(failure(res.error ?? "Couldn't void the checklist.")); return; }
    onChanged();
  };
  /** DEC-12: the author signs off only when nobody else on the project can
   *  — and waits while that is not known (`pending`). */
  const separation = signoffSeparation(checklist.createdBy, actor.uid, signoff.otherSigners, "checklist");
  const separationReason = separation.pending ? signoff.pendingReason : separation.reason;

  // Group items by section for rendering.
  const sections = useMemo(() => {
    const by = new Map<string, ChecklistItem[]>();
    for (const it of items ?? []) {
      const key = it.section ?? "";
      by.set(key, [...(by.get(key) ?? []), it]);
    }
    return [...by.entries()];
  }, [items]);

  const completeBlocked = progress != null && (progress.total === 0 || blocking > 0 || staleGreens > 0 || separation.blocked);
  const autoReasons = [
    autoGreens > 0 ? `${autoGreens} green${autoGreens === 1 ? " carries" : "s carry"} no person's reason — the sweep's alone, or a chip with no note (✓ Verify)` : null,
    unreasonedNa > 0 ? `${unreasonedNa} N/A${unreasonedNa === 1 ? " carries" : "s carry"} no person's reason (✓ Confirm N/A)` : null,
    humanGreens === 0 ? "no green item was decided by a person" : null,
  ].filter((x): x is string => Boolean(x));
  const completeTitle = progress == null ? "Loading items…"
    : progress.total === 0 ? "No items — nothing to verify, so this checklist cannot be completed."
    : blocking > 0 ? `${blocking} item${blocking === 1 ? " is" : "s are"} not satisfied yet — a checklist only completes when every applicable item is green or N/A.`
    : staleGreens > 0 ? `${staleGreens} green item${staleGreens === 1 ? " rests" : "s rest"} on a document that is no longer current — run "Check evidence we already hold" first.`
    : separation.blocked ? `${separationReason ?? "A second person signs this checklist off."}`
    : autoReasons.length > 0 ? `Every applicable item is green or N/A, but ${autoReasons.join("; ")} — completing now records this checklist as "auto", which no other checklist can cite.`
    : "Every applicable item is green or N/A, and a person stands behind every green and every N/A.";

  return (
    <div>
      <button onClick={() => setOpen((v) => !v)} className="w-full px-4 py-3 flex items-center gap-2 text-left hover:bg-[var(--color-surface-2)]/40 transition-colors">
        {open ? <ChevronDown className="w-4 h-4 text-[var(--color-text-faint)]" /> : <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)]" />}
        <span className="text-xs font-black text-[var(--color-text)]">{checklist.title}</span>
        <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{CHECKLIST_KIND_LABEL[checklist.kind] ?? checklist.kind}</span>
        {checklist.status === "complete" && (
          <span className="inline-flex items-center gap-0.5 text-[9px] font-black uppercase text-emerald-700 dark:text-emerald-300"
            title={checklist.completedBasis === "human" ? "Completed on human sign-off — a person stands behind every green and every N/A" : checklist.completedBasis === "auto" ? "Completed while a green or an N/A carried no person's reason, or no green was a person's decision — not citable as proof by another checklist" : "Completed"}>
            <ShieldCheck className="w-3 h-3" /> complete{checklist.completedBasis === "auto" ? " (auto)" : ""}
          </span>
        )}
        {checklist.status === "complete" && checklist.completedByName && (
          <span className="text-[9px] font-bold text-[var(--color-text-muted)]"
            title={checklist.completedSignatureId ? "Signed off with an e-signature (re-authenticated at signing)" : undefined}>
            signed off by {checklist.completedByName}{checklist.completedAt ? ` · ${fmtDay(new Date(checklist.completedAt))}` : ""}
          </span>
        )}
        {checklist.status === "complete" && checklist.completedSingleSigner && (
          <span className="text-[9px] font-black uppercase text-amber-700 dark:text-amber-300"
            title="Signed off by its own author because nobody else on the project could — a second person's sign-off was not possible">
            single-signer
          </span>
        )}
        {progress && checklist.status === "open" && (
          <span className="ml-auto text-[10px] font-bold tabular-nums text-[var(--color-text-muted)]">
            {progress.satisfied}/{progress.applicable} satisfied{progress.needsEvidence > 0 ? ` · ${progress.needsEvidence} need evidence` : ""}
          </span>
        )}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-2">
          {canManage && checklist.status === "open" && (
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => void assess()} disabled={busy != null || aiBlocked(ai)}
                className={`${DECISION_TARGET} inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors`}>
                {busy === "assess" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />} Which items apply to this job?
              </button>
              <AiPreconditionNote readiness={ai} />
              <HelpTooltip label="What “Which items apply to this job?” does">
                AI judges which items apply to THIS job, grounded on the project&apos;s purpose, SOW, schedule, and documents. It only <b>proposes</b> — you review each proposal before it applies, and it never marks an item not applicable on its own.
              </HelpTooltip>
              <button onClick={() => void sweep()} disabled={busy != null}
                className={`${DECISION_TARGET} inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors`}>
                {busy === "sweep" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ListChecks className="w-3 h-3" />} Check evidence we already hold
              </button>
              <HelpTooltip label="What “Check evidence we already hold” does">
                Deterministic — no AI. Greens items the platform can <b>prove</b> (accepted turnover on the same subject, Issued documents on file), citation attached; withdraws a green whose document is no longer current; flags the rest needs-evidence. It writes statuses on this checklist.
              </HelpTooltip>
              <button onClick={() => setSigning(true)} disabled={busy != null || completeBlocked}
                aria-disabled={completeBlocked || undefined}
                title={completeTitle}
                className={`${DECISION_TARGET} ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-[11px] font-black hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}>
                {busy === "complete" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />} Mark complete
              </button>
              {completeBlocked && progress && (
                <span className="basis-full text-[10px] text-[var(--color-text-muted)]">{completeTitle}</span>
              )}
              {!completeBlocked && progress && autoReasons.length > 0 && (
                <span className="basis-full text-[10px] font-bold text-amber-700 dark:text-amber-300">{completeTitle}</span>
              )}
              {!completeBlocked && progress && separation.singleSigner && (
                <span className="basis-full text-[10px] font-bold text-amber-700 dark:text-amber-300">
                  You created this checklist and nobody else on this project can sign it off — your completion will be marked single-signer.
                </span>
              )}
            </div>
          )}

          {signing && (
            <SignatureCeremony
              signerName={signoff.signerName}
              resourceLabel={`checklist "${checklist.title}"`}
              defaultIntent="Reviewed"
              lockIntent
              defaultStatement={`I, ${signoff.signerName}, have verified the checklist "${checklist.title}" complete — every applicable item is green or N/A as recorded — and affirm this as my electronic signature.`}
              busy={busy === "complete"}
              onCancel={() => { if (busy !== "complete") setSigning(false); }}
              onSign={(_intent, statement, signatureImage, reauth) => void complete({ statement, signatureImage: signatureImage ?? null, reauth: reauth ?? null, signerName: signoff.signerName })}
            />
          )}

          {mayVoid && checklist.status !== "void" && (
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void voidChecklist()} disabled={busy != null}
                title="Admin / Document Control: take this checklist out of the project and its closeout counts — its items and any signature stay on the record"
                className={`${DECISION_TARGET} ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-rose-500/40 text-[11px] font-bold text-rose-700 dark:text-rose-300 hover:bg-rose-500/10 disabled:opacity-50 transition-colors`}>
                {busy === "void" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />} Void checklist
              </button>
            </div>
          )}

          <Notice notice={notice} onClose={() => setNotice(null)} />

          {review && (
            <AssessmentReview review={review} busy={busy === "apply"}
              onToggle={(id) => setReview((r) => {
                if (!r) return r;
                const ticked = new Set(r.ticked);
                if (ticked.has(id)) ticked.delete(id); else ticked.add(id);
                return { ...r, ticked };
              })}
              onTickAll={() => setReview((r) => r ? { ...r, ticked: new Set([...r.ticked, ...r.proposals.filter((p) => p.applicability !== "na" && !p.current.humanDecided).map((p) => p.itemId)]) } : r)}
              onClear={() => setReview((r) => r ? { ...r, ticked: new Set() } : r)}
              onApply={() => void applyReview()} onCancel={() => setReview(null)} />
          )}

          {/* A11Y-2 / A11Y-12: the key to the item marks, always visible. */}
          <StatusLegend marks={CHECKLIST_STATUS_MARKS} />
          {items == null ? (
            <div className="py-4 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-[var(--color-accent)]" /></div>
          ) : itemsError ? (
            <Notice notice={failure(`The items couldn't be loaded — ${itemsError}`)} onClose={() => setItemsError(null)}
              action={<button type="button" onClick={() => void loadItems()} className="underline">Retry</button>} />
          ) : (
            <div className="rounded-xl border border-[var(--color-border)] overflow-hidden">
              {sections.map(([section, secItems]) => (
                <div key={section || "_"}>
                  {section && (
                    <div className="px-3 py-1.5 bg-[var(--color-surface-2)]/60 text-[9px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">
                      {section}
                    </div>
                  )}
                  <ul className="divide-y divide-[var(--color-border)]">
                    {secItems.map((it) => (
                      <ChecklistItemRow key={it.id} orgId={orgId} projectId={projectId} item={it} docs={docs} docsChecked={docsChecked}
                        canManage={canManage && checklist.status === "open"} actor={actor}
                        onChanged={() => { void loadItems(); onChanged(); }} notify={setNotice} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The per-item review of an AI assessment (SAF-2 / QUAL-5): every
 *  proposal listed with its rationale, each individually ticked, starting
 *  with nothing ticked. Proposals that would N/A an item already satisfied
 *  or evidence-bearing are shown but cannot be applied here. */
function AssessmentReview({ review, busy, onToggle, onTickAll, onClear, onApply, onCancel }: {
  review: { proposals: ReviewProposal[]; ticked: Set<string> };
  busy: boolean;
  onToggle: (id: string) => void; onTickAll: () => void; onClear: () => void;
  onApply: () => void; onCancel: () => void;
}) {
  const na = review.proposals.filter((p) => p.applicability === "na");
  const protectedNa = na.filter((p) => p.current.protectedFromDowngrade);
  return (
    <div className="rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)]/20 p-3 space-y-2">
      <div className="text-xs font-bold text-[var(--color-text)]">
        The assessment proposes applicability for {review.proposals.length} item{review.proposals.length === 1 ? "" : "s"}
        {na.length > 0 ? ` — ${na.length} look${na.length === 1 ? "s" : ""} not-applicable to this job` : ""}.
        Tick the ones you agree with; nothing is written until you apply.
      </div>
      {protectedNa.length > 0 && (
        <div className="flex items-start gap-1.5 text-[11px] font-bold text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{protectedNa.length} of the proposed N/As target{protectedNa.length === 1 ? "s" : ""} an item that is already satisfied or has evidence attached. The assessment will not change {protectedNa.length === 1 ? "it" : "them"} — if one really is not applicable, use its own N/A control and say why.</span>
        </div>
      )}
      {na.length > 0 && (
        <div className="text-[10px] text-[var(--color-text-muted)]">
          N/A proposals are ticked one by one. An applied N/A carries no reason of yours, so a checklist completed with it is recorded as &quot;auto&quot; until you confirm it on the item.
        </div>
      )}
      <div className="flex items-center gap-2 text-[10px] font-bold">
        <button type="button" onClick={onTickAll} className={`${DECISION_TARGET} px-1.5 rounded underline text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]`}
          title="Ticks every proposal that keeps an item in scope — never an N/A">Tick every in-scope proposal</button>
        <button type="button" onClick={onClear} className={`${DECISION_TARGET} px-1.5 rounded underline text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]`}>Clear</button>
        <span className="ml-auto tabular-nums text-[var(--color-text-muted)]">{review.ticked.size} ticked</span>
      </div>
      <ul className="max-h-80 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)]">
        {review.proposals.map((p) => {
          const locked = (p.applicability === "na" && p.current.protectedFromDowngrade) || p.current.humanDecided;
          const why = p.current.humanDecided ? "A person already decided this item — the assessment never touches it."
            : p.applicability === "na" && p.current.protectedFromDowngrade ? (p.current.status === "satisfied" ? "Currently SATISFIED — the assessment will not downgrade it." : "Evidence is attached — the assessment will not downgrade it.")
            : undefined;
          return (
            <li key={p.itemId} className={`px-3 py-1.5 flex items-start gap-2 text-xs ${locked ? "opacity-70" : ""}`}>
              <input type="checkbox" className="mt-0.5" checked={review.ticked.has(p.itemId)} disabled={locked || busy}
                onChange={() => onToggle(p.itemId)} aria-label={`Apply: ${p.current.text}`} />
              <div className="min-w-0 flex-1">
                <div className="text-[var(--color-text)]">
                  {p.current.section && <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-faint)] mr-1">{p.current.section}</span>}
                  {p.current.text}
                </div>
                <div className="text-[10px] text-[var(--color-text-muted)]">
                  <span className={`font-black uppercase mr-1 ${p.applicability === "na" ? "text-amber-700 dark:text-amber-300" : ""}`}>{p.applicability === "na" ? "N/A" : p.applicability}</span>
                  {p.rationale || "(no rationale given)"}
                  <span className="ml-1 text-[var(--color-text-faint)]">· now {p.current.status.replace("_", " ")}{p.current.hasEvidence ? ", evidence attached" : ""}</span>
                </div>
                {why && <div className="text-[10px] font-bold text-amber-700 dark:text-amber-300">{why}</div>}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onApply} disabled={busy || review.ticked.size === 0}
          className={`${DECISION_TARGET} inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50`}>
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Apply {review.ticked.size} ticked
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={`${DECISION_TARGET} px-2 rounded-lg text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]`}>Cancel</button>
      </div>
    </div>
  );
}

function ChecklistItemRow({ orgId, projectId, item, docs, docsChecked, canManage, actor, onChanged, notify }: {
  orgId: string; projectId: string; item: ChecklistItem; docs: Record<string, DocStanding>; docsChecked: boolean;
  canManage: boolean; actor: Actor;
  onChanged: () => void; notify: Notify;
}) {
  const [busy, setBusy] = useState(false);
  const na = item.applicability === "na" || item.status === "na";
  const machine = item.status === "satisfied" && !item.manualNote && isMachineActorName(item.updatedByName);
  // An N/A no person gave a reason for (the assessment's): a person can
  // Confirm it — their reason goes on the row, and the completion can then
  // be citable (QUAL-2).
  const unreasonedNa = isUnreasonedNa(item);
  // A green no person has verified (the sweep's, or a legacy one): a person
  // can Verify it — the row gains their note, uid and name, the sweep's
  // citation chip stays, and the sweep keeps its hands off from then on.
  const unverifiedGreen = !na && isAutoOnlyGreen(item);

  const override = async (
    patch: Parameters<typeof updateChecklistItem>[0]["patch"], promptNote: string,
    message = "Your reason goes on the record and marks this item human-decided — automation keeps its hands off from then on.",
  ) => {
    // SAF-4: a decision needs a typed reason — the prompt cannot settle
    // blank, and no placeholder is ever written. The server checks it too.
    const v = await promptReason(promptNote, message);
    if (v === null) return;
    setBusy(true);
    const res = await updateChecklistItem({ orgId, projectId, item, patch: { ...patch, manualNote: v.trim() }, actor });
    setBusy(false);
    if (!res.ok) notify(failure(res.error ?? "Couldn't update.")); else { notify(null); onChanged(); }
  };

  return (
    // A11Y-13 / GAP-410: an N/A row is set back by its mark ("Not
    // applicable") and the muted text token — never whole-row opacity,
    // which took its text under 4.5 : 1 in both themes.
    <li className="px-3 py-2 text-xs">
      <div className="flex flex-wrap sm:flex-nowrap items-start gap-2">
        <StatusMark spec={CHECKLIST_STATUS_MARKS[na ? "na" : item.status] ?? CHECKLIST_STATUS_MARKS.open} className="mt-px" />
        <div className="min-w-0 flex-1">
          <div className={na ? "text-[var(--color-text-muted)]" : "text-[var(--color-text)]"}>{item.text}</div>
          {item.aiRationale && (
            <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
              <span className="font-bold">Assessment:</span> {item.aiRationale}
            </div>
          )}
          {item.manualNote && (
            <div className="mt-0.5 text-[10px] font-bold text-[var(--color-accent)]">
              Human decision{item.updatedByName ? ` (${item.updatedByName})` : ""}: {item.manualNote}
            </div>
          )}
          {machine && (
            <div className="mt-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300" title="Set by the deterministic evidence sweep from a document on file — no person has verified this line.">
              Machine-verified ({item.updatedByName}){item.updatedAt ? ` · ${fmtDay(new Date(item.updatedAt))}` : ""} — not a human sign-off{canManage ? " · Verify to sign it off" : ""}
            </div>
          )}
          {unreasonedNa && (
            <div className="mt-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300" title="An N/A the AI assessment applied (or a legacy one) carries no reason — ticking a proposal is not a reason, so a completion containing this N/A is recorded as auto.">
              N/A with no person&apos;s reason on record{item.updatedByName ? ` — set by ${item.updatedByName}` : ""}{canManage ? " · Confirm N/A to sign it off" : ""}
            </div>
          )}
          {item.evidence.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {item.evidence.map((e, i) => <EvidenceChip key={i} chip={e} doc={e.documentId ? docs[e.documentId] : undefined} checked={docsChecked} />)}
            </div>
          )}
        </div>
        {canManage && !busy && (
          <span className="shrink-0 basis-full sm:basis-auto flex flex-wrap items-center justify-end gap-2">
            {!na && item.status !== "satisfied" && (
              <button onClick={() => void override({ status: "satisfied" }, "Mark satisfied")}
                className={`${DECISION_TARGET} px-1.5 py-0.5 rounded text-[10px] font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10`} title="Mark satisfied with your note on the record">✓ Satisfied</button>
            )}
            {unverifiedGreen && (
              <button onClick={() => void override({ status: "satisfied" }, "Verify this item",
                "Say what you checked. Your note goes on the record with your name and makes this green a human decision — the sweep's citation stays attached, and the sweep will not withdraw it from then on.")}
                className={`${DECISION_TARGET} px-1.5 py-0.5 rounded text-[10px] font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10`}
                title="Confirm this machine green yourself — only a checklist whose every green carries a person can be cited as proof elsewhere">✓ Verify</button>
            )}
            {!na && (
              <button onClick={() => void override({ applicability: "na", status: "na" }, "Mark not applicable")}
                className={`${DECISION_TARGET} px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]`} title="Not applicable to this job — your reason goes on the record">N/A</button>
            )}
            {unreasonedNa && (
              <button onClick={() => void override({ applicability: "na", status: "na" }, "Confirm not applicable",
                "Say why this item does not apply to this job. Your reason goes on the record with your name and makes this N/A your decision.")}
                className={`${DECISION_TARGET} px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]`}
                title="Confirm the assessment's N/A yourself — only a checklist where a person stands behind every N/A can be cited as proof elsewhere">✓ Confirm N/A</button>
            )}
            {na && (
              <button onClick={() => void override({ applicability: "applies", status: "open" }, "Reopen this item")}
                className={`${DECISION_TARGET} px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]`}>Reopen</button>
            )}
          </span>
        )}
        {busy && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-accent)] shrink-0" />}
      </div>
    </li>
  );
}

/** An evidence citation. A sweep chip is emerald and says so; a person's
 *  chip is sky. A chip that names a document shows that document's CURRENT
 *  status and revision — a citation to a Void or Superseded document turns
 *  rose so nobody reads it as proof (SAF-1 / QUAL-1). */
function EvidenceChip({ chip, doc, checked }: { chip: ChecklistItem["evidence"][number]; doc?: DocStanding; checked: boolean }) {
  const stale = doc ? (NOT_CURRENT_STATUSES.has(doc.status ?? "") || doc.status === "Draft") : false;
  // No row back from a lookup that ran: the viewer cannot read the cited
  // document (access-restricted for them, or removed) — the citation itself
  // is unchanged, so never call it "not found".
  const hidden = !doc && Boolean(chip.documentId) && checked;
  const tone = stale
    ? "border-rose-500/50 bg-rose-500/[0.08] text-rose-700 dark:text-rose-300"
    : chip.source === "auto"
      ? "border-emerald-500/40 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300"
      : "border-sky-500/40 bg-sky-500/[0.07] text-sky-700 dark:text-sky-300";
  const standing = doc ? ` · ${doc.status ?? "status unknown"}${doc.rev ? ` rev ${doc.rev}` : ""}` : hidden ? " · not visible to you" : "";
  const title = `${chip.source === "auto" ? "Found by the evidence sweep" : "Attached by a person"}${doc ? ` — the cited document is currently ${doc.status ?? "of unknown status"}${doc.rev ? `, rev ${doc.rev}` : ""}` : ""}${hidden ? " — you can't open the cited document (it is access-restricted for you, or it was removed); ask someone who can to check its status" : ""}${stale ? ". This citation no longer proves anything." : ""}`;
  return (
    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${tone}`} title={title}>
      <span className="font-black uppercase tracking-wider mr-1">{chip.source === "auto" ? "Sweep" : "Attached"}</span>
      {chip.label}{standing}
    </span>
  );
}

// ── Turnover package ─────────────────────────────────────────────────────

/** A small document picker for "which document did you accept?" (QUAL-13). */
function DocPicker({ orgId, title, onPick, onSkip, onCancel }: {
  orgId: string; title: string;
  onPick: (doc: { id: string; label: string }) => void; onSkip: () => void; onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ q: string; rows: Array<{ id: string; label: string; status: string | null }> }>({ q: "", rows: [] });
  const q = query.trim();
  const results = q.length >= 2 && found.q === q ? found.rows : [];
  useEffect(() => {
    if (q.length < 2) return;
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from("documents").select("id, document_number, title, name, status")
        .eq("org_id", orgId)
        .or(`document_number.ilike.%${q}%,title.ilike.%${q}%,name.ilike.%${q}%`)
        .limit(8);
      setFound({ q, rows: (((data ?? []) as Array<Record<string, unknown>>)).map((d) => ({
        id: String(d.id), label: String(d.document_number || d.title || d.name || "Document"), status: (d.status as string | null) ?? null,
      })) });
    }, 250);
    return () => clearTimeout(t);
  }, [q, orgId]);
  return (
    <div className="mt-2 rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)]/20 p-2.5 space-y-1.5">
      <div className="text-[11px] font-bold text-[var(--color-text)]">{title}</div>
      <div className="text-[10px] text-[var(--color-text-muted)]">Name the document you reviewed so the acceptance points at a revision, not a memory.</div>
      <span className="relative block">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-faint)]" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
          placeholder="Find the document (by number or title)…"
          className="w-full h-8 pl-8 pr-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-xs" />
      </span>
      {results.length > 0 && (
        <ul className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] overflow-hidden">
          {results.map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => onPick(d)} className={`${DECISION_TARGET} w-full px-3 py-1.5 text-left text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2`}>
                <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> {d.label}
                {d.status && <span className="ml-auto text-[9px] font-bold uppercase text-[var(--color-text-faint)]">{d.status}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 text-[10px] font-bold">
        <button type="button" onClick={onSkip} className={`${DECISION_TARGET} px-1.5 rounded underline text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]`}>Accept without naming a document</button>
        <button type="button" onClick={onCancel} className={`${DECISION_TARGET} ml-auto px-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]`}>Cancel</button>
      </div>
    </div>
  );
}

function TurnoverSection({ orgId, projectId, canManage, actor, signoff, items, events, loadError, historyError, onRetry, jobKind, onChanged, onEvidenceSwept, contractors = [], contractorsState = "ready" }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor; signoff: SignoffContext;
  items: TurnoverItem[]; events: TurnoverReviewEvent[];
  /** The items' read failed / the history's read failed (UX-10). */
  loadError?: string; historyError?: string; onRetry: () => void;
  jobKind: string | null;
  onChanged: () => void;
  /** UX-16: an acceptance swept the checklists — the section re-reads them. */
  onEvidenceSwept: () => void;
  /** COST-12 / MON-7: who delivers an item — its acceptance counts for the
   *  Known Company that contractor is linked to. */
  contractors?: CostParty[];
  /** Whether `contractors` is the project's list yet (UX-10, final review). */
  contractorsState?: ContractorsState;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [addName, setAddName] = useState("");
  const [addParty, setAddParty] = useState("");
  /** MON-7: the contractor the seeded package is assigned to (optional). */
  const [seedParty, setSeedParty] = useState("");
  const contractorName = useMemo(() => contractorNames(contractors), [contractors]);
  const pickable = useMemo(() => pickableContractors(contractors), [contractors]);
  const unread = contractorsState === "failed";
  const addItem = async () => {
    if (!addName.trim()) return;
    const r = await addTurnoverItem({ orgId, projectId, name: addName, partyId: addParty || null, actor });
    if (!r.ok) setNotice(failure(r.error ?? "Couldn't add."));
    else { setAddName(""); onChanged(); }
  };
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [accepting, setAccepting] = useState<TurnoverItem | null>(null);
  /** QUAL-4: an acceptance or a waiver waiting on the signing ceremony — the
   *  reviewed document already picked (undefined when the picker was
   *  skipped) or the waiver's reason already given. */
  const [signingDecision, setSigningDecision] = useState<
    { item: TurnoverItem; status: "accepted"; documentId?: string } | { item: TurnoverItem; status: "waived"; note: string } | null
  >(null);
  /** Why the open ceremony's last signing failed — said inside the ceremony,
   *  which stays open (and keeps the decision) until a signing lands. */
  const [signingError, setSigningError] = useState<string | null>(null);
  const [reviewedDocs, setReviewedDocs] = useState<Record<string, { label: string; status: string | null; rev: string | null; libraryId: string | null }>>({});
  const progress = useMemo(() => computeTurnoverProgress(items), [items]);
  const documentIds = useMemo(() => [...new Set(items.map((i) => i.documentId).filter((x): x is string => Boolean(x)))].sort().join(","), [items]);
  useEffect(() => {
    if (!documentIds) return;
    let cancelled = false;
    void (async () => {
      // The reviewed document's label and CURRENT standing (QUAL-13).
      const { data } = await supabase.from("documents").select("id, document_number, title, name, status, rev, library_id")
        .in("id", documentIds.split(",")).limit(300);
      if (cancelled) return;
      const map: Record<string, { label: string; status: string | null; rev: string | null; libraryId: string | null }> = {};
      for (const d of ((data ?? []) as Array<Record<string, unknown>>)) {
        map[String(d.id)] = {
          label: String(d.document_number || d.title || d.name || "Document"),
          status: (d.status as string | null) ?? null, rev: (d.rev as string | null) ?? null,
          libraryId: (d.library_id as string | null) ?? null,
        };
      }
      setReviewedDocs(map);
    })();
    return () => { cancelled = true; };
  }, [documentIds]);
  const eventsByItem = useMemo(() => {
    const by = new Map<string, TurnoverReviewEvent[]>();
    for (const e of events) by.set(e.itemId, [...(by.get(e.itemId) ?? []), e]);
    return by;
  }, [events]);

  const seed = async () => {
    setBusy("seed"); setNotice(null);
    const res = await seedTurnoverItems({ orgId, projectId, jobKind, partyId: seedParty || null, actor });
    setBusy(null);
    if (!res.ok) { setNotice(failure(res.error ?? "Couldn't seed.")); return; }
    setNotice(res.added > 0 ? success(`Added ${res.added} required item${res.added === 1 ? "" : "s"}.`) : info("Every required item for this job size is already listed."));
    onChanged();
  };

  /** Settles a write and hands its result back, so a caller closes what it
   *  opened only once the write landed. UX-16: an acceptance (or the
   *  reopening of one) swept the project's open checklists — say what it
   *  did, and have the checklists re-read the items it changed. */
  const finish = (res: { ok: boolean; error?: string; evidenceSweep?: ProjectSweepOutcome }): { ok: boolean; error?: string } => {
    setBusy(null);
    if (!res.ok) setNotice(failure(res.error ?? "Couldn't update.")); else { setNotice(null); onChanged(); }
    const swept = res.ok && res.evidenceSweep ? describeProjectSweep(res.evidenceSweep) : null;
    if (swept) { setNotice(swept.ok ? success(swept.text) : failure(swept.text)); onEvidenceSwept(); }
    return res;
  };

  const review = async (item: TurnoverItem, status: TurnoverItem["status"], documentId?: string | null, signed?: SignoffInput, waiverNote?: string): Promise<{ ok: boolean; error?: string } | null> => {
    let note: string | null = waiverNote ?? null;
    if (status === "rejected") {
      note = await promptReason(
        `Reject "${item.name}"`,
        "Why is it not acceptable? The contractor sees this reason, it lands on their record, and it is kept as a nonconformance.",
        "Reason (at least 10 characters)",
      );
      if (note === null) return null;
    }
    setBusy(item.id); setNotice(null);
    return finish(await reviewTurnoverItem({ item, status, note, ...(documentId !== undefined ? { documentId } : {}), actor, ...(signed ? { signoff: signed } : {}) }));
  };

  // QUAL-4: a waiver clears the item from the package as an acceptance does,
  // so it is a signed sign-off too — the reason first (checked against the
  // bar before anyone is asked to sign), then the ceremony.
  const startWaive = async (item: TurnoverItem) => {
    const note = await promptReason(
      `Waive "${item.name}"`,
      "Why can this job go without it? A waiver is a signed sign-off: it goes on the record with your e-signature — and a waived item is counted apart from an accepted one.",
      "Reason (at least 10 characters)",
    );
    if (note === null) return;
    const problem = reasonProblem(note);
    if (problem) { setNotice(failure(problem)); return; }
    setSigningDecision({ item, status: "waived", note: note.trim() });
  };

  /** MON-7: assign a seeded or existing item to its contractor (or, while it
   *  is undecided, change it) — its acceptance then counts for that
   *  contractor's Known Company. */
  const assign = async (item: TurnoverItem, partyId: string) => {
    setBusy(item.id); setNotice(null);
    finish(await assignTurnoverContractor({ item, partyId: partyId || null, actor }));
  };

  /** MON-7 (J10 third fix): an accepted or waived item with no contractor is
   *  named only through "Assign" and a confirm that names the item, the
   *  contractor and its Known Company and says it is permanent — a pick on
   *  the select alone writes nothing. */
  const lateAssign = async (item: TurnoverItem, contractor: CostParty) => {
    if (item.status !== "accepted" && item.status !== "waived") return;
    if (!(await confirmLateContractor({ itemName: item.name, decided: item.status, contractor }))) return;
    setBusy(item.id); setNotice(null);
    finish(await assignTurnoverContractor({ item, partyId: contractor.id, actor }));
  };

  const reopen = async (item: TurnoverItem) => {
    const reason = await promptReason(`Reopen "${item.name}"`,
      `This item is ${item.status}. Reopening sends it back for review; the ${item.status === "accepted" ? "acceptance" : "waiver"} stays in the history with your reason.`,
      "Why reopen? (at least 10 characters)");
    if (reason === null) return;
    setBusy(item.id); setNotice(null);
    finish(await reopenTurnoverItem({ item, reason, actor }));
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <PackageCheck className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Turnover package — QA/QC sign-off</span>
        {progress.required > 0 && (
          <span className="text-[10px] font-bold tabular-nums text-[var(--color-text-muted)]">
            {progress.accepted}/{progress.required} accepted{progress.waived > 0 ? ` · ${progress.waived} waived` : ""}{progress.received > 0 ? ` · ${progress.received} awaiting review` : ""}
          </span>
        )}
        {canManage && !loadError && (
          <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {pickable.length > 0 ? (
              <ContractorPicker contractors={pickable} value={seedParty} onChange={setSeedParty} label="Contractor who delivers the seeded items" />
            ) : unread ? (
              <ContractorsUnavailable text="Seeded items get no contractor — the project's contractors couldn't be loaded" />
            ) : null}
            <button onClick={() => void seed()} disabled={busy != null}
              className={`${DECISION_TARGET} inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors`}
              title={`Adds the required contents for a ${jobKind ?? "standard"} job (existing items are kept).`}>
              {busy === "seed" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Seed required contents
            </button>
          </span>
        )}
      </div>

      {notice && <div className="px-4 pt-3"><Notice notice={notice} onClose={() => setNotice(null)} /></div>}

      {/* UX-15: the turnover words, said where they are used. */}
      {!loadError && items.length > 0 && (
        <p data-turnover-key className="px-4 pt-2 text-[10px] text-[var(--color-text-muted)]">
          <b>Accepted</b> — {TURNOVER_STATUS_MEANING.accepted} · <b>Waived</b> — {TURNOVER_STATUS_MEANING.waived} · <b>Rejected</b> — {TURNOVER_STATUS_MEANING.rejected}.
        </p>
      )}

      {!loadError && historyError && items.length > 0 && (
        <div role="alert" className="px-4 pt-2 text-[10px] font-bold text-rose-700 dark:text-rose-300">
          Review history unavailable — {historyError} · <button type="button" onClick={onRetry} className="underline">Retry</button>
        </div>
      )}

      {loadError ? (
        <LoadFailed what="The turnover package" error={loadError} onRetry={onRetry} />
      ) : items.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
          Nothing required yet. Seed the standard contents for this job size, or add items by hand —
          then track what the contractor has actually delivered and whether QA/QC accepted it.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {items.map((it) => {
            const history = eventsByItem.get(it.id) ?? [];
            // DEC-12: whoever added the item sees why a second person accepts
            // or waives it — and, while that is not known, why it waits.
            const separation = signoffSeparation(it.createdBy, actor.uid, signoff.otherSigners, "turnover");
            const separationReason = separation.pending ? signoff.pendingReason : separation.reason;
            return (
              <li key={it.id} className="px-4 py-2.5 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-[var(--color-text)]">{it.name}</span>
                  {canManage && busy !== it.id && pickable.length > 0 && (it.status === "open" || it.status === "received") ? (
                    // Undecided: written only by Assign / Save (the select
                    // alone writes nothing) — it can still be changed.
                    <ContractorSave key={it.partyId ?? ""} contractors={contractors} current={it.partyId ?? ""}
                      label={`Contractor who delivers ${it.name}`} onSave={(v) => void assign(it, v)} />
                  ) : canManage && busy !== it.id && pickable.length > 0 && !it.partyId && (it.status === "accepted" || it.status === "waived") ? (
                    // Decided: nothing is written until Assign is confirmed.
                    <LateContractorAssign contractors={pickable} label={`Contractor who delivered ${it.name}`} onAssign={(c) => void lateAssign(it, c)} />
                  ) : it.partyId ? (
                    <span className="text-[10px] text-[var(--color-text-muted)]">· {assignedName(contractorName, it.partyId, contractorsState)}</span>
                  ) : canManage && unread && it.status !== "rejected" ? (
                    <ContractorsUnavailable text="· no contractor — one can be assigned once the project's contractors load" />
                  ) : canManage && it.status === "rejected" && pickable.length > 0 ? (
                    <span className="text-[10px] text-[var(--color-text-muted)]">· no contractor — name one once the resubmission is accepted</span>
                  ) : null}
                  {!it.required && <span className="text-[9px] font-bold text-[var(--color-text-faint)]">optional</span>}
                  <TurnoverChip status={it.status} />
                  {canManage && busy !== it.id && (
                    <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
                      {it.status === "open" && (
                        <button onClick={() => void review(it, "received")} className={`${DECISION_TARGET} px-1.5 py-0.5 rounded text-[10px] font-bold text-sky-700 dark:text-sky-300 hover:bg-sky-500/10`}>Received</button>
                      )}
                      {(it.status === "received" || it.status === "rejected") && (separation.blocked ? (
                        <button type="button" disabled aria-disabled title={separationReason ?? undefined}
                          className={`${DECISION_TARGET} px-1.5 py-0.5 rounded text-[10px] font-bold text-emerald-700/50 dark:text-emerald-300/50 cursor-not-allowed`}>
                          {separation.pending ? "Accept — checking who else can sign" : "Accept — needs a second person"}
                        </button>
                      ) : (
                        <button onClick={() => setAccepting(it)} className={`${DECISION_TARGET} px-1.5 py-0.5 rounded text-[10px] font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10`}
                          title={separation.singleSigner ? "You added this item and nobody else on this project can accept it — your acceptance will be marked single-signer." : "Accept — signed with your e-signature"}>
                          Accept
                        </button>
                      ))}
                      {it.status === "received" && (
                        <button onClick={() => void review(it, "rejected")} className={`${DECISION_TARGET} px-1.5 py-0.5 rounded text-[10px] font-bold text-rose-700 dark:text-rose-300 hover:bg-rose-500/10`}>Reject</button>
                      )}
                      {(it.status === "open" || it.status === "received") && (separation.blocked ? (
                        <button type="button" disabled aria-disabled title={separationReason ?? undefined}
                          className={`${DECISION_TARGET} px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-faint)] cursor-not-allowed`}>
                          {separation.pending ? "Waive — checking who else can sign" : "Waive — needs a second person"}
                        </button>
                      ) : (
                        <button onClick={() => void startWaive(it)} className={`${DECISION_TARGET} px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]`}
                          title={separation.singleSigner ? "You added this item and nobody else on this project can waive it — your waiver will be marked single-signer." : "Waive — your reason, signed with your e-signature"}>
                          Waive
                        </button>
                      ))}
                      {(it.status === "accepted" || it.status === "waived") && (
                        <button onClick={() => void reopen(it)} className={`${DECISION_TARGET} inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]`}
                          title={`Reopen this ${it.status} item for review — the ${it.status === "accepted" ? "acceptance" : "waiver"} stays in the history.`}>
                          <RotateCcw className="w-3 h-3" /> Reopen
                        </button>
                      )}
                    </span>
                  )}
                  {busy === it.id && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-accent)] ml-auto" />}
                </div>
                <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                  {[
                    it.description,
                    it.reviewedByName ? `${it.status} by ${it.reviewedByName}${it.reviewedAt ? ` on ${fmtDay(new Date(it.reviewedAt))}` : ""}` : null,
                    (it.status === "accepted" || it.status === "waived") && it.reviewedSignatureId ? "signed" : null,
                    (it.status === "accepted" || it.status === "waived") && it.reviewedSingleSigner ? "single-signer (nobody else could sign it off)" : null,
                    it.reviewNote ? `“${it.reviewNote}”` : null,
                  ].filter(Boolean).join(" · ")}
                  {it.documentId && (() => {
                    const d = reviewedDocs[it.documentId];
                    const text = d ? `${d.label}${d.status ? ` · ${d.status}` : ""}${d.rev ? ` rev ${d.rev}` : ""}` : "reviewed document";
                    const inner = <><FileText className="w-3 h-3" /> {text}</>;
                    return (
                      <>
                        {" · "}
                        {d?.libraryId ? (
                          <a href={`/documents/${d.libraryId}?doc=${it.documentId}`} className="underline inline-flex items-center gap-0.5" title="The document that was reviewed">{inner}</a>
                        ) : (
                          <span className="inline-flex items-center gap-0.5" title="The document that was reviewed">{inner}</span>
                        )}
                      </>
                    );
                  })()}
                </div>
                {history.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-[10px] text-[var(--color-text-faint)]">
                    {history.map((e) => (
                      <li key={e.id}>
                        {e.kind === "nonconformance" ? <span className="font-black uppercase text-rose-600 dark:text-rose-400 mr-1">nonconformance</span>
                          : e.kind === "reopen" ? <span className="font-black uppercase mr-1">reopened</span> : null}
                        {e.fromStatus ? `${e.fromStatus} → ` : ""}{e.toStatus}{e.reviewerName ? ` by ${e.reviewerName}` : ""}{e.createdAt ? ` on ${fmtDay(new Date(e.createdAt))}` : ""}{e.note ? ` — “${e.note}”` : ""}
                      </li>
                    ))}
                  </ul>
                )}
                {accepting?.id === it.id && (
                  <DocPicker orgId={orgId} title={`Accept "${it.name}" — which document did you review?`}
                    onPick={(d) => { setAccepting(null); setSigningDecision({ item: it, status: "accepted", documentId: d.id }); }}
                    onSkip={() => { setAccepting(null); setSigningDecision({ item: it, status: "accepted" }); }}
                    onCancel={() => setAccepting(null)} />
                )}
                {signingDecision?.item.id === it.id && (
                  <SignatureCeremony
                    signerName={signoff.signerName}
                    resourceLabel={`turnover item "${it.name}"`}
                    defaultIntent="Reviewed"
                    lockIntent
                    defaultStatement={signingDecision.status === "accepted"
                      ? `I, ${signoff.signerName}, have reviewed "${it.name}" and accept it for this project's turnover package, and affirm this as my electronic signature.`
                      : `I, ${signoff.signerName}, waive "${it.name}" for this project's turnover package — ${signingDecision.note} — and affirm this as my electronic signature.`}
                    busy={busy === it.id}
                    error={signingError}
                    onCancel={() => { if (busy !== it.id) { setSigningError(null); setSigningDecision(null); } }}
                    onSign={(_intent, statement, signatureImage, reauth) => {
                      // The ceremony stays open, busy, while the decision is
                      // written, and closes only once it lands: a refused or
                      // failed signature keeps the reviewer's document pick
                      // or waiver reason, says why inside the ceremony, and
                      // lets them sign again or cancel (as ChecklistCard keeps
                      // its ceremony open until complete() has its answer).
                      const pending = signingDecision;
                      setSigningError(null);
                      const signed: SignoffInput = { statement, signatureImage: signatureImage ?? null, reauth: reauth ?? null, signerName: signoff.signerName };
                      const decided = pending.status === "accepted"
                        ? review(pending.item, "accepted", pending.documentId, signed)
                        : review(pending.item, "waived", undefined, signed, pending.note);
                      void decided.then((res) => {
                        if (res?.ok) setSigningDecision((cur) => (cur === pending ? null : cur));
                        else if (res) setSigningError(res.error ?? "Couldn't update.");
                      });
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canManage && !loadError && (
        <div className="px-4 py-2.5 border-t border-[var(--color-border)] flex items-center gap-2 flex-wrap">
          <input value={addName} onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void addItem(); }}
            placeholder="Add a required item — e.g. Torque records"
            className="h-8 flex-1 min-w-40 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
          {pickable.length > 0 ? (
            <ContractorPicker contractors={pickable} value={addParty} onChange={setAddParty} label="Contractor who delivers it" />
          ) : unread ? (
            <ContractorsUnavailable text="No contractor can be chosen — the project's contractors couldn't be loaded; the item is added without one" />
          ) : null}
          <button onClick={() => void addItem()}
            className={`${DECISION_TARGET} h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)]`}>
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>
      )}
    </div>
  );
}

/** The contractors a picker offers for a NEW choice — inactive ones are
 *  left out (J10 third fix: the list itself keeps them, see QualityTab). */
function pickableContractors(contractors: CostParty[]): CostParty[] {
  return contractors.filter((c) => c.status !== "inactive");
}

/** Every contractor's name, an inactive one marked — an item assigned to a
 *  contractor later set inactive still says who it counts for. */
function contractorNames(contractors: CostParty[]): Map<string, string> {
  return new Map(contractors.map((c) => [c.id, c.status === "inactive" ? `${c.name} (inactive)` : c.name]));
}

/** Whether the project's contractors have been read (UX-10, final review). */
type ContractorsState = "loading" | "ready" | "failed";

/** The name an assigned item shows. "Not on this project's list" is said
 *  only once the list answered — while it is unread, an id it cannot name
 *  is "not loaded" (a broken read is never shown as data). */
function assignedName(names: Map<string, string>, partyId: string, state: ContractorsState): string {
  return names.get(partyId) ?? (state === "ready" ? "a contractor not on this project's list" : "contractor not loaded");
}

/** Where a contractor picker would be while the project's contractors
 *  can't be read: it says why it is not there, never vanishes silently. */
function ContractorsUnavailable({ text }: { text: string }) {
  return <span data-contractors-unavailable className="text-[10px] text-[var(--color-text-muted)]">{text}</span>;
}

/** The contractor an item is assigned to (optional). Its acceptance or
 *  close-out counts for the Known Company that contractor is linked to; an
 *  unassigned or unlinked one counts for nobody (never as a zero). The
 *  options are the active contractors plus the one already chosen (and the
 *  item's own, `keep`) — marked "(inactive)" when it is, and named as
 *  missing when it is not on the list at all — so the select never shows
 *  another contractor than the item's. */
function ContractorPicker({ contractors, value, onChange, label, placeholder = "Contractor (optional)…", compact = false, keep = "" }: {
  contractors: CostParty[]; value: string; onChange: (v: string) => void; label: string;
  placeholder?: string;
  /** A row's own control (MON-7): smaller, with the decision-target floor. */
  compact?: boolean;
  /** The item's recorded contractor, offered even while another is picked. */
  keep?: string;
}) {
  const options = contractors.filter((c) => c.status !== "inactive" || c.id === value || (keep !== "" && c.id === keep));
  const missing = value !== "" && !options.some((c) => c.id === value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} title={`${label} — their company's scorecard counts it`}
      className={compact
        ? `${DECISION_TARGET} max-w-44 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[10px] text-[var(--color-text-muted)]`
        : "h-8 max-w-48 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs"}>
      <option value="">{placeholder}</option>
      {missing && <option value={value}>A contractor not on this project&apos;s list</option>}
      {options.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === "inactive" ? " (inactive)" : ""}{c.companyId ? "" : " (unlinked)"}</option>)}
    </select>
  );
}

/** MON-7 / COST-12 (final review): an UNDECIDED item's contractor is
 *  written only by its button — the select alone writes nothing (a
 *  keyboard arrow on a closed select fires `change` in some browsers, so
 *  one keystroke used to assign the first contractor). "Assign" names one
 *  for an unassigned item, "Save" changes or clears it; it can still be
 *  changed while the item is undecided, so no confirm is asked. */
function ContractorSave({ contractors, current, label, onSave }: {
  contractors: CostParty[]; current: string; label: string; onSave: (partyId: string) => void;
}) {
  const [pick, setPick] = useState(current);
  const changed = pick !== current;
  const chosen = contractors.find((c) => c.id === pick) ?? null;
  const verb = current ? "Save" : "Assign";
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <ContractorPicker contractors={contractors} value={pick} keep={current} onChange={setPick} label={label}
        placeholder={current ? "No contractor" : "Assign contractor…"} compact />
      <button type="button" disabled={!changed} onClick={() => { if (changed) onSave(pick); }}
        aria-label={!changed ? `${verb} — choose a different contractor first` : chosen ? `${verb} ${chosen.name}` : `${verb} — clear the contractor`}
        className={`${DECISION_TARGET} px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text)] border border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 disabled:cursor-not-allowed`}>
        {verb}
      </button>
    </span>
  );
}

/** MON-7 (J10 third fix): naming the contractor of an item that is ALREADY
 *  decided attributes the decision to that contractor's company at once,
 *  and the name never moves afterwards — so choosing on the select writes
 *  nothing (a keyboard arrow on a closed select fires `change`); the
 *  "Assign" button asks first (`confirmLateContractor`). */
function LateContractorAssign({ contractors, label, onAssign }: {
  contractors: CostParty[]; label: string; onAssign: (c: CostParty) => void;
}) {
  const [pick, setPick] = useState("");
  const chosen = contractors.find((c) => c.id === pick) ?? null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <ContractorPicker contractors={contractors} value={pick} onChange={setPick} label={label} placeholder="Name the contractor…" compact />
      <button type="button" disabled={!chosen} onClick={() => { if (chosen) onAssign(chosen); }}
        aria-label={chosen ? `Assign ${chosen.name} — asks before anything is written` : "Assign — choose a contractor first"}
        className={`${DECISION_TARGET} px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text)] border border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 disabled:cursor-not-allowed`}>
        Assign
      </button>
    </span>
  );
}

/** The confirm before a decided item's contractor is named: the item, the
 *  contractor, the Known Company it counts for (read now; said plainly when
 *  it cannot be read or the contractor is unlinked), what that does to the
 *  company's Quality score, and that the name is permanent — a turnover
 *  item's only way back is reopening the signed decision. */
async function confirmLateContractor(input: {
  itemName: string;
  decided: "accepted" | "waived" | "done" | "void";
  contractor: CostParty;
}): Promise<boolean> {
  const { itemName, decided, contractor: c } = input;
  let company: string | null = null;
  if (c.companyId) {
    try { company = (await getCompany(c.companyId))?.name ?? null; } catch { company = null; }
  }
  const statusWord = decided === "done" ? "closed" : decided === "void" ? "voided" : decided;
  const effect = decided === "accepted" ? "its acceptance counts toward that company's Quality score"
    : decided === "done" ? "its close-out counts toward that company's Quality score"
    : `a ${statusWord} item is not scored, but it is theirs on the record`;
  const counts = c.companyId
    ? `It will count for ${company ? `the Known Company “${company}”` : `the Known Company ${c.name} is linked to`} — ${effect}.`
    : `${c.name} is not linked to a Known Company, so it counts for nobody until the contractor is linked on the Costs tab — then for that company.`;
  const permanent = decided === "accepted" || decided === "waived"
    ? `The contractor can't be changed afterwards without reopening the signed ${decided === "accepted" ? "acceptance" : "waiver"} and signing it again.`
    : "The contractor can't be changed afterwards.";
  return appConfirm({
    title: `Name ${c.name} for “${itemName}”?`,
    message: `“${itemName}” is already ${statusWord}. ${counts} ${permanent}`,
    confirmLabel: `Assign ${c.name}`,
  });
}

function TurnoverChip({ status }: { status: TurnoverItem["status"] }) {
  const tone = status === "accepted" ? "border-emerald-500/40 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300"
    : status === "received" ? "border-sky-500/40 bg-sky-500/[0.07] text-sky-700 dark:text-sky-300"
    : status === "rejected" ? "border-rose-500/40 bg-rose-500/[0.07] text-rose-700 dark:text-rose-300"
    : status === "waived" ? "border-[var(--color-border)] text-[var(--color-text-faint)]"
    : "border-amber-500/40 bg-amber-500/[0.07] text-amber-700 dark:text-amber-300";
  return (
    <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${tone}`}>
      {TURNOVER_STATUS_LABEL[status] ?? status}
    </span>
  );
}

// ── Punch list ───────────────────────────────────────────────────────────

function PunchSection({ orgId, projectId, canManage, actor, items, loadError, onRetry, onChanged, contractors = [], contractorsState = "ready" }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  items: PunchItem[]; loadError?: string; onRetry: () => void; onChanged: () => void;
  /** COST-12 / MON-7: whose snag it is — its burn-down counts for the
   *  Known Company that contractor is linked to. */
  contractors?: CostParty[];
  /** Whether `contractors` is the project's list yet (UX-10, final review). */
  contractorsState?: ContractorsState;
}) {
  const [title, setTitle] = useState("");
  const [party, setParty] = useState("");
  const contractorName = useMemo(() => contractorNames(contractors), [contractors]);
  const pickable = useMemo(() => pickableContractors(contractors), [contractors]);
  const unread = contractorsState === "failed";
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const open = items.filter((i) => i.status === "open");
  const closed = items.filter((i) => i.status !== "open");
  // Captured once at mount — render stays pure.
  const [now] = useState(() => Date.now());

  const add = async () => {
    if (!title.trim()) return;
    setBusy("add"); setNotice(null);
    const res = await addPunchItem({ orgId, projectId, title, dueDate: due || null, location: location || null, description: description || null, partyId: party || null, actor });
    setBusy(null);
    if (!res.ok) { setNotice(failure(res.error ?? "Couldn't add.")); return; }
    setTitle(""); setDue(""); setLocation(""); setDescription(""); setParty(""); onChanged();
  };

  /** MON-7: assign an existing punch item to its contractor (or, while it is
   *  open, change it) — its close-out then counts for that contractor's
   *  Known Company. */
  const assign = async (it: PunchItem, partyId: string) => {
    setBusy(it.id); setNotice(null);
    const r = await assignPunchContractor({ item: it, partyId: partyId || null, actor });
    setBusy(null);
    if (!r.ok) setNotice(failure(r.error ?? "Couldn't change the contractor.")); else onChanged();
  };

  /** MON-7 (J10 third fix): a closed or voided item with no contractor is
   *  named only through "Assign" and the confirm — never on the pick. */
  const lateAssign = async (it: PunchItem, contractor: CostParty) => {
    if (it.status === "open") return;
    if (!(await confirmLateContractor({ itemName: it.title, decided: it.status, contractor }))) return;
    await assign(it, contractor.id);
  };

  const close = async (it: PunchItem, status: "done" | "void") => {
    // SAF-4: void needs a reason; done records what closed it.
    const note = status === "void"
      ? await promptReason(`Void "${it.title}"`, "Why is this not a real snag? The reason goes on the record.")
      : await appPrompt({ title: `Done — "${it.title}"`, message: "What was done, and who verified it? (optional — it goes on the closure record)", placeholder: "e.g. Insulation reinstalled, verified by J. Chen 9/14" });
    if (note === null) return;
    setBusy(it.id); setNotice(null);
    const r = await setPunchStatus({ item: it, status, note, actor });
    setBusy(null);
    if (!r.ok) setNotice(failure(r.error ?? "Couldn't update.")); else { setNotice(null); onChanged(); }
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <ListChecks className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Punch list</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">The closeout snag list — visible until it&apos;s empty.</span>
        {open.length > 0 && (
          <span className="ml-auto text-[10px] font-black px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/40">{open.length} open</span>
        )}
      </div>

      {notice && <div className="px-4 pt-3"><Notice notice={notice} onClose={() => setNotice(null)} /></div>}

      {canManage && !loadError && (
        <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            placeholder="e.g. Reinstall insulation at E-301 north nozzle"
            className="h-8 flex-1 min-w-56 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
          <input value={location} onChange={(e) => setLocation(e.target.value)}
            placeholder="Location / tag (optional)" aria-label="Location or equipment tag"
            className="h-8 w-40 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
          <input value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Details (optional)" aria-label="Description"
            className="h-8 w-48 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date"
            className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs [color-scheme:light] dark:[color-scheme:dark]" />
          {pickable.length > 0 ? (
            <ContractorPicker contractors={pickable} value={party} onChange={setParty} label="Contractor responsible" />
          ) : unread ? (
            <ContractorsUnavailable text="No contractor can be chosen — the project's contractors couldn't be loaded; the item is added without one" />
          ) : null}
          <button onClick={() => void add()} disabled={busy === "add"}
            className={`${DECISION_TARGET} h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50`}>
            {busy === "add" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Add
          </button>
        </div>
      )}

      {loadError ? (
        <LoadFailed what="The punch list" error={loadError} onRetry={onRetry} />
      ) : items.length === 0 ? (
        <div className="px-4 py-5 text-center text-xs text-[var(--color-text-muted)]">Nothing on the punch list.</div>
      ) : (
        <>
        <StatusLegend marks={PUNCH_STATUS_MARKS} className="px-4 pt-2.5" />
        <ul className="divide-y divide-[var(--color-border)]">
          {[...open, ...closed].map((it) => {
            // Overdue starts AFTER the due day ends, in the viewer's timezone
            // — an item due today is due, not late.
            const overdue = it.status === "open" && it.dueDate && new Date(`${it.dueDate}T23:59:59`).getTime() < now;
            return (
              // A11Y-13 / GAP-410: a closed row is set back by its mark, its
              // "done / voided by" label, a strike and the muted text token —
              // never whole-row opacity (below 4.5 : 1 in both themes).
              <li key={it.id} className="px-4 py-2 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusMark spec={PUNCH_STATUS_MARKS[it.status === "done" ? "done" : it.status === "void" ? "void" : overdue ? "overdue" : "open"]} />
                  <span className={it.status !== "open" ? "text-[var(--color-text-muted)] line-through" : "text-[var(--color-text)]"}>{it.title}</span>
                  {it.location && <span className="text-[10px] font-bold text-[var(--color-text-muted)]">@ {it.location}</span>}
                  {canManage && busy !== it.id && pickable.length > 0 && it.status === "open" ? (
                    // Open: written only by Assign / Save (the select alone
                    // writes nothing) — it can still be changed.
                    <ContractorSave key={it.partyId ?? ""} contractors={contractors} current={it.partyId ?? ""}
                      label={`Contractor responsible for ${it.title}`} onSave={(v) => void assign(it, v)} />
                  ) : canManage && busy !== it.id && pickable.length > 0 && !it.partyId ? (
                    // Closed or voided: nothing is written until Assign is confirmed.
                    <LateContractorAssign contractors={pickable} label={`Contractor who was responsible for ${it.title}`} onAssign={(c) => void lateAssign(it, c)} />
                  ) : it.partyId ? (
                    <span className="text-[10px] text-[var(--color-text-muted)]">· {assignedName(contractorName, it.partyId, contractorsState)}</span>
                  ) : canManage && unread ? (
                    <ContractorsUnavailable text="· no contractor — one can be assigned once the project's contractors load" />
                  ) : null}
                  {it.dueDate && it.status === "open" && (
                    <span className={`text-[10px] font-bold ${overdue ? "text-rose-600 dark:text-rose-400" : "text-[var(--color-text-muted)]"}`}>
                      due {fmtDay(new Date(it.dueDate + "T00:00:00"))}{overdue ? " — overdue" : ""}
                    </span>
                  )}
                  {it.createdByName && <span className="text-[10px] text-[var(--color-text-faint)]">by {it.createdByName}</span>}
                  {it.status !== "open" && (
                    <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${it.status === "done" ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : "border-rose-500/40 text-rose-700 dark:text-rose-300"}`}>
                      {it.status === "done" ? "done" : "voided"}{it.closedByName ? ` by ${it.closedByName}` : ""}{it.closedAt ? ` on ${fmtDay(new Date(it.closedAt))}` : ""}
                    </span>
                  )}
                  {canManage && it.status === "open" && busy !== it.id && (
                    <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
                      <button onClick={() => void close(it, "done")}
                        className={`${DECISION_TARGET} px-1.5 py-0.5 rounded text-[10px] font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10`}>Done</button>
                      <button onClick={() => void close(it, "void")} aria-label={`Void "${it.title}" — not a real snag (a reason is required)`}
                        className={`${DECISION_TARGET} inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-500/10`} title="Void — not a real snag (a reason is required)">
                        <Ban className="w-3 h-3" /> Void
                      </button>
                    </span>
                  )}
                  {busy === it.id && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-accent)] ml-auto" />}
                </div>
                {(it.description || it.closureNote) && (
                  <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                    {[it.description, it.closureNote ? `${it.status === "void" ? "voided" : "closed"}: “${it.closureNote}”` : null].filter(Boolean).join(" · ")}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        </>
      )}
    </div>
  );
}
