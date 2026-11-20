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
//   * a dismissed pair is remembered — the engine never nags twice

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2, Check, X, RefreshCw,
  ShieldCheck, Info,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import {
  listProposals, approveProposal, dismissProposal,
  proposerLabel, TIER_LABELS,
  type LinkProposal, type ProposalTier,
} from "@/lib/linkProposals";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary } from "@/components/ui/PageHero";
import { tbl, sheet, btnRow, StatusTag, Section, Problem, type Tone } from "@/components/admin/kit";
import { plural } from "@/components/admin/band";
import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";
import ConnectionSkillsPanel from "@/components/intelligence/ConnectionSkillsPanel";
import EstateReviewPanel from "@/components/intelligence/EstateReviewPanel";
import LoadingBlock from "@/components/ui/LoadingBlock";

const TIER_TONE: Record<ProposalTier, Tone> = {
  provable: "good",
  strong: "none",
  inferred: "warn",
};

/** Mirrors ProposerInputs from the engine — what each skill had to work with. */
interface RunInputs {
  documents: number; withNumbers: number; mirroredDocs: number;
  extractedRefs: number; registryAssets: number; equipmentLinks: number;
  citedQuestions: number; customSkills: number; chunksScanned: number;
  skillsInstalled: boolean;
}

interface RunResult {
  scanned: number; proposed: number; autoApplied: number;
  evidenceLost: number; more: boolean; notes: string[];
  inputs?: RunInputs;
}

/** Zero findings must explain themselves: each empty input maps to the
 *  concrete next step that would feed it. This is the difference between
 *  "the feature is broken" and "the registry is empty". */
function diagnose(inputs: RunInputs): string[] {
  const out: string[] = [];
  if (inputs.withNumbers === 0) {
    out.push("No documents have document numbers yet, so references can't point at anything. Fill in numbers (the title-block reader fills them in for you).");
  }
  if (inputs.registryAssets === 0) {
    out.push("The equipment list is empty, so Shared equipment has nothing to compare. Add equipment in Operating areas, or run the registry sweep.");
  } else if (inputs.equipmentLinks === 0) {
    out.push("No documents are linked to equipment yet. Run an Equipment sweep on a library to link them.");
  }
  if (inputs.mirroredDocs === 0) {
    out.push("No knowledge documents mirror controlled documents. Link a document-control library as a knowledge source so extraction can read the real files.");
  } else if (inputs.extractedRefs === 0) {
    out.push("No cross-references were found in the linked documents yet (they may not be drawings, or aren't indexed yet).");
  }
  if (inputs.citedQuestions === 0) {
    out.push("No answered questions cite two controlled documents yet. Answered-together grows with use.");
  }
  if (inputs.customSkills === 0 && inputs.skillsInstalled) {
    out.push("No custom skills yet. Teach it your site's own numbering conventions above.");
  } else if (inputs.customSkills > 0 && inputs.chunksScanned === 0) {
    out.push("Custom skills had no indexed text to scan. Index the source documents into a knowledge library first.");
  }
  return out;
}

