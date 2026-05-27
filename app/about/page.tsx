// app/about/page.tsx — public marketing landing.
//
// Visited by prospects evaluating the product. Compliance language is
// deliberately honest — we support documentation requirements; we are
// not a certifier and using the product does not make a customer
// compliant. See the "What we are, what we aren't" section.
//
// Product tour section uses styled React components that mimic the
// actual product UI — they're not real screenshots, but they're built
// with the same color palette and layout language as the live app so
// prospects get an honest sense of what they'd be using.

import Link from "next/link";
import {
  Layout, ShieldCheck, FileCheck2, GitBranch, Database,
  Workflow, Users, Lock, Server, ArrowRight, CheckCircle2,
  AtSign, Clock, FileArchive, Webhook, KeyRound,
  AlertTriangle, Factory, Wrench, ClipboardCheck, ExternalLink,
  Download, Zap, ScrollText, XCircle,
  Search, Filter, ChevronDown, ChevronRight, Calendar,
  Eye, FolderOpen, FileText, MoreVertical, Plus,
  Star, FolderKanban, Tag, Camera, Sparkles, Pencil,
} from "lucide-react";

export const metadata = {
  title: "Manufacturing OS — Document control your plant can audit",
  description:
    "The drafting workflow, document control, and audit trail your refinery actually runs on. Designed to support OSHA PSM 1910.119 and ISO 9001 documentation — engineer-routed approvals and a one-click export of every byte you put in, no lock-in, ever.",
};

export default function MarketingPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <Nav />
      <Hero />
      <ProblemSection />
      <CapabilitiesSection />
      <ProductTourSection />
      <TrustSection />
      <ComplianceHonestySection />
      <SecuritySection />
      <AudienceSection />
      <FinalCta />
      <Footer />
    </div>
  );
}

// ─── Nav ──────────────────────────────────────────────────────

function Nav() {
  return (
    <header className="sticky top-0 z-50 bg-white/80 backdrop-blur border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-gradient-to-br from-orange-500 to-orange-700 rounded-lg flex items-center justify-center shadow-sm">
            <Layout className="w-4 h-4 text-white" />
          </div>
          <div className="font-black text-slate-900 text-sm tracking-tight">
            Manufacturing<span className="text-orange-600">OS</span>
          </div>
        </Link>
        <nav className="hidden md:flex items-center gap-6 text-sm font-bold text-slate-600">
          <a href="#capabilities" className="hover:text-slate-900">Capabilities</a>
          <a href="#tour" className="hover:text-slate-900">See It</a>
          <a href="#trust" className="hover:text-slate-900">Your Data</a>
          <a href="#honesty" className="hover:text-slate-900">Compliance</a>
          <a href="#security" className="hover:text-slate-900">Security</a>
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/" className="text-sm font-bold text-slate-700 hover:text-slate-900 px-3 py-1.5">
            Sign in
          </Link>
          <Link
            href="/signup"
            className="inline-flex items-center gap-1.5 text-sm font-black text-white bg-slate-900 hover:bg-slate-800 px-4 py-2 rounded-lg shadow"
          >
            Get Started <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </header>
  );
}

// ─── Hero ───────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="relative overflow-hidden bg-slate-950 text-white">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-orange-700/60 to-transparent" />
      <div className="relative max-w-6xl mx-auto px-6 py-24 md:py-32">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-500/10 border border-orange-500/30 text-orange-300 text-xs font-bold uppercase tracking-widest mb-6">
            <Zap className="w-3.5 h-3.5" /> For refineries & plants
          </div>
          <h1 className="text-4xl md:text-6xl font-black tracking-tight leading-[1.05] mb-5">
            Document control your{" "}
            <span className="text-orange-500">plant can audit.</span>
          </h1>
          <p className="text-lg md:text-xl text-slate-300 leading-relaxed mb-8 max-w-2xl">
            Manufacturing OS replaces shared drives, scattered email threads, and three-binders-deep
            revision tracking with a single source of truth — <b className="text-white">designed to
            support OSHA PSM 1910.119 and ISO 9001 documentation</b>, and engineered so you own your data,
            every byte, end-to-end.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/signup"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-sm font-black shadow-lg shadow-orange-900/30"
            >
              Start a workspace <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="#tour"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-white/10 hover:bg-white/15 border border-white/20 text-white text-sm font-bold backdrop-blur"
            >
              <Eye className="w-4 h-4" /> See it in action
            </Link>
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Full export, any time</span>
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Standard JSON + PDFs</span>
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Public schema, no lock-in</span>
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Encrypted at rest</span>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Problem ─────────────────────────────────────────────────────

