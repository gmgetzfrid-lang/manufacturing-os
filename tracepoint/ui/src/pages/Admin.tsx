import { useCallback, useEffect, useState } from "react";
import { FolderCog, ScrollText, Search, Trash2, UserPlus, Users } from "lucide-react";
import { api } from "../lib/api";
import type { AppState, Member, Role } from "../lib/types";
import { Avatar, Button, Empty, Field, IconButton, Input, Pill, Section, Segmented, Select, useToast } from "../components/ui";
import { initials, when } from "../lib/format";

const ROLE: Record<Role, { label: string; color: string; desc: string }> = {
  admin: { label: "Administrator", color: "var(--color-accent)", desc: "Gives out roles, scans THOR, shares the index." },
  indexer: { label: "Indexer", color: "var(--color-info)", desc: "Scans THOR and shares the index." },
  user: { label: "User", color: "var(--color-text-muted)", desc: "Everyone else, automatically. Search, equipment and graph — only what their Windows account can open." },
};

interface Audit { at: string; actor?: string; action: string; detail?: string; machine?: string }

export function AdminPage({ state }: { state: AppState; setState?: (s: AppState) => void }) {
  const [tab, setTab] = useState<"roles" | "folder" | "audit">("roles");
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1100px] px-8 py-7">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-[24px] font-[700] tracking-tight">Administration</h1>
            <p className="mt-1 text-[13.5px] text-[var(--color-text-muted)]">Everyone signs in with their Windows account. Roles are the only thing set here.</p>
          </div>
          <Segmented value={tab} onChange={setTab} options={[
            { value: "roles", label: <><Users className="size-3.5" />Roles</> },
            { value: "folder", label: <><FolderCog className="size-3.5" />Shared folder</> },
            { value: "audit", label: <><ScrollText className="size-3.5" />Activity</> },
          ]} />
        </div>
        <div className="mt-6">
          {tab === "roles" && <Roles state={state} />}
          {tab === "folder" && <SharedFolder state={state} />}
          {tab === "audit" && <AuditLog />}
        </div>
      </div>
    </div>
  );
}

