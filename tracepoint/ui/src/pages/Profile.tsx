import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Bot, Brain, Check, CheckCircle2, Eye, EyeOff, KeyRound, Loader2, Lock, ShieldCheck, Sparkles, Trash2, UserRound } from "lucide-react";
import { api } from "../lib/api";
import type { AppState } from "../lib/types";
import { Avatar, Button, Field, Input, Pill, Section, Segmented, cx, useToast } from "../components/ui";
import { initials, when } from "../lib/format";

interface ProviderInfo { id: string; name: string; company: string; key_prefix: string; key_url: string; key_help: string; host: string; recommended_model: string }
interface Level { id: string; label: string; hint: string }
interface ModelInfo { id: string; name: string; context?: number | null; max_output?: number | null; reasoning: Level[]; default_reasoning?: string | null; recommended: boolean; vision: boolean; price?: { input: number; output: number; basis: string; note?: string | null; per_question: number } }

const money = (x: number) => (x < 0.01 && x > 0 ? `${(x * 100).toFixed(2)}¢` : x < 1 ? `${(x * 100).toFixed(1)}¢` : `$${x.toFixed(2)}`);
interface AiConfig { provider?: string | null; model?: string | null; reasoning?: string | null; key_mask?: string | null; has_key: boolean; can_ai: boolean }

export function ProfilePage({ state, setState, refresh }: { state: AppState; setState: (s: AppState) => void; refresh: () => void }) {
  const isAdmin = state.user?.role === "admin";
  const asked = (new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("tab") ?? "account") as "account" | "ai";
  const tab = isAdmin ? asked : "account";
  const go = (t: string) => (window.location.hash = `/profile?tab=${t}`);
  const u = state.user!;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[980px] px-8 py-7">
        <div className="flex items-center gap-4">
          <Avatar text={initials(u.name, "")} size={56} />
          <div className="flex-1">
            <h1 className="text-[22px] font-[700] tracking-tight">{u.name}</h1>
            <div className="text-[13px] text-[var(--color-text-muted)]">{u.account} · <span className="capitalize">{u.role}</span> · signed in with Windows</div>
          </div>
          {isAdmin && <Segmented value={tab} onChange={go} options={[{ value: "account", label: <><UserRound className="size-3.5" />Account</> }, { value: "ai", label: <><Bot className="size-3.5" />AI assistant</> }]} />}
        </div>
        <div className="mt-6">{tab === "account" ? <Account state={state} setState={setState} /> : <AiSetup state={state} refresh={refresh} />}</div>
      </div>
    </div>
  );
}

