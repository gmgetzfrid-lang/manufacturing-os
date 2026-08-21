"use client";

// /companies/[id] — one company's full record: the score with all its work
// shown, the safety/performance log, the quality-manual evaluation, and the
// history (jobs, bids, change orders) the scores are computed from.
//
// The AI evaluates the quality manual but only PROPOSES — a controller
// reviews the per-area findings before anything lands on the record.
// Events (recordables, near misses, warnings, stop-works, commendations)
// are the one human-entered feed, and each is a dated, attributed fact —
// not a rating.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  HardHat, ArrowLeft, Loader2, AlertTriangle, X, Check, Plus, Pencil,
  Phone, Mail, FileText, Search, Sparkles, BookOpenCheck, Trophy,
  GitPullRequestArrow, Briefcase, ShieldAlert,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { Spinner } from "@/components/ui/Spinner";
import {
  getCompany, saveCompany, gatherCompanyProfile, addCompanyEvent, confirmQualityManual,
  COMPANY_KIND_LABEL, EVENT_KIND_LABEL,
  type Company, type CompanyEvent, type CompanyProfileData,
} from "@/lib/companies";
import { scoreBand, type CompanyScorecard } from "@/lib/companyScore";
import { QUALITY_MANUAL_RUBRIC, type RubricFinding } from "@/lib/checklistEngine";
import { CO_REASON_LABEL, type CoReason } from "@/lib/changeOrders";
import { ScoreDial, scoreBandColor } from "@/components/ui/ChartKit";
import { fmtMoney } from "@/lib/costs";

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

