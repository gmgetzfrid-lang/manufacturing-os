"use client";

// /admin/proposed-links — review what the system found.
//
// The engine reads what extraction already stored — off-page connector
// continuity, shared equipment tags, aliases — and files each discovered
// connection here WITH ITS EVIDENCE. Provable ones (an OPC reference that
// resolves to exactly one sheet) applied themselves and are listed as such;
// everything inferred waits for a human.
//
// Two rules this page exists to keep:
//   * a link with no visible reason is worse than no link, so every row
//     shows why the system thinks the two documents belong together
//   * a dismissal is remembered — the same skill never proposes that pair
//     again (another skill's different evidence still can, LNK-8), and a
//     dismissal can be revisited under "Dismissed"
//
// LNK-12: the run's numbers are the truth — "queued" counts rows actually
// added or changed, a pass that finds nothing new ends the loop, and every
// input that reached a ceiling is shown next to the zeroes (LNK-2).

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Waypoints, Loader2, Check, X, RefreshCw, AlertTriangle, FileText,
  Sparkles, ShieldCheck, Info, Undo2,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import {
  listProposals, approveProposal, dismissProposal, reopenProposal,
  proposerLabel, TIER_LABELS,
  type LinkProposal, type ProposalTier,
} from "@/lib/linkProposals";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";
import ConnectionSkillsPanel from "@/components/intelligence/ConnectionSkillsPanel";

const TIER_STYLE: Record<ProposalTier, string> = {
  provable: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  strong: "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300",
  inferred: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
};

/** Mirrors ProposerInputs from the engine — what each skill had to work with. */
interface RunInputs {
  documents: number; withNumbers: number; mirroredDocs: number;
  extractedRefs: number; registryAssets: number; equipmentLinks: number;
  citedQuestions: number; customSkills: number; chunksScanned: number;
  skillsInstalled: boolean;
  /** Inputs that reached their read ceiling this run (LNK-2). */
  saturated?: string[];
}

interface RunResult {
  scanned: number; proposed: number; autoApplied: number;
  evidenceLost: number; more: boolean; notes: string[];
  errors: string[];
  heldInferred: number;
  passes: number;
  inputs?: RunInputs;
}

/** LNK-2: what each ceiling means, next to the zeroes. */
const CEILING_COPY: Record<string, string> = {
  documents: "The run read its ceiling of controlled documents — documents past it were not considered.",
  mirroredDocs: "The run read its ceiling of mirrored knowledge documents — cross-references and custom skills on the rest were not read.",
  extractedRefs: "The run read its ceiling of extracted drawing references.",
  equipmentLinks: "The run read its ceiling of document–equipment links.",
  aliases: "The run read its ceiling of equipment aliases.",
  chunksScanned: "Custom skills read their ceiling of indexed pages this pass — later pages were not scanned.",
  citedQuestions: "Answered-together reads the latest answered questions only.",
  systemLinks: "The evidence audit read its ceiling of system links.",
};

/** Zero findings must explain themselves: each empty input maps to the
 *  concrete next step that would feed it. This is the difference between
 *  "the feature is broken" and "the registry is empty". */
function diagnose(inputs: RunInputs): string[] {
  const out: string[] = [];
  if (inputs.withNumbers === 0) {
    out.push("No documents carry document numbers yet — references can't resolve to anything. Fill in numbers (the title-block ingest wizard reads them automatically).");
  }
  if (inputs.registryAssets === 0) {
    out.push("The equipment registry is empty, so the Shared equipment skill has nothing to compare. Add assets under Admin → Assets, or run the registry sweep.");
  } else if (inputs.equipmentLinks === 0) {
    out.push("No documents are linked to equipment yet — run an Equipment sweep on a library to bridge them.");
  }
  if (inputs.mirroredDocs === 0) {
    out.push("No knowledge documents mirror controlled documents. Link a document-control library as a knowledge source so extraction can read the real files.");
  } else if (inputs.extractedRefs === 0) {
    out.push("Extraction hasn't found cross-references in the mirrored documents yet (they may not be drawings, or haven't been indexed).");
  }
  if (inputs.citedQuestions === 0) {
    out.push("No answered questions cite two controlled documents yet — the Answered-together skill grows with use.");
  }
  if (inputs.customSkills === 0 && inputs.skillsInstalled) {
    out.push("No org-wide custom skills yet — teach the engine your facility's own numbering conventions above (a private skill runs once a document controller shares it).");
  } else if (inputs.customSkills > 0 && inputs.chunksScanned === 0) {
    out.push("Custom skills had no indexed text to scan — index the source documents into a knowledge library first.");
  }
  // LNK-2: a ceiling is a diagnosis too — "healthy" is never printed over it.
  for (const k of inputs.saturated ?? []) out.push(CEILING_COPY[k] ?? `The run reached its read ceiling for ${k}.`);
  return out;
}

