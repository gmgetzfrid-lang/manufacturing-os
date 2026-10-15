import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Bot, Brain, Check, CheckCircle2, Eye, EyeOff, KeyRound, Loader2, Lock, ShieldCheck, Sparkles, Trash2, UserRound } from "lucide-react";
import { api } from "../lib/api";
import type { AppState } from "../lib/types";
import { Avatar, Button, Field, Input, Pill, Section, Segmented, cx, useToast } from "../components/ui";
import { PasswordMeter } from "../screens/ChangePassword";
import { initials, when } from "../lib/format";

interface ProviderInfo { id: string; name: string; company: string; key_prefix: string; key_url: string; key_help: string; host: string; recommended_model: string }
interface Level { id: string; label: string; hint: string }
interface ModelInfo { id: string; name: string; context?: number | null; max_output?: number | null; reasoning: Level[]; default_reasoning?: string | null; recommended: boolean; vision: boolean }
interface AiConfig { provider?: string | null; model?: string | null; reasoning?: string | null; key_mask?: string | null; has_key: boolean; can_ai: boolean }

export function ProfilePage({ state, setState, refresh }: { state: AppState; setState: (s: AppState) => void; refresh: () => void }) {
  const tab = (new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("tab") ?? "account") as "account" | "ai";
  const go = (t: string) => (window.location.hash = `/profile?tab=${t}`);
  const u = state.user!;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[980px] px-8 py-7">
        <div className="flex items-center gap-4">
          <Avatar text={initials(u.name, u.email)} size={56} />
          <div className="flex-1">
            <h1 className="text-[22px] font-[700] tracking-tight">{u.name || u.email}</h1>
            <div className="text-[13px] text-[var(--color-text-muted)]">{u.email} · <span className="capitalize">{u.role}</span> · last sign-in {when(u.last_login_at)}</div>
          </div>
          <Segmented value={tab} onChange={go} options={[{ value: "account", label: <><UserRound className="size-3.5" />Account</> }, { value: "ai", label: <><Bot className="size-3.5" />AI assistant</> }]} />
        </div>
        <div className="mt-6">{tab === "account" ? <Account state={state} setState={setState} /> : <AiSetup state={state} refresh={refresh} />}</div>
      </div>
    </div>
  );
}

function Account({ state, setState }: { state: AppState; setState: (s: AppState) => void }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [conf, setConf] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const [openMode, setOpenMode] = useState(state.prefs.open_mode ?? "copy");
  const save = async () => {
    setBusy(true);
    try { setState(await api<AppState>("auth.change_password", { current: cur, new: next })); setCur(""); setNext(""); setConf(""); toast("ok", "Password changed. Your AI key stays protected under the new one."); } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };
  const setMode = async (m: string) => { setOpenMode(m); await api("auth.set_pref", { key: "open_mode", value: m }); toast("ok", "Saved"); };
  return (
    <div className="grid grid-cols-2 gap-6">
      <Section title="Change password" subtitle="Also re-locks your saved AI key under the new password">
        <div className="space-y-3.5">
          <Field label="Current password"><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
          <Field label="New password"><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} />{next && <PasswordMeter pw={next} />}</Field>
          <Field label="Confirm" error={conf && conf !== next ? "Passwords don't match." : null}><Input type="password" value={conf} onChange={(e) => setConf(e.target.value)} /></Field>
          <Button variant="primary" loading={busy} disabled={!cur || !next || conf !== next} onClick={save}>Change password</Button>
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
    try { await api("ai.save", { provider: provider.id, model: model.id, reasoning, key: key || undefined }); toast("ok", "AI assistant ready. Your key is encrypted with your password."); setKey(""); setEditing(false); setStep(0); load(); refresh(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const removeKey = async () => {
    if (!confirm("Remove your saved API key from TracePoint?")) return;
    await api("ai.delete"); toast("ok", "Key removed"); load();
  };

  if (!state.policy.ai_enabled) return <Notice title="AI is turned off for this team" text="Your administrator has turned off AI features. Search, graph, preview and export work without it." />;
  if (cfg && !cfg.can_ai) return <Notice title="AI isn't enabled for your profile" text="Ask an administrator to enable AI for you under Admin › Profiles." />;
  if (!cfg) return <div className="skeleton h-40" />;

  if (!editing && cfg.provider) {
    const p = providers.find((x) => x.id === cfg.provider);
    return (
      <div className="grid grid-cols-[1fr_340px] gap-6">
        <Section title="Your AI assistant" subtitle="Used by Ask THOR to read documents and answer questions with citations">
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
              <div className="mt-4 flex items-start gap-2 rounded-xl bg-[var(--color-surface-2)] p-3 text-[12.5px] text-[var(--color-text-muted)]"><Lock className="mt-0.5 size-4 shrink-0 text-[var(--color-ok)]" />The key is checked with {provider.host} now, and only saved — encrypted with your password — when you finish.</div>
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
                  <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">Deeper reasoning gives more careful answers on hard engineering questions, but is slower and costs more.</p>
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

function Summary({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="rounded-xl bg-[var(--color-surface-2)] p-3"><div className="text-[11.5px] text-[var(--color-text-faint)]">{label}</div><div className={cx("mt-0.5 truncate font-semibold", mono && "font-mono text-[12.5px]")}>{value}</div></div>;
}

function KeySafety() {
  const points = useMemo(() => [
    "Only you can use your key. It's encrypted with your password — administrators can't read it.",
    "It's sent only to the provider you chose, over HTTPS, straight from this PC.",
    "Change your password and the key stays protected. If an administrator resets your password, the key is erased.",
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
