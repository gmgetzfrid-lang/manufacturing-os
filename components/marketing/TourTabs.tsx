"use client";

// The product tour, tabbed — six stations, one screenful. Auto-advances
// until the visitor touches it, then it's theirs. Mockups are styled React
// mirroring the live product's layout language (not screenshots, but the
// same UI DNA), with deliberately generic industrial data so the page never
// claims one industry.

import React, { useEffect, useState } from "react";
import {
  FolderOpen, FileText, Search, Filter, ChevronDown, MoreVertical, Plus,
  Lock, Calendar, AtSign, CheckCircle2, ChevronRight, ChevronLeft, X, Tag,
  Camera, AlertTriangle, Settings, Zap, Sparkles, BookOpen, Eye, Waypoints,
} from "lucide-react";

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
  library: "Every drawing and procedure, one current revision each, filterable by collection, status, and age.",
  ask: "Ask your document library a question in plain language — the answer is cited to the page, with highlighted proof one click away.",
  ticket: "Requests route through review, drafting, and engineer approval. The system enforces who is allowed to sign.",
  graph: "Documents, equipment, and operating areas as one living map — switch lenses to see process flow, equipment, or paper.",
  assets: "Tap an equipment tag anywhere it appears and get the photo record of the physical thing.",
  locking: "Projects scope people to their work; checkout locks stop two drafters saving over each other.",
};

