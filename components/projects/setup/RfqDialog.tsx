"use client";

// RfqDialog - write the RFQ letter from the project (lib/rfqFromScope): asks
// only what the project can't know (who it goes to, the service, the quote
// date, the contact and the dates) and remembers those on this device for
// the next one. The scope, the shift times and the turnover meetings come
// from the project. Downloads a Word file in the plant's RFQ layout.

import React, { useEffect, useMemo, useState } from "react";
import { FileText, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { field as fieldCls, label as labelCls } from "@/components/admin/kit";
import { useShiftTimes } from "@/lib/shiftTimesStore";
import { meetingLeadMin } from "@/lib/shiftReport";
import { rfqContent, rfqDocx, type RfqFrom } from "@/lib/rfqFromScope";
import { saveFile } from "@/lib/updatePrint";
import { ORG_NAME_KEY } from "@/lib/deviceWorkspace";
import type { ScopeState } from "@/lib/scopeStore";

const SERVICES = ["Mechanical Contractor Services", "Scaffold Services", "Hydroblasting Services", "Crane Services", "Inspection and NDE Services", "Heater Pigging Services", "Chemical Cleaning Services", "Insulation Services"];
const KEEP = "rfq.last";

interface Kept { service: string; fromName: string; contact: string; location: string; equipmentPlan: string; ownerSupplies: string; workByOthers: string }

export default function RfqDialog({ projectName, projectId, scope, crews, actorEmail, finish, onClose, onMade }: {
  projectName: string; projectId: string; scope: ScopeState; crews: string[]; actorEmail?: string; finish?: string;
  onClose: () => void; onMade: (r: { service: string; to: string }) => void;
}) {
  const times = useShiftTimes(projectId);
  const kept = useMemo<Partial<Kept>>(() => { try { return JSON.parse(localStorage.getItem(KEEP) || "{}") as Partial<Kept>; } catch { return {}; } }, []);
  const org = useMemo(() => { try { return localStorage.getItem(ORG_NAME_KEY) || ""; } catch { return ""; } }, []);
  const [to, setTo] = useState("");
  const [service, setService] = useState(kept.service ?? SERVICES[0]);
  const [quoteBy, setQuoteBy] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState(finish ?? "");
  const [fromName, setFromName] = useState(kept.fromName ?? (actorEmail ?? ""));
  const [contact, setContact] = useState(kept.contact ?? (actorEmail ?? ""));
  const [location, setLocation] = useState(kept.location ?? "");
  const [orgName, setOrgName] = useState(org);
  const [workByOthers, setWorkByOthers] = useState(kept.workByOthers ?? "");
  const [ownerSupplies, setOwnerSupplies] = useState(kept.ownerSupplies ?? "Crane, Forklifts");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);

  const missing = !to.trim() ? "Who it goes to" : !quoteBy ? "the quote date" : !orgName.trim() ? "your company's name" : !contact.trim() ? "a contact" : null;
  const input: RfqFrom = {
    project: projectName, org: orgName.trim(), service, to: to.trim(), fromName: fromName.trim(), contact: contact.trim(), location: location.trim(),
    quoteBy, start: start || undefined, finish: end || undefined, dayStart: times.dayStart, nightStart: times.nightStart, meetingBefore: meetingLeadMin(times),
    nights: times.nightJobs !== undefined && (times.nightJobs === "file" || times.nightJobs.length > 0),
    workByOthers, ownerSupplies, crews, items: scope.items, coming: scope.coming,
  };
  const glance = rfqContent(input).glance.rows;

  const make = () => {
    if (missing) { setError(`Add ${missing} first.`); return; }
    try {
      const bytes = rfqDocx(input);
      saveFile(bytes, `RFQ - ${service} - ${projectName} - ${to.trim()}.docx`);
      try { localStorage.setItem(KEEP, JSON.stringify({ service, fromName, contact, location, ownerSupplies, workByOthers, equipmentPlan: "" } satisfies Kept)); } catch { /* private mode */ }
      onMade({ service, to: to.trim() });
    } catch (e) { setError(e instanceof Error ? e.message : "The Word file couldn't be made."); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="rfq-title" className="fixed inset-0 z-[200] bg-[var(--color-ink)]/55 flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="ui-float ui-float-in w-full max-w-2xl bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] overflow-hidden">
        <div className="px-6 pt-4 pb-4 border-b border-[var(--color-border)] flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2 id="rfq-title" className="font-display text-section font-semibold text-[var(--color-text)]">Write the RFQ</h2>
            <p className="mt-0.5 text-body text-[var(--color-text-muted)]">In your RFQ layout. The scope, shift times and meetings come from the project; you add who it goes to and the dates.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-5 space-y-4 max-h-[66vh] overflow-y-auto">
          <div className="grid sm:grid-cols-2 gap-x-4 gap-y-4">
            <div><label htmlFor="rfq-to" className={labelCls}>To (contractor)</label><input id="rfq-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="e.g. Schultz Industrial" className={fieldCls} autoComplete="off" /></div>
            <div><label htmlFor="rfq-svc" className={labelCls}>Service</label>
              <select id="rfq-svc" value={service} onChange={(e) => setService(e.target.value)} className={fieldCls}>{SERVICES.map((s) => <option key={s}>{s}</option>)}</select></div>
            <div><label htmlFor="rfq-by" className={labelCls}>Preferred quote date</label><input id="rfq-by" type="date" value={quoteBy} onChange={(e) => setQuoteBy(e.target.value)} className={fieldCls} /></div>
            <div><label htmlFor="rfq-org" className={labelCls}>Your company</label><input id="rfq-org" value={orgName} onChange={(e) => setOrgName(e.target.value)} className={fieldCls} autoComplete="organization" /></div>
            <div><label htmlFor="rfq-start" className={labelCls}>Mechanical start</label><input id="rfq-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} className={fieldCls} /></div>
            <div><label htmlFor="rfq-end" className={labelCls}>Mechanical complete</label><input id="rfq-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={fieldCls} /></div>
            <div><label htmlFor="rfq-from" className={labelCls}>From</label><input id="rfq-from" value={fromName} onChange={(e) => setFromName(e.target.value)} className={fieldCls} autoComplete="name" /></div>
            <div><label htmlFor="rfq-contact" className={labelCls}>Contact (phone and email)</label><input id="rfq-contact" value={contact} onChange={(e) => setContact(e.target.value)} className={fieldCls} /></div>
          </div>
          <div><label htmlFor="rfq-loc" className={labelCls}>Work location</label><input id="rfq-loc" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Plant name and address" className={fieldCls} /></div>
          <div className="grid sm:grid-cols-2 gap-x-4 gap-y-4">
            <div><label htmlFor="rfq-others" className={labelCls}>Work by others <span className="font-normal text-[var(--color-text-muted)]">(optional)</span></label><input id="rfq-others" value={workByOthers} onChange={(e) => setWorkByOthers(e.target.value)} placeholder="e.g. Hydroblasting and inspections by others" className={fieldCls} /></div>
            <div><label htmlFor="rfq-owner" className={labelCls}>You provide</label><input id="rfq-owner" value={ownerSupplies} onChange={(e) => setOwnerSupplies(e.target.value)} className={fieldCls} /></div>
          </div>
          <div className="rounded-lg border border-[var(--color-border)]">
            <div className="px-3 py-2 text-body font-semibold text-[var(--color-text)] border-b border-[var(--color-border)]">Scope at a Glance, from the list</div>
            <ul className="text-body divide-y divide-[var(--color-border)]">
              {glance.map(([w, e, n]) => <li key={w} className="px-3 py-1.5 flex gap-3"><span className="flex-1 min-w-0 text-[var(--color-text)]">{w}</span><span className="tabular-nums text-[var(--color-text-muted)]">{e} equipment · {n} WO</span></li>)}
            </ul>
          </div>
          <p className="text-caption text-[var(--color-text-muted)]">Also in the letter: shift coverage from your shift times, turnover meetings, site expectations, what to include, and every work order grouped as your list groups them.</p>
          {error && <ErrorNote title={error} />}
        </div>
        <div className="px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-wrap items-center justify-end gap-2">
          {missing && <span className="mr-auto text-body text-[var(--color-text-muted)]">Add {missing} to make it.</span>}
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={make} disabled={!!missing}><FileText className="w-4 h-4" /> Download the RFQ (Word)</Button>
        </div>
      </div>
    </div>
  );
}
