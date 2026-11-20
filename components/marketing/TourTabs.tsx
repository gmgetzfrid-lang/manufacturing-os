"use client";

// The product tour: six stations, one screenful. Auto-advances until the
// visitor touches it, then it's theirs. The screens are the live product's
// look in miniature (the grey panel, a title block holding the answer,
// white sheets, one filled action), with example data.

import React, { useEffect, useState } from "react";
import {
  FileText, Search, Lock, CheckCircle2, Camera, AlertTriangle, BookOpen,
  ChevronLeft, ChevronRight, Tag, Upload, Plus,
} from "lucide-react";
import { bandSeg, bandSegItem } from "@/components/admin/band";
import { StatusTag } from "@/components/admin/kit";

const TABS = [
  { key: "library", label: "Library" },
  { key: "ask", label: "Ask the AI" },
  { key: "ticket", label: "Workflow" },
  { key: "graph", label: "Site graph" },
  { key: "assets", label: "Equipment" },
  { key: "locking", label: "Projects & locking" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const CAPTIONS: Record<TabKey, string> = {
  library: "Every drawing and procedure, one current revision each.",
  ask: "Ask in plain words. The answer is cited to the page, with the proof one click away.",
  ticket: "Requests route through drafting and engineer approval. The system enforces who may sign.",
  graph: "Documents, equipment and operating areas as one map. Switch lenses to see flow, equipment or paper.",
  assets: "Tap an equipment tag anywhere it appears and see the photo record of the real thing.",
  locking: "Projects scope people to their work. Checkout locks stop two drafters saving over each other.",
};

export function TourTabs({ header }: { header?: React.ReactNode }) {
  const [active, setActive] = useState<TabKey>("library");
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => {
      setActive((cur) => {
        const i = TABS.findIndex((x) => x.key === cur);
        return TABS[(i + 1) % TABS.length].key;
      });
    }, 7000);
    return () => clearInterval(t);
  }, [auto]);

  const pick = (k: TabKey) => { setAuto(false); setActive(k); };

  return (
    <>
      <div>
        {header}
        <div className="mt-6 flex items-center gap-2 min-w-0">
          {/* Explicit pause/play: auto-advance must be stoppable without
              parking the cursor over the panel (WCAG 2.2.2). */}
          <button
            type="button"
            onClick={() => setAuto((a) => !a)}
            aria-pressed={!auto}
            aria-label={auto ? "Pause the tour" : "Resume the tour"}
            title={auto ? "Pause the tour" : "Resume the tour"}
            className="w-9 h-9 shrink-0 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors grid place-items-center"
          >
            {auto ? (
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="currentColor" aria-hidden="true">
                <rect x="3" y="2.5" width="3.5" height="11" rx="1" />
                <rect x="9.5" y="2.5" width="3.5" height="11" rx="1" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="currentColor" aria-hidden="true">
                <path d="M4.5 2.8a1 1 0 0 1 1.53-.85l8 5.2a1 1 0 0 1 0 1.7l-8 5.2a1 1 0 0 1-1.53-.85V2.8Z" />
              </svg>
            )}
          </button>
          <div role="tablist" aria-label="Product tour" className={`${bandSeg} min-w-0`}>
            {TABS.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={t.key === active} onClick={() => pick(t.key)}
                className={`relative overflow-hidden ${bandSegItem(t.key === active)}`}>
                {t.label}
                {t.key === active && auto && (
                  <span aria-hidden className="absolute bottom-0 left-0 h-0.5 bg-[var(--color-text-faint)]"
                    style={{ animation: "mkt-progress 7s linear both" }} />
                )}
              </button>
            ))}
          </div>
        </div>
        <p key={active} className="mt-3 text-[15px] text-[var(--color-text-muted)] max-w-2xl"
          style={{ animation: "rise 0.4s var(--ease-fluid) both" }}>
          {CAPTIONS[active]}
        </p>
      </div>
      <style>{`@keyframes mkt-progress { from { width: 0 } to { width: 100% } }
@keyframes mkt-dash { to { stroke-dashoffset: -24 } }
.mkt-dash-anim { animation: mkt-dash 1.2s linear infinite }
@media (prefers-reduced-motion: reduce) { .mkt-dash-anim { animation: none } }`}</style>
      <div key={`panel-${active}`} role="tabpanel" aria-live="polite"
        className="mt-4"
        style={{ animation: "rise 0.5s var(--ease-fluid) both" }}>
        {active === "library" && <LibraryMockup />}
        {active === "ask" && <AskMockup />}
        {active === "ticket" && <TicketMockup />}
        {active === "graph" && <GraphMockup />}
        {active === "assets" && <EquipmentMockup />}
        {active === "locking" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <ProjectMockup />
            <CheckoutMockup />
          </div>
        )}
      </div>
    </>
  );
}