export function TourTabs() {
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
    <div>
      <div className="flex flex-wrap gap-2 mb-3">
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => pick(t.key)}
            className={`relative px-4 py-2 rounded-xl text-sm font-black border transition-all overflow-hidden ${
              t.key === active
                ? "bg-orange-600 text-white border-orange-600 shadow-lg"
                : "bg-white text-slate-700 border-slate-200 hover:border-orange-300"
            }`}>
            {t.label}
            {t.key === active && auto && (
              <span className="absolute bottom-0 left-0 h-0.5 bg-white/70"
                style={{ animation: "mkt-progress 7s linear both" }} />
            )}
          </button>
        ))}
      </div>
      <p key={active} className="text-sm text-slate-600 font-medium mb-4"
        style={{ animation: "rise 0.4s var(--ease-fluid) both" }}>
        {CAPTIONS[active]}
      </p>
      <style>{`@keyframes mkt-progress { from { width: 0 } to { width: 100% } }
@keyframes mkt-dash { to { stroke-dashoffset: -24 } }`}</style>
      <div key={`panel-${active}`} style={{ animation: "rise 0.5s var(--ease-fluid) both" }}>
        {active === "library" && <DocumentLibraryMockup />}
        {active === "ask" && <AskAiMockup />}
        {active === "ticket" && <DraftingTicketMockup />}
        {active === "graph" && <GraphMockup />}
        {active === "assets" && <AssetRegistryMockup />}
        {active === "locking" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ProjectMockup />
            <CheckoutMockup />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Shared frame + bits ────────────────────────────────────────────────────

function MockupFrame({ url, children }: { url?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
      <div className="bg-slate-100 border-b border-slate-200 px-3 py-2 flex items-center gap-2">
        <div className="flex gap-1.5 shrink-0">
          <div className="w-2.5 h-2.5 rounded-full bg-red-400" />
          <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
        </div>
        {url && (
          <div className="flex-1 bg-white border border-slate-200 rounded px-3 py-0.5 text-[10px] text-slate-500 font-mono truncate">
            {url}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function Avatar({ initials, color, pulse, sm }: { initials: string; color: string; pulse?: boolean; sm?: boolean }) {
  const size = sm ? "w-5 h-5 text-[8px]" : "w-6 h-6 text-[9px]";
  return (
    <div className={`${size} rounded-full ${color} text-white font-black flex items-center justify-center shrink-0 ${pulse ? "ring-2 ring-blue-300 animate-pulse" : ""}`}>
      {initials}
    </div>
  );
}

// ─── Library ────────────────────────────────────────────────────────────────

function DocRow({
  id, name, rev, status, age, checkedOut,
}: {
  id: string; name: string; rev: string;
  status: "current" | "draft" | "revision";
  age: string; checkedOut?: boolean;
}) {
  const statusStyle =
    status === "current" ? "bg-emerald-100 text-emerald-700" :
    status === "revision" ? "bg-amber-100 text-amber-700" :
    "bg-slate-100 text-slate-700";
  const statusLabel =
    status === "current" ? "Issued" :
    status === "revision" ? "In Revision" :
    "Draft";
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 flex items-center gap-3">
      <input type="checkbox" disabled className="shrink-0" />
      <FileText className="w-4 h-4 text-blue-500 shrink-0" />
      <div className="flex-1 min-w-0 flex items-center gap-3">
        <span className="text-[11px] font-mono font-bold text-slate-900 shrink-0">{id}</span>
        <span className="text-[11px] text-slate-600 truncate">{name}</span>
      </div>
      <span className="text-[10px] font-bold text-slate-500 shrink-0">{rev}</span>
      <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded shrink-0 ${statusStyle}`}>{statusLabel}</span>
      {checkedOut && (
        <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 shrink-0 flex items-center gap-1">
          <Lock className="w-2.5 h-2.5" /> Checked out
        </span>
      )}
      <span className="text-[10px] text-slate-400 shrink-0 w-24 text-right hidden sm:block">{age}</span>
      <MoreVertical className="w-3.5 h-3.5 text-slate-400 shrink-0" />
    </div>
  );
}

function DocumentLibraryMockup() {
  return (
    <MockupFrame url="app.manufacturing-os.com/documents/site-mechanical">
      <div className="bg-white border-b border-slate-200 px-5 py-3 flex items-center justify-between">
        <div>
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Library</div>
          <div className="text-sm font-black text-slate-900 flex items-center gap-1.5"><FolderOpen className="w-4 h-4 text-orange-500" /> Site Mechanical</div>
        </div>
        <div className="flex items-center gap-2">
          <button className="px-3 py-1.5 rounded-lg bg-slate-100 text-xs font-bold text-slate-700">Bulk Upload</button>
          <button className="px-3 py-1.5 rounded-lg bg-orange-600 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3 h-3" /> New Document</button>
        </div>
      </div>

      <div className="grid grid-cols-12">
        <div className="col-span-3 p-4 border-r border-slate-200 bg-slate-50/50 hidden md:block">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Collections</div>
          <ul className="space-y-1">
            <li className="px-2 py-1 rounded bg-orange-100 text-orange-700 text-[11px] font-bold">Process drawings (47)</li>
            <li className="px-2 py-1 rounded text-[11px] text-slate-700">Isometrics (122)</li>
            <li className="px-2 py-1 rounded text-[11px] text-slate-700">As-builts (89)</li>
            <li className="px-2 py-1 rounded text-[11px] text-slate-700">Plot plans (12)</li>
            <li className="px-2 py-1 rounded text-[11px] text-slate-700">Procedures (34)</li>
          </ul>
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mt-5 mb-2">Status</div>
          <ul className="space-y-1 text-[11px]">
            <li className="flex items-center gap-2 text-slate-700"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Issued (38)</li>
            <li className="flex items-center gap-2 text-slate-700"><span className="w-2 h-2 rounded-full bg-amber-500" /> In Revision (7)</li>
            <li className="flex items-center gap-2 text-slate-700"><span className="w-2 h-2 rounded-full bg-slate-400" /> Draft (2)</li>
          </ul>
        </div>

        <div className="col-span-12 md:col-span-9 p-4 bg-slate-50/30">
          <div className="flex items-center gap-2 mb-4">
            <div className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-[11px] text-slate-400">Search documents…</span>
            </div>
            <button className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-[11px] font-bold text-slate-700 flex items-center gap-1">
              <Filter className="w-3.5 h-3.5" /> Filters
            </button>
            <button className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-[11px] font-bold text-slate-700 items-center gap-1 hidden sm:flex">
              Modified <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="space-y-1.5">
            <DocRow id="100-PRC-001" name="Process Drawing — Area 100 East" rev="Rev 7" status="current" age="2 days ago" />
            <DocRow id="100-PRC-002" name="Process Drawing — Area 100 West" rev="Rev 5" status="current" age="5 days ago" />
            <DocRow id="200-PRC-001" name="Process Drawing — Area 200" rev="Rev 2" status="draft" age="1 hr ago" checkedOut />
            <DocRow id="200-ISO-014" name='Iso 14" Line — Feed Inlet' rev="Rev 1" status="current" age="1 month ago" />
            <DocRow id="200-ISO-015" name='Iso 8" Line — Cooling Return' rev="Rev 3" status="revision" age="3 days ago" />
          </div>
        </div>
      </div>
    </MockupFrame>
  );
}

// ─── Ask the AI ─────────────────────────────────────────────────────────────

function AskAiMockup() {
  return (
    <MockupFrame url="app.manufacturing-os.com/intelligence/ask">
      <div className="p-5 bg-slate-50/40">
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex items-center gap-3 mb-4 shadow-sm">
          <Sparkles className="w-4 h-4 text-orange-500 shrink-0" />
          <span className="text-[13px] text-slate-800 font-medium flex-1">
            What is the minimum design pressure for the Area 200 feed line?
          </span>
          <span className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-black">Ask</span>
        </div>

        <div className="bg-white border-2 border-orange-200 rounded-2xl overflow-hidden shadow-md">
          <div className="px-4 py-2.5 bg-gradient-to-r from-orange-50 to-white border-b border-orange-100 flex items-center gap-2">
            <span className="relative flex w-2 h-2">
              <span className="absolute inline-flex w-full h-full rounded-full bg-orange-400 opacity-75 animate-ping" />
              <span className="relative inline-flex w-2 h-2 rounded-full bg-orange-500" />
            </span>
            <span className="text-[10px] font-black uppercase tracking-widest text-orange-700">Answer</span>
            <span className="ml-auto text-[10px] text-slate-400 font-bold">cited to the page</span>
          </div>
          <div className="p-4">
            <p className="text-[15px] font-bold text-slate-900 leading-snug mb-3">
              The feed line is rated for a minimum design pressure of 285 psig at 650&nbsp;°F
              <sup className="text-orange-600 font-black ml-0.5">1</sup>, governed by the piping
              class specified for that service<sup className="text-orange-600 font-black ml-0.5">2</sup>.
            </p>
            <div className="space-y-1.5 text-[12px] text-slate-600 mb-4">
              <div className="flex items-start gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 mt-0.5 shrink-0" /> Basis: piping class table, line list entry for the 14&quot; feed line.</div>
              <div className="flex items-start gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 mt-0.5 shrink-0" /> The answer can only reference documents in your library — nothing is invented.</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-50 border border-blue-200 text-blue-800 text-[11px] font-bold">
                <BookOpen className="w-3 h-3" /> Piping Class Spec <span className="font-mono text-blue-600">p. 143</span>
                <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-white text-blue-700 text-[9px] font-black"><Eye className="w-2.5 h-2.5" /> Show me</span>
              </span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-50 border border-blue-200 text-blue-800 text-[11px] font-bold">
                <FileText className="w-3 h-3" /> Line List — Area 200 <span className="font-mono text-blue-600">p. 12</span>
              </span>
            </div>
          </div>
          <div className="px-4 py-2 bg-slate-50 border-t border-slate-200 text-[10px] text-slate-500 font-medium">
            Runs on <b>your own AI key</b> (Claude, OpenAI, or Gemini) with per-user spend caps — your documents are never used to train anyone&apos;s model.
          </div>
        </div>
      </div>
    </MockupFrame>
  );
}

// ─── Site graph ─────────────────────────────────────────────────────────────

function GraphMockup() {
  const edge = "stroke-slate-300";
  return (
    <MockupFrame url="app.manufacturing-os.com/graph">
      <div className="bg-slate-950 relative">
        <div className="absolute top-3 left-3 z-10 flex gap-1.5">
          {["Everything", "Process flow", "Equipment", "Documents"].map((l, i) => (
            <span key={l} className={`px-2.5 py-1 rounded-lg text-[10px] font-black ${i === 1 ? "bg-cyan-500 text-slate-950" : "bg-white/10 text-white/70"}`}>{l}</span>
          ))}
        </div>
        <svg viewBox="0 0 640 300" className="w-full h-[300px]">
          {/* flow edges (animated dashes) */}
          <g stroke="#06b6d4" strokeWidth="2" fill="none" strokeDasharray="6 6" style={{ animation: "mkt-dash 1.2s linear infinite" }}>
            <path d="M150 150 L290 110" />
            <path d="M290 110 L430 150" />
            <path d="M430 150 L540 100" />
          </g>
          {/* document edges */}
          <g className={edge} strokeWidth="1" fill="none" opacity="0.5">
            <path d="M150 150 L100 230" />
            <path d="M290 110 L260 40" />
            <path d="M290 110 L360 50" />
            <path d="M430 150 L470 235" />
          </g>
          {/* unit nodes */}
          {[
            { x: 150, y: 150, label: "Area 100" },
            { x: 290, y: 110, label: "Area 200" },
            { x: 430, y: 150, label: "Area 300" },
          ].map((n) => (
            <g key={n.label}>
              <circle cx={n.x} cy={n.y} r="17" fill="#10b981" opacity="0.25" className="animate-pulse" />
              <circle cx={n.x} cy={n.y} r="10" fill="#10b981" />
              <text x={n.x} y={n.y + 30} textAnchor="middle" fill="#94a3b8" fontSize="10" fontWeight="700">{n.label}</text>
            </g>
          ))}
          {/* asset node */}
          <circle cx="540" cy="100" r="8" fill="#a855f7" />
          <text x="540" y="126" textAnchor="middle" fill="#94a3b8" fontSize="10" fontWeight="700">P-201A</text>
          {/* document nodes */}
          {[
            { x: 100, y: 230, label: "100-PRC-001" },
            { x: 260, y: 40, label: "200-PRC-001" },
            { x: 360, y: 50, label: "Line List" },
            { x: 470, y: 235, label: "300-ISO-014" },
          ].map((n) => (
            <g key={n.label}>
              <circle cx={n.x} cy={n.y} r="6" fill="#3b82f6" />
              <text x={n.x} y={n.y + 18} textAnchor="middle" fill="#64748b" fontSize="9" fontFamily="monospace">{n.label}</text>
            </g>
          ))}
        </svg>
        <div className="px-4 py-2.5 bg-slate-900 border-t border-white/10 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-bold">
          <span className="text-white/50 uppercase tracking-widest text-[9px]">Legend</span>
          <span className="inline-flex items-center gap-1.5 text-emerald-300"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Operating area</span>
          <span className="inline-flex items-center gap-1.5 text-purple-300"><span className="w-2 h-2 rounded-full bg-purple-500" /> Equipment</span>
          <span className="inline-flex items-center gap-1.5 text-blue-300"><span className="w-2 h-2 rounded-full bg-blue-500" /> Document</span>
          <span className="inline-flex items-center gap-1.5 text-cyan-300"><Waypoints className="w-3 h-3" /> Process flow (AI-read from your drawings, human-confirmed)</span>
        </div>
      </div>
    </MockupFrame>
  );
}

// ─── Workflow ticket ────────────────────────────────────────────────────────

function SidebarStat({
  label, name, subtitle, initials, color, pulse, subtitleColor,
}: {
  label: string; name: string; subtitle: string;
  initials: string; color: string; pulse?: boolean;
  subtitleColor?: string;
}) {
  return (
    <div>
      <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <Avatar initials={initials} color={color} pulse={pulse} />
        <div className="min-w-0">
          <div className="text-xs font-bold text-slate-900 truncate">{name}</div>
          <div className={`text-[10px] font-bold truncate ${subtitleColor || "text-slate-500"}`}>{subtitle}</div>
        </div>
      </div>
    </div>
  );
}

function DraftingTicketMockup() {
  return (
    <MockupFrame url="app.manufacturing-os.com/requests/T-211">
      <div className="grid grid-cols-12">
        <div className="col-span-12 lg:col-span-8 p-5 lg:border-r border-slate-200">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600">Ticket T-211</span>
            <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-black uppercase">MOC</span>
            <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px] font-black uppercase">Pending Engineer Approval</span>
          </div>
          <h3 className="text-base font-black text-slate-900 mb-1">Area 200 bypass — flow element FE-201</h3>
          <p className="text-xs text-slate-500 mb-5">Opened 3 days ago by an operator — routed for qualified sign-off automatically</p>

          <div className="mb-5">
            <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Workflow</div>
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="px-2 py-1 rounded bg-emerald-100 text-emerald-700 font-bold flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Initial</span>
              <ChevronRight className="w-3 h-3 text-slate-300" />
              <span className="px-2 py-1 rounded bg-emerald-100 text-emerald-700 font-bold flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Assigned</span>
              <ChevronRight className="w-3 h-3 text-slate-300" />
              <span className="px-2 py-1 rounded bg-emerald-100 text-emerald-700 font-bold flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Drafted</span>
              <ChevronRight className="w-3 h-3 text-slate-300" />
              <span className="px-2 py-1 rounded bg-blue-100 text-blue-700 font-bold ring-2 ring-blue-200 animate-pulse">● Eng Approval</span>
              <ChevronRight className="w-3 h-3 text-slate-300" />
              <span className="px-2 py-1 rounded bg-slate-100 text-slate-400 font-bold">Issue</span>
            </div>
          </div>

          <div>
            <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Latest comment</div>
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Avatar initials="JD" color="bg-orange-500" sm />
                <span className="text-xs font-bold text-slate-900">John Doe</span>
                <span className="text-[10px] text-slate-500">2 hours ago</span>
              </div>
              <p className="text-sm text-slate-700 leading-relaxed">
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[12px] font-bold ring-1 ring-blue-200 mr-0.5">
                  <AtSign className="w-3 h-3" />Sarah Mitchell
                </span>
                {" "}— please confirm the sizing on FE-201 is correct for the new flow conditions. Scope doc is attached.
              </p>
            </div>
          </div>
        </div>

        <div className="col-span-12 lg:col-span-4 p-5 bg-slate-50/40 space-y-4">
          <SidebarStat label="Requester" name="John Doe" subtitle="Operator" initials="JD" color="bg-orange-500" />
          <SidebarStat label="Engineer Reviewer" name="Sarah Mitchell" subtitle="Engineer · Awaiting" initials="SM" color="bg-blue-500" pulse subtitleColor="text-blue-700" />
          <SidebarStat label="Drafter" name="Tom Reyes" subtitle="Drafter" initials="TR" color="bg-purple-500" />
          <div>
            <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Target completion</div>
            <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-amber-500" />
              2026-06-10
              <span className="text-[10px] font-black uppercase bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Due Soon</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Watching</div>
            <div className="flex items-center gap-1">
              <Avatar initials="JD" color="bg-orange-500" sm />
              <Avatar initials="SM" color="bg-blue-500" sm />
              <Avatar initials="TR" color="bg-purple-500" sm />
              <span className="ml-1 text-[10px] text-slate-500 font-bold">+2</span>
            </div>
          </div>
        </div>
      </div>
    </MockupFrame>
  );
}

// ─── Equipment & photos ─────────────────────────────────────────────────────

function AssetRegistryMockup() {
  return (
    <MockupFrame url="app.manufacturing-os.com/admin/assets">
      <div className="grid grid-cols-12">
        <div className="col-span-12 lg:col-span-7 p-5 border-r border-slate-200 bg-slate-50/30">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Tag className="w-4 h-4 text-purple-700" />
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-700">Equipment Registry</span>
              <span className="text-[10px] text-slate-400">· Area 200 · grouped by category</span>
            </div>
            <span className="text-[10px] font-bold text-purple-700">+ New Category</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[
              { tag: "FE-201", type: "Instrument", photos: 4, hot: true },
              { tag: "P-200A", type: "Pump", photos: 3 },
              { tag: "V-101", type: "Vessel", photos: 5 },
              { tag: "E-301", type: "Exchanger", photos: 0 },
            ].map((a) => (
              <div key={a.tag} className={`bg-white rounded-lg border ${a.hot ? "border-purple-300 ring-2 ring-purple-100" : "border-slate-200"} p-2.5`}>
                <div className="aspect-[4/3] rounded-md bg-gradient-to-br from-slate-200 to-slate-100 mb-2 relative overflow-hidden">
                  {a.photos > 0 ? (
                    <>
                      <div className="absolute inset-0 flex items-center justify-center text-[9px] text-slate-400 font-mono">[ photo ]</div>
                      <div className="absolute top-1 right-1 px-1.5 py-0.5 rounded bg-black/60 text-white text-[9px] font-bold flex items-center gap-0.5">
                        <Camera className="w-2.5 h-2.5" /> {a.photos}
                      </div>
                    </>
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <FileText className="w-5 h-5 text-slate-300" />
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black text-slate-900">{a.tag}</span>
                  <span className="text-[9px] font-bold uppercase bg-slate-100 text-slate-600 px-1 py-px rounded">{a.type}</span>
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {a.photos > 0 ? (
                    <span className="text-blue-700 inline-flex items-center gap-0.5"><Camera className="w-2.5 h-2.5" /> {a.photos} photos</span>
                  ) : (
                    <span className="text-amber-700 inline-flex items-center gap-0.5"><AlertTriangle className="w-2.5 h-2.5" /> No photos</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="col-span-12 lg:col-span-5 bg-slate-900 text-white relative flex flex-col">
          <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <div className="p-1.5 bg-white/10 rounded">
                <Tag className="w-3 h-3 text-white" />
              </div>
              <span className="text-sm font-black text-white">FE-201</span>
              <span className="text-[9px] font-bold uppercase tracking-widest bg-white/15 px-1.5 py-0.5 rounded text-white/90">Instrument</span>
              <span className="text-[10px] font-mono text-white/60">2 / 4</span>
            </div>
            <X className="w-3.5 h-3.5 text-white/60" />
          </div>
          <div className="flex-1 relative bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center min-h-[180px]">
            <div className="text-[10px] text-white/40 font-mono">[ Hero photo ]</div>
            <div className="absolute bottom-2 right-2 inline-flex items-center gap-1 px-2 py-1 rounded bg-black/60 backdrop-blur text-white text-[10px] font-mono">
              <Calendar className="w-2.5 h-2.5" /> 2025-08-15
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="opacity-70">· 12mo ago</span>
            </div>
            <span className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-white/15 text-white"><ChevronLeft className="w-3 h-3" /></span>
            <span className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-white/15 text-white"><ChevronRight className="w-3 h-3" /></span>
          </div>
          <div className="px-4 py-2 border-t border-white/10 flex gap-1">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className={`w-10 h-10 rounded ${i === 2 ? "ring-2 ring-white border-2 border-white" : "border-2 border-white/20"} bg-gradient-to-br from-slate-600 to-slate-700 relative`}>
                <span className={`absolute bottom-0 left-1 w-1 h-1 rounded-full ${i === 4 ? "bg-amber-400" : "bg-emerald-400"}`} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-purple-50 border-t border-purple-200 px-5 py-3">
        <div className="flex items-center gap-3 text-[11px] text-slate-700 flex-wrap">
          <Zap className="w-3.5 h-3.5 text-purple-700 shrink-0" />
          <span className="font-bold">The same chip works everywhere FE-201 appears:</span>
          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-gradient-to-br from-blue-50 to-blue-100 text-blue-800 border border-blue-200 text-[10px] font-bold">
            <Settings className="w-2.5 h-2.5 mr-1 text-blue-500" /> FE-201
            <span className="ml-1 inline-flex items-center gap-0.5 px-1 py-px rounded bg-white/80 text-blue-700 text-[9px]">
              <Camera className="w-2 h-2" /> 4
            </span>
          </span>
          <span className="text-slate-500">→ document rows, viewers, tickets, the graph — one click, full carousel.</span>
        </div>
      </div>
    </MockupFrame>
  );
}

// ─── Projects & locking ─────────────────────────────────────────────────────

function ActivityItem({ actor, color, text, time }: { actor: string; color: string; text: React.ReactNode; time: string }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <Avatar initials={actor} color={color} sm />
      <div className="flex-1 min-w-0 text-slate-600 leading-snug">
        <span className="font-bold text-slate-700">{actor}</span> {text}
      </div>
      <span className="text-[10px] text-slate-400 shrink-0">{time}</span>
    </div>
  );
}

function ProjectMockup() {
  return (
    <MockupFrame url="app.manufacturing-os.com/projects/area-200-moc">
      <div className="p-5">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-purple-600">Project</span>
          <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-black uppercase">Active</span>
        </div>
        <h3 className="text-base font-black text-slate-900 mb-1">Area 200 Change — Bypass Install</h3>
        <p className="text-xs text-slate-500 mb-4">12 documents · 6 open tickets · Phase 3 of 5</p>

        <div className="flex items-center gap-1 mb-5">
          <Avatar initials="JD" color="bg-orange-500" />
          <Avatar initials="SM" color="bg-blue-500" />
          <Avatar initials="TR" color="bg-purple-500" />
          <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center text-[9px] font-black text-slate-600">+1</div>
          <span className="ml-2 text-[10px] text-slate-500 font-bold">4 members · contractor scoped to this project only</span>
        </div>

        <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Recent activity</div>
        <div className="space-y-2">
          <ActivityItem actor="JD" color="bg-orange-500" text={<>approved <b className="text-slate-900">100-PRC-001</b> Rev 7</>} time="2h ago" />
          <ActivityItem actor="SM" color="bg-blue-500" text={<>commented on <b className="text-slate-900">Ticket-209</b></>} time="4h ago" />
          <ActivityItem actor="TR" color="bg-purple-500" text={<>issued the final package for <b className="text-slate-900">200-ISO-014</b></>} time="1d ago" />
          <ActivityItem actor="JD" color="bg-orange-500" text={<>opened <b className="text-slate-900">Ticket-211</b> (MOC)</>} time="3d ago" />
        </div>
      </div>
    </MockupFrame>
  );
}

function CheckoutMockup() {
  return (
    <MockupFrame url="app.manufacturing-os.com/documents/100-PRC-001">
      <div className="p-5">
        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Document</div>
        <h3 className="text-base font-black text-slate-900">100-PRC-001</h3>
        <p className="text-xs text-slate-500 mb-4">Process Drawing — Area 100 East · Rev 7 Issued</p>

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2.5 mb-4">
          <div className="p-1.5 bg-amber-100 rounded-lg shrink-0">
            <Lock className="w-3.5 h-3.5 text-amber-700" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-black text-amber-900">Checked out by Jane Smith</div>
            <div className="text-[11px] text-amber-700">Started 4 hours ago · Auto-release in 20h</div>
          </div>
        </div>

        <div className="bg-gradient-to-br from-slate-100 to-slate-50 border border-slate-200 rounded-xl h-32 flex flex-col items-center justify-center text-[10px] text-slate-400 font-mono gap-1">
          <FileText className="w-8 h-8 text-slate-300" />
          [ PDF preview — process drawing ]
        </div>

        <div className="flex gap-2 mt-4">
          <button className="flex-1 py-2 rounded-lg text-xs font-bold bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200">Edit (Locked)</button>
          <button className="flex-1 py-2 rounded-lg text-xs font-bold bg-slate-900 text-white">View History</button>
        </div>

        <div className="mt-3 text-[10px] text-slate-500 leading-relaxed">
          <b>Why it&apos;s locked:</b> one editor at a time — two drafters can never save conflicting versions of the same drawing. Ad-hoc holds release themselves after 24 hours.
        </div>
      </div>
    </MockupFrame>
  );
}