export default function ProposedLinksPage() {
  const { activeOrgId, hasAnyRole, uid, userEmail } = useRole();
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  const canDecide = hasAnyRole(["Admin", "DocCtrl", "Manager", "Supervisor"]);
  const canRun = hasAnyRole(["Admin", "DocCtrl"]);

  const [rows, setRows] = useState<LinkProposal[] | null>(null);
  const [view, setView] = useState<"pending" | "dismissed">("pending");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RunResult | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try { setRows(await listProposals(activeOrgId, { status: view })); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [activeOrgId, view]);
  useEffect(() => { void refresh(); }, [refresh]);

  const runProposers = async () => {
    if (!activeOrgId) return;
    setRunning(true); setError(null);
    try {
      // Bounded slices: keep going while the server says there's more, so a
      // big library finishes without any single request running long.
      let last: RunResult | null = null as RunResult | null;
      for (let pass = 0; pass < 12; pass++) {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch("/api/links/propose", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token ?? ""}`,
          },
          body: JSON.stringify({ orgId: activeOrgId }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Run failed");
        // LNK-12: each pass reports rows it actually added or changed, and
        // `more` is false once a pass has nothing new — the sum is real.
        last = {
          scanned: json.scanned ?? 0,
          proposed: (last?.proposed ?? 0) + (json.proposed ?? 0),
          autoApplied: (last?.autoApplied ?? 0) + (json.autoApplied ?? 0),
          evidenceLost: (last?.evidenceLost ?? 0) + (json.evidenceLost ?? 0),
          more: !!json.more,
          notes: json.notes ?? [],
          errors: [...(last?.errors ?? []), ...((json.errors as string[] | undefined) ?? [])],
          heldInferred: json.heldInferred ?? 0,
          passes: pass + 1,
          inputs: json.inputs ?? last?.inputs,
        };
        if (!json.more) break;
      }
      setLastRun(last);
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setRunning(false); }
  };

  const decide = async (p: LinkProposal, approve: boolean) => {
    if (!uid) return;
    setBusyId(p.id);
    try {
      const actor = { userId: uid, userName: userEmail ?? undefined };
      if (approve) await approveProposal(p, actor);
      else await dismissProposal(p.id, actor);
      setRows((prev) => (prev ?? []).filter((r) => r.id !== p.id));
    } catch (e) { setError((e as Error).message); }
    finally { setBusyId(null); }
  };

  /** LNK-8: a dismissal can be revisited — back to the queue as it was. */
  const reopen = async (p: LinkProposal) => {
    setBusyId(p.id);
    try {
      await reopenProposal(p.id);
      setRows((prev) => (prev ?? []).filter((r) => r.id !== p.id));
    } catch (e) { setError((e as Error).message); }
    finally { setBusyId(null); }
  };

  const docLink = (d: LinkProposal["doc"]) =>
    d ? `/documents/${d.library_id}?doc=${d.id}` : "/documents";
  const docLabel = (d: LinkProposal["doc"]) =>
    d?.document_number || d?.title || "Document";

  return (
    <PageShell>
      <ViewTabs title="Intelligence" tabs={INTELLIGENCE_VIEWS} />
      <PageHeaderBar
        icon={Waypoints}
        eyebrow="Link discovery"
        title="Proposed connections"
        subtitle="What the system found in your own extracted data — each with the evidence behind it. Nothing here was applied without you."
        actions={canRun ? (
          <button onClick={() => void runProposers()} disabled={running}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-black text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-60">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {running ? "Scanning…" : "Find connections"}
          </button>
        ) : undefined}
      />

      <ConnectionSkillsPanel />

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-950/40 p-3">
          <AlertTriangle className="w-4 h-4 text-rose-600 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-700 dark:text-rose-300">{error}</div>
        </div>
      )}

      {lastRun && lastRun.errors.length > 0 && (
        // LNK-3: a failed auto-apply (or queue write) is an error, not a note.
        <div className="mb-3 rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/40 p-3 space-y-1">
          {lastRun.errors.map((e) => (
            <div key={e} className="flex items-start gap-2 text-xs font-bold text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {e}
            </div>
          ))}
        </div>
      )}

      {lastRun && (
        <div className="mb-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/60 p-3 space-y-1">
          <div className="text-xs font-bold text-[var(--color-text)]">
            Scanned {lastRun.scanned} documents · {lastRun.autoApplied} provable connection{lastRun.autoApplied === 1 ? "" : "s"} applied · {lastRun.proposed} new or updated in the queue
            {lastRun.passes > 1 ? ` · ${lastRun.passes} passes` : ""}
          </div>
          {lastRun.more && (
            <div className="text-[11px] text-amber-700">More connections were found than this run could queue — run it again to continue.</div>
          )}
          {lastRun.evidenceLost > 0 && (
            <div className="text-[11px] text-amber-700">
              {lastRun.evidenceLost} existing system link{lastRun.evidenceLost === 1 ? "" : "s"} no longer match their original evidence — marked, not removed.
            </div>
          )}
          {lastRun.notes.map((n) => (
            <div key={n} className="text-[11px] text-[var(--color-text-muted)] flex items-center gap-1">
              <Info className="w-3 h-3" /> {n}
            </div>
          ))}
          {/* Zero findings explain themselves — which input was empty and
              what feeds it. Silence here reads as "broken"; this is the
              honest answer instead. */}
          {lastRun.inputs && ((lastRun.proposed === 0 && lastRun.autoApplied === 0) || (lastRun.inputs.saturated?.length ?? 0) > 0) && (
            <div className="pt-1.5 mt-1 border-t border-[var(--color-border)] space-y-1">
              <div className="text-[11px] font-black text-[var(--color-text)]">
                {lastRun.proposed === 0 && lastRun.autoApplied === 0 ? "Why nothing was found" : "What this run could not read"}
              </div>
              {diagnose(lastRun.inputs).map((d) => (
                <div key={d} className="text-[11px] text-[var(--color-text-muted)] flex items-start gap-1.5">
                  <span className="mt-1 w-1 h-1 rounded-full bg-amber-500 shrink-0" /> {d}
                </div>
              ))}
              {diagnose(lastRun.inputs).length === 0 && (
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  The inputs look healthy and were read in full — everything discoverable is already linked, waiting in the queue, or was decided.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mb-3 inline-flex rounded-lg border border-[var(--color-border)] overflow-hidden text-[11px] font-black">
        {(["pending", "dismissed"] as const).map((v) => (
          <button key={v} type="button" onClick={() => { setRows(null); setView(v); }}
            className={`px-3 py-1.5 ${view === v ? "bg-violet-600 text-white" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
            {v === "pending" ? "Waiting for review" : "Dismissed"}
          </button>
        ))}
      </div>

      {rows === null ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-faint)]" /></div>
      ) : rows.length === 0 ? (
        <div className="text-center py-16 space-y-2">
          <Sparkles className="w-8 h-8 mx-auto text-[var(--color-text-faint)]" />
          <div className="text-sm font-bold text-[var(--color-text)]">{view === "dismissed" ? "Nothing dismissed" : "Nothing waiting on you"}</div>
          <p className="text-xs text-[var(--color-text-muted)] max-w-md mx-auto">
            {view === "dismissed" ? "Connections someone marked “Not related” appear here, where the decision can be revisited." : canRun
              ? "Run “Find connections” to scan your off-page connectors, equipment tags and aliases. Provable links apply themselves; anything less certain lands here for review."
              : "When the system finds connections that need a human decision, they'll appear here."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((p) => (
            <div key={p.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <div className="flex items-start gap-3 flex-wrap">
                <div className="flex-1 min-w-[16rem] space-y-1.5">
                  {/* The pair */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link href={docLink(p.doc)} className="inline-flex items-center gap-1.5 text-xs font-black text-[var(--color-text)] hover:text-[var(--color-accent)]">
                      <FileText className="w-3.5 h-3.5 text-blue-600" /> {docLabel(p.doc)}
                    </Link>
                    <span className="text-[var(--color-text-faint)] text-xs">↔</span>
                    <Link href={docLink(p.target)} className="inline-flex items-center gap-1.5 text-xs font-black text-[var(--color-text)] hover:text-[var(--color-accent)]">
                      <FileText className="w-3.5 h-3.5 text-blue-600" /> {docLabel(p.target)}
                    </Link>
                  </div>

                  {/* Why — never a bare confidence number */}
                  <div className="text-xs text-[var(--color-text)]">{p.evidence?.summary}</div>
                  {p.evidence?.detail && (
                    <div className="text-[11px] text-[var(--color-text-muted)]">{p.evidence.detail}</div>
                  )}

                  <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                    <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wide ${TIER_STYLE[p.tier]}`}>
                      {TIER_LABELS[p.tier]}
                    </span>
                    <span className="text-[10px] font-bold text-[var(--color-text-muted)]">
                      {proposerLabel(p.proposer, p.evidence)}
                    </span>
                    {p.source_rev && (
                      <span className="text-[10px] text-[var(--color-text-faint)]">from rev {p.source_rev}</span>
                    )}
                  </div>
                </div>

                {canDecide && view === "dismissed" && (
                  <button onClick={() => void reopen(p)} disabled={busyId === p.id}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-violet-700 disabled:opacity-50">
                    {busyId === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />} Back to review
                  </button>
                )}
                {canDecide && view === "pending" && (
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => void decide(p, false)} disabled={busyId === p.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-rose-600 disabled:opacity-50">
                      <X className="w-3.5 h-3.5" /> Not related
                    </button>
                    <button onClick={() => void decide(p, true)} disabled={busyId === p.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-black text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50">
                      {busyId === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Link them
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
          <div className="flex items-center gap-1.5 pt-2 text-[11px] text-[var(--color-text-muted)]">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
            {view === "pending"
              ? "A dismissal is remembered — the same skill won’t propose that pair again; a different kind of evidence can. When a document is revised, its waiting proposals are re-checked against the new revision."
              : "Put a dismissed connection back in the queue to decide it again."}
          </div>
        </div>
      )}
    </PageShell>
  );
}