function Roles({ state }: { state: AppState }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [file, setFile] = useState("");
  const [account, setAccount] = useState("");
  const [role, setRole] = useState<Role>("indexer");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const load = useCallback(() => api<{ members: Member[]; roles_file: string }>("admin.members").then((r) => { setMembers(r.members); setFile(r.roles_file); }).catch((e) => toast("error", e.message)), [toast]);
  useEffect(() => { load(); }, [load]);
  const set = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try {
      const r = await api<{ warning?: string | null }>("admin.member.set", body);
      if (r.warning) toast("error", r.warning); else toast("ok", ok);
      setAccount("");
      load();
    } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="card overflow-hidden">
        <div className="flex items-end gap-3 border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex-1"><Field label="Windows account"><Input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="KERN\jsmith" className="font-mono" onKeyDown={(e) => e.key === "Enter" && account.trim() && set({ account, role }, `${account} is now ${ROLE[role].label}`)} /></Field></div>
          <div className="w-44"><Field label="Role"><Select value={role} onChange={(v) => setRole(v as Role)} options={[{ value: "indexer", label: "Indexer" }, { value: "admin", label: "Administrator" }]} /></Field></div>
          <Button variant="primary" icon={<UserPlus className="size-4" />} loading={busy} disabled={!account.trim()} onClick={() => set({ account, role }, `${account} is now ${ROLE[role].label}`)}>Give role</Button>
        </div>
        {!members ? <div className="p-6"><div className="skeleton h-24" /></div> : members.length === 0 ? <Empty icon={<Users className="size-5" />} title="No roles yet" /> : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[11.5px] uppercase tracking-wide text-[var(--color-text-faint)]">
                <th className="px-4 py-2.5 font-semibold">Windows account</th><th className="px-4 py-2.5 font-semibold">Role</th><th className="px-4 py-2.5 font-semibold">Added</th><th />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.sid} className="border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-surface-2)]">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar text={initials(m.account.split("\\").pop() ?? "", "")} size={32} />
                      <div><div className="font-semibold">{m.account}{m.sid === state.user?.id && <span className="ml-1.5 text-[11.5px] font-normal text-[var(--color-text-faint)]">(you)</span>}</div><div className="font-mono text-[11px] text-[var(--color-text-faint)]">{m.sid}</div></div>
                    </div>
                  </td>
                  <td className="px-4 py-3"><Select value={m.role} onChange={(v) => set({ sid: m.sid, role: v }, "Role changed")} options={[{ value: "admin", label: "Administrator" }, { value: "indexer", label: "Indexer" }]} className="h-8 text-[12.5px]" /></td>
                  <td className="px-4 py-3 text-[12.5px] text-[var(--color-text-muted)]">{when(m.added_at)}{m.added_by ? ` · ${m.added_by}` : ""}</td>
                  <td className="px-2 py-3 text-right">{m.sid !== state.user?.id && <IconButton label="Remove role" onClick={() => confirm(`Remove ${m.account}'s role? They become a normal user.`) && set({ sid: m.sid, role: "user" }, "Role removed")}><Trash2 className="size-4" /></IconButton>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        {(Object.keys(ROLE) as Role[]).map((r) => (
          <div key={r} className="rounded-xl border border-[var(--color-border)] p-3.5">
            <Pill color={ROLE[r].color}>{ROLE[r].label}</Pill>
            <div className="mt-1.5 text-[12.5px] text-[var(--color-text-muted)]">{ROLE[r].desc}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12px] text-[var(--color-text-faint)]">Saved in <span className="font-mono">{file}</span>. Windows enforces it: administrators and indexers are given write access to the shared folder; everyone else can only read it.</p>
    </>
  );
}

interface TeamInfo { team: AppState["team"]; found?: string | null; default: string; next_to_exe?: string | null }

function SharedFolder({ state }: { state: AppState }) {
  const [info, setInfo] = useState<TeamInfo | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { api<TeamInfo>("team.status").then((i) => { setInfo(i); setPath(i.team.folder ?? i.found ?? i.default); }); }, []);
  const go = async (cmd: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await api<{ shared?: string | null; cancelled?: boolean }>(cmd, body);
      if (!r.cancelled) toast("ok", r.shared ?? "Done. Loading the shared index…");
      setInfo(await api<TeamInfo>("team.status"));
    } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };
  const t = info?.team ?? state.team;
  return (
    <div className="grid grid-cols-[1.2fr_1fr] gap-6">
      <Section title="Shared TracePoint folder" subtitle="One folder everyone reads; only administrators and indexers write. TracePoint locks it when setting it up.">
        <div className="space-y-4 text-[13.5px]">
          <div className="rounded-xl bg-[var(--color-surface-2)] p-3">
            {t.mode === "team" ? <>This PC uses <span className="font-mono">{t.folder}</span>{t.forced && " (set by IT)"}.</> : t.mode === "offline" ? <>Can't reach <span className="font-mono">{t.folder}</span> right now.</> : <>This PC isn't connected to a shared folder — its index is only on this PC.</>}
          </div>
          {!t.forced && (
            <Field label="Folder" hint="Default: \\thor\Public\TP\TracePoint Data. If TracePoint is already set up there, this PC simply joins.">
              <div className="flex gap-2">
                <Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" />
                <Button onClick={() => go("team.join", { pick: true })}>Browse…</Button>
              </div>
            </Field>
          )}
          {!t.forced && (
            <div className="flex gap-2">
              <Button variant="primary" loading={busy} onClick={() => go("team.setup", { path })}>Set up / join</Button>
              {t.mode !== "standalone" && <Button onClick={() => confirm("Use this PC on its own? You'll stop seeing the shared index.") && go("team.leave", {})}>Leave</Button>}
            </div>
          )}
        </div>
      </Section>
      <Section title="What's in it" subtitle="No file names outside locked folders">
        <ul className="space-y-2.5 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
          <li><b className="text-[var(--color-text)]">roles.json</b> — who is an administrator or indexer.</li>
          <li><b className="text-[var(--color-text)]">index\g-…\</b> — one folder per set of Windows permissions on THOR, locked with those same permissions. Each holds the names and document text of only those files.</li>
          <li><b className="text-[var(--color-text)]">admin\</b> — activity log and scan lock. Administrators and indexers only.</li>
        </ul>
      </Section>
    </div>
  );
}

function AuditLog() {
  const [rows, setRows] = useState<Audit[] | null>(null);
  const [q, setQ] = useState("");
  const toast = useToast();
  useEffect(() => { api<Audit[]>("admin.audit").then(setRows).catch((e) => toast("error", e.message)); }, [toast]);
  const list = (rows ?? []).filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase()));
  const color = (a: string) => (a.includes("fail") || a.includes("denied") ? "var(--color-bad)" : a.includes("shared") ? "var(--color-ok)" : a.includes("policy") || a.includes("role") ? "var(--color-accent)" : "var(--color-text-muted)");
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <div className="w-80"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter the log…" icon={<Search className="size-4" />} /></div>
        <div className="ml-auto text-[12.5px] text-[var(--color-text-faint)]">Scans, sharing, roles, settings. Searches are never logged.</div>
      </div>
      <div className="max-h-[62vh] overflow-y-auto">
        {list.map((r, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-[var(--color-border)] px-4 py-2.5 text-[13px] last:border-0">
            <span className="w-40 shrink-0 text-[12px] tabular-nums text-[var(--color-text-faint)]">{new Date(r.at).toLocaleString()}</span>
            <span className="w-36 shrink-0"><Pill color={color(r.action)}>{r.action.replace(/_/g, " ")}</Pill></span>
            <span className="w-48 shrink-0 truncate">{r.actor ?? "system"}</span>
            <span className="flex-1 truncate text-[var(--color-text-muted)]" title={r.detail}>{r.detail}</span>
            <span className="shrink-0 text-[11.5px] text-[var(--color-text-faint)]">{r.machine}</span>
          </div>
        ))}
        {rows && list.length === 0 && <Empty title="Nothing logged yet" />}
      </div>
    </div>
  );
}