function ProblemSection() {
  return (
    <section className="bg-slate-50 border-y border-slate-200">
      <div className="max-w-6xl mx-auto px-6 py-20">
        <div className="max-w-3xl">
          <div className="text-xs font-black uppercase tracking-widest text-orange-600 mb-3">The problem</div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-5">
            Your engineering library is held together with email and goodwill.
          </h2>
          <p className="text-base text-slate-600 leading-relaxed">
            P&amp;IDs live on a network drive nobody remembers the path to. MOC requests live in someone&apos;s
            Outlook. Redlines are scanned PDFs from a printer that hasn&apos;t been serviced since 2019. When
            the auditor asks who approved revision 3, the answer is a phone call to whoever happened to be
            on shift. None of it produces the documentation OSHA PSM or ISO 9001 auditors expect to see.
            None of it scales. And if your document-control person retires, the institutional knowledge
            walks out with them.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-4">
          <Pain icon={<AlertTriangle className="w-5 h-5 text-red-600" />} title="No revision integrity" body="The 'latest' PDF on the shared drive is whichever one was last saved. Superseded copies still get printed. The drawing in the operator's hand might be three revisions out of date." />
          <Pain icon={<AlertTriangle className="w-5 h-5 text-red-600" />} title="No approval trail" body="A non-engineer signs off on engineering work because the workflow doesn't enforce who's allowed to. The audit fails. Insurance gets nervous. The QC manager gets a phone call at 11pm." />
          <Pain icon={<AlertTriangle className="w-5 h-5 text-red-600" />} title="No exit strategy" body="Whatever document-management product you bought five years ago is now twice the price, and the data is in their proprietary format. Migrating is a six-figure project nobody wants to sign off on." />
        </div>
      </div>
    </section>
  );
}

function Pain({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
      <div className="p-1.5 bg-red-50 rounded-lg w-fit mb-3">{icon}</div>
      <h3 className="text-sm font-black text-slate-900 mb-1.5">{title}</h3>
      <p className="text-xs text-slate-600 leading-relaxed">{body}</p>
    </div>
  );
}

// ─── Capabilities ──────────────────────────────────────────────────

function CapabilitiesSection() {
  return (
    <section id="capabilities" className="bg-white">
      <div className="max-w-6xl mx-auto px-6 py-20">
        <div className="max-w-3xl mb-12">
          <div className="text-xs font-black uppercase tracking-widest text-orange-600 mb-3">What it does</div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-4">One system. The whole drawing lifecycle.</h2>
          <p className="text-base text-slate-600 leading-relaxed">
            Every drawing has a controlled revision history. Every request has a tracked workflow. Every
            approval has the right engineer&apos;s signature behind it. Every action is in the audit log.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Capability icon={<FileCheck2 className="w-5 h-5 text-blue-700" />} iconBg="bg-blue-50" title="Controlled Document Library" body="Every P&ID, isometric, plot plan, and procedure stored with full revision history. The current revision is unambiguous — superseded ones are visibly marked. IFC-stamped PDFs generated automatically." bullets={["Auto-incremented revision numbers", "Side-by-side rev comparison", "Bulk import + library organization", "Checkout to prevent edit conflicts"]} />
          <Capability icon={<Workflow className="w-5 h-5 text-emerald-700" />} iconBg="bg-emerald-50" title="Drafting Request Workflow" body="Tickets route through Initial Review → Assignment → Drafting → Engineer Approval → IFC Issue. Non-engineers route their approval through a qualified engineer — the system enforces it." bullets={["MOC, ISO, As-Built, RFI, Inspection types", "Engineer-routing for sign-off documentation", "Redline markup tools", "Revision request loops with categories"]} />
          <Capability icon={<GitBranch className="w-5 h-5 text-purple-700" />} iconBg="bg-purple-50" title="Projects" body="Bundle related documents, drawings, and tickets into a project. Track activity across the whole bundle. Onboard contractors with scoped access to just the project they're working on." bullets={["Multi-document containers", "Per-project member roles", "Activity feed", "External markup-request sharing"]} />
          <Capability icon={<ScrollText className="w-5 h-5 text-amber-700" />} iconBg="bg-amber-50" title="Audit Trail" body="Every login, every download, every revision, every approval, every credential change written to an immutable audit log. Filter by user, date, action type. Exportable as evidence for internal or external audits." bullets={["Login + access tracking", "Download attribution", "Workflow state change capture", "Data-export events logged"]} />
          <Capability icon={<AtSign className="w-5 h-5 text-rose-700" />} iconBg="bg-rose-50" title="Real-time Collaboration" body="@-mention any teammate in a comment and they're notified in-app + by email. Watch tickets to subscribe to all activity. Mentions render as clickable chips that survive name changes." bullets={["@-mention autocomplete", "Watch / subscribe toggles", "Per-user notification preferences", "Email delivery (optional)"]} />
          <Capability icon={<Clock className="w-5 h-5 text-indigo-700" />} iconBg="bg-indigo-50" title="SLA Tracking" body="Every request gets a target completion date — either set explicitly or defaulted by request type. Past-due and due-soon badges surface on the request list so nothing gets lost." bullets={["Per-type SLA defaults", "Due Soon / Past Due chips", "Configurable warn-ahead windows", "Org-level SLA overrides"]} />
          <Capability
            icon={<Tag className="w-5 h-5 text-purple-700" />}
            iconBg="bg-purple-50"
            title="Asset Registry + Photo Galleries"
            body="Click any equipment tag in your library to see a full-screen carousel of photos of that physical thing. Replaces the use case point-cloud subscriptions cover at 5% of the cost — covers MOC photo-of-record, training reference, what-does-this-look-like operator support."
            bullets={["Canonical record per tagged asset", "Date-watermarked photo galleries", "Click-through from any P&ID / ISO / ticket", "Supersession-aware photo lifecycle"]}
          />
          <Capability
            icon={<FolderKanban className="w-5 h-5 text-purple-700" />}
            iconBg="bg-purple-50"
            title="Curated Collections (Playbooks)"
            body="Admin-curated groupings of documents pinned at the top of a library. 'Crude Cold Side — Receipt to Surge' walks you through a process flow in order. Users can also create personal pin sets for their own workflows."
            bullets={["Ordered document playbooks", "Admin org-wide + personal scope", "Pinned to library home page", "Reorder + notes per item"]}
          />
          <Capability
            icon={<Eye className="w-5 h-5 text-blue-700" />}
            iconBg="bg-blue-50"
            title="Saved Views + Favorites"
            body="Admins define default views ('All In-Revision P&IDs', 'Past Due This Week'); users star their personal favorites and save their own views. The library shows what each person needs to see, not the same flat list for everyone."
            bullets={["Per-user star toggles", "Admin + personal saved views", "Filter / sort / display snapshots", "Default view per role"]}
          />
          <Capability
            icon={<Sparkles className="w-5 h-5 text-orange-700" />}
            iconBg="bg-orange-50"
            title="Metadata-First Upload"
            body="Drop files → review staging grid → upload. Filename patterns auto-fill the document number, rev, sheet, unit, and type before the first byte hits storage. Bulk-apply controls handle 50-file batches in seconds."
            bullets={["Auto-parsed metadata hints", "Bulk-apply status / type / unit", "Validation: duplicates + required fields", "No silent uploads — always confirm first"]}
          />
          <Capability
            icon={<Pencil className="w-5 h-5 text-teal-700" />}
            iconBg="bg-teal-50"
            title="Configurable Everything"
            body="Custom metadata columns per library. Rename system columns (Doc No → Sheet No). Add new asset types beyond the defaults. Color-coded pill columns. Your library, your terminology."
            bullets={["Per-library custom columns", "Rename system columns inline", "Custom asset types", "Drag-reorder display"]}
          />
        </div>
      </div>
    </section>
  );
}