export default function CompanyProfilePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { activeOrgId, uid, userEmail, hasAnyRole } = useRole();
  const canManage = hasAnyRole(["Admin", "DocCtrl"]);

  const [company, setCompany] = useState<Company | null>(null);
  const [profile, setProfile] = useState<CompanyProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEdit, setShowEdit] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!params.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const c = await getCompany(params.id);
        if (cancelled) return;
        if (!c) { setError("Company not found."); setLoading(false); return; }
        setError(null);
        setCompany(c);
        setLoading(false);
        const p = await gatherCompanyProfile(c);
        if (!cancelled) setProfile(p);
      } catch (e) {
        if (!cancelled) { setError((e as Error).message); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [params.id, reloadKey]);
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  if (loading) return <div className="min-h-full flex items-center justify-center"><Spinner /></div>;
  if (error || !company) return (
    <div className="min-h-full p-8">
      <div className="max-w-2xl mx-auto bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div>{error ?? "Company not found."}<div className="mt-2"><Link href="/companies" className="underline">Back to companies</Link></div></div>
      </div>
    </div>
  );

  const sc = profile?.scorecard ?? null;
  const band = scoreBand(sc?.composite ?? null);

  return (
    <div className="pb-20 max-w-5xl mx-auto px-6 py-6 space-y-4">
      <button onClick={() => { if (window.history.length > 1) router.back(); else router.push("/companies"); }}
        className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to companies
      </button>

      {/* ── Header card ── */}
      <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-5 shadow-sm">
        <div className="flex items-start gap-5 flex-wrap">
          <ScoreDial score={sc?.composite ?? null} size={92} label={band.label} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-black text-[var(--color-text)] flex items-center gap-2">
                <HardHat className="w-5 h-5 text-[var(--color-accent)]" /> {company.name}
              </h1>
              <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-muted)]">{COMPANY_KIND_LABEL[company.kind]}</span>
              {company.trade && <span className="text-xs text-[var(--color-text-muted)]">{company.trade}</span>}
              {company.status !== "active" && (
                <span className={`text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${company.status === "do_not_use" ? "border-rose-500/50 bg-rose-500/10 text-rose-700 dark:text-rose-300" : "border-[var(--color-border)] text-[var(--color-text-faint)]"}`}>
                  {company.status === "do_not_use" ? "Do not use" : "Inactive"}
                </span>
              )}
              {canManage && (
                <button onClick={() => setShowEdit(true)}
                  className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                  <Pencil className="w-3 h-3" /> Edit
                </button>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)]">
              {company.contactName && <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" /> {company.contactName}{company.contactPhone ? ` · ${company.contactPhone}` : ""}</span>}
              {company.contactEmail && <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" /> {company.contactEmail}</span>}
            </div>
            {company.notes && <p className="mt-2 text-xs text-[var(--color-text-muted)]">{company.notes}</p>}

            {/* Dimensions with their work shown. */}
            <div className="mt-3 space-y-1.5">
              {(sc?.dimensions ?? []).map((d) => (
                <div key={d.key} className="flex items-center gap-2 text-[11px]">
                  <span className="w-28 shrink-0 font-bold text-[var(--color-text-muted)]">{d.label}</span>
                  {d.score != null ? (
                    <>
                      <span className="h-2 w-32 rounded-full bg-[var(--viz-track)] overflow-hidden shrink-0">
                        <span className="block h-full rounded-full" style={{ width: `${d.score}%`, background: scoreBandColor(d.score) }} />
                      </span>
                      <span className="tabular-nums font-black text-[var(--color-text)] w-8 shrink-0">{Math.round(d.score)}</span>
                      <span className="text-[var(--color-text-muted)]">{d.detail}</span>
                    </>
                  ) : (
                    <span className="text-[var(--color-text-faint)] italic">{d.detail}</span>
                  )}
                </div>
              ))}
              {!profile && <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-faint)]"><Loader2 className="w-3 h-3 animate-spin" /> gathering the record…</div>}
            </div>
            {sc && (
              <div className="mt-2 text-[10px] text-[var(--color-text-faint)]">
                Score computed from {sc.evidenceCount} recorded evidence point{sc.evidenceCount === 1 ? "" : "s"} — never from typed-in ratings. Dimensions without evidence stay Unrated and don&apos;t count.
              </div>
            )}
          </div>
        </div>
      </div>

      <QualityManualPanel orgId={activeOrgId ?? company.orgId} company={company} canManage={canManage}
        actorId={uid ?? ""} onChanged={() => void refresh()} setErr={setError} />

      <EventsPanel orgId={company.orgId} company={company} events={profile?.events ?? []}
        canManage={canManage} actorId={uid ?? ""} actorName={userEmail?.split("@")[0] ?? null}
        onChanged={() => void refresh()} setErr={setError} />

      <HistoryPanels profile={profile} scorecard={sc} />

      {showEdit && uid && (
        <EditCompanyModal company={company} actorId={uid}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); void refresh(); }} />
      )}
    </div>
  );
}

// ── Quality manual ───────────────────────────────────────────────────────

