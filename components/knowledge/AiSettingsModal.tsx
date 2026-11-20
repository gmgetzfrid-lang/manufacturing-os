"use client";

// AI settings — PER-USER keys only. Every member brings their own API key,
// spends their own money, and is metered against their own monthly cap.
// There is no workspace key: one person's key never pays for another's
// questions, and removing someone's key affects only them.
//
// Keys are write-only: the server stores them and hands back only the last
// 4, so this modal can prove a key exists without ever holding one.
// Claude and OpenAI are the ONLY providers — nothing that can train on
// submitted data is offered, and the server refuses it anyway.

import React, { useEffect, useState } from "react";
import {
  Loader2, Plug, CheckCircle2, AlertTriangle, Trash2, KeyRound, Users, Sparkles, Cpu, Gauge,
} from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
import { appConfirm } from "@/components/providers/DialogProvider";
import { Button } from "@/components/ui/Button";
import { Modal, ModalHeader, ModalBody } from "@/components/ui/Modal";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { Input, Select } from "@/components/ui/Field";
import {
  getAiConnections, saveAiConnection, testAiConnection, removeAiConnection,
  saveEmbeddingKey, removeEmbeddingKey, testEmbeddingKey,
  getAiUsage, setAiCap, saveJobModels,
  type AiConnectionInfo, type AiUsageSummary,
} from "@/lib/knowledge";
import type { AiProviderId } from "@/lib/ai/providerCall";
import {
  AI_JOBS, MAIN, jobDefault, modelName, costPerUse, fmtCost,
  type AiJob, type JobModels,
} from "@/lib/ai/jobModels";
import { ALLOWED_PROVIDERS, PROVIDER_BLOCK_MESSAGE } from "@/lib/ai/pricing";
import { EMBEDDING_PROVIDERS, defaultEmbeddingModel } from "@/lib/ai/embeddings";

// The complete provider offering — Claude and OpenAI, nothing else, ever.
const PROVIDERS = [
  { id: "anthropic", label: "Anthropic (Claude)", models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] },
  { id: "openai", label: "OpenAI", models: ["gpt-5.1", "gpt-4o", "gpt-4o-mini"] },
];

const providerAllowed = (p: string) => (ALLOWED_PROVIDERS as readonly string[]).includes(p);

// What each offered model is for, in the picker.
const MODEL_BLURB: Record<string, string> = {
  "claude-opus-5-5": "most capable",
  "claude-sonnet-5-5": "balanced - about half the cost",
  "claude-haiku-5-5": "fastest, lowest cost",
  "gpt-5.1": "most capable",
  "gpt-4o": "balanced",
  "gpt-4o-mini": "fastest, lowest cost",
};
const modelLabel = (m: string, offered: string[]) =>
  `${modelName(m)}${MODEL_BLURB[m] ? ` - ${MODEL_BLURB[m]}` : offered.includes(m) ? "" : " - older model, your current setting"}`;

// Persistent inline status line — toasts vanish; this stays until the next
// action, so "did that work?" always has a visible answer.
function Notice({ notice }: { notice: { tone: "ok" | "err"; text: string } | null }) {
  if (!notice) return null;
  return (
    <p className={`relative pl-4 py-0.5 text-[14px] font-semibold flex items-start gap-1.5 ${
      notice.tone === "ok" ? "text-[var(--color-text)]" : "text-[var(--state-overdue)]"}`}>
      <span aria-hidden className={`absolute left-0 inset-y-0 w-[3px] rounded-full ${notice.tone === "ok" ? "bg-[var(--state-released)]" : "bg-[var(--state-overdue)]"}`} />
      {notice.tone === "ok"
        ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-[var(--state-released)]" />
        : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
      <span>{notice.text}</span>
    </p>
  );
}

/** A status as a soft pill: green active, amber missing. */
const StateTag = ({ tone, children }: { tone: "good" | "warn"; children: React.ReactNode }) => (
  <span className={`ui-pill ${tone === "good" ? "is-good" : "is-warn"}`}>
    {tone === "good" ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> : <AlertTriangle className="w-3.5 h-3.5" aria-hidden />}{children}
  </span>
);

/** One settings section: its heading on the panel, the form on a white
 *  sheet (the same shape as a page Card). */
function Section({ title, icon: Icon, state, help, children }: { title: string; icon?: React.ComponentType<{ className?: string }>; state?: React.ReactNode; help?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="flex items-end gap-3 mb-2.5 min-h-8">
        <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)] inline-flex items-center gap-1.5">
          {Icon && <span aria-hidden className="ui-icon-tile is-sm is-solid mr-1"><Icon className="w-4 h-4" /></span>}
          {title}{help && <HelpTooltip>{help}</HelpTooltip>}
        </h2>
        <div className="flex-1" />
        {state}
      </div>
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5 space-y-4">{children}</div>
    </section>
  );
}