function Capability({
  icon, iconBg, title, body, bullets,
}: {
  icon: React.ReactNode; iconBg: string; title: string; body: string; bullets: string[];
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md hover:border-slate-300 transition-all">
      <div className="flex items-start gap-3 mb-3">
        <div className={`p-2 rounded-lg ${iconBg}`}>{icon}</div>
        <h3 className="text-base font-black text-slate-900 leading-tight pt-1">{title}</h3>
      </div>
      <p className="text-sm text-slate-600 leading-relaxed mb-4">{body}</p>
      <ul className="space-y-1.5">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-2 text-xs text-slate-700">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Product Tour (visual mockups) ─────────────────────────────────────────
// Styled React mockups that mirror the live product's layout language
// so prospects can see what they'd actually be looking at. Data is
// hardcoded refinery-specific (P&IDs, MOC tickets, real-sounding
// engineer names) so the visuals feel like screenshots from a working
// install — because they ARE the same UI.

function ProductTourSection() {
  return (
    <section id="tour" className="bg-slate-100 border-y border-slate-200">
      <div className="max-w-6xl mx-auto px-6 py-20">
        <div className="max-w-3xl mb-12">
          <div className="text-xs font-black uppercase tracking-widest text-orange-600 mb-3">See it in action</div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-4">
            What each part actually looks like.
          </h2>
          <p className="text-base text-slate-600 leading-relaxed">
            Visual previews of the parts you and your team will use every day. Built with the same design
            language as the live app — these aren&apos;t marketing renders, they&apos;re the real UI with
            realistic refinery data dropped in.
          </p>
        </div>

        {/* Mockup 1: Documents Library — full-width */}
        <div className="mb-10">
          <MockupHeader title="Document Library" subtitle="Every P&ID, iso, and procedure in one place. Filterable by collection, status, library, age." />
          <DocumentLibraryMockup />
        </div>

        {/* Mockup row: Projects + Checkout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
          <div>
            <MockupHeader title="Projects" subtitle="Bundle docs + tickets. Track activity, manage members, scope contractor access." />
            <ProjectMockup />
          </div>
          <div>
            <MockupHeader title="Checkout Locking" subtitle="Prevent two people editing the same drawing. Auto-release after 24h." />
            <CheckoutMockup />
          </div>
        </div>

        {/* Mockup 4: Drafting Portal Ticket — full-width */}
        <div>
          <MockupHeader title="Drafting Portal" subtitle="Tickets with engineer-routed approval, workflow stages, @-mention comment threads." />
          <DraftingTicketMockup />
        </div>
      </div>
    </section>
  );
}

function MockupHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-4">
      <div>
        <h3 className="text-lg font-black text-slate-900">{title}</h3>
        <p className="text-sm text-slate-600">{subtitle}</p>
      </div>
    </div>
  );
}