// ─── The miniature app: frame, side menu, band, cards ─────────────────────

function MockupFrame({ url, side, children }: { url: string; side?: number; children: React.ReactNode }) {
  // Pictures of the product: inert + aria-hidden keeps their dead buttons
  // out of the tab order; the captions above carry the meaning.
  return (
    <div inert aria-hidden
      className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] overflow-hidden">
      <div className="h-9 px-3 flex items-center gap-3 border-b border-[var(--color-border)]">
        <div className="flex gap-1.5 shrink-0">
          <span className="w-2.5 h-2.5 rounded-full bg-[var(--color-border-strong)]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[var(--color-border-strong)]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[var(--color-border-strong)]" />
        </div>
        <div className="flex-1 min-w-0 max-w-md mx-auto h-6 px-3 rounded bg-[var(--color-surface-2)] text-[12px] text-[var(--color-text-muted)] truncate leading-6">
          {url}
        </div>
      </div>
      <div className="flex">
        {side !== undefined && (
          <div className="hidden sm:flex w-12 shrink-0 flex-col items-center gap-2 py-3 bg-[var(--color-surface)] border-r border-[var(--color-border)]">
            <span className="w-6 h-6 rounded bg-[var(--color-text)] mb-2" />
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <span key={i} className={`w-7 h-7 rounded ${i === side ? "bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-main)]" : "bg-[var(--color-surface-2)]"}`} />
            ))}
          </div>
        )}
        <div className="flex-1 min-w-0 bg-[var(--color-canvas)] p-3 sm:p-5">{children}</div>
      </div>
    </div>
  );
}

