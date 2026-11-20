"use client";

// /companies — the KNOWN COMPANIES registry: every contractor, vendor,
// rental supplier, and internal crew the org works with, each wearing a
// profile card loaded with the data that matters at selection time.
//
// Nothing on a card is a typed-in opinion. The composite dial and its five
// dimensions (safety, quality, cost discipline, schedule, responsiveness)
// are computed from rows the platform already wrote — awards, change
// orders, turnover reviews, milestones, portal timestamps, safety events —
// so every number can show its work, and "Unrated" stays honest where
// evidence doesn't exist yet.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { useDraft } from "@/hooks/useDraft";
import {
  HardHat, Plus, Search, Loader2, AlertTriangle, X, Check, Phone, Mail,
  Trophy, GitPullRequestArrow, Briefcase, ShieldAlert, BookOpenCheck, Timer,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary } from "@/components/ui/PageHero";
import { bandInput, bandInputIcon, bandSeg, bandSegItem, plural } from "@/components/admin/band";
import {
  listCompanies, saveCompany, gatherCompanyProfile,
  COMPANY_KIND_LABEL, type Company, type CompanyProfileData,
} from "@/lib/companies";
import { scoreBand } from "@/lib/companyScore";
import { ScoreDial, scoreBandColor } from "@/components/ui/ChartKit";
import { fmtMoney } from "@/lib/costs";

const KIND_FILTERS = ["all", "contractor", "vendor", "rental", "internal"] as const;

