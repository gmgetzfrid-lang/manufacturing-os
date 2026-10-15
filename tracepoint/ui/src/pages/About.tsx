import { useEffect, useState, type ReactNode } from "react";
import { Ban, Check, Cpu, Eye, FileLock2, FolderLock, Globe, HardDrive, KeyRound, ListChecks, Package, ShieldCheck, Terminal, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { AppState } from "../lib/types";
import { Mark, Pill } from "../components/ui";

interface About { version: string; local_data: string; temp: string; profiles: string; team_folder?: string | null; protected_roots: string[]; writable: string[]; exe?: string; machine: string; index: { source: string } }

export function AboutPage({ state }: { state: AppState }) {
  const [a, setA] = useState<About | null>(null);
  useEffect(() => { api<About>("about").then(setA); }, []);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-8 py-8">
        <div className="flex items-center gap-4">
          <Mark size={60} />
          <div>
            <div className="text-[24px] font-[800] tracking-[0.18em]">TRACEPOINT</div>
            <div className="text-[13px] text-[var(--color-text-muted)]">Version {state.version} · THOR document search and equipment graph</div>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-[color-mix(in_srgb,var(--color-ok)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-ok)_6%,transparent)] p-5">
          <div className="flex items-center gap-2 text-[15px] font-semibold"><ShieldCheck className="size-5 text-[var(--color-ok)]" /> For IT: the short version</div>
          <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
            {[
              "One portable .exe. No installer, no admin rights, no services, no drivers, no registry changes, no scheduled tasks.",
              "Never writes, renames, moves or deletes anything on THOR. Enforced in code by a single write guard.",
              "Reads THOR with the signed-in Windows user's own permissions, using normal shared read access.",
              "No AI of any kind. No internet connections: no telemetry, no auto-update, no license server, no cloud services.",
              "Only network traffic: reading THOR over SMB. The exe contains no HTTP client.",
              "Passwords stored as Argon2id hashes only. Profiles are created by administrators only.",
            ].map((t) => <li key={t} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-[var(--color-ok)]" />{t}</li>)}
          </ul>
        </div>

        <Block icon={<Eye className="size-4" />} title="What it reads">
          <Row k="THOR files" v="Only when a person previews or opens a file, or when an administrator/indexer runs a scan. Scans read folder listings and file metadata (name, size, dates); they do not read file contents." />
          <Row k="Index" v={a?.index.source ?? "…"} />
          <Row k="Protected sources" v={a ? a.protected_roots.join(" · ") || "—" : "…"} mono />
        </Block>

        <Block icon={<FolderLock className="size-4" />} title="What it writes — and the only places it can">
          <Row k="Local data" v={a?.local_data ?? "…"} mono note="Settings, unpacked index, caches. Per Windows user." />
          <Row k="Profiles" v={a?.profiles ?? "…"} mono note="Profile list, password hashes, preferences, audit log." />
          <Row k="Team folder" v={a?.team_folder ?? "Not configured"} mono note="Optional shared folder chosen by an administrator. Must be outside THOR's indexed roots." />
          <Row k="Temporary" v={a?.temp ?? "…"} mono note="Read-only copies of files opened for viewing." />
          <Row k="Exports" v="Excel files are written only where the user chooses in the Save dialog (refused inside THOR)." />
        </Block>

        <Block icon={<Globe className="size-4" />} title="Network connections">
          <Row k="THOR" v="SMB to the indexed shares, as the signed-in Windows user." />
          <Row k="Internet" v="None. TracePoint has no AI features and no HTTP client. No analytics, update checks, licence calls, fonts or scripts from the internet — the interface is bundled inside the exe." />
        </Block>

        <Block icon={<Cpu className="size-4" />} title="Processes and components">
          <Row k="Processes" v="TracePoint.exe plus the Microsoft Edge WebView2 processes Windows uses to draw the window (msedgewebview2.exe). The THOR indexer runs inside TracePoint.exe — no Python, no scripts, no child processes." />
          <Row k="Opening files" v="Uses the Windows default program for the file type (like double-clicking it in Explorer). By default it opens a read-only temporary copy." />
          <Row k="Built with" v="Rust · SQLite · Microsoft WebView2 · React · Inter font (OFL). All embedded in the exe except WebView2, which is part of Windows." />
        </Block>

        <Block icon={<KeyRound className="size-4" />} title="Accounts and security">
          <Row k="Sign-in" v="One built-in administrator (temporary password, forced change at first sign-in). Only administrators create profiles and assign roles. Five wrong passwords lock a profile for 5 minutes." />
          <Row k="Passwords" v="Argon2id (64 MiB, 3 passes). Never stored or logged in plain text." />
          <Row k="AI" v="None. TracePoint does not use, call or embed any AI service or model. Search understands plain English with built-in rules that run entirely on the PC." />
          <Row k="Audit" v="Sign-ins, failures, profile changes, password resets and index imports are logged with time, user and computer name." />
        </Block>

        <Block icon={<ListChecks className="size-4" />} title="How IT can verify this">
          <ol className="list-decimal space-y-2 pl-5 text-[13px] leading-relaxed">
            <li><b>Self-test:</b> run <Code>TracePoint.exe --selftest</Code> in a command prompt. It checks the search engine, the THOR write guard (attempts writes into protected paths and confirms they're refused), password hashing and profile rules, and prints PASS/FAIL.</li>
            <li><b>File activity:</b> Sysinternals Process Monitor with filters <Code>Process Name is TracePoint.exe</Code> and <Code>Operation is WriteFile</Code> / <Code>SetDispositionInformationFile</Code> / <Code>SetRenameInformationFile</Code>. Use the app normally: no write, delete or rename appears on a THOR path.</li>
            <li><b>Network:</b> Resource Monitor › Network, or <Code>netstat -b</Code>. TracePoint.exe opens only SMB (445) connections to THOR — nothing to the internet. (msedgewebview2.exe is Windows’ own component; TracePoint only ever points it at its built-in pages.)</li>
            <li><b>Integrity:</b> record the SHA-256 of the exe (<Code>certutil -hashfile TracePoint.exe SHA256</Code>) for an AppLocker/WDAC hash rule if needed.</li>
            <li><b>Remove completely:</b> delete <Code>TracePoint.exe</Code> and the folder <Code>{a?.local_data ?? "%LOCALAPPDATA%\\TracePoint"}</Code>. Nothing else is left behind.</li>
          </ol>
        </Block>

        <div className="mt-6 grid grid-cols-3 gap-3 text-[12.5px]">
          <Tag icon={<Ban className="size-4" />} t="No admin rights" />
          <Tag icon={<Package className="size-4" />} t="No installer" />
          <Tag icon={<Trash2 className="size-4" />} t="Delete to uninstall" />
          <Tag icon={<FileLock2 className="size-4" />} t="Read-only on THOR" />
          <Tag icon={<HardDrive className="size-4" />} t="No AI · no internet" />
          <Tag icon={<Terminal className="size-4" />} t="--selftest for IT" />
        </div>
        <div className="mt-6 text-[12px] text-[var(--color-text-faint)]">{a?.exe} · {a?.machine}</div>
      </div>
    </div>
  );
}

function Block({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="mt-6 card p-5">
      <div className="mb-3 flex items-center gap-2 text-[14.5px] font-semibold"><span className="flex size-7 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">{icon}</span>{title}</div>
      <div className="divide-y divide-[var(--color-border)]">{children}</div>
    </section>
  );
}
function Row({ k, v, note, mono }: { k: string; v: string; note?: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-4 py-2.5 text-[13px]">
      <div className="font-medium text-[var(--color-text-muted)]">{k}</div>
      <div><div className={mono ? "break-all font-mono text-[12.5px]" : ""}>{v}</div>{note && <div className="mt-0.5 text-[12px] text-[var(--color-text-faint)]">{note}</div>}</div>
    </div>
  );
}
function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 font-mono text-[12px]">{children}</code>;
}
function Tag({ icon, t }: { icon: ReactNode; t: string }) {
  return <div className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] p-3"><span className="text-[var(--color-ok)]">{icon}</span>{t}<Pill color="var(--color-ok)" className="ml-auto">✓</Pill></div>;
}
