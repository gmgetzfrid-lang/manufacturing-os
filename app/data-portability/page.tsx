// /data-portability — public commitment page. Anyone evaluating the
// product before signing up can read this without an account.
//
// The commitments here are policy, not features — pointing customers
// at the actual /admin/data-export feature backs them up with code.

import Link from "next/link";
import {
  Download, ShieldCheck, FileJson, Layers, Clock, Inbox, Lock,
  Database, ExternalLink, Server, Key, ArrowRight,
} from "lucide-react";

export const metadata = {
  title: "Data Portability — Manufacturing OS",
  description: "Your data, exportable any time, in standard formats, with no lock-in.",
};

export default function DataPortabilityPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-sm font-black text-slate-900">Manufacturing OS</Link>
          <Link href="/" className="text-xs font-bold text-slate-600 hover:text-slate-900">Sign in</Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <div className="mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-bold mb-4">
            <ShieldCheck className="w-3.5 h-3.5" /> Your Data, Your Choice
          </div>
          <h1 className="text-4xl font-black text-slate-900 mb-3">No Lock-In, Ever.</h1>
          <p className="text-base text-slate-600 leading-relaxed">
            Industrial document control is critical infrastructure. You can&apos;t afford to wonder whether a vendor outage
            or a contract dispute will cost you years of engineering work. This page is the commitment — every
            organization on this platform owns its data, can export everything at any time, and can walk away cleanly
            without losing a single record.
          </p>
        </div>

        <Section title="The promise in one sentence">
          <p className="text-slate-700 leading-relaxed">
            <b>Any administrator can download the complete dataset for their organization &mdash; every document,
            every revision, every ticket, every audit-log entry, every comment, and every file &mdash; in standard
            formats, at any time, with one click.</b>
          </p>
        </Section>

        <Section title="What's in the export">
          <ul className="space-y-3 text-sm text-slate-700">
            <Bullet icon={<FileJson className="w-4 h-4 text-blue-600" />} title="One JSON file" body="Self-describing. Every Postgres column from our schema preserved verbatim. Read it with jq, import into Postgres, or open it in any text editor." />
            <Bullet icon={<Layers className="w-4 h-4 text-purple-600" />} title="Every record type" body="Documents, document_versions, tickets, projects, project_activity, audit_logs, checkout sessions, markup requests, comments, history, configuration — every org-scoped table." />
            <Bullet icon={<Inbox className="w-4 h-4 text-emerald-600" />} title="File manifest with presigned URLs" body="Every PDF, DWG, redline, IFC stamp — listed with size + a 24-hour signed download URL so you can pull binaries with curl, wget, or any S3 SDK." />
            <Bullet icon={<Database className="w-4 h-4 text-amber-600" />} title="Schema DDL in the public repo" body="The complete database schema lives at supabase/schema.sql in our source tree. You can reconstruct the data layer in your own Postgres in minutes." />
          </ul>
        </Section>

        <Section title="What you can do with it">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <UseCase title="Offsite backup" body="Run it monthly, archive to your own S3 / R2 / NAS. Your continuity plan is yours to control." />
            <UseCase title="Compliance archive" body="OSHA PSM 1910.119 requires document and change history retention. Every revision + audit row is included." />
            <UseCase title="Migration to a different system" body="Standard JSON + standard PDFs. Any competitor can import — that's the point." />
            <UseCase title="Disaster recovery" body="Even if our service is offline, your backed-up export contains every byte you've ever uploaded." />
          </div>
        </Section>

        <Section title="Security posture">
          <ul className="space-y-2 text-sm text-slate-700">
            <Bullet icon={<Lock className="w-4 h-4 text-slate-600" />} title="Encryption in transit + at rest" body="HTTPS only. Postgres data encrypted at rest by Supabase. File storage encrypted at rest by Cloudflare R2." />
            <Bullet icon={<Server className="w-4 h-4 text-slate-600" />} title="Row-level isolation between organizations" body="Postgres RLS enforces that your queries can only see rows belonging to your organization. No cross-tenant data leakage at the database layer." />
            <Bullet icon={<Key className="w-4 h-4 text-slate-600" />} title="Audited service-role usage" body="The only code path that crosses RLS boundaries is the data-export endpoint itself — and exports are logged to your audit trail." />
          </ul>
        </Section>

        <Section title="Coming soon">
          <ul className="space-y-2 text-sm text-slate-700">
            <Bullet icon={<Clock className="w-4 h-4 text-slate-500" />} title="Scheduled exports to your own bucket" body="Daily / weekly / monthly cron that pushes a fresh export straight to your S3-compatible storage. You own the backups end-to-end." />
            <Bullet icon={<Download className="w-4 h-4 text-slate-500" />} title="Single-zip download with binaries inline" body="One archive containing the JSON + every file pre-bundled. Heavier infra; available for larger orgs on request." />
          </ul>
        </Section>

        <Section title="Try it now">
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-5">
            <p className="text-sm text-slate-700 mb-4">
              Already have an account? Run an export right now and verify the commitment with your own data.
            </p>
            <Link
              href="/admin/data-export"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-black shadow"
            >
              <Download className="w-4 h-4" /> Run an export <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </Section>

        <Section title="Open schema">
          <p className="text-sm text-slate-700 mb-3">
            The DDL of every table mentioned above is public. Read it, audit it, fork it.
          </p>
          <a
            href="https://github.com/gmgetzfrid-lang/manufacturing-os/blob/master/supabase/schema.sql"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-bold text-slate-700 hover:text-slate-900 underline"
          >
            View the database schema <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </Section>

        <div className="mt-12 pt-6 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
          <span>Last updated 2026-05-29</span>
          <Link href="/" className="hover:text-slate-900">Back to home</Link>
        </div>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-lg font-black text-slate-900 mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Bullet({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <li className="flex items-start gap-3">
      <div className="p-1.5 bg-slate-100 rounded-md shrink-0 mt-0.5">{icon}</div>
      <div>
        <div className="text-sm font-bold text-slate-900">{title}</div>
        <div className="text-xs text-slate-600">{body}</div>
      </div>
    </li>
  );
}

function UseCase({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
      <div className="text-sm font-bold text-slate-900 mb-1">{title}</div>
      <div className="text-xs text-slate-600 leading-relaxed">{body}</div>
    </div>
  );
}
