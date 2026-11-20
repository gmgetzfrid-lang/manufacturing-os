// /data-portability — public commitment page. Anyone evaluating the
// product before signing up can read this without an account.
//
// The commitments here are policy, not features — pointing customers
// at the actual /admin/data-export feature backs them up with code.

import Link from "next/link";
import { PageHero, PageBody, Card } from "@/components/ui/PageHero";
import {
  Download, ShieldCheck, FileJson, Layers, Clock, Inbox, Lock,
  Database, ExternalLink, Server, Key, ArrowRight,
} from "lucide-react";

export const metadata = {
  title: "Data Portability | Manufacturing OS",
  description: "Your data, exportable any time, in standard formats, with no lock-in.",
};

// This is a server page, so the band's button styles are spelled out here
// (the shared class strings live in a client module). Same tokens.
const bandQuiet = "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-[10px] border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-[13px] font-semibold text-[var(--color-ink-fg)] hover:bg-[var(--color-ink-line)] transition-colors";
const bandPrimary = "inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[14px] font-extrabold hover:bg-[var(--color-accent-hover)] shadow-[0_12px_24px_-12px_var(--color-accent)] transition-colors";

export default function DataPortabilityPage() {
  return (
    <div className="min-h-dvh bg-[var(--color-canvas)]">
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-6 pb-20">
        <PageHero
          kicker={<Link href="/" className="hover:text-white">Manufacturing OS · Data portability</Link>}
          title="No lock-in, ever."
          sub="Every organization on this platform owns its data, can export everything at any time, and can walk away cleanly without losing a single record."
          tools={<Link href="/" className={bandQuiet}>Sign in</Link>}
          primary={
            <Link href="/admin/data-export" className={bandPrimary}>
              <Download className="w-4 h-4" /> Run an export
            </Link>
          }
        />

        <PageBody>
        <Card label={<span className="inline-flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> Why it matters</span>}>
          <p className="text-[15px] text-[var(--color-text-muted)] leading-relaxed">
            Industrial document control is critical infrastructure. You can&apos;t afford to wonder whether a vendor outage
            or a contract dispute will cost you years of engineering work. This page is the commitment.
          </p>
        </Card>

        <Section title="The promise in one sentence">
          <p className="text-[15px] text-[var(--color-text)] leading-relaxed">
            <b>Any administrator can download the complete dataset for their organization (every document,
            every revision, every ticket, every audit-log entry, every comment, and every file) in standard
            formats, at any time, with one click.</b>
          </p>
        </Section>

        <Section title="What's in the export">
          <ul className="space-y-3 text-sm text-[var(--color-text)]">
            <Bullet icon={<FileJson className="w-4 h-4 text-[var(--color-text-muted)]" />} title="One JSON file" body="Self-describing. Every Postgres column from our schema preserved verbatim. Read it with jq, import into Postgres, or open it in any text editor." />
            <Bullet icon={<Layers className="w-4 h-4 text-[var(--color-text-muted)]" />} title="Every record type" body="Documents, document_versions, tickets, projects, project_activity, audit_logs, checkout sessions, markup requests, comments, history, configuration, every org-scoped table." />
            <Bullet icon={<Inbox className="w-4 h-4 text-[var(--color-text-muted)]" />} title="File manifest with presigned URLs" body="Every PDF, DWG, redline, IFC stamp, listed with size + a 24-hour signed download URL so you can pull binaries with curl, wget, or any S3 SDK." />
            <Bullet icon={<Database className="w-4 h-4 text-[var(--color-text-muted)]" />} title="Schema DDL in the public repo" body="The complete database schema lives at supabase/schema.sql in our source tree. You can reconstruct the data layer in your own Postgres in minutes." />
          </ul>
        </Section>

        <Section title="What you can do with it">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 divide-y md:divide-y-0 divide-[var(--color-border)]">
            <UseCase title="Offsite backup" body="Run it monthly, archive to your own S3 / R2 / NAS. Your continuity plan is yours to control." />
            <UseCase title="Compliance archive" body="OSHA PSM 1910.119 requires document and change history retention. Every revision + audit row is included." />
            <UseCase title="Migration to a different system" body="Standard JSON + standard PDFs. Any competitor can import, that's the point." />
            <UseCase title="Disaster recovery" body="Even if our service is offline, your backed-up export contains every byte you've ever uploaded." />
          </div>
        </Section>

        <Section title="Security posture">
          <ul className="space-y-2 text-sm text-[var(--color-text)]">
            <Bullet icon={<Lock className="w-4 h-4 text-[var(--color-text-muted)]" />} title="Encryption in transit + at rest" body="HTTPS only. Postgres data encrypted at rest by Supabase. File storage encrypted at rest by Cloudflare R2." />
            <Bullet icon={<Server className="w-4 h-4 text-[var(--color-text-muted)]" />} title="Row-level isolation between organizations" body="Postgres RLS enforces that your queries can only see rows belonging to your organization. No cross-tenant data leakage at the database layer." />
            <Bullet icon={<Key className="w-4 h-4 text-[var(--color-text-muted)]" />} title="Audited service-role usage" body="The only code path that crosses RLS boundaries is the data-export endpoint itself, and exports are logged to your audit trail." />
          </ul>
        </Section>

        <Section title="Also available">
          <ul className="space-y-2 text-sm text-[var(--color-text)]">
            <Bullet icon={<Clock className="w-4 h-4 text-[var(--color-text-muted)]" />} title="Scheduled exports to your own bucket" body="Daily / weekly / monthly schedules that push a fresh export straight to your S3-compatible storage, with optional retention pruning. Configure destinations under Admin → Data export." />
            <Bullet icon={<Download className="w-4 h-4 text-[var(--color-text-muted)]" />} title="Single-zip download with binaries inline" body="One archive containing the JSON + your files pre-bundled (very large files past the embed cap are listed in the archive and stay individually downloadable via presigned URLs)." />
          </ul>
        </Section>

        <Section title="Try it now">
          <p className="text-[14px] text-[var(--color-text)]">
            Already have an account? Run an export right now and verify the commitment with your own data.{" "}
            <Link href="/admin/data-export" className="inline-flex items-center gap-1 font-bold underline underline-offset-2">
              Open Data export <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </p>
        </Section>

        <Section title="Open schema">
          <p className="text-[14px] text-[var(--color-text)] mb-3">
            The DDL of every table mentioned above is public. Read it, audit it, fork it.
          </p>
          <a
            href="https://github.com/gmgetzfrid-lang/manufacturing-os/blob/master/supabase/schema.sql"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[14px] font-bold text-[var(--color-text)] underline underline-offset-2"
          >
            View the database schema <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </Section>

        <div className="px-1 pt-2 flex items-center justify-between text-[12px] text-[var(--color-text-muted)]">
          <span>Last updated May 29, 2026</span>
          <Link href="/" className="hover:text-[var(--color-text)]">Back to home</Link>
        </div>
        </PageBody>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card label={title}>
      {children}
    </Card>
  );
}

function Bullet({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <li className="flex items-start gap-3">
      <div className="p-1.5 bg-[var(--color-surface-2)] rounded-md shrink-0 mt-0.5">{icon}</div>
      <div>
        <div className="text-[14px] font-bold text-[var(--color-text)]">{title}</div>
        <div className="text-[13px] text-[var(--color-text-muted)]">{body}</div>
      </div>
    </li>
  );
}

function UseCase({ title, body }: { title: string; body: string }) {
  return (
    <div className="py-3">
      <div className="text-[14px] font-bold text-[var(--color-text)] mb-0.5">{title}</div>
      <div className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">{body}</div>
    </div>
  );
}