const FIELD_LABEL = "block mb-1 text-[13px] font-semibold text-[var(--color-text-muted)]";
const NOTE = "text-[13px] text-[var(--color-text-muted)]";

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
const fmtTok = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
  : String(n);

export function KeyEditor({ orgId, current, onChanged }: {
  orgId: string;
  current: AiConnectionInfo | null;
  onChanged: () => void;
}) {
  const { showToast } = useToast();
  const normalizeProvider = (p: string) =>
    PROVIDERS.some((c) => c.id === p) ? p : PROVIDERS[0].id;

  const [provider, setProvider] = useState(normalizeProvider(current?.provider ?? "anthropic"));
  const [model, setModel] = useState(current?.model ?? PROVIDERS[0].models[0]);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // A row saved before the allowlist existed (e.g. a Gemini key): the server
  // ignores it at ask time — say so instead of silently pretending it works.
  const grandfatheredBlocked = !!current && !providerAllowed(current.provider);

  useEffect(() => {
    setProvider(normalizeProvider(current?.provider ?? "anthropic"));
    setModel(current?.model ?? PROVIDERS[0].models[0]);
    setApiKey("");
  }, [current]);

  const providerMeta = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
  // The models offered, plus a saved one that isn't offered any more — so
  // the picker always shows what's really set.
  const offered = providerMeta.models;
  const options = offered.includes(model) || !model ? offered : [...offered, model];
  // With a key already saved, picking a model is the whole change — saved
  // at once. A new key waits for Verify & save.
  const pickModel = (m: string) => {
    setModel(m);
    if (current && !apiKey.trim() && provider === current.provider && m !== current.model) void save(m);
  };

  const save = async (m = model) => {
    if (!m.trim()) { showToast({ type: "error", title: "Pick a model." }); return; }
    if (!apiKey.trim() && !current) { showToast({ type: "error", title: "Paste an API key." }); return; }
    // Before a NEW key goes live: whatever this key sends, the provider
    // receives — questions AND excerpts of indexed documents. (The recorded
    // acceptable-use agreement is signed at first question.)
    if (apiKey.trim()) {
      const proceed = await appConfirm({
        title: "Know what this key carries",
        message:
          "Every question you ask - and text pulled from indexed documents to answer it - is sent to " +
          `${providerMeta.label} under THIS key's account.\n\n` +
          "Use a key you pay for and control. Anthropic and OpenAI do not train on API traffic - " +
          "that's why they're the only providers allowed here.",
        confirmLabel: "Understood - save key",
      });
      if (!proceed) return;
    }
    setBusy("save"); setNotice(null);
    const hadNewKey = !!apiKey.trim();
    try {
      // The server verifies a new key with a live call BEFORE storing it —
      // if this succeeds, the key both works and is saved.
      const last4 = apiKey.trim().slice(-4);
      await saveAiConnection({
        orgId, scope: "personal", provider, model: m.trim(),
        apiKey: apiKey.trim() || undefined,
      });
      setNotice({
        tone: "ok",
        text: hadNewKey
          ? `Key verified and saved - ends in ····${last4}. You're set for questions.`
          : `Main model set to ${modelName(m)} (your key is unchanged).`,
      });
      showToast({ type: "success", title: hadNewKey ? "Key verified and saved." : `Main model set to ${modelName(m)}.` });
      setApiKey("");
      onChanged();
    } catch (e) {
      setNotice({ tone: "err", text: (e as Error).message });
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  const test = async () => {
    setBusy("test"); setNotice(null);
    try {
      await testAiConnection({
        orgId, scope: "personal", provider, model: model.trim() || undefined, apiKey: apiKey.trim() || undefined,
      });
      setNotice({
        tone: "ok",
        text: apiKey.trim()
          ? "The key works. Press Verify and save to store it; testing alone doesn't save."
          : "Your saved key works - the model answered.",
      });
    } catch (e) {
      setNotice({ tone: "err", text: (e as Error).message });
    } finally { setBusy(null); }
  };

  const remove = async () => {
    const ok = await appConfirm({
      title: "Remove your API key?",
      message: "You won't be able to ask AI questions until you add a key again. Nobody else is affected.",
      confirmLabel: "Remove key",
    });
    if (!ok) return;
    setBusy("remove");
    try {
      await removeAiConnection(orgId, "personal");
      showToast({ type: "success", title: "Key removed." });
      onChanged();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  return (
    <Section title="Your API key" icon={KeyRound}
      help="Only you use it, only you pay for it. Verify and save makes a live call with the key first, so a key that saves is a key that works. Test only never saves anything. Saving again replaces your key; if your provider runs out of credits it stops answering until you top up."
      state={current && !grandfatheredBlocked
        ? <StateTag tone="good">Active, key ending {current.keyLast4 ?? "????"}</StateTag>
        : !current ? <StateTag tone="warn">No key saved yet</StateTag> : null}>
      {grandfatheredBlocked && (
        <p role="alert" className="relative pl-4 py-0.5 text-[14px] font-semibold text-[var(--state-overdue)]">
          <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] rounded-full bg-[var(--state-overdue)]" />
          Your saved {current?.provider} key is blocked: that provider can train on submitted data.
          Save a Claude or OpenAI key to ask questions again.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={FIELD_LABEL}>Provider</span>
          <Select value={provider} onChange={(e) => {
            setProvider(e.target.value);
            const meta = PROVIDERS.find((p) => p.id === e.target.value);
            if (meta) setModel(meta.models[0]);
          }}>
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </label>
        <label className="block">
          <span className={FIELD_LABEL}>Main model</span>
          <Select value={model} onChange={(e) => pickModel(e.target.value)} disabled={busy !== null}>
            {options.map((m) => <option key={m} value={m}>{modelLabel(m, offered)}</option>)}
          </Select>
        </label>
      </div>
      <p className={NOTE}>{PROVIDER_BLOCK_MESSAGE}</p>
      <label className="block">
        <span className={FIELD_LABEL}>
          API key {current ? "(leave blank to keep the saved key)" : ""}
        </span>
        <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          placeholder={current ? `Saved, ends in ${current.keyLast4 ?? "????"}` : "Paste your API key"} autoComplete="off" />
      </label>
      <div className="flex items-center gap-2 flex-wrap">
        <Button onClick={() => void save()} disabled={busy !== null}>
          {busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Verify and save
        </Button>
        <Button variant="secondary" onClick={() => void test()} disabled={busy !== null || (!current && !apiKey.trim())}>
          {busy === "test" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />} Test only
        </Button>
        {current && (
          <Button variant="secondary" onClick={() => void remove()} disabled={busy !== null}>
            {busy === "remove" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Remove
          </Button>
        )}
      </div>
      <Notice notice={notice} />
    </Section>
  );
}

// ── Which model each job runs on ──────────────────────────────────────────
// One menu per job. The main model (above) covers anything not listed; a job
// with its own default (reading on the cheap tier, shift notes lighter)
// keeps it until someone picks otherwise. Each choice shows what one use
// costs on it — from the person's own averages once they have a few.
export function JobModelsEditor({ orgId, current, jobModels, ready, jobUse, onChanged }: {
  orgId: string;
  current: AiConnectionInfo;
  jobModels: JobModels;
  ready: boolean;
  jobUse: Partial<Record<AiJob, { inputTokens: number; outputTokens: number; n: number }>>;
  onChanged: () => void;
}) {
  const { showToast } = useToast();
  const [picks, setPicks] = useState<JobModels>(jobModels);
  const [busy, setBusy] = useState<AiJob | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  useEffect(() => { setPicks(jobModels); }, [jobModels]);
  const provider = current.provider as AiProviderId;
  const suggestions = PROVIDERS.find((p) => p.id === provider)?.models ?? [];
  const mainName = modelName(current.model);

  const pick = async (job: AiJob, value: string) => {
    const next = { ...picks, [job]: value };
    setPicks(next); setBusy(job); setNotice(null);
    try {
      await saveJobModels(orgId, next);
      const label = AI_JOBS.find((j) => j.id === job)?.label ?? job;
      showToast({ type: "success", title: `${label} now runs on ${value === MAIN ? `the main model (${mainName})` : modelName(value)}.` });
      onChanged();
    } catch (e) {
      setPicks(picks);
      setNotice({ tone: "err", text: (e as Error).message });
    } finally { setBusy(null); }
  };

  return (
    <Section title="Model for each job" icon={Cpu}
      help={`Each choice shows what one use costs on it, from your own averages once you have a few. Everything else (codebook, flows, links, equipment census, catalog) runs on the main model, ${mainName}.`}>
      {!ready && (
        <p className="relative pl-4 py-0.5 text-[14px] font-semibold text-[var(--color-text)]">
          <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] rounded-full bg-[var(--state-held)]" />
          Picking a model per job needs a one-time database update (20261108_job_models.sql). Until it&apos;s run,
          every job uses its default below.
        </p>
      )}
      <ul className="-mx-4 sm:-mx-5 -my-1 divide-y divide-[var(--color-border)]">
        {AI_JOBS.map((j) => {
          const def = jobDefault(j.id, provider);
          const chosen = picks[j.id] ?? (def ?? MAIN);
          const options = [MAIN, ...suggestions, ...(def && !suggestions.includes(def) ? [def] : [])];
          if (chosen !== MAIN && !options.includes(chosen)) options.push(chosen);
          const own = jobUse[j.id];
          const use = own && own.n >= 3 ? own : j.use;
          return (
            <li key={j.id} className="px-4 sm:px-5 py-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,340px)] items-start">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold text-[var(--color-text)]">{j.label}</div>
                <div className={NOTE}>{j.what}</div>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Select value={chosen} onChange={(e) => void pick(j.id, e.target.value)}
                    disabled={!ready || busy !== null} aria-label={`Model for ${j.label}`} className="flex-1 min-w-0">
                    {options.map((m) => (
                      <option key={m} value={m}>
                        {m === MAIN ? `Main (${mainName})` : modelName(m)}, {fmtCost(costPerUse(m === MAIN ? current.model : m, use))}{(def ?? MAIN) === m ? ", default" : ""}
                      </option>
                    ))}
                  </Select>
                  {busy === j.id && <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)] shrink-0" />}
                </div>
                <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">
                  Cost per {j.use.per}{own && own.n >= 3 ? ` from your average of ${own.n}` : " at a typical size"}.
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      <Notice notice={notice} />
    </Section>
  );
}

/** The per-job menus for a saved connection — what both AI settings screens
 *  (this modal and Intelligence → AI setup) show under the key. */
export function JobModelsFor({ orgId, data, onChanged }: {
  orgId: string;
  data: Awaited<ReturnType<typeof getAiConnections>>;
  onChanged: () => void;
}) {
  const p = data.personal;
  if (!p || (p.provider !== "anthropic" && p.provider !== "openai")) return null;
  return (
    <JobModelsEditor orgId={orgId} current={p}
      jobModels={data.jobModels ?? {}} ready={data.jobModelsReady ?? false} jobUse={data.jobUse ?? {}}
      onChanged={onChanged} />
  );
}

// ── Embeddings key — a DIFFERENT service from the chat key ────────────────
//
// Anthropic makes no embeddings model. That is a fact about Anthropic's
// product line, not a reason a Claude user can't have meaning-based search:
// the two are unrelated services and nothing stops you holding one key for
// answers and another for vectors. Anthropic's own guidance points Claude
// users at Voyage AI, which is why it's first in the list and the default.
export function EmbeddingKeyEditor({ orgId, current, onChanged }: {
  orgId: string;
  current: AiConnectionInfo | null;
  onChanged: () => void;
}) {
  const { showToast } = useToast();
  const saved = current?.embeddingProvider ?? null;
  const [provider, setProvider] = useState(saved ?? "voyage");
  const [model, setModel] = useState(
    current?.embeddingModel ?? defaultEmbeddingModel((saved ?? "voyage") as "voyage" | "openai"),
  );
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    const p = current?.embeddingProvider ?? "voyage";
    setProvider(p);
    setModel(current?.embeddingModel ?? defaultEmbeddingModel(p as "voyage" | "openai"));
    setApiKey("");
  }, [current]);

  const meta = EMBEDDING_PROVIDERS.find((p) => p.id === provider) ?? EMBEDDING_PROVIDERS[0];
  // An OpenAI CHAT key already works for embeddings, so don't nag for a
  // second copy of the same secret.
  const reusingChatKey = !saved && current?.provider === "openai";

  const save = async () => {
    if (!apiKey.trim() && !saved) {
      setNotice({ tone: "err", text: "Paste your embeddings key first." });
      return;
    }
    setBusy("save"); setNotice(null);
    const hadNewKey = !!apiKey.trim();
    const last4 = apiKey.trim().slice(-4);
    try {
      // Server verifies a new key with a real embed call before storing.
      await saveEmbeddingKey({
        orgId, embeddingProvider: provider, embeddingModel: model.trim() || undefined,
        embeddingApiKey: apiKey.trim() || undefined,
      });
      setNotice({
        tone: "ok",
        text: hadNewKey
          ? `Embeddings key verified and saved - ends in ····${last4}. You can now build the meaning index.`
          : "Embeddings settings saved (your existing key is unchanged).",
      });
      showToast({ type: "success", title: hadNewKey ? "Embeddings key verified and saved." : "Settings saved." });
      setApiKey("");
      onChanged();
    } catch (e) {
      setNotice({ tone: "err", text: (e as Error).message });
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  const test = async () => {
    setBusy("test"); setNotice(null);
    try {
      await testEmbeddingKey({
        orgId, embeddingProvider: provider, embeddingModel: model.trim() || undefined,
        embeddingApiKey: apiKey.trim() || undefined,
      });
      setNotice({
        tone: "ok",
        text: apiKey.trim()
          ? "The key works. Press Verify and save to store it; testing alone doesn't save."
          : "Your saved embeddings key works.",
      });
    } catch (e) {
      setNotice({ tone: "err", text: (e as Error).message });
    } finally { setBusy(null); }
  };

  const remove = async () => {
    const ok = await appConfirm({
      title: "Remove your embeddings key?",
      message:
        "Meaning-based search stops for you; keyword search is unaffected. Vectors already built "
        + "stay in place and start working again as soon as you add a key back.",
      confirmLabel: "Remove key",
    });
    if (!ok) return;
    setBusy("remove");
    try {
      await removeEmbeddingKey(orgId);
      showToast({ type: "success", title: "Embeddings key removed." });
      onChanged();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  return (
    <Section title="Meaning-based search (optional)" icon={Sparkles}
      help={<>Finds &ldquo;pipe supports&rdquo; in a standard that says &ldquo;hanger and support details&rdquo;. This is a separate service from your chat key: Anthropic doesn&apos;t make an embeddings model, so Claude answers the questions and this key builds the index. Without it, search stays keyword-only. Verify and save makes a real embed call first. Embedding spend bills to your own account with that provider; the meter&apos;s figure is an estimate, your provider&apos;s invoice is the real number.</>}
      state={saved
        ? <StateTag tone="good">Active, key ending {current?.embeddingKeyLast4 ?? "????"}</StateTag>
        : reusingChatKey ? null : <StateTag tone="warn">No embeddings key yet</StateTag>}>
      <p className={NOTE}>A separate key from your chat key. Without it, search is keyword-only.</p>

      {reusingChatKey && !saved && (
        <p className="relative pl-4 py-0.5 text-[14px] text-[var(--color-text)]">
          <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] rounded-full bg-[var(--state-released)]" />
          Your OpenAI chat key already works for embeddings. Nothing to add here unless you
          want to use a different provider.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={FIELD_LABEL}>Provider</span>
          <Select value={provider} onChange={(e) => {
            setProvider(e.target.value);
            setModel(defaultEmbeddingModel(e.target.value as "voyage" | "openai"));
          }}>
            {EMBEDDING_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </label>
        <label className="block">
          <span className={FIELD_LABEL}>Model</span>
          <Select value={model} onChange={(e) => setModel(e.target.value)}>
            {meta.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
        </label>
      </div>
      <p className={NOTE}>{meta.hint}</p>

      <label className="block">
        <span className={FIELD_LABEL}>
          Embeddings API key {saved ? "(leave blank to keep the saved key)" : ""}
        </span>
        <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          placeholder={saved ? `Saved, ends in ${current?.embeddingKeyLast4 ?? "????"}` : "Paste your embeddings key"}
          autoComplete="off" />
      </label>

      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="secondary" onClick={() => void save()} disabled={busy !== null}>
          {busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Verify and save
        </Button>
        <Button variant="secondary" onClick={() => void test()} disabled={busy !== null || (!saved && !apiKey.trim())}>
          {busy === "test" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />} Test only
        </Button>
        {saved && (
          <Button variant="secondary" onClick={() => void remove()} disabled={busy !== null}>
            {busy === "remove" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Remove
          </Button>
        )}
      </div>
      <Notice notice={notice} />
    </Section>
  );
}

// ── Month meter: est. spend vs cap, tokens, avg prompt; controllers also
//    get the team's month and per-person cap dropdowns. ───────────────────
export function UsagePanel({ orgId }: { orgId: string }) {
  const { showToast } = useToast();
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const [capDraft, setCapDraft] = useState<string>("");
  const [savingCap, setSavingCap] = useState(false);
  const [savingUser, setSavingUser] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAiUsage(orgId)
      .then((u) => {
        if (cancelled) return;
        setUsage(u); setFailed(false);
        if (u.orgCapUsd !== undefined) setCapDraft(String(u.orgCapUsd));
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [orgId, tick]);

  // Pre-migration DB, or the read failed: say so in one quiet line.
  if (failed) return <p className={NOTE}>Couldn&apos;t load this month&apos;s AI spend.</p>;
  if (!usage) {
    return (
      <Section title="Your AI use this month" icon={Gauge}>
        <p className="text-center text-[14px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin inline mr-1.5" /> Loading this month&apos;s AI spend…</p>
      </Section>
    );
  }

  const totalTokens = usage.inputTokens + usage.outputTokens;
  // "20k of ~200k": extrapolate the month's token budget from what the
  // spend so far actually bought at the models really being used.
  // Tokens are counted for questions only, so scale by what questions cost.
  const background = usage.backgroundUsd ?? 0;
  const askSpend = usage.spentUsd - background;
  const estTokenBudget = askSpend > 0.0001 && usage.capUsd > 0
    ? Math.round(totalTokens * (usage.capUsd / askSpend))
    : null;
  const hot = usage.percent >= 80;
  const capped = usage.percent >= 100;
  const barColor = capped ? "bg-[var(--state-overdue)]" : hot ? "bg-[var(--state-held)]" : "bg-[var(--state-released)]";

  const saveCap = async () => {
    const cap = Number(capDraft);
    if (!Number.isFinite(cap) || cap < 0) {
      showToast({ type: "error", title: "Enter a cap in dollars, e.g. 10." });
      return;
    }
    setSavingCap(true);
    try {
      await setAiCap(orgId, cap);
      showToast({ type: "success", title: `Default monthly cap set to ${fmtUsd(cap)} per person.` });
      setTick((t) => t + 1);
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setSavingCap(false); }
  };

  // One person's cap: a preset picked from their row. "default" clears the
  // override so they follow the workspace default again.
  const setMemberCap = async (userId: string, name: string, value: string) => {
    setSavingUser(userId);
    try {
      if (value === "default") {
        await setAiCap(orgId, null, userId);
        showToast({ type: "success", title: `${name} follows the workspace default again.` });
      } else {
        await setAiCap(orgId, Number(value), userId);
        showToast({ type: "success", title: `${name}'s monthly cap set to $${Number(value)}.` });
      }
      setTick((t) => t + 1);
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setSavingUser(null); }
  };

  const cell = "px-4 sm:px-5 py-3 min-w-0";
  const figure = "font-display text-[24px] leading-none font-semibold tabular-nums text-[var(--color-text)]";
  return (
    <Section title={`Your AI use, ${usage.monthLabel}`} icon={Gauge}
      help="These numbers are yours alone: every question you ask, and every indexing or drawing-reading run your key pays for, is metered under your user id with the token counts your provider reported. All of it counts toward the cap. Estimated from provider token counts times published rates. Questions stop at 100% and reset on the 1st (UTC).">
      {/* The month in ruled cells: spent against the cap, then what it bought. */}
      <dl className="-mx-4 sm:-mx-5 -mt-4 sm:-mt-5 grid grid-cols-2 sm:grid-cols-4 divide-x divide-[var(--color-border)] border-b border-[var(--color-border)]">
        <div className={cell}>
          <dt className="text-[13px] text-[var(--color-text-muted)]">Spent</dt>
          <dd className={`mt-1 ${figure} ${capped ? "!text-[var(--state-overdue)]" : hot ? "!text-[var(--state-held)]" : ""}`}>{fmtUsd(usage.spentUsd)}</dd>
        </div>
        <div className={cell}>
          <dt className="text-[13px] text-[var(--color-text-muted)]">Cap</dt>
          <dd className={`mt-1 ${figure}`}>{fmtUsd(usage.capUsd)}</dd>
        </div>
        <div className={`${cell} max-sm:border-t max-sm:border-[var(--color-border)] max-sm:!border-l-0`}>
          <dt className="text-[13px] text-[var(--color-text-muted)]">Questions</dt>
          <dd className={`mt-1 ${figure}`}>{usage.asks.toLocaleString()}</dd>
        </div>
        <div className={`${cell} max-sm:border-t max-sm:border-[var(--color-border)]`}>
          <dt className="text-[13px] text-[var(--color-text-muted)]">Tokens</dt>
          <dd className={`mt-1 ${figure}`}>{fmtTok(totalTokens)}{estTokenBudget ? <span className="text-[15px] font-normal text-[var(--color-text-muted)]"> of ~{fmtTok(estTokenBudget)}</span> : null}</dd>
        </div>
      </dl>
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
          <div className={`h-full rounded-full transition-all ${barColor}`}
            style={{ width: `${Math.min(100, usage.percent)}%` }} />
        </div>
        <span className="font-display text-[15px] font-semibold tabular-nums text-[var(--color-text)]">{usage.percent}% used</span>
      </div>
      {(usage.asks > 0 || background > 0.005) && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-[var(--color-text-muted)]">
          {usage.asks > 0 && <span>About {fmtTok(usage.avgPromptTokens)} prompt tokens per question</span>}
          {background > 0.005 && <span>{fmtUsd(background)} on indexing and reading documents</span>}
        </div>
      )}
      {capped ? (
        <p className="relative pl-4 py-0.5 text-[14px] font-semibold text-[var(--state-overdue)]">
          <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] rounded-full bg-[var(--state-overdue)]" />
          Cap reached. Questions are locked until the 1st, unless an Admin raises the cap.
        </p>
      ) : hot ? (
        <p className="relative pl-4 py-0.5 text-[14px] font-semibold text-[var(--color-text)]">
          <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] rounded-full bg-[var(--state-held)]" />
          Over 80% of your monthly budget. Questions lock at 100% until the 1st.
        </p>
      ) : null}

      {usage.team && (
        <div className="pt-4 border-t border-[var(--color-border)] space-y-3">
          <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
            <h3 className="font-display text-[17px] font-semibold text-[var(--color-text)] inline-flex items-center gap-1.5">
              <span aria-hidden className="ui-icon-tile is-sm"><Users className="w-4 h-4" /></span> Team this month <span className="ui-count font-sans">{usage.team.length}</span>
            </h3>
            <div className="ml-auto flex items-center gap-2">
              <label htmlFor="ai-default-cap" className="text-[13px] text-[var(--color-text-muted)]">Default cap, $ per person</label>
              <Input id="ai-default-cap" value={capDraft} onChange={(e) => setCapDraft(e.target.value)}
                className="!w-20" inputMode="decimal" />
              <Button variant="secondary" size="sm" onClick={() => void saveCap()} disabled={savingCap}>
                {savingCap ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Set"}
              </Button>
            </div>
          </div>
          <div className="-mx-4 sm:-mx-5 border-y border-[var(--color-border)] overflow-x-auto">
            <table className="w-full text-[14px]">
              <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
                <tr>
                  <th className="font-semibold px-4 sm:px-5 h-10">Person</th>
                  <th className="font-semibold px-3 text-right">Spent</th>
                  <th className="font-semibold px-3 text-right hidden sm:table-cell">Questions</th>
                  <th className="font-semibold px-3 hidden md:table-cell w-[30%]">Used</th>
                  <th className="font-semibold px-4 sm:px-5">Cap</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {usage.team.map((m) => {
                  // Each person meters against THEIR cap (override or default).
                  const pct = m.capUsd > 0 ? Math.min(100, Math.round((m.spentUsd / m.capUsd) * 100)) : 100;
                  const presets = [5, 10, 15, 20, 25, 30, 35, 50, 75, 100];
                  if (m.hasOverride && !presets.includes(m.capUsd)) presets.push(m.capUsd);
                  return (
                    <tr key={m.userId}>
                      <td className="px-4 sm:px-5 py-2.5 font-semibold text-[var(--color-text)] max-w-[180px] truncate">{m.name}</td>
                      <td className={`px-3 py-2.5 text-right font-display tabular-nums font-semibold ${pct >= 100 ? "text-[var(--state-overdue)]" : "text-[var(--color-text)]"}`}>{fmtUsd(m.spentUsd)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-text-muted)] hidden sm:table-cell">{m.asks}</td>
                      <td className="px-3 py-2.5 hidden md:table-cell">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                            <div className={`h-full rounded-full ${pct >= 100 ? "bg-[var(--state-overdue)]" : pct >= 80 ? "bg-[var(--state-held)]" : "bg-[var(--state-released)]"}`}
                              style={{ width: `${pct}%` }} />
                          </div>
                          <span className={`ui-count !h-5 !text-[12px] ${pct >= 100 ? "is-bad" : pct >= 80 ? "is-warn" : ""}`}>{pct}%</span>
                        </div>
                      </td>
                      <td className="px-4 sm:px-5 py-2">
                        <select
                          value={m.hasOverride ? String(m.capUsd) : "default"}
                          disabled={savingUser === m.userId}
                          onChange={(e) => void setMemberCap(m.userId, m.name, e.target.value)}
                          aria-label={`${m.name}'s monthly cap`}
                          className={`h-8 w-[118px] text-[13px] font-semibold rounded-md border px-2 bg-[var(--color-surface)] cursor-pointer disabled:opacity-50 ${
                            m.hasOverride
                              ? "border-[var(--color-main)] text-[var(--color-accent-text)] bg-[var(--color-accent-soft)]"
                              : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"}`}>
                          <option value="default">${usage.orgCapUsd ?? usage.capUsd} default</option>
                          {presets.sort((a, b) => a - b).map((p) => (
                            <option key={p} value={String(p)}>${p}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className={NOTE}>A brand-colored cap means that person has their own cap.</p>
        </div>
      )}
    </Section>
  );
}

export default function AiSettingsModal({ orgId, open, onClose }: {
  orgId: string; open: boolean; onClose: () => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getAiConnections>> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getAiConnections(orgId)
      .then((next) => { if (!cancelled) { setData(next); setLoadError(null); } })
      .catch((e) => { if (!cancelled) setLoadError((e as Error).message); });
    return () => { cancelled = true; };
  }, [open, orgId, reloadTick]);

  if (!open) return null;
  return (
    <Modal onClose={onClose} size="lg">
        <ModalHeader icon={KeyRound} title="AI settings"
          subtitle="Your questions run on your own API key and monthly cap. Keys are stored on the server and never shown again."
          onClose={onClose} />
        <ModalBody className="space-y-6">
          {loadError && (
            <p role="alert" className="relative pl-4 py-0.5 text-[14px] font-semibold text-[var(--state-overdue)]"><span aria-hidden className="absolute left-0 inset-y-0 w-[3px] rounded-full bg-[var(--state-overdue)]" />Couldn&apos;t load the AI settings: {loadError}</p>
          )}
          {!data && !loadError && (
            <div className="py-8 text-center text-[14px] text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading the AI settings…</div>
          )}
          {data && (
            <>
              <UsagePanel orgId={orgId} />
              <KeyEditor orgId={orgId} current={data.personal}
                onChanged={() => setReloadTick((t) => t + 1)} />
              <JobModelsFor orgId={orgId} data={data} onChanged={() => setReloadTick((t) => t + 1)} />
              <EmbeddingKeyEditor orgId={orgId} current={data.personal}
                onChanged={() => setReloadTick((t) => t + 1)} />
            </>
          )}
        </ModalBody>
    </Modal>
  );
}