function QualityManualPanel({ orgId, company, canManage, actorId, onChanged, setErr }: {
  orgId: string; company: Company; canManage: boolean; actorId: string;
  onChanged: () => void; setErr: (m: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; label: string }>>([]);
  const [doc, setDoc] = useState<{ id: string; label: string } | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [proposal, setProposal] = useState<{ score: number; findings: RubricFinding[] } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const areaLabel = useMemo(() => new Map(QUALITY_MANUAL_RUBRIC.map((a) => [a.key, a.label])), []);

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

  const evaluate = async () => {
    if (!doc) return;
    setEvaluating(true); setErr(null);
    try {
      const res = await fetch("/api/companies/quality-manual", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ orgId, companyId: company.id, documentId: doc.id }),
      });
      const body = (await res.json().catch(() => null)) as { score?: number; findings?: RubricFinding[]; error?: string } | null;
      if (!res.ok || body?.score == null || !body.findings) throw new Error(body?.error || `HTTP ${res.status}`);
      setProposal({ score: body.score, findings: body.findings });
    } catch (e) {
      setErr((e as Error).message);
    } finally { setEvaluating(false); }
  };

  const confirm = async () => {
    if (!proposal || !doc) return;
    setConfirming(true); setErr(null);
    try {
      await confirmQualityManual({
        orgId, companyId: company.id, documentId: doc.id,
        score: proposal.score,
        gaps: proposal.findings.filter((f) => !f.covered).map((f) => ({ area: f.area, finding: f.finding })),
        actorId,
      });
      setProposal(null); setDoc(null); setQuery("");
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setConfirming(false); }
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <BookOpenCheck className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Quality manual</span>
        {company.qualityManualScore != null ? (
          <span className="text-[11px] font-black tabular-nums" style={{ color: scoreBandColor(company.qualityManualScore) }}>
            {Math.round(company.qualityManualScore)}% coverage
          </span>
        ) : (
          <span className="text-[10px] text-[var(--color-text-muted)]">Not evaluated — the score gauges how much of a real quality program their manual covers.</span>
        )}
        {company.qualityManualReviewedAt && (
          <span className="ml-auto text-[10px] text-[var(--color-text-faint)]">confirmed {new Date(company.qualityManualReviewedAt).toLocaleDateString()}</span>
        )}
      </div>

      {(company.qualityManualGaps?.length ?? 0) > 0 && !proposal && (
        <ul className="px-4 py-2.5 space-y-1 border-b border-[var(--color-border)]">
          {company.qualityManualGaps!.map((g, i) => (
            <li key={i} className="text-[11px] text-[var(--color-text-muted)]">
              <span className="font-bold text-amber-700 dark:text-amber-300">{areaLabel.get(g.area) ?? g.area}:</span> {g.finding}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="px-4 py-3 space-y-2">
          {!proposal ? (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                {doc ? (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] px-2.5 py-1.5 text-xs font-bold text-[var(--color-text)]">
                    <FileText className="w-3.5 h-3.5 text-[var(--color-accent)]" /> {doc.label}
                    <button onClick={() => setDoc(null)} className="text-[var(--color-text-faint)] hover:text-rose-600"><X className="w-3 h-3" /></button>
                  </span>
                ) : (
                  <span className="relative flex-1 min-w-64">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-faint)]" />
                    <input value={query} onChange={(e) => setQuery(e.target.value)}
                      placeholder="Find their quality manual in document control…"
                      className="w-full h-8 pl-8 pr-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-xs" />
                  </span>
                )}
                <button onClick={() => void evaluate()} disabled={!doc || evaluating}
                  className="h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                  title="AI reads the manual against the ISO 9001-shaped rubric (doc control, welding, NDE, calibration, ITPs, materials, NCRs, training, records). You review before anything lands.">
                  {evaluating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} Evaluate
                </button>
              </div>
              {results.length > 0 && !doc && (
                <ul className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
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
              <div className="flex items-center gap-2">
                <span className="text-xs font-black text-[var(--color-text)]">Proposed: {proposal.score}% coverage</span>
                <span className="text-[10px] text-[var(--color-text-muted)]">Review the findings — nothing lands on the record until you confirm.</span>
                <span className="ml-auto flex items-center gap-2">
                  <button onClick={() => setProposal(null)} className="text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Discard</button>
                  <button onClick={() => void confirm()} disabled={confirming}
                    className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
                    {confirming ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Confirm to record
                  </button>
                </span>
              </div>
              <ul className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
                {proposal.findings.map((f) => (
                  <li key={f.area} className="px-3 py-1.5 text-[11px] flex items-start gap-2">
                    <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${f.covered ? "bg-emerald-500" : "bg-rose-500"}`} />
                    <span><b className="text-[var(--color-text)]">{areaLabel.get(f.area) ?? f.area}:</b> <span className="text-[var(--color-text-muted)]">{f.finding}</span></span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Safety & performance log ─────────────────────────────────────────────

function EventsPanel({ orgId, company, events, canManage, actorId, actorName, onChanged, setErr }: {
  orgId: string; company: Company; events: CompanyEvent[];
  canManage: boolean; actorId: string; actorName: string | null;
  onChanged: () => void; setErr: (m: string | null) => void;
}) {
  const [kind, setKind] = useState<CompanyEvent["kind"]>("near_miss");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true); setErr(null);
    try {
      await addCompanyEvent({ orgId, companyId: company.id, kind, eventDate: date, description: desc, actorId, actorName });
      setDesc(""); onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <ShieldAlert className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Safety &amp; performance log</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">Dated facts, attributed — these feed the safety score. Near-miss REPORTING barely costs points; it&apos;s healthy culture.</span>
      </div>
      {canManage && (
        <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
          <select value={kind} onChange={(e) => setKind(e.target.value as CompanyEvent["kind"])}
            className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
            {(Object.keys(EVENT_KIND_LABEL) as CompanyEvent["kind"][]).map((k) => (
              <option key={k} value={k}>{EVENT_KIND_LABEL[k]}</option>
            ))}
          </select>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs [color-scheme:light] dark:[color-scheme:dark]" />
          <input value={desc} onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && desc.trim()) void add(); }}
            placeholder="What happened? (goes on their permanent record)"
            className="h-8 flex-1 min-w-56 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
          <button onClick={() => void add()} disabled={busy || !desc.trim()}
            className="h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Log it
          </button>
        </div>
      )}
      {events.length === 0 ? (
        <div className="px-4 py-4 text-center text-xs text-[var(--color-text-muted)]">No events on record.</div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] max-h-80 overflow-y-auto">
          {events.map((e) => (
            <li key={e.id} className="px-4 py-2 flex items-start gap-2 text-xs">
              <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${
                e.kind === "recordable" || e.kind === "stop_work" ? "bg-rose-500"
                : e.kind === "warning" ? "bg-amber-500"
                : e.kind === "commendation" ? "bg-emerald-500"
                : "bg-[var(--color-text-faint)]"}`} />
              <div className="min-w-0">
                <span className="font-bold text-[var(--color-text)]">{EVENT_KIND_LABEL[e.kind]}</span>
                <span className="text-[var(--color-text-muted)]"> · {new Date(e.eventDate + "T00:00:00").toLocaleDateString()}{e.createdByName ? ` · logged by ${e.createdByName}` : ""}</span>
                <div className="text-[var(--color-text-muted)]">{e.description}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── History: jobs, bids, change orders ───────────────────────────────────

function HistoryPanels({ profile, scorecard }: { profile: CompanyProfileData | null; scorecard: CompanyScorecard | null }) {
  void scorecard;
  if (!profile) return null;
  const { projects, bids, changeOrders } = profile;
  if (projects.length === 0 && bids.length === 0 && changeOrders.length === 0) return null;
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {projects.length > 0 && (
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
          <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-center gap-2 text-sm font-bold text-[var(--color-text)]">
            <Briefcase className="w-4 h-4 text-[var(--color-accent)]" /> Jobs ({projects.length})
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            {projects.map((p) => (
              <li key={p.projectId} className="px-4 py-2 text-xs">
                <Link href={`/projects/${p.projectId}`} className="font-bold text-[var(--color-text)] hover:text-[var(--color-accent)]">{p.projectName}</Link>
                <div className="text-[10px] text-[var(--color-text-muted)]">
                  {[p.trade, p.contractValue != null ? `contract ${fmtMoney(p.contractValue)}` : null].filter(Boolean).join(" · ") || "—"}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {bids.length > 0 && (
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
          <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-center gap-2 text-sm font-bold text-[var(--color-text)]">
            <Trophy className="w-4 h-4 text-[var(--color-accent)]" /> Bid history ({bids.filter((b) => b.won).length}/{bids.length} won)
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            {bids.map((b, i) => (
              <li key={i} className="px-4 py-2 text-xs flex items-center gap-2">
                <span className="text-[var(--color-text)]">{b.rfqGroup ?? "Quote"}</span>
                {b.total != null && <span className="font-black tabular-nums">{fmtMoney(b.total)}</span>}
                {b.won
                  ? <span className="ml-auto text-[9px] font-black uppercase text-emerald-700 dark:text-emerald-300">won</span>
                  : <span className="ml-auto text-[9px] font-bold uppercase text-[var(--color-text-faint)]">not selected</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {changeOrders.length > 0 && (
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm md:col-span-2">
          <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-center gap-2 text-sm font-bold text-[var(--color-text)]">
            <GitPullRequestArrow className="w-4 h-4 text-[var(--color-accent)]" /> Change orders on their scopes ({changeOrders.length})
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            {changeOrders.map((co, i) => (
              <li key={i} className="px-4 py-2 text-xs flex items-center gap-2 flex-wrap">
                <span className="font-mono text-[10px] font-black text-[var(--color-text-muted)]">{co.coNumber}</span>
                <span className="text-[var(--color-text)]">{co.title}</span>
                <span className="font-black tabular-nums">{fmtMoney(co.amount)}</span>
                <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${co.reasonCode === "scope_gap" ? "border-rose-500/40 bg-rose-500/[0.06] text-rose-700 dark:text-rose-300" : "border-[var(--color-border)] text-[var(--color-text-muted)]"}`}
                  title={co.reasonCode === "scope_gap" ? "Their bid missed this scope — counts against their cost discipline" : undefined}>
                  {CO_REASON_LABEL[co.reasonCode as CoReason] ?? co.reasonCode}
                </span>
                <span className="ml-auto text-[9px] font-bold uppercase text-[var(--color-text-faint)]">{co.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Edit modal ───────────────────────────────────────────────────────────

function EditCompanyModal({ company, actorId, onClose, onSaved }: {
  company: Company; actorId: string; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(company.name);
  const [kind, setKind] = useState<Company["kind"]>(company.kind);
  const [trade, setTrade] = useState(company.trade ?? "");
  const [status, setStatus] = useState<Company["status"]>(company.status);
  const [contactName, setContactName] = useState(company.contactName ?? "");
  const [contactEmail, setContactEmail] = useState(company.contactEmail ?? "");
  const [contactPhone, setContactPhone] = useState(company.contactPhone ?? "");
  const [notes, setNotes] = useState(company.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await saveCompany({
        orgId: company.orgId, id: company.id,
        name, kind, trade, status,
        contactName, contactEmail, contactPhone, notes,
        actorId,
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="text-sm font-black text-[var(--color-text)] flex-1">Edit {company.name}</div>
          <button onClick={onClose} disabled={busy} className="p-2 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company name *"
              className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
            <select value={kind} onChange={(e) => setKind(e.target.value as Company["kind"])}
              className="px-2 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]">
              {(Object.keys(COMPANY_KIND_LABEL) as Company["kind"][]).map((k) => (
                <option key={k} value={k}>{COMPANY_KIND_LABEL[k]}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input value={trade} onChange={(e) => setTrade(e.target.value)} placeholder="Trade"
              className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
            <select value={status} onChange={(e) => setStatus(e.target.value as Company["status"])}
              className="px-2 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]"
              title="'Do not use' keeps the record but flags the company across the app.">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="do_not_use">Do not use</option>
            </select>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Contact name"
              className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
            <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="Email"
              className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
            <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="Phone"
              className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
          </div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Notes"
            className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm resize-y bg-[var(--color-surface)]" />
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-rose-500/40 bg-rose-500/[0.07] text-xs font-bold text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
            </div>
          )}
        </div>
        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">Cancel</button>
          <button onClick={() => void submit()} disabled={busy || !name.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
          </button>
        </div>
      </div>
    </div>
  );
}
