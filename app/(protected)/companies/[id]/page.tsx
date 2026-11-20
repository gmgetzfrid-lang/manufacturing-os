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
  Loader2, AlertTriangle, X, Check, Plus, Pencil,
  Phone, Mail, FileText, Search, Sparkles, BookOpenCheck, Trophy,
  GitPullRequestArrow, Briefcase, ShieldAlert,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { useDraft } from "@/hooks/useDraft";
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
import { orIlike } from "@/lib/orFilter";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";

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
  // Errors from the panels below show as a line here; they never hide the page.
  const [actionError, setActionError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

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
        try {
          const p = await gatherCompanyProfile(c);
          if (!cancelled) { setProfile(p); setProfileError(null); }
        } catch (pe) {
          if (!cancelled) setProfileError((pe as Error).message || "Couldn't gather the record.");
        }
      } catch (e) {
        if (!cancelled) { setError((e as Error).message); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [params.id, reloadKey]);
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const goBack = () => { if (window.history.length > 1) router.back(); else router.push("/companies"); };
  if (loading) return (
    <PageShell width="work">
      <PageHero kicker="Known companies" title="Company" back={{ onClick: goBack, label: "Back to companies" }} size="md" overlap={false} />
      <LoadingBlock what="the company" />
    </PageShell>
  );
  if (error || !company) return (
    <PageShell width="work">
      <PageHero kicker="Known companies" back={{ href: "/companies", label: "Back to companies" }} size="md"
        title={error === "Company not found." || !error ? "Company not found." : "Couldn't load this company."} />
      <PageBody>
        <Card>
          <div role="alert" className="text-[14px] text-red-700 dark:text-red-400 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>{error ?? "Company not found."}
              <div className="mt-2 flex gap-3">
                {error && error !== "Company not found." && <button type="button" onClick={() => { setLoading(true); refresh(); }} className="font-bold underline">Try again</button>}
                <Link href="/companies" className="underline">Back to companies</Link>
              </div>
            </div>
          </div>
        </Card>
      </PageBody>
    </PageShell>
  );

  const sc = profile?.scorecard ?? null;
  const band = scoreBand(sc?.composite ?? null);
  // The answer: the company's standing, in words.
  const answer = company.status === "do_not_use" ? `${company.name}: do not use.`
    : sc?.composite != null ? `${company.name} scores ${Math.round(sc.composite)}.`
    : !profile && !profileError ? company.name
    : `${company.name} is not rated yet.`;
  const events = profile?.events ?? [];
  const bad = events.filter((e) => e.kind === "recordable" || e.kind === "stop_work").length;
  const sub = [
    COMPANY_KIND_LABEL[company.kind],
    company.trade,
    company.status === "inactive" ? "Inactive" : null,
    sc?.composite != null ? band.label : null,
    profile ? `${profile.projects.length} job${profile.projects.length === 1 ? "" : "s"}` : null,
    profile && bad > 0 ? `${bad} recordable or stop-work event${bad === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <PageShell width="work">
      <PageHero
        kicker={<>Known companies · {COMPANY_KIND_LABEL[company.kind]}</>}
        back={{ onClick: goBack, label: "Back to companies" }}
        size="md"
        title={answer}
        sub={sub}
        tools={canManage ? (
          <button type="button" onClick={() => setShowEdit(true)} className={heroQuiet}>
            <Pencil className="w-3.5 h-3.5" /> Edit
          </button>
        ) : undefined}
        primary={canManage ? (
          <button type="button" className={heroPrimary}
            onClick={() => {
              const el = document.getElementById("company-event-what");
              el?.scrollIntoView({ behavior: "smooth", block: "center" });
              (el as HTMLInputElement | null)?.focus({ preventScroll: true });
            }}>
            <Plus className="w-4 h-4" /> Log an event
          </button>
        ) : undefined}
      />

      <PageBody>
      {/* ── Score card ── */}
      <Card label="Score">
        {actionError && (
          <p role="alert" className="mb-3 text-[13px] text-red-700 dark:text-red-400 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {actionError}
            <button type="button" onClick={() => setActionError(null)} className="ml-auto font-bold underline">Dismiss</button>
          </p>
        )}
        <div className="flex items-start gap-5 flex-wrap">
          <ScoreDial score={sc?.composite ?? null} size={92} label={band.label} />
          <div className="min-w-0 flex-1">
            {company.status === "do_not_use" && (
              <p className="mb-1.5 text-[13px] font-bold text-rose-700 dark:text-rose-300">Marked do not use. The record stays; the company is flagged across the app.</p>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-[var(--color-text-muted)]">
              {company.contactName && <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" /> {company.contactName}{company.contactPhone ? ` · ${company.contactPhone}` : ""}</span>}
              {company.contactEmail && <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" /> {company.contactEmail}</span>}
            </div>
            {company.notes && <p className="mt-2 text-[13px] text-[var(--color-text-muted)]">{company.notes}</p>}

            {/* Dimensions with their work shown. */}
            <div className="mt-3 space-y-1.5">
              {(sc?.dimensions ?? []).map((d) => (
                <div key={d.key} className="flex items-center gap-2 text-[13px]">
                  <span className="w-28 shrink-0 font-semibold text-[var(--color-text-muted)]">{d.label}</span>
                  {d.score != null ? (
                    <>
                      <span className="h-2 w-32 rounded-full bg-[var(--viz-track)] overflow-hidden shrink-0">
                        <span className="block h-full rounded-full" style={{ width: `${d.score}%`, background: scoreBandColor(d.score) }} />
                      </span>
                      <span className="tabular-nums font-black text-[var(--color-text)] w-8 shrink-0">{Math.round(d.score)}</span>
                      <span className="text-[var(--color-text-muted)] min-w-0">{d.detail}</span>
                    </>
                  ) : (
                    <span className="text-[var(--color-text-faint)] italic">{d.detail}</span>
                  )}
                </div>
              ))}
              {!profile && profileError && (
                <div role="alert" className="text-[11px] text-rose-700 dark:text-rose-400">
                  Couldn&apos;t gather the record: {profileError} <button type="button" onClick={refresh} className="font-bold underline">Try again</button>
                </div>
              )}
              {!profile && !profileError && <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-faint)]"><Loader2 className="w-3 h-3 animate-spin" /> Gathering the record…</div>}
            </div>
            {sc && (
              <div className="mt-2 text-[12px] text-[var(--color-text-muted)]">
                Scored from {sc.evidenceCount} recorded evidence point{sc.evidenceCount === 1 ? "" : "s"}, never from typed-in ratings. A part with no evidence stays Unrated and doesn&apos;t count.
              </div>
            )}
          </div>
        </div>
      </Card>

      <QualityManualPanel orgId={activeOrgId ?? company.orgId} company={company} canManage={canManage}
        actorId={uid ?? ""} onChanged={() => void refresh()} setErr={setActionError} />

      <EventsPanel orgId={company.orgId} company={company} events={profile?.events ?? []}
        canManage={canManage} actorId={uid ?? ""} actorName={userEmail?.split("@")[0] ?? null}
        onChanged={() => void refresh()} setErr={setActionError} />

      <HistoryPanels profile={profile} scorecard={sc} />

      {showEdit && uid && (
        <EditCompanyModal company={company} actorId={uid}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); void refresh(); }} />
      )}
      </PageBody>
    </PageShell>
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
        .or(orIlike(["document_number", "title", "name"], q))
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
    <Card pad={false} className="overflow-hidden">
      <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <BookOpenCheck className="w-4 h-4 text-[var(--color-text-muted)]" />
        <h2 className="text-[13px] font-semibold text-[var(--color-text-muted)]">Quality manual</h2>
        {company.qualityManualScore != null ? (
          <span className="text-[13px] font-bold tabular-nums" style={{ color: scoreBandColor(company.qualityManualScore) }}>
            {Math.round(company.qualityManualScore)}% coverage
          </span>
        ) : (
          <span className="text-[13px] text-[var(--color-text-muted)]">Not checked yet. The score shows how much of a real quality program their manual covers.</span>
        )}
        {company.qualityManualReviewedAt && (
          <span className="ml-auto text-[12px] text-[var(--color-text-muted)]">confirmed {new Date(company.qualityManualReviewedAt).toLocaleDateString()}</span>
        )}
      </div>

      {(company.qualityManualGaps?.length ?? 0) > 0 && !proposal && (
        <ul className="px-4 sm:px-5 py-2.5 space-y-1 border-b border-[var(--color-border)]">
          {company.qualityManualGaps!.map((g, i) => (
            <li key={i} className="text-[13px] text-[var(--color-text-muted)]">
              <span className="font-bold text-amber-700 dark:text-amber-300">{areaLabel.get(g.area) ?? g.area}:</span> {g.finding}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="px-4 sm:px-5 py-3 space-y-2">
          {!proposal ? (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                {doc ? (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] px-2.5 py-1.5 text-xs font-bold text-[var(--color-text)]">
                    <FileText className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> {doc.label}
                    <button onClick={() => setDoc(null)} aria-label={`Remove ${doc.label}`} className="text-[var(--color-text-faint)] hover:text-rose-600"><X className="w-3 h-3" /></button>
                  </span>
                ) : (
                  <span className="relative flex-1 min-w-64">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-faint)]" />
                    <input value={query} onChange={(e) => setQuery(e.target.value)}
                      aria-label="Find their quality manual"
                      placeholder="Find their quality manual in document control…"
                      className="w-full h-9 pl-8 pr-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] text-[13px]" />
                  </span>
                )}
                <button onClick={() => void evaluate()} disabled={!doc || evaluating}
                  className="h-9 inline-flex items-center gap-1 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] text-[13px] font-semibold hover:bg-[var(--color-surface-2)] disabled:opacity-50"
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
                <span className="text-[14px] font-bold text-[var(--color-text)]">Proposed: {proposal.score}% coverage</span>
                <span className="text-[13px] text-[var(--color-text-muted)]">Check the findings. Nothing goes on the record until you confirm.</span>
                <span className="ml-auto flex items-center gap-2">
                  <button onClick={() => setProposal(null)} className="text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Discard</button>
                  <button onClick={() => void confirm()} disabled={confirming}
                    className="inline-flex items-center gap-1 h-9 px-3 rounded-lg bg-[var(--color-text)] text-[var(--color-surface)] text-[13px] font-bold hover:opacity-90 disabled:opacity-50">
                    {confirming ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Confirm to record
                  </button>
                </span>
              </div>
              <ul className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
                {proposal.findings.map((f) => (
                  <li key={f.area} className="px-3 py-1.5 text-[13px] flex items-start gap-2">
                    <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${f.covered ? "bg-emerald-500" : "bg-rose-500"}`} />
                    <span><b className="text-[var(--color-text)]">{areaLabel.get(f.area) ?? f.area}:</b> <span className="text-[var(--color-text-muted)]">{f.finding}</span></span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Card>
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
  // What happened autosaves on this device until it's logged.
  useDraft<string>(canManage ? `company-event:${company.id}` : null, desc, setDesc, (v) => !v.trim());

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
    <Card pad={false} className="overflow-hidden">
      <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-[var(--color-text-muted)]" />
          <h2 className="text-[13px] font-semibold text-[var(--color-text-muted)]">Safety and performance log · {events.length}</h2>
        </div>
        <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">Dated, named facts that feed the safety score. Reporting a near miss costs almost nothing: it&apos;s a healthy habit.</p>
      </div>
      {canManage && (
        <div className="px-4 sm:px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
          <select value={kind} aria-label="Kind of event" onChange={(e) => setKind(e.target.value as CompanyEvent["kind"])}
            className="h-9 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] px-2 text-[13px]">
            {(Object.keys(EVENT_KIND_LABEL) as CompanyEvent["kind"][]).map((k) => (
              <option key={k} value={k}>{EVENT_KIND_LABEL[k]}</option>
            ))}
          </select>
          <input type="date" value={date} aria-label="Date" onChange={(e) => setDate(e.target.value)}
            className="h-9 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[13px] [color-scheme:light] dark:[color-scheme:dark]" />
          <input id="company-event-what" value={desc} onChange={(e) => setDesc(e.target.value)}
            aria-label="What happened"
            onKeyDown={(e) => { if (e.key === "Enter" && desc.trim()) void add(); }}
            placeholder="What happened? (goes on their permanent record)"
            className="h-9 flex-1 min-w-56 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] px-2.5 text-[13px]" />
          <button type="button" onClick={() => void add()} disabled={busy || !desc.trim()}
            className="h-9 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-text)] text-[var(--color-surface)] text-[13px] font-bold hover:opacity-90 disabled:opacity-50">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Log it
          </button>
        </div>
      )}
      {events.length === 0 ? (
        <div className="px-4 py-4 text-center text-[13px] text-[var(--color-text-muted)]">No events on record.</div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] max-h-80 overflow-y-auto">
          {events.map((e) => (
            <li key={e.id} className="px-4 sm:px-5 py-2.5 flex items-start gap-2 text-[13px]">
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
    </Card>
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
        <Card pad={false} className="overflow-hidden" label={<span className="inline-flex items-center gap-2"><Briefcase className="w-4 h-4" /> Jobs · {projects.length}</span>}>
          <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
            {projects.map((p) => (
              <li key={p.projectId} className="px-4 sm:px-5 py-2.5 text-[14px]">
                <Link href={`/projects/${p.projectId}`} className="font-bold text-[var(--color-text)] hover:underline">{p.projectName}</Link>
                <div className="text-[12px] text-[var(--color-text-muted)]">
                  {[p.trade, p.contractValue != null ? `contract ${fmtMoney(p.contractValue)}` : null].filter(Boolean).join(" · ") || "-"}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {bids.length > 0 && (
        <Card pad={false} className="overflow-hidden" label={<span className="inline-flex items-center gap-2"><Trophy className="w-4 h-4" /> Bid history · {bids.filter((b) => b.won).length} of {bids.length} won</span>}>
          <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
            {bids.map((b, i) => (
              <li key={i} className="px-4 sm:px-5 py-2.5 text-[13px] flex items-center gap-2">
                <span className="text-[var(--color-text)]">{b.rfqGroup ?? "Quote"}</span>
                {b.total != null && <span className="font-black tabular-nums">{fmtMoney(b.total)}</span>}
                {b.won
                  ? <span className="ml-auto text-[11px] font-black uppercase text-emerald-700 dark:text-emerald-300">won</span>
                  : <span className="ml-auto text-[11px] font-bold uppercase text-[var(--color-text-faint)]">not selected</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {changeOrders.length > 0 && (
        <Card pad={false} className="overflow-hidden md:col-span-2" label={<span className="inline-flex items-center gap-2"><GitPullRequestArrow className="w-4 h-4" /> Change orders on their scopes · {changeOrders.length}</span>}>
          <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
            {changeOrders.map((co, i) => (
              <li key={i} className="px-4 sm:px-5 py-2.5 text-[13px] flex items-center gap-2 flex-wrap">
                <span className="font-mono text-[11px] font-black text-[var(--color-text-muted)]">{co.coNumber}</span>
                <span className="text-[var(--color-text)]">{co.title}</span>
                <span className="font-black tabular-nums">{fmtMoney(co.amount)}</span>
                <span className={`text-[11px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${co.reasonCode === "scope_gap" ? "border-rose-500/40 bg-rose-500/[0.06] text-rose-700 dark:text-rose-300" : "border-[var(--color-border)] text-[var(--color-text-muted)]"}`}
                  title={co.reasonCode === "scope_gap" ? "Their bid missed this scope. It counts against their cost discipline." : undefined}>
                  {CO_REASON_LABEL[co.reasonCode as CoReason] ?? co.reasonCode}
                </span>
                <span className="ml-auto text-[11px] font-bold uppercase text-[var(--color-text-faint)]">{co.status}</span>
              </li>
            ))}
          </ul>
        </Card>
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

  useEffect(() => {
    if (busy) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

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
    <div role="dialog" aria-modal="true" aria-label={`Edit ${company.name}`} className="fixed inset-0 z-[200] bg-[var(--color-ink)]/60 animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="text-[14px] font-bold text-[var(--color-text)] flex-1">Edit {company.name}</div>
          <button onClick={onClose} disabled={busy} aria-label="Close" className="p-2 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company name *" aria-label="Company name"
              className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]" />
            <select value={kind} aria-label="Kind" onChange={(e) => setKind(e.target.value as Company["kind"])}
              className="px-2 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]">
              {(Object.keys(COMPANY_KIND_LABEL) as Company["kind"][]).map((k) => (
                <option key={k} value={k}>{COMPANY_KIND_LABEL[k]}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input value={trade} onChange={(e) => setTrade(e.target.value)} placeholder="Trade" aria-label="Trade"
              className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]" />
            <select value={status} aria-label="Status" onChange={(e) => setStatus(e.target.value as Company["status"])}
              className="px-2 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]"
              title="'Do not use' keeps the record but flags the company across the app.">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="do_not_use">Do not use</option>
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Contact name" aria-label="Contact name"
              className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]" />
            <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="Email" aria-label="Email"
              className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]" />
            <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="Phone" aria-label="Phone"
              className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]" />
          </div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Notes" aria-label="Notes"
            className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm resize-y bg-[var(--color-surface)] text-[var(--color-text)]" />
          {error && (
            <p role="alert" className="flex items-start gap-2 border-l-2 border-rose-500 pl-3 text-xs font-bold text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
            </p>
          )}
        </div>
        <div className="px-6 py-3 border-t border-[var(--color-border)] flex items-center justify-end gap-2">
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
