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
import { Loader2, X, Check, Plus, Pencil, FileText, Search, Sparkles } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { useDraft } from "@/hooks/useDraft";
import {
  getCompany, saveCompany, gatherCompanyProfile, addCompanyEvent, confirmQualityManual,
  COMPANY_KIND_LABEL, EVENT_KIND_LABEL,
  type Company, type CompanyEvent, type CompanyProfileData,
} from "@/lib/companies";
import { scoreBand } from "@/lib/companyScore";
import { QUALITY_MANUAL_RUBRIC, type RubricFinding } from "@/lib/checklistEngine";
import { CO_REASON_LABEL, type CoReason } from "@/lib/changeOrders";
import { fmtMoney } from "@/lib/costs";
import { orIlike } from "@/lib/orFilter";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet, type HeroFact } from "@/components/ui/PageHero";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { plural } from "@/components/admin/band";
import { StatusTag, fmtDay, type Tone } from "@/components/requests/RequestBits";

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
      <PageHero kicker="Known companies" title="Company" back={{ onClick: goBack, label: "Back to companies" }} size="md" />
      <PageBody><Card><LoadingBlock what="the company" className="border-0 p-0" /></Card></PageBody>
    </PageShell>
  );
  if (error || !company) return (
    <PageShell width="work">
      <PageHero kicker="Known companies" back={{ href: "/companies", label: "Back to companies" }} size="md"
        title={error === "Company not found." || !error ? "Company not found." : "Couldn't load this company."} />
      <PageBody>
        <Card>
          <p role="alert" className="relative pl-3 text-[15px] text-[var(--color-text)]">
            <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />{error ?? "Company not found."}
          </p>
          <div className="mt-3 flex gap-2">
            {error && error !== "Company not found." && <button type="button" onClick={() => { setLoading(true); refresh(); }} className={heroQuiet}>Try again</button>}
            <Link href="/companies" className={heroQuiet}>Back to companies</Link>
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
  const facts: HeroFact[] = profile ? [
    { label: "Score", value: sc?.composite != null ? Math.round(sc.composite) : "None", tone: band.tone === "green" ? "good" : band.tone === "amber" ? "warn" : band.tone === "rose" ? "bad" : undefined },
    { label: "Jobs", value: profile.projects.length },
    { label: <span title="Recordable injuries and stop works">Incidents</span>, value: bad, tone: bad > 0 ? "bad" : undefined },
  ] : [];
  const cells: Array<[string, React.ReactNode]> = [
    ["Kind", COMPANY_KIND_LABEL[company.kind]],
    ["Trade", company.trade || <Faint key="t">None</Faint>],
    ["Status", company.status === "do_not_use" ? <StatusTag key="s" tone="bad">Do not use</StatusTag> : company.status === "inactive" ? <StatusTag key="s">Inactive</StatusTag> : <StatusTag key="s" tone="good">Active</StatusTag>],
    ["Contact", company.contactName || <Faint key="c">None</Faint>],
    ["Phone", company.contactPhone ? <a key="p" href={`tel:${company.contactPhone}`} className="text-[var(--color-accent-text)] hover:underline underline-offset-2">{company.contactPhone}</a> : <Faint key="p">None</Faint>],
    ["Email", company.contactEmail ? <a key="e" href={`mailto:${company.contactEmail}`} className="truncate text-[var(--color-accent-text)] hover:underline underline-offset-2">{company.contactEmail}</a> : <Faint key="e">None</Faint>],
  ];

  return (
    <PageShell width="work">
      <PageHero
        kicker="Known companies"
        back={{ onClick: goBack, label: "Back to companies" }}
        size="md"
        title={answer}
        sub={sc?.composite != null ? `${band.label}, from ${plural(sc.evidenceCount, "recorded evidence point")}.` : company.trade ? `${COMPANY_KIND_LABEL[company.kind]}, ${company.trade}.` : undefined}
        facts={facts}
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
      {actionError && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[15px] text-[var(--color-text)]">
          <span className="relative pl-3 flex-1"><span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="text-[var(--color-accent-text)] hover:underline underline-offset-2">Dismiss</button>
        </div>
      )}

      <Card label="Details" pad={false} className="overflow-hidden">
        <dl className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-px bg-[var(--color-border)]">
          {cells.map(([label, value]) => (
            <div key={label} className="bg-[var(--color-surface)] px-4 py-3 min-w-0">
              <dt className="text-[13px] text-[var(--color-text-muted)]">{label}</dt>
              <dd className="mt-0.5 text-[15px] text-[var(--color-text)] min-w-0 truncate">{value}</dd>
            </div>
          ))}
        </dl>
        {company.notes && <p className="px-4 py-3 border-t border-[var(--color-border)] text-[15px] text-[var(--color-text)] max-w-[80ch]">{company.notes}</p>}
      </Card>

      <Card pad={false} className="overflow-hidden" label={
        <span className="inline-flex items-center gap-1.5">Score
          <HelpTooltip>Scored from recorded work only, never from typed-in ratings. A part with no evidence stays unrated and doesn&apos;t count.</HelpTooltip>
        </span>
      }>
        {!profile ? (
          profileError
            ? <p role="alert" className="px-4 py-3 text-[15px] text-[var(--color-text)]">Couldn&apos;t gather the record: {profileError} <button type="button" onClick={refresh} className="text-[var(--color-accent-text)] hover:underline underline-offset-2">Try again</button></p>
            : <p className="px-4 py-3 flex items-center gap-2 text-[15px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Gathering the record…</p>
        ) : (
          <table className="w-full text-[15px]">
            <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
              <tr>
                <th className="font-semibold px-4 h-10 whitespace-nowrap">Part</th>
                <th className="font-semibold px-4 h-10 text-right whitespace-nowrap">Score</th>
                <th className="font-semibold px-4 h-10 hidden sm:table-cell w-40"><span className="sr-only">Out of 100</span></th>
                <th className="font-semibold px-4 h-10 w-full">How it&apos;s worked out</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {(sc?.dimensions ?? []).map((d) => (
                <tr key={d.key}>
                  <td className="px-4 py-2.5 font-semibold text-[var(--color-text)] whitespace-nowrap">{d.label}</td>
                  <td className="px-4 py-2.5 text-right">{d.score != null ? <span className="font-display text-[17px] font-semibold tabular-nums">{Math.round(d.score)}</span> : <Faint>None</Faint>}</td>
                  <td className="px-4 py-2.5 hidden sm:table-cell">
                    {d.score != null && (
                      <span className="block h-1.5 w-32 rounded-full bg-[var(--color-border)] overflow-hidden" aria-hidden>
                        <span className="block h-full rounded-full bg-[var(--color-text)]" style={{ width: `${d.score}%` }} />
                      </span>
                    )}
                  </td>
                  <td className={`px-4 py-2.5 ${d.score != null ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{d.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <QualityManualPanel orgId={activeOrgId ?? company.orgId} company={company} canManage={canManage}
        actorId={uid ?? ""} onChanged={() => void refresh()} setErr={setActionError} />

      <EventsPanel orgId={company.orgId} company={company} events={profile?.events ?? []}
        canManage={canManage} actorId={uid ?? ""} actorName={userEmail?.split("@")[0] ?? null}
        onChanged={() => void refresh()} setErr={setActionError} />

      <HistoryPanels profile={profile} />

      {showEdit && uid && (
        <EditCompanyModal company={company} actorId={uid}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); void refresh(); }} />
      )}
      </PageBody>
    </PageShell>
  );
}

function Faint({ children }: { children: React.ReactNode }) {
  return <span className="text-[var(--color-text-faint)]">{children}</span>;
}

const FIELD = "h-10 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[15px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] outline-none focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40";
const LABEL = "block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5";
const TH = "font-semibold px-4 h-10 whitespace-nowrap";

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
    <Card pad={false} className="overflow-hidden"
      label={<span className="inline-flex items-center gap-1.5">Quality manual <HelpTooltip>How much of a real quality program their manual covers, checked against an ISO 9001-shaped list (document control, welding, NDE, calibration, ITPs, materials, NCRs, training, records). The AI only proposes; you confirm before anything is recorded.</HelpTooltip></span>}
      action={company.qualityManualReviewedAt ? <span className="text-[13px] text-[var(--color-text-muted)]">Confirmed {fmtDay(company.qualityManualReviewedAt)}</span> : undefined}>
      <div className="px-4 py-3 flex items-baseline gap-2">
        {company.qualityManualScore != null ? (
          <><span className="font-display text-[22px] font-semibold tabular-nums text-[var(--color-text)]">{Math.round(company.qualityManualScore)}%</span><span className="text-[15px] text-[var(--color-text-muted)]">covered</span></>
        ) : (
          <span className="text-[15px] text-[var(--color-text-muted)]">Not checked yet.</span>
        )}
      </div>

      {(company.qualityManualGaps?.length ?? 0) > 0 && !proposal && (
        <table className="w-full text-[15px] border-t border-[var(--color-border)]">
          <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
            <tr><th className={TH}>Gap</th><th className={`${TH} w-full`}>Finding</th></tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {company.qualityManualGaps!.map((g, i) => (
              <tr key={i}>
                <td className="px-4 py-2.5 align-top whitespace-nowrap"><StatusTag tone="warn">{areaLabel.get(g.area) ?? g.area}</StatusTag></td>
                <td className="px-4 py-2.5 text-[var(--color-text)]">{g.finding}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canManage && (
        <div className="px-4 py-3 border-t border-[var(--color-border)] space-y-2">
          {!proposal ? (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                {doc ? (
                  <span className="inline-flex items-center gap-1.5 h-10 rounded-md border border-[var(--color-border-strong)] px-3 text-[15px] font-semibold text-[var(--color-text)]">
                    <FileText className="w-4 h-4 text-[var(--color-text-muted)]" /> {doc.label}
                    <button type="button" onClick={() => setDoc(null)} aria-label={`Remove ${doc.label}`} className="w-7 h-7 grid place-items-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"><X className="w-3.5 h-3.5" /></button>
                  </span>
                ) : (
                  <span className="relative flex-1 min-w-64">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
                    <input value={query} onChange={(e) => setQuery(e.target.value)}
                      aria-label="Find their quality manual"
                      placeholder="Find their quality manual in document control"
                      className={`${FIELD} w-full pl-9`} />
                  </span>
                )}
                <button type="button" onClick={() => void evaluate()} disabled={!doc || evaluating} className={`${heroQuiet} h-10`}>
                  {evaluating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Evaluate
                </button>
              </div>
              {results.length > 0 && !doc && (
                <ul className="rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
                  {results.map((d) => (
                    <li key={d.id}>
                      <button type="button" onClick={() => setDoc(d)} className="w-full px-3 h-10 text-left text-[15px] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2">
                        <FileText className="w-4 h-4 text-[var(--color-text-faint)]" /> {d.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-[15px] font-semibold text-[var(--color-text)]">Proposed: {proposal.score}% covered</span>
                <span className="text-[13px] text-[var(--color-text-muted)]">Nothing is recorded until you confirm.</span>
                <span className="ml-auto flex items-center gap-2">
                  <button type="button" onClick={() => setProposal(null)} className={heroQuiet}>Discard</button>
                  <button type="button" onClick={() => void confirm()} disabled={confirming} className={heroQuiet}>
                    {confirming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Confirm to record
                  </button>
                </span>
              </div>
              <table className="w-full text-[15px] rounded-md border border-[var(--color-border)]">
                <tbody className="divide-y divide-[var(--color-border)]">
                  {proposal.findings.map((f) => (
                    <tr key={f.area}>
                      <td className="px-3 py-2 align-top whitespace-nowrap"><StatusTag tone={f.covered ? "good" : "bad"}>{areaLabel.get(f.area) ?? f.area}</StatusTag></td>
                      <td className="px-3 py-2 text-[var(--color-text)]">{f.finding}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Safety & performance log ─────────────────────────────────────────────

const EVENT_TONE: Record<CompanyEvent["kind"], Tone> = { recordable: "bad", stop_work: "bad", warning: "warn", commendation: "good", near_miss: "none", other: "none" };

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
    <Card pad={false} className="overflow-hidden"
      label={<span className="inline-flex items-center gap-1.5">Safety and performance log <HelpTooltip>Dated, named facts that feed the safety score. Logging a near miss costs nothing; it&apos;s a healthy habit.</HelpTooltip></span>}
      action={<span className="text-[13px] text-[var(--color-text-muted)] tabular-nums">{plural(events.length, "event")}</span>}>
      {canManage && (
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
          <select value={kind} aria-label="Kind of event" onChange={(e) => setKind(e.target.value as CompanyEvent["kind"])} className={FIELD}>
            {(Object.keys(EVENT_KIND_LABEL) as CompanyEvent["kind"][]).map((k) => (
              <option key={k} value={k}>{EVENT_KIND_LABEL[k]}</option>
            ))}
          </select>
          <input type="date" value={date} aria-label="Date" onChange={(e) => setDate(e.target.value)} className={`${FIELD} [color-scheme:light] dark:[color-scheme:dark]`} />
          <input id="company-event-what" value={desc} onChange={(e) => setDesc(e.target.value)}
            aria-label="What happened"
            onKeyDown={(e) => { if (e.key === "Enter" && desc.trim()) void add(); }}
            placeholder="What happened? It goes on their permanent record."
            className={`${FIELD} flex-1 min-w-56`} />
          <button type="button" onClick={() => void add()} disabled={busy || !desc.trim()} className={`${heroQuiet} h-10`}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Log it
          </button>
        </div>
      )}
      {events.length === 0 ? (
        <p className="px-4 py-4 text-[15px] text-[var(--color-text-muted)]">No events on record.</p>
      ) : (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-[15px]">
            <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
              <tr><th className={TH}>Date</th><th className={TH}>Event</th><th className={`${TH} w-full`}>What happened</th><th className={`${TH} hidden sm:table-cell`}>Logged by</th></tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="px-4 py-2.5 align-top whitespace-nowrap tabular-nums">{fmtDay(e.eventDate + "T00:00:00")}</td>
                  <td className="px-4 py-2.5 align-top whitespace-nowrap"><StatusTag tone={EVENT_TONE[e.kind]}>{EVENT_KIND_LABEL[e.kind]}</StatusTag></td>
                  <td className="px-4 py-2.5 align-top text-[var(--color-text)]">{e.description}</td>
                  <td className="px-4 py-2.5 align-top whitespace-nowrap hidden sm:table-cell text-[var(--color-text-muted)]">{e.createdByName ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ── History: jobs, bids, change orders ───────────────────────────────────

function HistoryPanels({ profile }: { profile: CompanyProfileData | null }) {
  if (!profile) return null;
  const { projects, bids, changeOrders } = profile;
  if (projects.length === 0 && bids.length === 0 && changeOrders.length === 0) return null;
  const won = bids.filter((b) => b.won).length;
  return (
    <>
      {projects.length > 0 && (
        <Card pad={false} className="overflow-hidden" label="Jobs" action={<span className="text-[13px] text-[var(--color-text-muted)] tabular-nums">{plural(projects.length, "job")}</span>}>
          <table className="w-full text-[15px]">
            <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
              <tr><th className={`${TH} w-full`}>Project</th><th className={TH}>Trade</th><th className={`${TH} text-right`}>Contract</th></tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {projects.map((p) => (
                <tr key={p.projectId}>
                  <td className="px-4 py-2.5"><Link href={`/projects/${p.projectId}`} className="font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{p.projectName}</Link></td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{p.trade ?? <Faint>None</Faint>}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right tabular-nums">{p.contractValue != null ? fmtMoney(p.contractValue) : <Faint>None</Faint>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {bids.length > 0 && (
        <Card pad={false} className="overflow-hidden" label="Bid history" action={<span className="text-[13px] text-[var(--color-text-muted)] tabular-nums">{won} of {bids.length} won</span>}>
          <table className="w-full text-[15px]">
            <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
              <tr><th className={`${TH} w-full`}>Quote</th><th className={`${TH} hidden sm:table-cell`}>Date</th><th className={`${TH} text-right`}>Total</th><th className={TH}>Result</th></tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {bids.map((b, i) => (
                <tr key={i}>
                  <td className="px-4 py-2.5">{b.rfqGroup ?? "Quote"}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap hidden sm:table-cell tabular-nums text-[var(--color-text-muted)]">{b.docDate ? fmtDay(b.docDate) : ""}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right tabular-nums">{b.total != null ? fmtMoney(b.total) : <Faint>None</Faint>}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{b.won ? <StatusTag tone="good">Won</StatusTag> : <span className="text-[13px] text-[var(--color-text-muted)]">Not selected</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {changeOrders.length > 0 && (
        <Card pad={false} className="overflow-hidden" label="Change orders on their scopes" action={<span className="text-[13px] text-[var(--color-text-muted)] tabular-nums">{plural(changeOrders.length, "change order")}</span>}>
          <table className="w-full text-[15px]">
            <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
              <tr><th className={TH}>Number</th><th className={`${TH} w-full`}>Title</th><th className={`${TH} text-right`}>Amount</th><th className={`${TH} hidden md:table-cell`}>Reason</th><th className={`${TH} hidden sm:table-cell`}>Status</th></tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {changeOrders.map((co, i) => (
                <tr key={i}>
                  <td className="px-4 py-2.5 whitespace-nowrap font-display font-semibold tabular-nums">{co.coNumber}</td>
                  <td className="px-4 py-2.5">{co.title}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right tabular-nums">{fmtMoney(co.amount)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap hidden md:table-cell" title={co.reasonCode === "scope_gap" ? "Their bid missed this scope. It counts against their cost discipline." : undefined}>
                    <StatusTag tone={co.reasonCode === "scope_gap" ? "bad" : "none"}>{CO_REASON_LABEL[co.reasonCode as CoReason] ?? co.reasonCode}</StatusTag>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap hidden sm:table-cell text-[var(--color-text-muted)]">{co.status ? co.status[0].toUpperCase() + co.status.slice(1).replace(/_/g, " ") : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
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
    <Modal onClose={onClose} dismissable={!busy} size="lg">
      <ModalHeader title={`Edit ${company.name}`} onClose={busy ? undefined : onClose} />
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) void submit(); }} className="contents">
        <ModalBody className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_200px] gap-4">
            <div><label htmlFor="ce-name" className={LABEL}>Company name</label><input id="ce-name" value={name} onChange={(e) => setName(e.target.value)} required className={`${FIELD} w-full`} /></div>
            <div>
              <label htmlFor="ce-kind" className={LABEL}>Kind</label>
              <select id="ce-kind" value={kind} onChange={(e) => setKind(e.target.value as Company["kind"])} className={`${FIELD} w-full`}>
                {(Object.keys(COMPANY_KIND_LABEL) as Company["kind"][]).map((k) => (
                  <option key={k} value={k}>{COMPANY_KIND_LABEL[k]}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_200px] gap-4">
            <div><label htmlFor="ce-trade" className={LABEL}>Trade <span className="font-normal">(optional)</span></label><input id="ce-trade" value={trade} onChange={(e) => setTrade(e.target.value)} className={`${FIELD} w-full`} /></div>
            <div>
              <label htmlFor="ce-status" className={LABEL}>Status</label>
              <select id="ce-status" value={status} onChange={(e) => setStatus(e.target.value as Company["status"])} className={`${FIELD} w-full`} aria-describedby="ce-status-hint">
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="do_not_use">Do not use</option>
              </select>
            </div>
          </div>
          <p id="ce-status-hint" className="-mt-2 text-[13px] text-[var(--color-text-muted)]">Do not use keeps the record and flags the company across the app.</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div><label htmlFor="ce-cname" className={LABEL}>Contact <span className="font-normal">(optional)</span></label><input id="ce-cname" value={contactName} onChange={(e) => setContactName(e.target.value)} className={`${FIELD} w-full`} /></div>
            <div><label htmlFor="ce-email" className={LABEL}>Email <span className="font-normal">(optional)</span></label><input id="ce-email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} className={`${FIELD} w-full`} /></div>
            <div><label htmlFor="ce-phone" className={LABEL}>Phone <span className="font-normal">(optional)</span></label><input id="ce-phone" type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} className={`${FIELD} w-full`} /></div>
          </div>
          <div><label htmlFor="ce-notes" className={LABEL}>Notes <span className="font-normal">(optional)</span></label><textarea id="ce-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${FIELD} w-full h-auto py-2 resize-y`} /></div>
          {error && (
            <p role="alert" className="relative pl-3 text-[13px] font-semibold text-[var(--color-text)]">
              <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />{error}
            </p>
          )}
        </ModalBody>
        <ModalFooter>
          <button type="button" onClick={onClose} disabled={busy} className={heroQuiet}>Cancel</button>
          <button type="submit" disabled={busy || !name.trim()} className={heroPrimary}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Save
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