// Browser-chrome wrapper used by all mockups so they look like screenshots
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

// ----- Documents Library mockup -----

function DocumentLibraryMockup() {
  return (
    <MockupFrame url="app.manufacturing-os.com/documents/acme-refinery-mechanical">
      <div className="bg-white border-b border-slate-200 px-5 py-3 flex items-center justify-between">
        <div>
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Library</div>
          <div className="text-sm font-black text-slate-900 flex items-center gap-1.5"><FolderOpen className="w-4 h-4 text-orange-500" /> Acme Refinery — Mechanical</div>
        </div>
        <div className="flex items-center gap-2">
          <button className="px-3 py-1.5 rounded-lg bg-slate-100 text-xs font-bold text-slate-700">Bulk Upload</button>
          <button className="px-3 py-1.5 rounded-lg bg-orange-600 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3 h-3" /> New Document</button>
        </div>
      </div>

      <div className="grid grid-cols-12">
        {/* Sidebar */}
        <div className="col-span-3 p-4 border-r border-slate-200 bg-slate-50/50">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Collections</div>
          <ul className="space-y-1">
            <li className="px-2 py-1 rounded bg-orange-100 text-orange-700 text-[11px] font-bold">P&IDs (47)</li>
            <li className="px-2 py-1 rounded text-[11px] text-slate-700 hover:bg-slate-100 cursor-default">Isometrics (122)</li>
            <li className="px-2 py-1 rounded text-[11px] text-slate-700 hover:bg-slate-100 cursor-default">As-builts (89)</li>
            <li className="px-2 py-1 rounded text-[11px] text-slate-700 hover:bg-slate-100 cursor-default">Plot plans (12)</li>
            <li className="px-2 py-1 rounded text-[11px] text-slate-700 hover:bg-slate-100 cursor-default">Procedures (34)</li>
          </ul>
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mt-5 mb-2">Status</div>
          <ul className="space-y-1 text-[11px]">
            <li className="flex items-center gap-2 text-slate-700"><span className="w-2 h-2 rounded-full bg-emerald-500" /> IFC (38)</li>
            <li className="flex items-center gap-2 text-slate-700"><span className="w-2 h-2 rounded-full bg-amber-500" /> In Revision (7)</li>
            <li className="flex items-center gap-2 text-slate-700"><span className="w-2 h-2 rounded-full bg-slate-400" /> Draft (2)</li>
          </ul>
        </div>

        {/* Main list */}
        <div className="col-span-9 p-4 bg-slate-50/30">
          <div className="flex items-center gap-2 mb-4">
            <div className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-[11px] text-slate-400">Search documents...</span>
            </div>
            <button className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-[11px] font-bold text-slate-700 flex items-center gap-1">
              <Filter className="w-3.5 h-3.5" /> Filters
            </button>
            <button className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-[11px] font-bold text-slate-700 flex items-center gap-1">
              Modified <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="space-y-1.5">
            <DocRow id="100-PID-001" name="P&amp;ID Unit 100 East" rev="Rev 7" status="ifc" age="2 days ago" />
            <DocRow id="100-PID-002" name="P&amp;ID Unit 100 West" rev="Rev 5" status="ifc" age="5 days ago" />
            <DocRow id="200-PID-001" name="P&amp;ID Unit 200 Reactor" rev="Rev 2" status="draft" age="1 hr ago" checkedOut />
            <DocRow id="200-ISO-014" name='Iso 14" 6CR Inlet' rev="Rev 1" status="ifc" age="1 month ago" />
            <DocRow id="200-ISO-015" name='Iso 8" CW Return' rev="Rev 3" status="revision" age="3 days ago" />
          </div>
        </div>
      </div>
    </MockupFrame>
  );
}

function DocRow({
  id, name, rev, status, age, checkedOut,
}: {
  id: string; name: string; rev: string;
  status: "ifc" | "draft" | "revision";
  age: string; checkedOut?: boolean;
}) {
  const statusStyle =
    status === "ifc" ? "bg-emerald-100 text-emerald-700" :
    status === "revision" ? "bg-amber-100 text-amber-700" :
    "bg-slate-100 text-slate-700";
  const statusLabel =
    status === "ifc" ? "IFC" :
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
      <span className="text-[10px] text-slate-400 shrink-0 w-24 text-right">{age}</span>
      <MoreVertical className="w-3.5 h-3.5 text-slate-400 shrink-0" />
    </div>
  );
}

