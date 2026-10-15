import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Copy, FolderCog, KeyRound, MoreHorizontal, Plus, RefreshCw, ScrollText, Search, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { api } from "../lib/api";
import type { AppState, Role, User } from "../lib/types";
import { Avatar, Button, Empty, Field, IconButton, Input, Modal, Pill, Section, Segmented, Select, Toggle, cx, useToast } from "../components/ui";
import { initials, when } from "../lib/format";

const ROLE: Record<Role, { label: string; color: string; desc: string }> = {
  admin: { label: "Administrator", color: "var(--color-accent)", desc: "Manages profiles, roles, AI policy and the index" },
  indexer: { label: "Indexer", color: "var(--color-info)", desc: "Can rescan THOR and publish the index" },
  user: { label: "User", color: "var(--color-text-muted)", desc: "Search, graph and Ask THOR" },
};

function tempPassword(): string {
  const words = ["Crude", "Tower", "Valve", "Flare", "Drum", "Pump", "Steam", "Amine", "Relief", "Tank", "Header", "Nozzle"];
  const a = new Uint32Array(3);
  crypto.getRandomValues(a);
  return `${words[a[0] % words.length]}-${words[a[1] % words.length]}-${1000 + (a[2] % 9000)}`;
}

interface Audit { at: string; actor?: string; action: string; detail?: string; machine?: string }

export function AdminPage({ state, setState }: { state: AppState; setState: (s: AppState) => void }) {
  const [tab, setTab] = useState<"people" | "ai" | "audit" | "deploy">("people");
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-8 py-7">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-[24px] font-[700] tracking-tight">Administration</h1>
            <p className="mt-1 text-[13.5px] text-[var(--color-text-muted)]">Only administrators see this page. Every change here is recorded in the audit log.</p>
          </div>
          <Segmented value={tab} onChange={setTab} options={[
            { value: "people", label: <><Users className="size-3.5" />Profiles</> },
            { value: "ai", label: <><Bot className="size-3.5" />AI policy</> },
            { value: "deploy", label: <><FolderCog className="size-3.5" />Team folder</> },
            { value: "audit", label: <><ScrollText className="size-3.5" />Audit log</> },
          ]} />
        </div>
        <div className="mt-6">
          {tab === "people" && <People state={state} />}
          {tab === "ai" && <AiPolicy state={state} setState={setState} />}
          {tab === "deploy" && <TeamFolder state={state} />}
          {tab === "audit" && <AuditLog />}
        </div>
      </div>
    </div>
  );
}