function Account({ state }: { state: AppState; setState: (s: AppState) => void }) {
  const toast = useToast();
  const [openMode, setOpenMode] = useState(state.prefs.open_mode ?? "copy");
  const setMode = async (m: string) => { setOpenMode(m); await api("auth.set_pref", { key: "open_mode", value: m }); toast("ok", "Saved"); };
  const u = state.user!;
  return (
    <div className="grid grid-cols-2 gap-6">
      <Section title="Your account" subtitle="TracePoint has no passwords of its own">
        <div className="space-y-3 text-[13px] leading-relaxed">
          <div className="rounded-xl bg-[var(--color-surface-2)] p-3"><div className="font-mono text-[13px]">{u.account}</div><div className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">You're signed in as the Windows account that started TracePoint.</div></div>
          <p className="flex gap-2.5"><Lock className="mt-0.5 size-4 shrink-0 text-[var(--color-ok)]" />You only ever see THOR files and folders your Windows account can open. If something is missing that you should see, ask IT for access to that folder.</p>
        </div>
      </Section>
      <Section title="Opening files" subtitle="How Open behaves for files on THOR">
        <div className="space-y-2">
          {[
            { id: "copy", t: "Read-only copy (recommended)", d: "Opens a temporary copy marked read-only. Nothing you do can change the file on THOR." },
            { id: "original", t: "The original on THOR", d: "Opens the actual file. Programs like Word or Excel could save changes back to THOR." },
          ].map((o) => (
            <button key={o.id} onClick={() => setMode(o.id)} className={cx("flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition cursor-pointer", openMode === o.id ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]")}>
              <span className={cx("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2", openMode === o.id ? "border-[var(--color-accent)]" : "border-[var(--color-border-strong)]")}>{openMode === o.id && <span className="size-2 rounded-full bg-[var(--color-accent)]" />}</span>
              <span><span className="block text-[13.5px] font-semibold">{o.t}</span><span className="block text-[12.5px] text-[var(--color-text-muted)]">{o.d}</span></span>
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}

const STEPS = ["Provider", "API key", "Model", "Reasoning", "Test & save"];

function AiSetup({ state, refresh }: { state: AppState; refresh: () => void }) {
  const toast = useToast();
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [reasoning, setReasoning] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [test, setTest] = useState<{ reply: string; ms: number; reasoning_used?: string | null } | null>(null);
  const [mq, setMq] = useState("");
  const load = () => api<AiConfig>("ai.get").then((c) => { setCfg(c); if (!c.provider) setEditing(true); });
  useEffect(() => { load(); api<ProviderInfo[]>("ai.providers").then(setProviders); }, []);
  const allowed = providers.filter((p) => state.policy.ai_providers.includes(p.id));
  const keyFromSaved = !key && cfg?.has_key && cfg.provider === provider?.id;

  const checkKey = async () => {
    if (!provider) return;
    setBusy(true); setErr(null);
    try {
      const list = await api<ModelInfo[]>("ai.models", { provider: provider.id, key: key || undefined });
      setModels(list);
      const rec = list.find((m) => m.recommended) ?? list.find((m) => m.id === cfg?.model) ?? list[0];
      setModel(rec ?? null);
      setReasoning(rec?.default_reasoning ?? "");
      setStep(2);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const runTest = async () => {
    if (!provider || !model) return;
    setBusy(true); setErr(null); setTest(null);
    try { setTest(await api("ai.test", { provider: provider.id, model: model.id, reasoning, key: key || undefined })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!provider || !model) return;
    setBusy(true);
    try { await api("ai.save", { provider: provider.id, model: model.id, reasoning, key: key || undefined }); toast("ok", "AI ready. Windows encrypted your key for your account on this PC."); setKey(""); setEditing(false); setStep(0); load(); refresh(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const removeKey = async () => {
    if (!confirm("Remove your saved API key from TracePoint?")) return;
    await api("ai.delete"); toast("ok", "Key removed"); load();
  };

  if (!state.policy.ai_enabled) return <Notice title="AI is turned off for this team" text="Your administrator has turned off AI features. Search, graph, preview and export work without it." />;
  if (state.policy.ai_blocked_by_it) return <Notice title="AI is switched off on this PC" text="Your IT department turned AI off (DisableAI policy). Everything else in TracePoint works without it." />;
  if (cfg && !cfg.can_ai) return <Notice title="AI isn't enabled for your account" text="Ask another administrator to turn AI on for you under Admin › Roles." />;
  if (!cfg) return <div className="skeleton h-40" />;

  if (!editing && cfg.provider) {
    const p = providers.find((x) => x.id === cfg.provider);
    return (
      <div className="grid grid-cols-[1fr_340px] gap-6">
        <Section title="AI for reading scanned pages" subtitle="Used only when you approve reading pages free OCR couldn't read (Sources › Document contents)">
          <div className="flex items-center gap-4 rounded-2xl bg-[var(--color-surface-2)] p-5">
            <div className="flex size-12 items-center justify-center rounded-2xl text-white shadow-md" style={{ background: "var(--brand-gradient)" }}><Sparkles className="size-6" /></div>
            <div className="flex-1">
              <div className="text-[16px] font-semibold">{p?.name ?? cfg.provider} · <span className="font-mono text-[14px]">{cfg.model}</span></div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Pill color="var(--color-ok)"><CheckCircle2 className="size-3" />Key saved {cfg.key_mask}</Pill>
                {cfg.reasoning ? <Pill color="var(--color-violet)"><Brain className="size-3" />Reasoning: {cfg.reasoning}</Pill> : <Pill color="var(--color-text-muted)">Standard reasoning</Pill>}
              </div>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button variant="primary" onClick={() => { setEditing(true); setStep(0); setProvider(providers.find((x) => x.id === cfg.provider) ?? null); }}>Change setup</Button>
            <Button icon={<Trash2 className="size-4" />} onClick={removeKey}>Remove key</Button>
          </div>
        </Section>
        <KeySafety />
        <div className="col-span-2"><Spending /></div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[1fr_320px] gap-6">
      <div className="card overflow-hidden">
        {/* Stepper */}
        <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-5 py-4">
          {STEPS.map((s, i) => (
            <div key={s} className="flex flex-1 items-center gap-2">
              <span className={cx("flex size-6 shrink-0 items-center justify-center rounded-full text-[11.5px] font-semibold transition", i < step ? "bg-[var(--color-ok)] text-white" : i === step ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "bg-[var(--color-surface-3)] text-[var(--color-text-faint)]")}>{i < step ? <Check className="size-3.5" /> : i + 1}</span>
              <span className={cx("text-[12.5px] font-medium", i === step ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)]")}>{s}</span>
              {i < STEPS.length - 1 && <span className="mx-1 h-px flex-1 bg-[var(--color-border)]" />}
            </div>
          ))}
        </div>
        <div className="min-h-[380px] p-6">
          {step === 0 && (
            <div className="animate-[var(--animate-rise)]">
              <h3 className="text-[17px] font-semibold">Which AI company do you have an account with?</h3>
              <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">You'll use your own API key. Charges from the provider go to that account.</p>
              <div className="mt-5 grid grid-cols-3 gap-3">
                {allowed.map((p) => (
                  <button key={p.id} onClick={() => { setProvider(p); setModels(null); setModel(null); setErr(null); }} className={cx("rounded-2xl border p-4 text-left transition hover-lift cursor-pointer", provider?.id === p.id ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] ring-2 ring-[color-mix(in_srgb,var(--color-accent)_25%,transparent)]" : "border-[var(--color-border)]")}>
                    <div className="text-[15px] font-semibold">{p.name}</div>
                    <div className="text-[12.5px] text-[var(--color-text-muted)]">by {p.company}</div>
                    {p.id === "anthropic" && <Pill color="var(--color-ok)" className="mt-2">Recommended</Pill>}
                  </button>
                ))}
              </div>
              {allowed.length === 0 && <div className="mt-4 text-[13px] text-[var(--color-text-muted)]">Your administrator hasn't allowed any AI providers.</div>}
            </div>
          )}
          {step === 1 && provider && (
            <div className="animate-[var(--animate-rise)]">
              <h3 className="text-[17px] font-semibold">Paste your {provider.company} API key</h3>
              <ol className="mt-3 space-y-1.5 text-[13px] text-[var(--color-text-muted)]">
                {provider.key_help.split(/(?<=\.)\s+/).map((s, i) => <li key={i} className="flex gap-2"><span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-3)] text-[11px] font-semibold">{i + 1}</span>{s}</li>)}
              </ol>
              <div className="mt-2 font-mono text-[12px] text-[var(--color-text-faint)]">{provider.key_url}</div>
              <div className="mt-5 flex gap-2">
                <div className="flex-1"><Input type={show ? "text" : "password"} value={key} onChange={(e) => { setKey(e.target.value); setErr(null); }} placeholder={keyFromSaved ? `Using your saved key ${cfg.key_mask} — paste a new one to replace it` : `${provider.key_prefix}…`} className="font-mono" icon={<KeyRound className="size-4" />} autoFocus /></div>
                <Button onClick={() => setShow(!show)} icon={show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}>{show ? "Hide" : "Show"}</Button>
              </div>
              {key && !key.trim().startsWith(provider.key_prefix) && <div className="mt-2 text-[12.5px] text-[var(--color-warn)]">{provider.company} keys usually start with “{provider.key_prefix}”. Check you copied the whole key.</div>}
              <div className="mt-4 flex items-start gap-2 rounded-xl bg-[var(--color-surface-2)] p-3 text-[12.5px] text-[var(--color-text-muted)]"><Lock className="mt-0.5 size-4 shrink-0 text-[var(--color-ok)]" />The key is checked with {provider.host} now, and only saved — encrypted by Windows for your account, on this PC — when you finish.</div>
            </div>
          )}
          {step === 2 && models && (
            <div className="animate-[var(--animate-rise)]">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <h3 className="text-[17px] font-semibold">Choose a model</h3>
                  <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">These are the models your key can use right now ({models.length}).</p>
                </div>
                <div className="w-56"><Input value={mq} onChange={(e) => setMq(e.target.value)} placeholder="Filter models…" /></div>
              </div>
              <div className="mt-4 max-h-[330px] space-y-1.5 overflow-y-auto pr-1">
                {models.filter((m) => !mq || m.id.includes(mq.toLowerCase()) || m.name.toLowerCase().includes(mq.toLowerCase())).map((m) => (
                  <button key={m.id} onClick={() => { setModel(m); setReasoning(m.default_reasoning ?? ""); }} className={cx("flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition cursor-pointer", model?.id === m.id ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]")}>
                    <span className={cx("flex size-4 shrink-0 items-center justify-center rounded-full border-2", model?.id === m.id ? "border-[var(--color-accent)]" : "border-[var(--color-border-strong)]")}>{model?.id === m.id && <span className="size-2 rounded-full bg-[var(--color-accent)]" />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] font-semibold">{m.name}</span>
                      <span className="block font-mono text-[11.5px] text-[var(--color-text-faint)]">{m.id}</span>
                    </span>
                    {m.recommended && <Pill color="var(--color-ok)">Recommended</Pill>}
                    {m.reasoning.length > 0 && <Pill color="var(--color-violet)"><Brain className="size-3" />Reasoning</Pill>}
                    {m.context && <span className="text-[11.5px] text-[var(--color-text-faint)]">{m.context >= 1e6 ? `${m.context / 1e6}M` : `${Math.round(m.context / 1000)}K`} context</span>}
                    {m.price && <span className="w-[120px] shrink-0 text-right" title={`$${m.price.input} in / $${m.price.output} out per million tokens${m.price.note ? " — " + m.price.note : ""}`}><span className={cx("block text-[13px] font-semibold", m.price.basis === "unlisted" && "text-[var(--color-warn)]")}>≈ {money(m.price.per_question)} / request</span><span className="block text-[11px] text-[var(--color-text-faint)]">${m.price.input} / ${m.price.output} per M</span></span>}
                  </button>
                ))}
              </div>
            </div>
          )}
          {step === 3 && model && (
            <div className="animate-[var(--animate-rise)]">
              <h3 className="text-[17px] font-semibold">How hard should it think?</h3>
              {model.reasoning.length === 0 ? (
                <p className="mt-2 text-[13.5px] text-[var(--color-text-muted)]">{model.name} doesn't offer adjustable reasoning. Continue to test it.</p>
              ) : (
                <>
                  <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">Page reading uses each provider's cheapest vision model; this setting only affects the key test.</p>
                  <div className="mt-5 grid grid-cols-2 gap-2.5">
                    {model.reasoning.map((l) => (
                      <button key={l.id} onClick={() => setReasoning(l.id)} className={cx("rounded-xl border p-3.5 text-left transition cursor-pointer", reasoning === l.id ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]")}>
                        <div className="flex items-center gap-2 text-[14px] font-semibold">{l.label}{model.default_reasoning === l.id && <Pill color="var(--color-text-muted)">Default</Pill>}</div>
                        <div className="mt-0.5 text-[12.5px] text-[var(--color-text-muted)]">{l.hint}</div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          {step === 4 && model && provider && (
            <div className="animate-[var(--animate-rise)]">
              <h3 className="text-[17px] font-semibold">Test the connection</h3>
              <div className="mt-4 grid grid-cols-3 gap-3 text-[13px]">
                <Summary label="Provider" value={provider.name} />
                <Summary label="Model" value={model.id} mono />
                <Summary label="Reasoning" value={model.reasoning.find((l) => l.id === reasoning)?.label ?? "Standard"} />
              </div>
              <Button className="mt-5" loading={busy} onClick={runTest} icon={<Sparkles className="size-4" />}>Send a test message</Button>
              {test && (
                <div className="mt-4 rounded-xl border border-[color-mix(in_srgb,var(--color-ok)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-ok)_7%,transparent)] p-4 text-[13.5px] animate-[var(--animate-pop)]">
                  <div className="flex items-center gap-2 font-semibold text-[var(--color-ok)]"><CheckCircle2 className="size-4" /> Connected in {(test.ms / 1000).toFixed(1)} s</div>
                  <div className="mt-1.5 text-[var(--color-text-muted)]">Reply: “{test.reply.trim()}”</div>
                  {reasoning && !test.reasoning_used && <div className="mt-1.5 text-[12.5px] text-[var(--color-warn)]">This model didn't accept a reasoning level, so it will use its standard setting.</div>}
                </div>
              )}
            </div>
          )}
          {err && <div className="mt-4 rounded-xl bg-[color-mix(in_srgb,var(--color-bad)_8%,transparent)] px-4 py-3 text-[13px] text-[var(--color-bad)]">{err}</div>}
        </div>
        <div className="flex items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-5 py-3">
          <Button variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={() => (step === 0 ? cfg.provider && setEditing(false) : setStep(step - 1))} disabled={step === 0 && !cfg.provider}>{step === 0 ? "Cancel" : "Back"}</Button>
          {step === 0 && <Button variant="primary" disabled={!provider} onClick={() => setStep(1)}>Continue <ArrowRight className="size-4" /></Button>}
          {step === 1 && <Button variant="primary" loading={busy} disabled={!key.trim() && !keyFromSaved} onClick={checkKey}>{busy ? "Checking key…" : "Check key"} {!busy && <ArrowRight className="size-4" />}</Button>}
          {step === 2 && <Button variant="primary" disabled={!model} onClick={() => setStep(3)}>Continue <ArrowRight className="size-4" /></Button>}
          {step === 3 && <Button variant="primary" onClick={() => setStep(4)}>Continue <ArrowRight className="size-4" /></Button>}
          {step === 4 && <Button variant="primary" loading={busy} disabled={!test} onClick={save} icon={busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}>Save securely</Button>}
        </div>
      </div>
      <KeySafety />
    </div>
  );
}

interface BudgetInfo {
  budget_usd: number; max_request_usd: number; month: string;
  spent_usd: number; held_usd: number; calls: number;
  current?: { provider: string; model: string; price: { input: number; output: number }; basis: string; note?: string | null; per_question: number } | null;
  upcoming: { provider: string; model: string; from: string; input: number; output: number }[];
  prices_checked: string; sources: string[];
  rows: { at: string; account?: string | null; feature: string; model?: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; reserved_usd: number; cost_usd: number; status: string; note?: string | null }[];
}

/** Monthly AI budget, how it's enforced, and every call's cost. */
function Spending() {
  const [b, setB] = useState<BudgetInfo | null>(null);
  const [edit, setEdit] = useState<{ budget: string; max: string } | null>(null);
  const toast = useToast();
  const load = () => api<BudgetInfo>("ai.budget").then((x) => { setB(x); setEdit({ budget: String(x.budget_usd), max: String(x.max_request_usd) }); }).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!b || !edit) return null;
  const save = async () => {
    try {
      await api("ai.budget.set", { ai_budget_usd: Number(edit.budget), ai_max_request_usd: Number(edit.max) });
      toast("ok", "Spending limits saved"); load();
    } catch (e) { toast("error", (e as Error).message); }
  };
  const monthName = new Date(`${b.month}-01T12:00:00`).toLocaleString(undefined, { month: "long", year: "numeric" });
  const Bar = ({ label, spent, cap }: { label: string; spent: number; cap: number }) => {
    const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 100;
    return (
      <div>
        <div className="flex items-baseline justify-between"><span className="text-[14px] font-semibold">{label}</span><span className="text-[14px]"><b className="tabular-nums">${spent.toFixed(2)}</b> <span className="text-[var(--color-text-muted)]">of ${cap.toFixed(2)}</span></span></div>
        <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-[var(--color-surface-3)]"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct > 90 ? "var(--color-bad)" : pct > 70 ? "var(--color-warn)" : "var(--color-ok)" }} /></div>
        <div className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">${Math.max(0, cap - spent).toFixed(2)} left this month</div>
      </div>
    );
  };
  return (
    <Section title={`AI spending · ${monthName}`} subtitle="One budget for the whole team, shared by all administrators. Resets on the 1st of each month.">
      <div className="grid grid-cols-[1.2fr_1fr] gap-8">
        <div className="space-y-5">
          <Bar label="AI reading of scanned pages" spent={b.spent_usd} cap={b.budget_usd} />
          {b.held_usd > 0 && <div className="text-[13px] text-[var(--color-text-muted)]">${b.held_usd.toFixed(2)} on hold for requests in progress.</div>}
          <div className="grid grid-cols-2 gap-3 rounded-xl bg-[var(--color-surface-2)] p-4">
            <Field label="Monthly budget ($)"><Input type="number" min={0} step={1} value={edit.budget} onChange={(e) => setEdit({ ...edit, budget: e.target.value })} /></Field>
            <Field label="Most per request ($)"><Input type="number" min={0.01} step={0.05} value={edit.max} onChange={(e) => setEdit({ ...edit, max: e.target.value })} /></Field>
            <div className="col-span-2 flex justify-end"><Button variant="primary" size="sm" onClick={save}>Save limits</Button></div>
          </div>
          {b.current && (
            <div className="text-[13.5px]">
              <b>{b.current.model}</b>: ${b.current.price.input} per million tokens in, ${b.current.price.output} out — about <b>{money(b.current.per_question)}</b> per 6,000-token request.
              {b.current.note && <div className="mt-1 text-[var(--color-warn)]">{b.current.note}</div>}
            </div>
          )}
          {b.upcoming.length > 0 && <div className="text-[12.5px] text-[var(--color-text-muted)]">Announced price changes: {b.upcoming.map((u) => `${u.model} → $${u.input}/$${u.output} from ${u.from}`).join(" · ")} (applied automatically).</div>}
        </div>
        <div className="rounded-xl border border-[var(--color-border)] p-4">
          <div className="text-[14.5px] font-bold">How your cap works</div>
          <ol className="mt-2 list-decimal space-y-2 pl-5 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            <li><b className="text-[var(--color-text)]">Before every AI request</b>, TracePoint works out the most it could cost: the size of what it sends plus the longest answer allowed, at the model's published price.</li>
            <li>If that worst case is more than <b className="text-[var(--color-text)]">what's left of the team's budget this month</b> or more than the <b className="text-[var(--color-text)]">per-request limit</b>, the request is not sent and you're told why.</li>
            <li>Otherwise that amount is <b className="text-[var(--color-text)]">held</b> while the request runs, then replaced by the <b className="text-[var(--color-text)]">real cost</b> from the provider's usage report.</li>
            <li>A model with no published price is counted at its provider's highest price, so the cap is never under-estimated.</li>
          </ol>
          <div className="mt-3 rounded-lg bg-[color-mix(in_srgb,var(--color-warn)_10%,transparent)] p-2.5 text-[12.5px] text-[var(--color-text)]">Also set a monthly spending limit in your provider's billing settings — it protects you even outside TracePoint.</div>
          <div className="mt-2 text-[11.5px] text-[var(--color-text-faint)]">Prices checked {b.prices_checked} from the providers' pricing pages.</div>
        </div>
      </div>
      {b.rows.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 text-[14px] font-bold">Recent AI requests · {b.calls} this month</div>
          <div className="max-h-[320px] overflow-y-auto rounded-xl border border-[var(--color-border)]">
            <table className="w-full text-[12.5px]">
              <thead className="sticky top-0 bg-[var(--color-surface-2)] text-left text-[11.5px] uppercase tracking-wide text-[var(--color-text-faint)]">
                <tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Who</th><th className="px-3 py-2">For</th><th className="px-3 py-2">Model</th><th className="px-3 py-2 text-right">Tokens in / out</th><th className="px-3 py-2 text-right">Held</th><th className="px-3 py-2 text-right">Cost</th><th className="px-3 py-2">Status</th></tr>
              </thead>
              <tbody>
                {b.rows.map((r, i) => (
                  <tr key={i} className="border-t border-[var(--color-border)]" title={r.note ?? ""}>
                    <td className="px-3 py-1.5 whitespace-nowrap">{when(r.at)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{r.account ?? ""}</td>
                    <td className="px-3 py-1.5">{({ index: "Page reading", test: "Key test" } as Record<string, string>)[r.feature] ?? r.feature}</td>
                    <td className="px-3 py-1.5 font-mono text-[11.5px]">{r.model}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.input_tokens.toLocaleString()}{r.cache_read_tokens ? ` (+${r.cache_read_tokens.toLocaleString()} cached)` : ""} / {r.output_tokens.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[var(--color-text-faint)]">${r.reserved_usd.toFixed(4)}</td>
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums">${r.cost_usd.toFixed(4)}</td>
                    <td className="px-3 py-1.5">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Section>
  );
}

function Summary({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="rounded-xl bg-[var(--color-surface-2)] p-3"><div className="text-[11.5px] text-[var(--color-text-faint)]">{label}</div><div className={cx("mt-0.5 truncate font-semibold", mono && "font-mono text-[12.5px]")}>{value}</div></div>;
}

function KeySafety() {
  const points = useMemo(() => [
    "Windows encrypts your key for your account on this PC (DPAPI). Nobody else — and no other PC — can decrypt it.",
    "It never goes to the shared folder. It's sent only to the provider you chose, over HTTPS, straight from this PC.",
    "AI only reads pages you approve, within the team's monthly budget.",
    "TracePoint works fully without AI — search, graph and preview never need it.",
  ], []);
  return (
    <div className="card h-fit p-5">
      <div className="flex items-center gap-2 text-[14px] font-semibold"><ShieldCheck className="size-4 text-[var(--color-ok)]" /> Your key stays yours</div>
      <ul className="mt-3 space-y-3 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">{points.map((p) => <li key={p} className="flex gap-2"><Check className="mt-0.5 size-3.5 shrink-0 text-[var(--color-ok)]" />{p}</li>)}</ul>
    </div>
  );
}

function Notice({ title, text }: { title: string; text: string }) {
  return <div className="card flex items-start gap-3 p-5"><Bot className="size-5 text-[var(--color-text-muted)]" /><div><div className="font-semibold">{title}</div><div className="mt-0.5 text-[13px] text-[var(--color-text-muted)]">{text}</div></div></div>;
}