function MiniBand({ kicker, answer, sub, action, children }: {
  kicker: string; answer: string; sub?: string; action?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div className="pb-3 border-b border-[var(--color-border-strong)]">
      <div className="text-[12px] font-medium text-[var(--color-text-muted)] truncate">{kicker}</div>
      <div className="mt-1 flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-[220px]">
          <div className="font-display text-[22px] sm:text-[26px] font-semibold leading-[1.08] text-[var(--color-text)]">{answer}</div>
          {sub && <div className="mt-1 text-[13px] text-[var(--color-text-muted)]">{sub}</div>}
        </div>
        {action && (
          <span className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-semibold">
            {action}
          </span>
        )}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

function MiniBody({ children }: { children: React.ReactNode }) {
  return <div className="mt-3 space-y-3">{children}</div>;
}

function MiniCard({ label, children, className = "" }: { label?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      {label && <div className="mb-1.5 font-display text-[15px] font-semibold text-[var(--color-text)]">{label}</div>}
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 sm:p-4">{children}</div>
    </div>
  );
}

function MiniSteps({ steps, now }: { steps: string[]; now: number }) {
  return (
    <div className="flex items-start">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const done = i < now;
        return (
          <div key={s} className={last ? "shrink-0 pr-1" : "flex-1 min-w-0"}>
            <div className="flex items-center">
              <span className="w-3 h-3 rounded-full shrink-0 box-border"
                style={done ? { background: "var(--color-text)" } : { border: `2px solid ${i === now ? "var(--color-text)" : "var(--color-border-strong)"}` }} />
              {!last && <span className="flex-1 h-0.5" style={{ background: i + 1 <= now ? "var(--color-text)" : "var(--color-border-strong)" }} />}
            </div>
            <div className={`mt-1.5 pr-2 text-[12px] font-semibold truncate ${i <= now ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{s}</div>
          </div>
        );
      })}
    </div>
  );
}

function Avatar({ initials }: { initials: string }) {
  return (
    <span className="w-6 h-6 shrink-0 rounded-full bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] text-[var(--color-text)] text-[11px] font-semibold grid place-items-center">
      {initials}
    </span>
  );
}

const statusChip = {
  current: { tone: "good", label: "Issued" },
  revision: { tone: "warn", label: "In revision" },
  draft: { tone: "none", label: "Draft" },
} as const;

// ─── Library ────────────────────────────────────────────────────────────────

function DocRow({ id, name, rev, status, checkedOut }: {
  id: string; name: string; rev: string; status: keyof typeof statusChip; checkedOut?: boolean;
}) {
  const s = statusChip[status];
  return (
    <div className="flex items-center gap-3 py-2.5 border-t first:border-t-0 border-[var(--color-border)]">
      <FileText className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />
      <div className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-3">
        <div className="font-display text-[14px] font-semibold tabular-nums text-[var(--color-text)] shrink-0">{id}</div>
        <div className="text-[13px] text-[var(--color-text-muted)] truncate">{name}</div>
      </div>
      <span className="hidden sm:block text-[13px] text-[var(--color-text-muted)] shrink-0">{rev}</span>
      {checkedOut && (
        <span className="hidden sm:inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-text-muted)] shrink-0">
          <Lock className="w-3 h-3" /> Checked out
        </span>
      )}
      <StatusTag tone={s.tone} className="shrink-0">{s.label}</StatusTag>
    </div>
  );
}

function LibraryMockup() {
  return (
    <MockupFrame url="app.manufacturing-os.com/documents/site-mechanical" side={1}>
      <MiniBand kicker="Document control · Site mechanical" answer="47 drawings. 1 checked out."
        sub="38 issued, 7 in revision, 2 drafts." action={<><Upload className="w-3.5 h-3.5" /> Upload</>}>
        <div className="h-9 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] flex items-center gap-2 text-[13px] text-[var(--color-text-faint)]">
          <Search className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">Find by number, title or equipment tag</span>
        </div>
      </MiniBand>
      <MiniBody>
        <MiniCard label="Process drawings">
          <DocRow id="100-PRC-001" name="Process drawing, Area 100 east" rev="Rev 7" status="current" />
          <DocRow id="100-PRC-002" name="Process drawing, Area 100 west" rev="Rev 5" status="current" />
          <DocRow id="200-PRC-001" name="Process drawing, Area 200" rev="Rev 2" status="draft" checkedOut />
          <DocRow id="200-ISO-014" name='Iso 14" line, feed inlet' rev="Rev 1" status="current" />
          <DocRow id="200-ISO-015" name='Iso 8" line, cooling return' rev="Rev 3" status="revision" />
          <div className="pt-2.5 border-t border-[var(--color-border)] text-[13px] text-[var(--color-accent-text)]">Show 42 more</div>
        </MiniCard>
      </MiniBody>
    </MockupFrame>
  );
}

// ─── Ask the AI ─────────────────────────────────────────────────────────────

function AskMockup() {
  return (
    <MockupFrame url="app.manufacturing-os.com/assistant" side={3}>
      <MiniBand kicker="Intelligence · Ask" answer="285 psig at 650 °F." sub="Cited to 2 pages in your library.">
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] text-[var(--color-text)]">
            What is the minimum design pressure for the Area 200 feed line?
          </div>
        </div>
      </MiniBand>
      <MiniBody>
        <MiniCard label="Answer">
          <p className="text-[14px] text-[var(--color-text)] leading-relaxed">
            The feed line is rated for a minimum design pressure of 285 psig at 650&nbsp;°F<sup className="font-semibold ml-0.5">1</sup>,
            set by the piping class for that service<sup className="font-semibold ml-0.5">2</sup>.
          </p>
          <div className="mt-3 space-y-1.5 text-[12px] text-[var(--color-text-muted)]">
            <div className="flex items-start gap-2"><CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--color-text)]" /> Basis: the piping class table and the line list entry for the 14&quot; feed line.</div>
            <div className="flex items-start gap-2"><CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--color-text)]" /> It can only cite documents in your library. Nothing is invented.</div>
          </div>
          <div className="mt-3 pt-3 border-t border-[var(--color-border)] flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text)]">
              <BookOpen className="w-3.5 h-3.5" /> 1. Piping class spec <span className="text-[var(--color-text-muted)]">p. 143</span>
            </span>
            <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text)]">
              <FileText className="w-3.5 h-3.5" /> 2. Line list, Area 200 <span className="text-[var(--color-text-muted)]">p. 12</span>
            </span>
          </div>
          <p className="mt-3 text-[12px] text-[var(--color-text-muted)]">
            Runs on your own AI key (Claude or OpenAI) with per-user spend caps. Your documents never train anyone&apos;s model.
          </p>
        </MiniCard>
      </MiniBody>
    </MockupFrame>
  );
}

// ─── Workflow ───────────────────────────────────────────────────────────────

function Person({ label, name, note, warn }: { label: string; name: string; note: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] font-semibold text-[var(--color-text-muted)] mb-1">{label}</div>
      <div className="flex items-center gap-2 min-w-0">
        <Avatar initials={name.split(" ").map((w) => w[0]).join("")} />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-[var(--color-text)] truncate">{name}</div>
          <div className={`text-[12px] truncate ${warn ? "font-semibold text-[var(--state-held)]" : "text-[var(--color-text-muted)]"}`}>{note}</div>
        </div>
      </div>
    </div>
  );
}

function TicketMockup() {
  return (
    <MockupFrame url="app.manufacturing-os.com/requests/T-211" side={2}>
      <MiniBand kicker="Drafting requests · T-211 · MOC" answer="Waiting on Sarah's approval."
        sub="Area 200 bypass, flow element FE-201. Opened by an operator, routed to a qualified engineer.">
        <MiniSteps steps={["Opened", "Assigned", "Drafted", "Approval", "Issued"]} now={3} />
      </MiniBand>
      <MiniBody>
        <MiniCard>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Person label="Requester" name="John Doe" note="Operator" />
            <Person label="Engineer" name="Sarah Mitchell" note="Awaiting sign-off" warn />
            <Person label="Drafter" name="Tom Reyes" note="Drafter" />
            <div>
              <div className="text-[13px] font-semibold text-[var(--color-text-muted)] mb-1">Target</div>
              <div className="font-display text-[15px] font-semibold text-[var(--color-text)]">Jun 10</div>
              <div className="text-[12px] font-semibold text-[var(--state-held)]">Due soon</div>
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-[var(--color-border)]">
            <div className="text-[13px] font-semibold text-[var(--color-text-muted)] mb-2">Latest comment</div>
            <div className="flex items-start gap-2.5">
              <Avatar initials="JD" />
              <p className="text-[13px] text-[var(--color-text)] leading-relaxed">
                <span className="font-semibold">John Doe</span> <span className="text-[12px] text-[var(--color-text-muted)]">2 hours ago</span><br />
                <span className="text-[var(--color-accent-text)]">@Sarah Mitchell</span>{" "}
                please confirm the sizing on FE-201 is right for the new flow. The scope is attached.
              </p>
            </div>
          </div>
        </MiniCard>
      </MiniBody>
    </MockupFrame>
  );
}

// ─── Site graph ─────────────────────────────────────────────────────────────

function GraphMockup() {
  const areas = [
    { x: 150, y: 150, label: "Area 100" },
    { x: 290, y: 110, label: "Area 200" },
    { x: 430, y: 150, label: "Area 300" },
  ];
  const docs = [
    { x: 95, y: 240, label: "100-PRC-001" },
    { x: 250, y: 40, label: "200-PRC-001" },
    { x: 375, y: 52, label: "Line list" },
    { x: 480, y: 245, label: "300-ISO-014" },
  ];
  return (
    <MockupFrame url="app.manufacturing-os.com/graph" side={3}>
      <MiniBand kicker="Site graph · Process flow" answer="3 areas, 1 pump, 4 drawings.">
        <div className={bandSeg}>
          {["Everything", "Process flow", "Equipment", "Documents"].map((l, i) => (
            <span key={l} className={bandSegItem(i === 1)}>{l}</span>
          ))}
        </div>
      </MiniBand>
      <MiniBody>
        <MiniCard className="lg:flex lg:items-center lg:gap-6">
          {/* A fixed-size picture: on a phone it scrolls sideways (cut off at
              the edge, so it's plain it keeps going) and its labels stay
              readable instead of shrinking. */}
          <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:flex-1">
            <svg width="600" height="290" viewBox="0 0 600 290" className="block mx-auto">
              <g className="mkt-dash-anim" stroke="var(--color-text)" strokeWidth="2" fill="none" strokeDasharray="6 6">
                <path d="M150 150 L290 110" />
                <path d="M290 110 L430 150" />
                <path d="M430 150 L540 100" />
              </g>
              <g stroke="var(--color-border-strong)" strokeWidth="1.5" fill="none">
                <path d="M150 150 L95 240" />
                <path d="M290 110 L250 40" />
                <path d="M290 110 L375 52" />
                <path d="M430 150 L480 245" />
              </g>
              {areas.map((n) => (
                <g key={n.label}>
                  <circle cx={n.x} cy={n.y} r="17" fill="var(--color-text)" opacity="0.08" />
                  <circle cx={n.x} cy={n.y} r="10" fill="var(--color-text)" />
                  <text x={n.x} y={n.y + 32} textAnchor="middle" fill="var(--color-text)" fontSize="12" fontWeight="700">{n.label}</text>
                </g>
              ))}
              <rect x="531" y="91" width="18" height="18" rx="3" fill="var(--color-text-muted)" />
              <text x="540" y="128" textAnchor="middle" fill="var(--color-text)" fontSize="12" fontWeight="700">P-201A</text>
              {docs.map((n) => (
                <g key={n.label}>
                  <circle cx={n.x} cy={n.y} r="6" fill="var(--color-surface)" stroke="var(--color-text)" strokeWidth="2" />
                  <text x={n.x} y={n.y + (n.y < 100 ? -12 : 22)} textAnchor="middle" fill="var(--color-text-muted)" fontSize="13" fontFamily="var(--font-display)">{n.label}</text>
                </g>
              ))}
            </svg>
          </div>
          <div className="mt-3 lg:mt-0 pt-3 lg:pt-0 border-t lg:border-t-0 lg:border-l border-[var(--color-border)] lg:pl-6 lg:w-56 flex flex-wrap lg:flex-col gap-x-4 gap-y-2 text-[12px] font-semibold text-[var(--color-text)]">
            <span className="inline-flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-[var(--color-text)]" /> Operating area</span>
            <span className="inline-flex items-center gap-2"><span className="w-3 h-3 rounded-sm bg-[var(--color-text-muted)]" /> Equipment</span>
            <span className="inline-flex items-center gap-2"><span className="w-3 h-3 rounded-full border-2 border-[var(--color-text)]" /> Document</span>
            <span className="inline-flex items-center gap-2"><span className="w-4 shrink-0 border-t-2 border-dashed border-[var(--color-text)]" /> Process flow, read by the AI from your drawings and confirmed by a person</span>
          </div>
        </MiniCard>
      </MiniBody>
    </MockupFrame>
  );
}

// ─── Equipment & photos ─────────────────────────────────────────────────────

function EquipmentMockup() {
  const tiles = [
    { tag: "FE-201", type: "Instrument", photos: 4, on: true },
    { tag: "P-200A", type: "Pump", photos: 3 },
    { tag: "V-101", type: "Vessel", photos: 5 },
    { tag: "E-301", type: "Exchanger", photos: 0 },
  ];
  return (
    <MockupFrame url="app.manufacturing-os.com/admin/assets" side={2}>
      <MiniBand kicker="Operating areas · Area 200" answer="4 pieces of equipment. 1 has no photos."
        action={<><Plus className="w-3.5 h-3.5" /> Add equipment</>} />
      <MiniBody>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          <MiniCard label="Instruments and rotating" className="lg:col-span-7">
            <div className="grid grid-cols-2 gap-2.5">
              {tiles.map((a) => (
                <div key={a.tag} className={`rounded-md p-2 bg-[var(--color-surface)] ${a.on ? "ring-2 ring-[var(--color-text)]" : "ring-1 ring-[var(--color-border)]"}`}>
                  <div className="h-20 sm:h-24 rounded-md bg-[var(--color-surface-2)] grid place-items-center mb-2">
                    {a.photos > 0 ? <Camera className="w-5 h-5 text-[var(--color-text-faint)]" /> : <FileText className="w-5 h-5 text-[var(--color-text-faint)]" />}
                  </div>
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-display text-[14px] font-semibold text-[var(--color-text)]">{a.tag}</span>
                    <span className="text-[11px] font-semibold text-[var(--color-text-muted)] truncate">{a.type}</span>
                  </div>
                  {a.photos > 0 ? (
                    <div className="text-[12px] text-[var(--color-text-muted)]">{a.photos} photos</div>
                  ) : (
                    <div className="text-[12px] font-semibold text-[var(--state-held)] inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> No photos</div>
                  )}
                </div>
              ))}
            </div>
          </MiniCard>
          {/* A photo opened over the list: viewer chrome is charcoal. */}
          <div className="lg:col-span-5 rounded-md bg-[var(--color-ink)] text-white overflow-hidden flex flex-col min-h-[220px]">
            <div className="px-3 py-2.5 border-b border-white/10 flex items-center gap-2 min-w-0">
              <Tag className="w-3.5 h-3.5 shrink-0" />
              <span className="font-display text-[14px] font-semibold">FE-201</span>
              <span className="text-[11px] text-white/70">Instrument</span>
              <span className="ml-auto text-[11px] tabular-nums text-white/70">2 of 4</span>
            </div>
            <div className="flex-1 relative grid place-items-center bg-white/5">
              <Camera className="w-8 h-8 text-white/30" />
              <span className="absolute left-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white/15 grid place-items-center"><ChevronLeft className="w-4 h-4" /></span>
              <span className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white/15 grid place-items-center"><ChevronRight className="w-4 h-4" /></span>
              <span className="absolute bottom-2 right-2 px-2 py-1 rounded-md bg-black/50 text-[11px] font-semibold">Aug 15, 2025 · 12 months ago</span>
            </div>
            <div className="px-3 py-2 border-t border-white/10 flex gap-1.5">
              {[1, 2, 3, 4].map((i) => (
                <span key={i} className={`w-9 h-9 rounded-md bg-white/10 ${i === 2 ? "ring-2 ring-white" : ""}`} />
              ))}
            </div>
          </div>
        </div>
        <MiniCard>
          <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed">
            <span className="inline-flex items-center gap-1 px-1.5 mr-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[12px] font-semibold text-[var(--color-text)]"><Tag className="w-3 h-3" /> FE-201, 4 photos</span>
            The same tag works everywhere FE-201 appears: document rows, viewers, requests, the graph. One tap, every photo.
          </p>
        </MiniCard>
      </MiniBody>
    </MockupFrame>
  );
}

// ─── Projects & locking ─────────────────────────────────────────────────────

function ActivityRow({ who, children, when }: { who: string; children: React.ReactNode; when: string }) {
  return (
    <div className="flex items-start gap-2.5 py-2 border-t first:border-t-0 border-[var(--color-border)]">
      <Avatar initials={who} />
      <div className="flex-1 min-w-0 text-[13px] text-[var(--color-text-muted)] leading-snug">
        <span className="font-semibold text-[var(--color-text)]">{who}</span> {children}
      </div>
      <span className="text-[12px] text-[var(--color-text-muted)] shrink-0">{when}</span>
    </div>
  );
}

function ProjectMockup() {
  return (
    <MockupFrame url="app.manufacturing-os.com/projects/area-200-change">
      <MiniBand kicker="Projects · Area 200 change" answer="Phase 3 of 5. On track." sub="12 documents · 6 open requests">
        <MiniSteps steps={["Scope", "Design", "Build", "Turnover", "Close"]} now={2} />
      </MiniBand>
      <MiniBody>
        <MiniCard label="Recent activity">
          <ActivityRow who="JD" when="2h">approved <span className="font-display font-semibold text-[var(--color-text)]">100-PRC-001</span> Rev 7</ActivityRow>
          <ActivityRow who="SM" when="4h">commented on <span className="font-display font-semibold text-[var(--color-text)]">T-209</span></ActivityRow>
          <ActivityRow who="TR" when="1d">issued the final package for <span className="font-display font-semibold text-[var(--color-text)]">200-ISO-014</span></ActivityRow>
          <div className="pt-2.5 border-t border-[var(--color-border)] flex items-center gap-1">
            <Avatar initials="JD" /><Avatar initials="SM" /><Avatar initials="TR" />
            <span className="ml-1.5 text-[12px] text-[var(--color-text-muted)]">4 members. The contractor sees this project only.</span>
          </div>
        </MiniCard>
      </MiniBody>
    </MockupFrame>
  );
}

function CheckoutMockup() {
  return (
    <MockupFrame url="app.manufacturing-os.com/documents/100-PRC-001">
      <MiniBand kicker="Document · 100-PRC-001 · Rev 7" answer="Checked out by Jane Smith."
        sub="Started 4 hours ago. Releases itself in 20 hours." />
      <MiniBody>
        <MiniCard>
          <div className="h-28 rounded bg-[var(--color-surface-2)] grid place-items-center">
            <FileText className="w-8 h-8 text-[var(--color-text-faint)]" />
          </div>
          <div className="mt-3 flex gap-2">
            <span className="flex-1 h-9 rounded-md border border-[var(--color-border)] text-[13px] font-semibold text-[var(--color-text-faint)] grid place-items-center">
              <span className="inline-flex items-center gap-1.5"><Lock className="w-3.5 h-3.5" /> Edit (locked)</span>
            </span>
            <span className="flex-1 h-9 rounded-md border border-[var(--color-border-strong)] text-[13px] font-semibold text-[var(--color-text)] grid place-items-center">View history</span>
          </div>
          <p className="mt-3 text-[12px] text-[var(--color-text-muted)] leading-relaxed">
            One editor at a time, so two drafters can never save over each other. A quick hold releases itself after 24 hours.
          </p>
        </MiniCard>
      </MiniBody>
    </MockupFrame>
  );
}