function People({ state }: { state: AppState }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const toast = useToast();
  const load = useCallback(() => api<User[]>("admin.users").then(setUsers).catch((e) => toast("error", e.message)), [toast]);
  useEffect(() => { load(); }, [load]);
  const update = async (u: User, patch: Partial<{ role: Role; disabled: boolean; can_ai: boolean; name: string }>) => {
    try { await api("admin.user.update", { id: u.id, ...patch }); toast("ok", "Profile updated"); load(); } catch (e) { toast("error", (e as Error).message); }
  };
  const remove = async (u: User) => {
    if (!confirm(`Delete the profile ${u.email}? Their saved AI key is deleted with it.`)) return;
    try { await api("admin.user.delete", { id: u.id }); toast("ok", "Profile deleted"); load(); } catch (e) { toast("error", (e as Error).message); }
  };
  const list = useMemo(() => (users ?? []).filter((u) => !q || u.email.toLowerCase().includes(q.toLowerCase()) || u.name.toLowerCase().includes(q.toLowerCase())), [users, q]);
  const counts = useMemo(() => ({ total: users?.length ?? 0, admins: users?.filter((u) => u.role === "admin").length ?? 0, pending: users?.filter((u) => u.must_change).length ?? 0, ai: users?.filter((u) => u.has_ai_key).length ?? 0 }), [users]);
  return (
    <>
      <div className="mb-4 grid grid-cols-4 gap-3">
        {[["Profiles", counts.total], ["Administrators", counts.admins], ["Awaiting first sign-in", counts.pending], ["With their own AI key", counts.ai]].map(([l, v]) => (
          <div key={l as string} className="card px-4 py-3"><div className="text-[12px] text-[var(--color-text-muted)]">{l}</div><div className="mt-1 text-[22px] font-semibold tabular-nums">{v}</div></div>
        ))}
      </div>
      <div className="card overflow-hidden">
        <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
          <div className="w-72"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a profile…" icon={<Search className="size-4" />} /></div>
          <div className="ml-auto"><Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setCreating(true)}>New profile</Button></div>
        </div>
        {!users ? <div className="p-6"><div className="skeleton h-24" /></div> : list.length === 0 ? <Empty icon={<Users className="size-5" />} title="No profiles match" /> : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[11.5px] uppercase tracking-wide text-[var(--color-text-faint)]">
                <th className="px-4 py-2.5 font-semibold">Person</th><th className="px-4 py-2.5 font-semibold">Role</th><th className="px-4 py-2.5 font-semibold">Status</th><th className="px-4 py-2.5 font-semibold">AI</th><th className="px-4 py-2.5 font-semibold">Last sign-in</th><th />
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id} className={cx("border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-surface-2)]", u.disabled && "opacity-55")}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar text={initials(u.name, u.email)} size={34} />
                      <div><div className="font-semibold">{u.name || "—"}{u.id === state.user?.id && <span className="ml-1.5 text-[11.5px] font-normal text-[var(--color-text-faint)]">(you)</span>}</div><div className="text-[12px] text-[var(--color-text-muted)]">{u.email}</div></div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Select value={u.role} onChange={(v) => update(u, { role: v as Role })} options={(Object.keys(ROLE) as Role[]).map((r) => ({ value: r, label: ROLE[r].label }))} className="h-8 text-[12.5px]" />
                  </td>
                  <td className="px-4 py-3">
                    {u.disabled ? <Pill color="var(--color-bad)">Disabled</Pill> : u.must_change ? <Pill color="var(--color-warn)">Must set password</Pill> : <Pill color="var(--color-ok)">Active</Pill>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-10"><Toggle checked={u.can_ai} onChange={(v) => update(u, { can_ai: v })} /></div>
                      {u.has_ai_key && <Pill color="var(--color-info)" title="Encrypted with the user's own password">Own key</Pill>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[12.5px] text-[var(--color-text-muted)]">{when(u.last_login_at)}</td>
                  <td className="relative px-2 py-3 text-right">
                    <IconButton label="More" onClick={() => setMenu(menu === u.id ? null : u.id)}><MoreHorizontal className="size-4" /></IconButton>
                    {menu === u.id && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setMenu(null)} />
                        <div className="absolute right-3 top-11 z-20 w-56 card p-1.5 text-left shadow-xl animate-[var(--animate-pop)]">
                          <MenuBtn icon={<KeyRound className="size-4" />} onClick={() => { setMenu(null); setResetting(u); }}>Reset password…</MenuBtn>
                          <MenuBtn icon={<ShieldCheck className="size-4" />} onClick={() => { setMenu(null); update(u, { disabled: !u.disabled }); }}>{u.disabled ? "Enable profile" : "Disable profile"}</MenuBtn>
                          <div className="my-1 h-px bg-[var(--color-border)]" />
                          <MenuBtn icon={<Trash2 className="size-4 text-[var(--color-bad)]" />} onClick={() => { setMenu(null); remove(u); }}>Delete profile</MenuBtn>
                        </div>
                      </>
                    )}
                  </td>
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
      <CreateUser open={creating} onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />
      <ResetPassword user={resetting} onClose={() => setResetting(null)} onDone={() => { setResetting(null); load(); }} />
    </>
  );
}

function MenuBtn({ icon, children, onClick }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void }) {
  return <button onClick={onClick} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] hover:bg-[var(--color-surface-3)] cursor-pointer"><span className="text-[var(--color-text-muted)]">{icon}</span>{children}</button>;
}