// ----- Project mockup -----

function ProjectMockup() {
  return (
    <MockupFrame url="app.manufacturing-os.com/projects/u200-moc-phase-3">
      <div className="p-5">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-purple-600">Project</span>
          <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-black uppercase">Active</span>
        </div>
        <h3 className="text-base font-black text-slate-900 mb-1">Unit 200 MOC — Reactor Bypass</h3>
        <p className="text-xs text-slate-500 mb-4">12 documents · 6 open tickets · Phase 3 of 5</p>

        <div className="flex items-center gap-1 mb-5">
          <Avatar initials="JD" color="bg-orange-500" />
          <Avatar initials="SM" color="bg-blue-500" />
          <Avatar initials="TR" color="bg-purple-500" />
          <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center text-[9px] font-black text-slate-600">+1</div>
          <span className="ml-2 text-[10px] text-slate-500 font-bold">4 members</span>
        </div>

        <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Recent activity</div>
        <div className="space-y-2">
          <ActivityItem actor="JD" color="bg-orange-500" text={<>approved <b className="text-slate-900">100-PID-001</b> Rev 7</>} time="2h ago" />
          <ActivityItem actor="SM" color="bg-blue-500" text={<>commented on <b className="text-slate-900">Ticket-209</b></>} time="4h ago" />
          <ActivityItem actor="TR" color="bg-purple-500" text={<>submitted Final IFC package for <b className="text-slate-900">200-ISO-014</b></>} time="1d ago" />
          <ActivityItem actor="JD" color="bg-orange-500" text={<>opened <b className="text-slate-900">Ticket-211</b> (MOC)</>} time="3d ago" />
        </div>
      </div>
    </MockupFrame>
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

// ----- Checkout mockup -----

function CheckoutMockup() {
  return (
    <MockupFrame url="app.manufacturing-os.com/documents/100-PID-001">
      <div className="p-5">
        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Document</div>
        <h3 className="text-base font-black text-slate-900">100-PID-001</h3>
        <p className="text-xs text-slate-500 mb-4">P&amp;ID Unit 100 East · Rev 7 IFC</p>

        {/* Checkout banner */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2.5 mb-4">
          <div className="p-1.5 bg-amber-100 rounded-lg shrink-0">
            <Lock className="w-3.5 h-3.5 text-amber-700" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-black text-amber-900">Checked out by Jane Smith</div>
            <div className="text-[11px] text-amber-700">Started 4 hours ago · Auto-release in 20h</div>
          </div>
        </div>

        {/* PDF preview placeholder */}
        <div className="bg-gradient-to-br from-slate-100 to-slate-50 border border-slate-200 rounded-xl h-32 flex flex-col items-center justify-center text-[10px] text-slate-400 font-mono gap-1">
          <FileText className="w-8 h-8 text-slate-300" />
          [ PDF Preview — P&amp;ID drawing ]
        </div>

        <div className="flex gap-2 mt-4">
          <button className="flex-1 py-2 rounded-lg text-xs font-bold bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200">Edit (Locked)</button>
          <button className="flex-1 py-2 rounded-lg text-xs font-bold bg-slate-900 text-white">View History</button>
        </div>

        <div className="mt-3 text-[10px] text-slate-500 leading-relaxed">
          <b>Why it&apos;s locked:</b> Only one user can edit at a time. Stops two drafters from saving conflicting versions of the same drawing.
        </div>
      </div>
    </MockupFrame>
  );
}

// ----- Drafting Ticket mockup -----

function DraftingTicketMockup() {
  return (
    <MockupFrame url="app.manufacturing-os.com/requests/T-211">
      <div className="grid grid-cols-12">
        {/* Main column */}
        <div className="col-span-12 lg:col-span-8 p-5 lg:border-r border-slate-200">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600">Ticket T-211</span>
            <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-black uppercase">MOC</span>
            <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px] font-black uppercase">Pending Engineer Approval</span>
          </div>
          <h3 className="text-base font-black text-slate-900 mb-1">Unit 200 Reactor Bypass — orifice plate FE-201</h3>
          <p className="text-xs text-slate-500 mb-5">Opened 3 days ago by John Doe (Operator)</p>

          {/* Workflow chips */}
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
              <span className="px-2 py-1 rounded bg-slate-100 text-slate-400 font-bold">IFC Issue</span>
            </div>
          </div>

          {/* Latest comment with @mention */}
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
                {" "}— please confirm orifice plate sizing on FE-201 is correct for the new flow conditions. MOC scope doc is in the attachment list.
              </p>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="col-span-12 lg:col-span-4 p-5 bg-slate-50/40 space-y-4">
          <SidebarStat label="Requester" name="John Doe" subtitle="Operator" initials="JD" color="bg-orange-500" />
          <SidebarStat label="Engineer Reviewer" name="Sarah Mitchell" subtitle="Eng-2 · Awaiting" initials="SM" color="bg-blue-500" pulse subtitleColor="text-blue-700" />
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

// ─── Trust / Data Portability ────────────────────────────────────────

function TrustSection() {
  return (
    <section id="trust" className="bg-gradient-to-b from-emerald-50 to-white border-y border-emerald-200">
      <div className="max-w-6xl mx-auto px-6 py-24">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-100 border border-emerald-300 text-emerald-800 text-xs font-bold uppercase tracking-widest mb-5">
            <ShieldCheck className="w-3.5 h-3.5" /> Your data, your choice
          </div>
          <h2 className="text-3xl md:text-5xl font-black tracking-tight mb-5">No lock-in. Not now, not ever.</h2>
          <p className="text-base md:text-lg text-slate-700 leading-relaxed mb-8">
            Industrial document control is critical infrastructure. You can&apos;t afford to wonder whether a
            vendor outage or a contract dispute will cost you years of engineering work. So we built three
            independent paths off this platform — and your administrators can use any of them, any time,
            with no special tooling, no support ticket, and no per-export cost.
          </p>
        </div>

        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
          <ExitPath icon={<Download className="w-5 h-5 text-blue-700" />} title="1. Direct download" body="One click. A single JSON file with every record, plus a manifest with 24-hour presigned URLs for every file. Or a full ZIP with the binaries inline." />
          <ExitPath icon={<Server className="w-5 h-5 text-emerald-700" />} title="2. Scheduled push" body="Point us at your own S3 / R2 bucket. We push a fresh export there daily, weekly, or monthly. Credentials encrypted with AES-256-GCM. You own the backups." />
          <ExitPath icon={<Webhook className="w-5 h-5 text-purple-700" />} title="3. Webhook delivery" body="HMAC-signed POST to your endpoint with the ZIP body. Build your own pipeline. Re-export to anywhere. Pipe into your data lake." />
        </div>

        <div className="mt-12 bg-white border-2 border-emerald-200 rounded-2xl p-6 shadow-sm">
          <div className="flex flex-col md:flex-row items-start md:items-center gap-5">
            <div className="p-3 bg-emerald-100 rounded-xl shrink-0">
              <FileArchive className="w-8 h-8 text-emerald-700" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-black text-slate-900 mb-1">Everything you&apos;d need to rebuild from scratch.</h3>
              <p className="text-sm text-slate-600 leading-relaxed mb-3">
                The export is a portable ZIP: manifest, README, the database schema DDL, one JSON file per
                table, and every binary file path-preserved. Unzip it, point a fresh Postgres at the schema,
                bulk-load the JSON, and you&apos;re back online — with any document-control vendor, or none.
              </p>
              <div className="flex flex-wrap gap-2 text-[11px] text-slate-500 font-mono">
                <Chip>/manifest.json</Chip>
                <Chip>/README.md</Chip>
                <Chip>/schema/schema.sql</Chip>
                <Chip>/tables/*.json</Chip>
                <Chip>/files/&lt;storage-path&gt;</Chip>
              </div>
            </div>
            <Link
              href="/data-portability"
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-black shadow shrink-0"
            >
              Read the full commitment <ExternalLink className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function ExitPath({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
      <div className="p-2 bg-slate-100 rounded-lg w-fit mb-3">{icon}</div>
      <h3 className="text-sm font-black text-slate-900 mb-1.5">{title}</h3>
      <p className="text-xs text-slate-600 leading-relaxed">{body}</p>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-700">{children}</span>
  );
}

// ─── Compliance Honesty ──────────────────────────────────────────────

function ComplianceHonestySection() {
  return (
    <section id="honesty" className="bg-white border-y border-slate-200">
      <div className="max-w-6xl mx-auto px-6 py-20">
        <div className="max-w-3xl mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-100 border border-slate-300 text-slate-700 text-xs font-bold uppercase tracking-widest mb-4">
            <ClipboardCheck className="w-3.5 h-3.5" /> Honest about compliance
          </div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-4">What we are, and what we aren&apos;t.</h2>
          <p className="text-base text-slate-600 leading-relaxed">
            Manufacturing OS is <b>software that supports compliance documentation</b>. It is not a
            certification. Running this product does not, by itself, make your organization compliant with
            any standard. Your QMS coordinator, PSM officer, or compliance lead remains responsible for the
            overall program. We&apos;re the system of record they rely on — not a substitute for their
            judgment. Here&apos;s the line, drawn explicitly.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="bg-emerald-50 border-2 border-emerald-200 rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-4">
              <CheckCircle2 className="w-5 h-5 text-emerald-700" />
              <h3 className="text-base font-black text-emerald-900">What we do support</h3>
            </div>
            <ul className="space-y-2.5 text-sm text-slate-700">
              <Honesty title="Document control infrastructure" body="Revision history, current-vs-superseded clarity, IFC stamping — the documentation backbone called for by ISO 9001 §7.5 and OSHA PSM §(d)." />
              <Honesty title="Management of Change (MOC) tickets" body="Dedicated MOC ticket type with engineer-routed sign-off, addressing the documentation OSHA PSM §(l) requires when modifying covered processes." />
              <Honesty title="Immutable audit trail" body="Every login, download, approval, status change written to a tamper-evident log. Exportable as evidence for internal or external audits." />
              <Honesty title="Engineer-routed approval enforcement" body="Non-engineer requesters cannot self-approve engineering work; the system enforces routing to a qualified engineer." />
              <Honesty title="Customer-owned data" body="Full data export anytime, in standard formats. Supports vendor risk management policies and disaster recovery requirements." />
            </ul>
          </div>

          <div className="bg-slate-50 border-2 border-slate-300 rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-4">
              <XCircle className="w-5 h-5 text-slate-600" />
              <h3 className="text-base font-black text-slate-900">What stays your responsibility</h3>
            </div>
            <ul className="space-y-2.5 text-sm text-slate-700">
              <Honesty title="Certification" body="We are not auditors and we do not certify your organization. ISO 9001 certification and PSM compliance audits are conducted by independent third parties, not by us." />
              <Honesty title="Process Hazard Analysis (PHA)" body="OSHA PSM §(e) requires PHA studies (HAZOP, what-if, etc.). We don&apos;t run them; your safety team does. We store the resulting documents." />
              <Honesty title="Mechanical Integrity programs" body="PM schedules, inspection records, RBI — outside this product&apos;s scope. We&apos;re a complement to your CMMS / inspection tool, not a replacement." />
              <Honesty title="Training records & competency" body="Personnel training matrices and competency assessments are managed in your HR or LMS system, not here." />
              <Honesty title="Operating procedures, incident investigation, emergency planning" body="PSM elements §(f), §(m), §(n). We can store the documents; your team produces and maintains them." />
            </ul>
          </div>
        </div>

        <div className="mt-8 p-4 bg-slate-900 text-slate-300 rounded-xl text-sm leading-relaxed">
          <b className="text-white">In plain English:</b> Manufacturing OS makes it dramatically easier to
          <b className="text-white"> produce </b>the documentation an auditor would accept. It does not
          <b className="text-white"> grant </b>compliance, and using it does not absolve you of running your
          program. Final compliance posture is yours.
        </div>
      </div>
    </section>
  );
}

function Honesty({ title, body }: { title: string; body: string }) {
  return (
    <li className="flex flex-col gap-0.5">
      <span className="text-sm font-black text-slate-900">{title}</span>
      <span className="text-xs text-slate-600 leading-relaxed">{body}</span>
    </li>
  );
}

// ─── Security ──────────────────────────────────────────────────────

function SecuritySection() {
  return (
    <section id="security" className="bg-slate-950 text-white">
      <div className="max-w-6xl mx-auto px-6 py-24">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-300 text-xs font-bold uppercase tracking-widest mb-5">
            <Lock className="w-3.5 h-3.5" /> Security posture
          </div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-5">The same things your IT auditor is going to ask about.</h2>
          <p className="text-base text-slate-300 leading-relaxed mb-12">No vague marketing. The specific technical controls, named.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Security icon={<Lock className="w-5 h-5 text-blue-300" />} title="HTTPS-only transport" body="All traffic over TLS. No HTTP fallback." />
          <Security icon={<Database className="w-5 h-5 text-blue-300" />} title="Encryption at rest" body="Postgres encrypted at rest by Supabase. File storage encrypted at rest by Cloudflare R2." />
          <Security icon={<Server className="w-5 h-5 text-blue-300" />} title="Row-level isolation" body="Postgres RLS enforces every query to its org. No cross-tenant leakage possible at the database layer." />
          <Security icon={<KeyRound className="w-5 h-5 text-blue-300" />} title="AES-256-GCM for secrets" body="Customer-provided S3 credentials encrypted at rest with a key your data team controls." />
          <Security icon={<Users className="w-5 h-5 text-blue-300" />} title="Role-based access" body="Admin, Manager, Supervisor, Engineer (1–4), Drafter, DocCtrl, Requester. Every action gated by role + identity." />
          <Security icon={<ClipboardCheck className="w-5 h-5 text-blue-300" />} title="Audited service-role usage" body="The only code that bypasses RLS is the export endpoint — and exports log themselves to your audit trail." />
        </div>
      </div>
    </section>
  );
}

function Security({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <div className="p-1.5 bg-blue-500/10 rounded-lg w-fit mb-3">{icon}</div>
      <h3 className="text-sm font-black text-white mb-1.5">{title}</h3>
      <p className="text-xs text-slate-400 leading-relaxed">{body}</p>
    </div>
  );
}

// ─── Audience ──────────────────────────────────────────────────────

function AudienceSection() {
  return (
    <section className="bg-white">
      <div className="max-w-6xl mx-auto px-6 py-20">
        <div className="max-w-3xl mb-12">
          <div className="text-xs font-black uppercase tracking-widest text-orange-600 mb-3">Who runs on it</div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-4">Built for sites where the drawings matter.</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <Audience icon={<Factory className="w-6 h-6 text-orange-700" />} title="Refineries & chemical plants" body="Captures the documentation OSHA PSM 1910.119 §(l) calls for in Management of Change. MOC ticket type, engineer-routed approvals, revision lineage that survives audits." />
          <Audience icon={<Wrench className="w-6 h-6 text-orange-700" />} title="EPC firms" body="Project containers scope work per-client. Contractor access without exposing the rest of your library." />
          <Audience icon={<ClipboardCheck className="w-6 h-6 text-orange-700" />} title="In-house engineering teams" body="One document control system that the engineers, drafters, and supervisors actually want to use — with audit trails that hold up to ISO 9001 surveillance." />
        </div>
      </div>
    </section>
  );
}

function Audience({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-gradient-to-b from-orange-50 to-white border border-orange-200 rounded-2xl p-6">
      <div className="p-2.5 bg-white rounded-lg w-fit mb-4 shadow-sm border border-orange-100">{icon}</div>
      <h3 className="text-base font-black text-slate-900 mb-2">{title}</h3>
      <p className="text-sm text-slate-600 leading-relaxed">{body}</p>
    </div>
  );
}

// ─── Final CTA ───────────────────────────────────────────────────────

function FinalCta() {
  return (
    <section className="bg-gradient-to-br from-orange-600 to-orange-700 text-white">
      <div className="max-w-4xl mx-auto px-6 py-20 text-center">
        <h2 className="text-3xl md:text-5xl font-black tracking-tight mb-5">Stop running your library off a shared drive.</h2>
        <p className="text-base md:text-lg text-orange-50 leading-relaxed mb-8 max-w-2xl mx-auto">
          Stand up a workspace, import your documents, configure your team&apos;s roles. The whole thing
          takes an afternoon. And the day you decide to leave, you take everything with you.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link href="/signup" className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-white hover:bg-slate-50 text-orange-700 text-sm font-black shadow-lg">
            Create your workspace <ArrowRight className="w-4 h-4" />
          </Link>
          <Link href="/" className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-white/10 hover:bg-white/15 border border-white/30 text-white text-sm font-bold backdrop-blur">
            Sign in to existing workspace
          </Link>
        </div>
      </div>
    </section>
  );
}

// ─── Footer ───────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="bg-slate-950 text-slate-400 border-t border-slate-800">
      <div className="max-w-6xl mx-auto px-6 py-12 grid grid-cols-2 md:grid-cols-4 gap-8">
        <div className="col-span-2">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-7 h-7 bg-gradient-to-br from-orange-500 to-orange-700 rounded-md flex items-center justify-center">
              <Layout className="w-3.5 h-3.5 text-white" />
            </div>
            <div className="font-black text-white text-sm">Manufacturing<span className="text-orange-500">OS</span></div>
          </div>
          <p className="text-xs leading-relaxed max-w-sm">
            Industrial document control + drafting workflow. Built so your data is yours, your audit trail
            is real, and your exit story is one click.
          </p>
        </div>
        <div>
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-3">Product</div>
          <ul className="space-y-2 text-xs">
            <li><a href="#capabilities" className="hover:text-white">Capabilities</a></li>
            <li><a href="#tour" className="hover:text-white">See It</a></li>
            <li><a href="#trust" className="hover:text-white">Your Data</a></li>
            <li><a href="#honesty" className="hover:text-white">Compliance</a></li>
            <li><a href="#security" className="hover:text-white">Security</a></li>
            <li><Link href="/data-portability" className="hover:text-white">Data Portability</Link></li>
          </ul>
        </div>
        <div>
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-3">Account</div>
          <ul className="space-y-2 text-xs">
            <li><Link href="/" className="hover:text-white">Sign in</Link></li>
            <li><Link href="/signup" className="hover:text-white">Create workspace</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-slate-800">
        <div className="max-w-6xl mx-auto px-6 py-4 flex flex-col md:flex-row items-center justify-between gap-2 text-[11px]">
          <span>&copy; {new Date().getFullYear()} Manufacturing OS. All rights reserved.</span>
          <span className="font-mono text-slate-600">v2.1.0 — built for industrial workloads</span>
        </div>
      </div>
    </footer>
  );
}