export default function CompaniesPage() {
  const { activeOrgId, uid, hasAnyRole } = useRole();
  const canManage = hasAnyRole(["Admin", "DocCtrl"]);
  const router = useRouter();
  const [profileFailed, setProfileFailed] = useState<Set<string>>(new Set());

  const [companies, setCompanies] = useState<Company[]>([]);
  const [profiles, setProfiles] = useState<Map<string, CompanyProfileData>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<(typeof KIND_FILTERS)[number]>("all");
  const [showAdd, setShowAdd] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setError(null);
    try {
      const list = await listCompanies(activeOrgId);
      setCompanies(list);
      setLoading(false);
      // Evidence gathers run AFTER the cards paint, a few at a time — the
      // page is instant, the scores stream in.
      const queue = [...list];
      const workers = Array.from({ length: 4 }, async () => {
        for (;;) {
          const c = queue.shift();
          if (!c) return;
          try {
            const p = await gatherCompanyProfile(c);
            setProfiles((prev) => new Map(prev).set(c.id, p));
          } catch { setProfileFailed((prev) => new Set(prev).add(c.id)); }
        }
      });
      await Promise.all(workers);
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
    }
  }, [activeOrgId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return companies.filter((c) =>
      (kindFilter === "all" || c.kind === kindFilter) &&
      (!q || c.name.toLowerCase().includes(q) || (c.trade ?? "").toLowerCase().includes(q)));
  }, [companies, search, kindFilter]);

  const doNotUse = companies.filter((c) => c.status === "do_not_use").length;
  const answer = loading ? "Known companies" : error && companies.length === 0 ? "Couldn't load the companies."
    : companies.length === 0 ? "No companies yet." : `${plural(companies.length, "company", "companies")}.`;
  const sub = loading
    ? "Contractors, vendors and crews, scored only on recorded work."
    : <>{doNotUse > 0 && <><span className="font-semibold text-rose-300">{doNotUse} marked do not use</span>. </>}Scored only on recorded work, never on opinion.</>;
  const [limit, setLimit] = useState(20);

  return (
    <PageShell width="work">
      <PageHero
        kicker="Known companies"
        title={answer}
        sub={sub}
        primary={canManage ? (
          <button type="button" onClick={() => setShowAdd(true)} className={heroPrimary}><Plus className="w-4 h-4" /> Add company</button>
        ) : undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search className={bandInputIcon} />
            <label htmlFor="company-search" className="sr-only">Search companies</label>
            <input id="company-search" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Find by name or trade (piping, E&I)"
              className={bandInput} />
          </div>
          <div className={bandSeg} role="group" aria-label="Kind of company">
            {KIND_FILTERS.map((k) => (
              <button key={k} type="button" onClick={() => setKindFilter(k)} aria-pressed={kindFilter === k} className={bandSegItem(kindFilter === k)}>
                {k === "all" ? "All" : COMPANY_KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
      </PageHero>

      <PageBody>
      {error && (
        <Card>
          <p role="alert" className="flex items-center gap-2 text-[14px] font-semibold text-rose-700 dark:text-rose-300">
            <AlertTriangle className="w-4 h-4 shrink-0" /> Couldn&apos;t load the companies: {error}
            <button type="button" onClick={() => void refresh()} className="underline">Try again</button>
          </p>
        </Card>
      )}

      {loading ? (
        <Card><LoadingBlock what="companies" className="border-0 p-0" /></Card>
      ) : shown.length === 0 ? (
        <Card className="text-center py-10">
          <HardHat className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-3" />
          <h3 className="text-[14px] font-bold text-[var(--color-text)] mb-1">
            {companies.length === 0 ? "Start the registry" : "No companies match"}
          </h3>
          <p className="text-[14px] text-[var(--color-text-muted)] max-w-md mx-auto">
            {companies.length === 0
              ? "Add the contractors and vendors you work with. Their record (awards, change orders, turnover acceptance, safety events) fills in as projects run."
              : "Try a different filter or search."}
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {shown.slice(0, limit).map((c) => (
              <CompanyCard key={c.id} company={c} profile={profiles.get(c.id) ?? null} failed={profileFailed.has(c.id)} />
            ))}
          </div>
          {shown.length > limit && (
            <Card className="flex items-center justify-between text-[13px]">
              <span className="text-[var(--color-text-muted)]">{limit} of {shown.length} shown</span>
              <button type="button" onClick={() => setLimit((n) => n + 40)} className="font-bold text-[var(--color-accent)] hover:underline">
                Show {Math.min(40, shown.length - limit)} more
              </button>
            </Card>
          )}
        </>
      )}
      </PageBody>

      {showAdd && activeOrgId && uid && (
        <AddCompanyModal orgId={activeOrgId} actorId={uid}
          onClose={() => setShowAdd(false)}
          onCreated={(created) => { setShowAdd(false); router.push(`/companies/${created.id}`); }} />
      )}
    </PageShell>
  );
}

// ── The juicy card ───────────────────────────────────────────────────────

function CompanyCard({ company: c, profile, failed }: { company: Company; profile: CompanyProfileData | null; failed?: boolean }) {
  const sc = profile?.scorecard ?? null;
  const band = scoreBand(sc?.composite ?? null);
  const safety = useMemo(() => {
    const ev = profile?.events ?? [];
    return {
      recordables: ev.filter((e) => e.kind === "recordable").length,
      nearMisses: ev.filter((e) => e.kind === "near_miss").length,
      stopWorks: ev.filter((e) => e.kind === "stop_work").length,
      commendations: ev.filter((e) => e.kind === "commendation").length,
    };
  }, [profile]);
  const bidsWon = profile?.bids.filter((b) => b.won).length ?? 0;
  const bidsTotal = profile?.bids.length ?? 0;
  const coCount = profile?.changeOrders.filter((co) => co.status === "approved").length ?? 0;
  const coAmount = profile?.changeOrders.filter((co) => co.status === "approved").reduce((s, co) => s + co.amount, 0) ?? 0;

  return (
    <Link href={`/companies/${c.id}`}
      className="group block bg-[var(--color-surface)] rounded-2xl p-4 sm:p-5 shadow-[var(--shadow-card)] hover-lift">
      <div className="flex items-start gap-4">
        {/* Dial */}
        <div className="shrink-0 flex flex-col items-center">
          <ScoreDial score={sc?.composite ?? null} size={76} label={band.label} />
          {sc && sc.evidenceCount > 0 && (
            <span className="mt-1 text-[11px] text-[var(--color-text-faint)]" title="How much recorded evidence backs this score">
              {sc.evidenceCount} evidence point{sc.evidenceCount === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {/* Identity + dimensions */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] font-bold text-[var(--color-text)] truncate group-hover:underline">{c.name}</span>
            <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">{COMPANY_KIND_LABEL[c.kind]}</span>
            {c.trade && <span className="text-[13px] text-[var(--color-text-muted)]">{c.trade}</span>}
            {c.status === "do_not_use" && (
              <span className="text-[11px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-rose-500/50 bg-rose-500/10 text-rose-700 dark:text-rose-300">Do not use</span>
            )}
            {c.status === "inactive" && <span className="text-[11px] font-bold text-[var(--color-text-faint)]">inactive</span>}
          </div>

          {/* The five dimensions — each shows its work on hover AND in text. */}
          <div className="mt-2 space-y-1">
            {(sc?.dimensions ?? []).map((d) => (
              <div key={d.key} className="flex items-center gap-2 text-[12px]" title={d.detail}>
                <span className="w-24 shrink-0 font-bold text-[var(--color-text-muted)]">{d.label}</span>
                {d.score != null ? (
                  <>
                    <span className="h-1.5 w-24 rounded-full bg-[var(--viz-track)] overflow-hidden shrink-0">
                      <span className="block h-full rounded-full" style={{ width: `${d.score}%`, background: scoreBandColor(d.score) }} />
                    </span>
                    <span className="tabular-nums font-black text-[var(--color-text)] w-7 shrink-0">{Math.round(d.score)}</span>
                    <span className="text-[var(--color-text-muted)] truncate">{d.detail}</span>
                  </>
                ) : (
                  <span className="text-[var(--color-text-faint)] italic">{d.detail}</span>
                )}
              </div>
            ))}
            {!profile && failed && (
              <div className="text-[11px] text-rose-700 dark:text-rose-400">Couldn&apos;t gather the record. Open the company to try again.</div>
            )}
            {!profile && !failed && (
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-faint)]"><Loader2 className="w-3 h-3 animate-spin" /> Gathering the record…</div>
            )}
          </div>
        </div>
      </div>

      {/* Fact strip — the juicy row. */}
      <div className="mt-3 pt-2.5 border-t border-[var(--color-border)] flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-[var(--color-text-muted)]">
        {(profile?.projects.length ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1" title={profile!.projects.map((p) => p.projectName).join(", ")}>
            <Briefcase className="w-3 h-3" /> {profile!.projects.length} job{profile!.projects.length === 1 ? "" : "s"}
          </span>
        )}
        {bidsTotal > 0 && (
          <span className="inline-flex items-center gap-1" title="Quotes submitted / awarded">
            <Trophy className="w-3 h-3" /> {bidsWon}/{bidsTotal} bids won
          </span>
        )}
        {coCount > 0 && (
          <span className="inline-flex items-center gap-1" title="Approved change orders on their scopes">
            <GitPullRequestArrow className="w-3 h-3" /> {coCount} CO{coCount === 1 ? "" : "s"} · {fmtMoney(coAmount)}
          </span>
        )}
        {(safety.recordables > 0 || safety.stopWorks > 0) && (
          <span className="inline-flex items-center gap-1 font-bold text-rose-700 dark:text-rose-300">
            <ShieldAlert className="w-3 h-3" /> {safety.recordables > 0 ? `${safety.recordables} recordable${safety.recordables === 1 ? "" : "s"}` : ""}{safety.recordables > 0 && safety.stopWorks > 0 ? " · " : ""}{safety.stopWorks > 0 ? `${safety.stopWorks} stop-work${safety.stopWorks === 1 ? "" : "s"}` : ""}
          </span>
        )}
        {c.qualityManualScore != null && (
          <span className="inline-flex items-center gap-1" title="Quality-manual coverage vs the ISO 9001-shaped rubric (human-confirmed)">
            <BookOpenCheck className="w-3 h-3" /> QM {Math.round(c.qualityManualScore)}%
          </span>
        )}
        {sc?.dimensions.find((d) => d.key === "responsiveness")?.score != null && (
          <span className="inline-flex items-center gap-1" title={sc.dimensions.find((d) => d.key === "responsiveness")!.detail}>
            <Timer className="w-3 h-3" /> {sc.dimensions.find((d) => d.key === "responsiveness")!.detail.split(" · ")[0]}
          </span>
        )}
        {c.contactName && <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" /> {c.contactName}</span>}
        {c.contactEmail && <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" /> {c.contactEmail}</span>}
      </div>
    </Link>
  );
}

// ── Add modal ────────────────────────────────────────────────────────────

function AddCompanyModal({ orgId, actorId, onClose, onCreated }: {
  orgId: string; actorId: string; onClose: () => void; onCreated: (created: Company) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Company["kind"]>("contractor");
  const [trade, setTrade] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notesDraft = useDraft<string>(`new-company-notes:${orgId}`, notes, setNotes, (v) => !v.trim());

  useEffect(() => {
    if (busy) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const created = await saveCompany({
        orgId, name, kind, trade,
        contactName, contactEmail, contactPhone, notes,
        actorId,
      });
      notesDraft.clear();
      // Straight to the new company's file.
      onCreated(created);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Add a known company" className="fixed inset-0 z-[200] bg-[var(--color-ink)]/60 animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="p-2 bg-[var(--color-surface-2)] rounded-lg"><HardHat className="w-5 h-5 text-[var(--color-text-muted)]" /></div>
          <div className="flex-1">
            <div className="text-[14px] font-bold text-[var(--color-text)]">Add a known company</div>
            <div className="text-[13px] text-[var(--color-text-muted)]">Their record fills in from real work. This is the front of the file.</div>
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Close" className="p-2 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company name *" aria-label="Company name" autoFocus
              className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]" />
            <select value={kind} aria-label="Kind" onChange={(e) => setKind(e.target.value as Company["kind"])}
              className="px-2 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]">
              {(Object.keys(COMPANY_KIND_LABEL) as Company["kind"][]).map((k) => (
                <option key={k} value={k}>{COMPANY_KIND_LABEL[k]}</option>
              ))}
            </select>
          </div>
          <input value={trade} onChange={(e) => setTrade(e.target.value)} placeholder="Trade (piping, E&I, scaffolding…)" aria-label="Trade"
            className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]" />
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
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Add company
          </button>
        </div>
      </div>
    </div>
  );
}