function CreateUser({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [temp, setTemp] = useState(tempPassword);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ email: string; temp: string } | null>(null);
  const toast = useToast();
  useEffect(() => { if (open) { setEmail(""); setName(""); setRole("user"); setTemp(tempPassword()); setError(null); setCreated(null); } }, [open]);
  const submit = async () => {
    setBusy(true); setError(null);
    try { await api("admin.user.create", { email, name, role, temp_password: temp }); setCreated({ email, temp }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={created ? onDone : onClose} title={created ? "Profile created" : "New profile"} subtitle={created ? undefined : "The person signs in with this temporary password and must choose their own straight away."}
      footer={created ? <Button variant="primary" onClick={onDone}>Done</Button> : <><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit} disabled={!email || temp.length < 8} icon={<Plus className="size-4" />}>Create profile</Button></>}>
      {created ? (
        <div className="space-y-3 text-[13.5px]">
          <p>Give these details to the person privately. The temporary password works once — they must replace it when they first sign in.</p>
          <div className="rounded-xl bg-[var(--color-surface-2)] p-4 font-mono text-[13px]">
            <div>Email: {created.email}</div>
            <div className="mt-1">Temporary password: <span className="font-semibold">{created.temp}</span></div>
          </div>
          <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => navigator.clipboard?.writeText(`TracePoint sign-in\nEmail: ${created.email}\nTemporary password: ${created.temp}\nYou'll be asked to choose your own password.`).then(() => toast("ok", "Copied"))}>Copy sign-in details</Button>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Work email"><Input autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@kernenergy.com" /></Field>
          <Field label="Full name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" /></Field>
          <Field label="Role">
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(ROLE) as Role[]).map((r) => (
                <button key={r} onClick={() => setRole(r)} className={cx("rounded-xl border p-3 text-left transition cursor-pointer", role === r ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]")}>
                  <div className="text-[13px] font-semibold">{ROLE[r].label}</div>
                  <div className="mt-0.5 text-[11.5px] leading-snug text-[var(--color-text-muted)]">{ROLE[r].desc}</div>
                </button>
              ))}
            </div>
          </Field>
          <Field label="Temporary password" hint="Generated for you. At least 8 characters.">
            <div className="flex gap-2"><Input value={temp} onChange={(e) => setTemp(e.target.value)} className="font-mono" /><IconButton label="Generate another" onClick={() => setTemp(tempPassword())}><RefreshCw className="size-4" /></IconButton></div>
          </Field>
          {error && <div className="rounded-lg bg-[color-mix(in_srgb,var(--color-bad)_8%,transparent)] px-3 py-2 text-[13px] text-[var(--color-bad)]">{error}</div>}
        </div>
      )}
    </Modal>
  );
}