export default function ProposedLinksPage() {
  const { activeOrgId, activeRole, uid, userEmail } = useRole();
  const canDecide = ["Admin", "DocCtrl", "Manager", "Supervisor"].includes(activeRole ?? "");
  const canRun = activeRole === "Admin" || activeRole === "DocCtrl";

  const [rows, setRows] = useState<LinkProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RunResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try { setRows(await listProposals(activeOrgId)); setLoadError(null); }
    catch (e) { setLoadError((e as Error).message || "Couldn't load the proposals."); }
  }, [activeOrgId]);
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
        last = {
          scanned: json.scanned ?? 0,
          proposed: (last?.proposed ?? 0) + (json.proposed ?? 0),
          autoApplied: (last?.autoApplied ?? 0) + (json.autoApplied ?? 0),
          evidenceLost: (last?.evidenceLost ?? 0) + (json.evidenceLost ?? 0),
          more: !!json.more,
          notes: json.notes ?? [],
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
    if (!uid) { setError("Your sign-in is still loading. Try again in a moment."); return; }
    setBusyId(p.id); setError(null);
    try {
      const actor = { userId: uid, userName: userEmail ?? undefined };
      if (approve) await approveProposal(p, actor);
      else await dismissProposal(p.id, actor);
      setRows((prev) => (prev ?? []).filter((r) => r.id !== p.id));
    } catch (e) { setError((e as Error).message); }
    finally { setBusyId(null); }
  };

  const docLink = (d: LinkProposal["doc"]) =>
    d ? `/documents/${d.library_id}?doc=${d.id}` : "/documents";
  const docLabel = (d: LinkProposal["doc"]) =>
    d?.document_number || d?.title || "Document";

  const answer = rows === null ? (loadError ? "Couldn't load the proposals." : "Proposed connections")
    : rows.length === 0 ? "Nothing waiting on you."
    : `${plural(rows.length, "connection")} to review.`;

  return (
    <PageShell>
      <PageHero
        kicker="Intelligence · Review"
        title={answer}
        sub={rows && rows.length > 0
          ? "Each one says why it was found. Link the pair or mark it not related."
          : "Connections found in your documents, each with the reason it was found."}
        primary={canRun ? (
          <button type="button" onClick={() => void runProposers()} disabled={running} className={heroPrimary}>
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {running ? "Scanning…" : "Find connections"}
          </button>
        ) : undefined}
      >
        <div className="[&>div]:mb-0">
          <ViewTabs tabs={INTELLIGENCE_VIEWS} variant="dark" />
        </div>
      </PageHero>

      <PageBody>
      {error && <Problem>{error}</Problem>}
      {lastRun && (
        <Section label="Last scan">
          <div className={sheet}>
            <dl className="grid grid-cols-3 divide-x divide-[var(--color-border)]">
              {[["Documents scanned", lastRun.scanned], ["Linked for you", lastRun.autoApplied], ["Waiting for review", lastRun.proposed]].map(([l, v]) => (
                <div key={String(l)} className="px-4 py-3">
                  <dt className="text-[13px] text-[var(--color-text-muted)]">{l}</dt>
                  <dd className="font-display text-[24px] leading-tight font-semibold tabular-nums text-[var(--color-text)]">{v}</dd>
                </div>
              ))}
            </dl>
            {(lastRun.evidenceLost > 0 || lastRun.notes.length > 0 || (lastRun.proposed === 0 && lastRun.autoApplied === 0 && lastRun.inputs)) && (
              <div className="border-t border-[var(--color-border)] px-4 py-3 space-y-1 text-[14px]">
                {lastRun.evidenceLost > 0 && (
                  <StatusTag tone="warn">{lastRun.evidenceLost} existing system link{lastRun.evidenceLost === 1 ? " no longer matches" : "s no longer match"} its reason. Marked, not removed.</StatusTag>
                )}
                {lastRun.notes.map((n) => (
                  <div key={n} className="text-[var(--color-text-muted)] flex items-center gap-1.5"><Info className="w-3.5 h-3.5 shrink-0" /> {n}</div>
                ))}
                {/* Zero findings explain themselves: which input was empty and
                    what feeds it. Silence here reads as "broken"; this is the
                    honest answer instead. */}
                {lastRun.proposed === 0 && lastRun.autoApplied === 0 && lastRun.inputs && (
                  <>
                    <div className="font-semibold text-[var(--color-text)]">Why nothing was found</div>
                    <ul className="list-disc pl-5 text-[var(--color-text-muted)]">
                      {diagnose(lastRun.inputs).map((d) => <li key={d}>{d}</li>)}
                      {diagnose(lastRun.inputs).length === 0 && <li>Everything it needs is there. What it can find is likely already linked or was decided before.</li>}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        </Section>
      )}

      {rows === null && loadError ? (
        <Problem retry={() => void refresh()}>Couldn&apos;t load the proposals: {loadError}</Problem>
      ) : rows === null ? (
        <LoadingBlock what="proposed connections" />
      ) : rows.length === 0 ? (
        <div className={`${sheet} px-5 py-8 text-center`}>
          <StatusTag tone="good">All decided.</StatusTag>
          <p className="mt-1 text-[15px] text-[var(--color-text-muted)] max-w-xl mx-auto">
            {canRun
              ? "Find connections reads off-page connectors, equipment tags and aliases. Sure links are made for you; the rest wait here."
              : "Connections that need a person's decision show up here."}
          </p>
        </div>
      ) : (
        <Section label="Waiting for a decision" action={<span className="text-[13px] text-[var(--color-text-muted)] inline-flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> &ldquo;Not related&rdquo; sticks until a new revision gives a new reason</span>}>
          <div className={tbl.wrap}>
            <table className={tbl.table}>
              <thead className={`${tbl.thead} max-md:hidden`}>
                <tr>
                  <th className={tbl.th}>Documents</th>
                  <th className={tbl.th}>Why</th>
                  <th className={`${tbl.th} max-lg:hidden`}>Found by</th>
                  {canDecide && <th className={`${tbl.th} w-[1%]`}><span className="sr-only">Decide</span></th>}
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {rows.map((p) => (
                  <tr key={p.id} className={`${tbl.tr} max-md:flex max-md:flex-col max-md:py-1`}>
                    <td className={`${tbl.td} max-md:py-1 align-top`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link href={docLink(p.doc)} className="font-display text-[16px] font-semibold tabular-nums text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{docLabel(p.doc)}</Link>
                        <span aria-label="and" className="text-[var(--color-text-muted)]">↔</span>
                        <Link href={docLink(p.target)} className="font-display text-[16px] font-semibold tabular-nums text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{docLabel(p.target)}</Link>
                      </div>
                    </td>
                    <td className={`${tbl.td} max-md:py-1 align-top`}>
                      <div className="text-[15px] text-[var(--color-text)]">{p.evidence?.summary}</div>
                      {p.evidence?.detail && <div className="text-[14px] text-[var(--color-text-muted)]">{p.evidence.detail}</div>}
                    </td>
                    <td className={`${tbl.td} max-md:py-1 align-top max-lg:hidden`}>
                      <StatusTag tone={TIER_TONE[p.tier]}>{TIER_LABELS[p.tier]}</StatusTag>
                      <div className="text-[13px] text-[var(--color-text-muted)]">{proposerLabel(p.proposer, p.evidence)}{p.source_rev ? `, from rev ${p.source_rev}` : ""}</div>
                    </td>
                    {canDecide && (
                      <td className={`${tbl.td} max-md:py-1 align-top`}>
                        <div className="flex items-center md:justify-end gap-1.5">
                          <button type="button" onClick={() => void decide(p, false)} disabled={busyId === p.id} className={btnRow}>
                            <X className="w-3.5 h-3.5" /> Not related
                          </button>
                          <button type="button" onClick={() => void decide(p, true)} disabled={busyId === p.id} className={btnRow}>
                            {busyId === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Link them
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <EstateReviewPanel />

      <ConnectionSkillsPanel />
      </PageBody>
    </PageShell>
  );
}