function ResetPassword({ user, onClose, onDone }: { user: User | null; onClose: () => void; onDone: () => void }) {
  const [temp, setTemp] = useState(tempPassword);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { if (user) setTemp(tempPassword()); }, [user]);
  const submit = async () => {
    if (!user) return;
    setBusy(true);
    try { await api("admin.user.reset", { id: user.id, temp_password: temp }); toast("ok", `Password reset for ${user.email}`); onDone(); } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!user} onClose={onClose} title={`Reset password · ${user?.email ?? ""}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} onClick={submit}>Reset password</Button></>}>
      <div className="space-y-4 text-[13.5px]">
        <div className="rounded-xl border border-[color-mix(in_srgb,var(--color-warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_8%,transparent)] p-3.5">
          Their saved AI key will be <b>erased</b>. It was locked with their old password, and nobody — including you — can unlock it. They'll need to paste it again after signing in.
        </div>
        <Field label="New temporary password"><div className="flex gap-2"><Input value={temp} onChange={(e) => setTemp(e.target.value)} className="font-mono" /><IconButton label="Generate another" onClick={() => setTemp(tempPassword())}><RefreshCw className="size-4" /></IconButton></div></Field>
      </div>
    </Modal>
  );
}

function AiPolicy({ state, setState }: { state: AppState; setState: (s: AppState) => void }) {
  const toast = useToast();
  const set = async (key: string, value: string) => {
    try { setState(await api<AppState>("admin.policy.set", { key, value })); toast("ok", "Policy saved"); } catch (e) { toast("error", (e as Error).message); }
  };
  const providers = [
    { id: "anthropic", name: "Anthropic Claude", host: "api.anthropic.com" },
    { id: "openai", name: "OpenAI", host: "api.openai.com" },
    { id: "gemini", name: "Google Gemini", host: "generativelanguage.googleapis.com" },
  ];
  const allowed = state.policy.ai_providers;
  return (
    <div className="grid grid-cols-2 gap-6">
      <Section title="AI features" subtitle="TracePoint works fully without AI. These switches control the optional Ask THOR assistant.">
        <div className="space-y-5">
          <Toggle checked={state.policy.ai_enabled} onChange={(v) => set("ai_enabled", String(v))} label="Allow AI for this team" hint="Off: no profile can use AI and no requests go to AI providers." />
          <div>
            <div className="mb-2 text-[12.5px] font-medium text-[var(--color-text-muted)]">Allowed providers</div>
            <div className="space-y-2">
              {providers.map((p) => (
                <div key={p.id} className="rounded-xl border border-[var(--color-border)] p-3">
                  <Toggle checked={allowed.includes(p.id)} onChange={(v) => set("ai_providers", (v ? [...allowed, p.id] : allowed.filter((x) => x !== p.id)).join(","))} label={p.name} hint={<span className="font-mono text-[11.5px]">{p.host}</span>} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>
      <Section title="How AI keys are protected" subtitle="So nobody can use someone else's key">
        <ul className="space-y-3 text-[13px] leading-relaxed">
          {[
            "Each person pastes their own API key. It is encrypted (XChaCha20-Poly1305) with a key derived from their password (Argon2id).",
            "There is no master key. Administrators can't read or use anyone's key — not even with a copy of the profile database.",
            "Keys are only decrypted in memory while their owner is signed in, and only sent to that provider over HTTPS.",
            "Resetting someone's password erases their saved key. Disabling a profile or turning AI off blocks all use immediately.",
            "Requests go straight from the person's PC to the provider they chose — never through any other server.",
          ].map((t) => <li key={t} className="flex gap-2.5"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--color-ok)]" />{t}</li>)}
        </ul>
      </Section>
    </div>
  );
}

function TeamFolder({ state }: { state: AppState }) {
  const [folder, setFolder] = useState<string>("");
  const [current, setCurrent] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => { api<{ team_folder?: string | null }>("index.status").then((s) => { setCurrent(s.team_folder ?? null); setFolder(s.team_folder ?? ""); }); }, []);
  const save = async (pick: boolean) => {
    try {
      const r = await api<{ team_folder?: string | null; cancelled?: boolean }>("admin.team_folder", pick ? { pick: true } : { path: folder });
      if (!r.cancelled) { setCurrent(r.team_folder ?? null); setFolder(r.team_folder ?? ""); toast("ok", "Saved. Restart TracePoint to switch to the team folder."); }
    } catch (e) { toast("error", (e as Error).message); }
  };
  return (
    <Section title="Team folder" subtitle="A shared folder (outside THOR's indexed roots) where TracePoint keeps the team's profiles and the published index.">
      <div className="space-y-4 text-[13.5px]">
        <div className="grid grid-cols-3 gap-3">
          {[["Profiles", "TracePoint_Profiles.db — one sign-in list for everyone"], ["Published index", "index\\thor_knowledge.db — every PC picks up the newest"], ["Safe by design", "Must be outside THOR's indexed roots; TracePoint refuses otherwise"]].map(([t, d]) => (
            <div key={t} className="rounded-xl bg-[var(--color-surface-2)] p-3"><div className="font-semibold">{t}</div><div className="mt-0.5 text-[12.5px] text-[var(--color-text-muted)]">{d}</div></div>
          ))}
        </div>
        <Field label="Folder" hint={`Currently: ${current ?? "not set — using this PC only"} · Profiles file: ${state.profiles_location}`}>
          <div className="flex gap-2">
            <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="\\THOR\Engineering Dept\Mechanical Integrity\TracePoint" className="font-mono" />
            <Button onClick={() => save(true)}>Browse…</Button>
            <Button variant="primary" onClick={() => save(false)}>Save</Button>
          </div>
        </Field>
      </div>
    </Section>
  );
}

function AuditLog() {
  const [rows, setRows] = useState<Audit[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => { api<Audit[]>("admin.audit").then(setRows); }, []);
  const list = (rows ?? []).filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase()));
  const color = (a: string) => (a.includes("fail") || a.includes("denied") || a.includes("delete") || a.includes("reset") ? "var(--color-bad)" : a.includes("login") ? "var(--color-ok)" : a.includes("policy") || a.includes("user_") ? "var(--color-accent)" : "var(--color-text-muted)");
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <div className="w-80"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter the log…" icon={<Search className="size-4" />} /></div>
        <div className="ml-auto text-[12.5px] text-[var(--color-text-faint)]">Last 500 events · sign-ins, profile and policy changes, key saves (never key contents)</div>
      </div>
      <div className="max-h-[62vh] overflow-y-auto">
        {list.map((r, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-[var(--color-border)] px-4 py-2.5 text-[13px] last:border-0">
            <span className="w-40 shrink-0 text-[12px] tabular-nums text-[var(--color-text-faint)]">{new Date(r.at).toLocaleString()}</span>
            <span className="w-36 shrink-0"><Pill color={color(r.action)}>{r.action.replace(/_/g, " ")}</Pill></span>
            <span className="w-56 shrink-0 truncate">{r.actor ?? "system"}</span>
            <span className="flex-1 truncate text-[var(--color-text-muted)]">{r.detail}</span>
            <span className="shrink-0 text-[11.5px] text-[var(--color-text-faint)]">{r.machine}</span>
          </div>
        ))}
        {rows && list.length === 0 && <Empty title="Nothing logged yet" />}
      </div>
    </div>
  );
}
