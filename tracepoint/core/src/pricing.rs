//! AI prices, for spending caps. US dollars per million tokens, from the
//! providers' published pricing pages (checked 2026-10-15). Entries carry the
//! date they take effect, so announced price changes apply on time.
//!
//! Matching is by the longest model-id prefix ("gpt-5-mini" beats "gpt-5").
//! A model that isn't listed is priced at its provider's most expensive
//! listed model, so a cap can never be under-estimated. Administrators can
//! override a price (policy "price:<model>" = "input,output").

use crate::ai::Provider;

pub const PRICES_CHECKED: &str = "2026-10-15";
pub const SOURCES: &[&str] = &[
    "https://platform.claude.com/docs/en/about-claude/pricing",
    "https://developers.openai.com/api/docs/pricing",
    "https://ai.google.dev/gemini-api/docs/pricing",
];

#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct Price {
    /// $/MTok for uncached input.
    pub input: f64,
    /// $/MTok for output, including reasoning/thinking tokens.
    pub output: f64,
    /// $/MTok for input read from the prompt cache.
    pub cache_read: f64,
    /// $/MTok for writing the prompt cache (Anthropic, 5-minute).
    pub cache_write: f64,
}

struct Row {
    provider: Provider,
    model: &'static str,
    /// First day this price applies (inclusive), YYYY-MM-DD.
    from: &'static str,
    /// Last day it applies (exclusive), if it ends.
    until: Option<&'static str>,
    /// Prompts longer than this many tokens use `long`.
    long_over: Option<u64>,
    p: Price,
    long: Option<Price>,
}

const fn p(input: f64, output: f64, cache_read: f64, cache_write: f64) -> Price {
    Price { input, output, cache_read, cache_write }
}

use Provider::{Anthropic as A, Gemini as G, Openai as O};

#[rustfmt::skip]
static TABLE: &[Row] = &[
    // Anthropic Claude
    Row { provider: A, model: "claude-fable-5-1",  from: "2026-01-01", until: None, long_over: None, p: p(10.0, 50.0, 0.25, 12.50), long: None },
    Row { provider: A, model: "claude-mythos-5-1", from: "2026-01-01", until: None, long_over: None, p: p(10.0, 50.0, 0.25, 12.50), long: None },
    Row { provider: A, model: "claude-fable-5",    from: "2026-01-01", until: None, long_over: None, p: p(10.0, 50.0, 1.00, 12.50), long: None },
    Row { provider: A, model: "claude-mythos-5",   from: "2026-01-01", until: None, long_over: None, p: p(10.0, 50.0, 1.00, 12.50), long: None },
    Row { provider: A, model: "claude-opus-5-5",   from: "2026-01-01", until: None, long_over: None, p: p(4.0, 20.0, 0.20, 5.00), long: None },
    Row { provider: A, model: "claude-opus-5",     from: "2026-01-01", until: None, long_over: None, p: p(5.0, 25.0, 0.50, 6.25), long: None },
    Row { provider: A, model: "claude-opus-4-8",   from: "2026-01-01", until: None, long_over: None, p: p(5.0, 25.0, 0.50, 6.25), long: None },
    Row { provider: A, model: "claude-opus-4-7",   from: "2026-01-01", until: None, long_over: None, p: p(5.0, 25.0, 0.50, 6.25), long: None },
    Row { provider: A, model: "claude-opus-4-6",   from: "2026-01-01", until: None, long_over: None, p: p(5.0, 25.0, 0.50, 6.25), long: None },
    Row { provider: A, model: "claude-opus-4-5",   from: "2026-01-01", until: None, long_over: None, p: p(5.0, 25.0, 0.50, 6.25), long: None },
    Row { provider: A, model: "claude-opus-4-1",   from: "2026-01-01", until: None, long_over: None, p: p(15.0, 75.0, 1.50, 18.75), long: None },
    Row { provider: A, model: "claude-opus-4-0",   from: "2026-01-01", until: None, long_over: None, p: p(15.0, 75.0, 1.50, 18.75), long: None },
    Row { provider: A, model: "claude-sonnet-5-5", from: "2026-01-01", until: None, long_over: None, p: p(2.0, 10.0, 0.10, 2.50), long: None },
    Row { provider: A, model: "claude-sonnet-5",   from: "2026-01-01", until: None, long_over: None, p: p(2.0, 10.0, 0.20, 2.50), long: None },
    Row { provider: A, model: "claude-sonnet-4-6", from: "2026-01-01", until: None, long_over: None, p: p(3.0, 15.0, 0.30, 3.75), long: None },
    Row { provider: A, model: "claude-sonnet-4-5", from: "2026-01-01", until: None, long_over: None, p: p(3.0, 15.0, 0.30, 3.75), long: None },
    Row { provider: A, model: "claude-haiku-5-5",  from: "2026-01-01", until: None, long_over: Some(100_000), p: p(0.10, 0.50, 0.01, 0.125), long: Some(p(0.50, 2.50, 0.05, 0.625)) },
    Row { provider: A, model: "claude-haiku-4-5",  from: "2026-01-01", until: None, long_over: None, p: p(1.0, 5.0, 0.10, 1.25), long: None },
    // OpenAI
    Row { provider: O, model: "gpt-6-astra",   from: "2026-01-01", until: None, long_over: Some(272_000), p: p(10.0, 50.0, 1.00, 10.0), long: Some(p(20.0, 75.0, 2.00, 20.0)) },
    Row { provider: O, model: "gpt-6.1-sol",   from: "2026-01-01", until: None, long_over: Some(272_000), p: p(2.0, 10.0, 0.10, 2.0), long: Some(p(4.0, 15.0, 0.20, 4.0)) },
    Row { provider: O, model: "gpt-6-sol",     from: "2026-01-01", until: None, long_over: Some(272_000), p: p(2.0, 10.0, 0.20, 2.0), long: Some(p(4.0, 15.0, 0.40, 4.0)) },
    Row { provider: O, model: "gpt-6-luna",    from: "2026-01-01", until: None, long_over: Some(272_000), p: p(0.10, 0.50, 0.01, 0.10), long: Some(p(0.20, 0.75, 0.02, 0.20)) },
    // Promotional price; after it ends the model is treated as unlisted (worst case) until updated.
    Row { provider: O, model: "gpt-5.6-sol",   from: "2026-01-01", until: Some("2026-11-21"), long_over: None, p: p(4.0, 20.0, 0.40, 4.0), long: None },
    Row { provider: O, model: "gpt-5.6-terra", from: "2026-01-01", until: None, long_over: None, p: p(2.0, 12.0, 0.20, 2.0), long: None },
    Row { provider: O, model: "gpt-5.6-luna",  from: "2026-01-01", until: None, long_over: None, p: p(0.20, 1.20, 0.02, 0.20), long: None },
    Row { provider: O, model: "gpt-5.5",       from: "2026-01-01", until: None, long_over: Some(272_000), p: p(5.0, 30.0, 0.50, 5.0), long: Some(p(10.0, 45.0, 1.00, 10.0)) },
    Row { provider: O, model: "gpt-5.4-mini",  from: "2026-01-01", until: None, long_over: None, p: p(0.75, 4.50, 0.075, 0.75), long: None },
    Row { provider: O, model: "gpt-5.4-nano",  from: "2026-01-01", until: None, long_over: None, p: p(0.20, 1.25, 0.02, 0.20), long: None },
    Row { provider: O, model: "gpt-5.4",       from: "2026-01-01", until: None, long_over: None, p: p(2.50, 15.0, 0.25, 2.50), long: None },
    Row { provider: O, model: "gpt-5-mini",    from: "2026-01-01", until: None, long_over: None, p: p(0.25, 2.0, 0.025, 0.25), long: None },
    Row { provider: O, model: "gpt-5-nano",    from: "2026-01-01", until: None, long_over: None, p: p(0.05, 0.40, 0.005, 0.05), long: None },
    Row { provider: O, model: "gpt-5",         from: "2026-01-01", until: None, long_over: None, p: p(1.25, 10.0, 0.125, 1.25), long: None },
    // Google Gemini (announced increases included)
    Row { provider: G, model: "gemini-4-argon",          from: "2026-01-01", until: Some("2026-12-01"), long_over: None, p: p(2.0, 10.0, 0.10, 2.0), long: None },
    Row { provider: G, model: "gemini-4-argon",          from: "2026-12-01", until: None, long_over: None, p: p(4.0, 20.0, 0.20, 4.0), long: None },
    Row { provider: G, model: "gemini-3.1-pro",          from: "2026-01-01", until: None, long_over: Some(200_000), p: p(2.0, 12.0, 0.20, 2.0), long: Some(p(4.0, 18.0, 0.40, 4.0)) },
    Row { provider: G, model: "gemini-3.8-flash",        from: "2026-01-01", until: Some("2027-01-01"), long_over: None, p: p(0.75, 3.75, 0.075, 0.75), long: None },
    Row { provider: G, model: "gemini-3.8-flash",        from: "2027-01-01", until: None, long_over: None, p: p(1.50, 7.50, 0.15, 1.50), long: None },
    Row { provider: G, model: "gemini-3.6-flash",        from: "2026-01-01", until: Some("2027-01-01"), long_over: None, p: p(0.75, 3.75, 0.075, 0.75), long: None },
    Row { provider: G, model: "gemini-3.6-flash",        from: "2027-01-01", until: None, long_over: None, p: p(1.50, 7.50, 0.15, 1.50), long: None },
    Row { provider: G, model: "gemini-3.5-flash-lite",   from: "2026-01-01", until: None, long_over: None, p: p(0.30, 2.50, 0.03, 0.30), long: None },
    Row { provider: G, model: "gemini-3.1-flash-lite",   from: "2026-01-01", until: None, long_over: None, p: p(0.25, 1.50, 0.025, 0.25), long: None },
    Row { provider: G, model: "gemini-3-flash",          from: "2026-01-01", until: None, long_over: None, p: p(0.50, 3.0, 0.05, 0.50), long: None },
    Row { provider: G, model: "gemini-2.5-pro",          from: "2026-01-01", until: None, long_over: Some(200_000), p: p(1.25, 10.0, 0.125, 1.25), long: Some(p(2.50, 15.0, 0.25, 2.50)) },
    Row { provider: G, model: "gemini-2.5-flash-lite",   from: "2026-01-01", until: None, long_over: None, p: p(0.10, 0.40, 0.01, 0.10), long: None },
    Row { provider: G, model: "gemini-2.5-flash",        from: "2026-01-01", until: None, long_over: None, p: p(0.30, 2.50, 0.03, 0.30), long: None },
];

#[derive(Clone, Debug, serde::Serialize)]
pub struct Quote {
    pub price: Price,
    /// "listed", "override" or "unlisted" (priced at the provider's maximum).
    pub basis: &'static str,
    pub note: Option<String>,
}

/// The price for `model` on `day` (YYYY-MM-DD) for a prompt of about
/// `prompt_tokens`. `override_` comes from the admin policy.
pub fn quote(provider: Provider, model: &str, day: &str, prompt_tokens: u64, override_: Option<(f64, f64)>) -> Quote {
    if let Some((i, o)) = override_ {
        return Quote { price: p(i, o, i * 0.1, i * 1.25), basis: "override", note: Some("Price set by an administrator".into()) };
    }
    let m = model.to_lowercase();
    let best = TABLE
        .iter()
        .filter(|r| r.provider == provider && same_model(&m, r.model) && r.from <= day && r.until.map(|u| day < u).unwrap_or(true))
        .max_by_key(|r| r.model.len());
    if let Some(r) = best {
        let long = matches!((r.long_over, r.long), (Some(t), Some(_)) if prompt_tokens > t);
        let price = if long { r.long.unwrap() } else { r.p };
        return Quote { price, basis: "listed", note: long.then(|| format!("Long prompt (over {} tokens) is billed at the higher rate", r.long_over.unwrap())) };
    }
    // Unknown (or an expired promotional price): assume the most expensive.
    let worst = TABLE
        .iter()
        .filter(|r| r.provider == provider)
        .map(|r| r.long.unwrap_or(r.p))
        .fold(p(0.0, 0.0, 0.0, 0.0), |a, b| p(a.input.max(b.input), a.output.max(b.output), a.cache_read.max(b.cache_read), a.cache_write.max(b.cache_write)));
    Quote { price: worst, basis: "unlisted", note: Some(format!("No published price on file for {model}; using {}'s highest price so the cap stays safe", provider.as_str())) }
}

/// `id` is `listed` or a dated/tagged variant of it ("-20250929",
/// "-preview", "-latest") — never a different version ("gpt-5.6" is not
/// "gpt-5", "claude-opus-5-5" is not "claude-opus-5").
fn same_model(id: &str, listed: &str) -> bool {
    let Some(rest) = id.strip_prefix(listed) else { return false };
    if rest.is_empty() {
        return true;
    }
    let Some(tail) = rest.strip_prefix('-') else { return false };
    let first = tail.split('-').next().unwrap_or("");
    if first.chars().all(|c| c.is_ascii_digit()) {
        first.len() >= 6 // a date stamp, not a version number
    } else {
        first.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false)
    }
}

/// Dollars for actual usage.
pub fn cost(q: &Price, input: u64, output: u64, cache_read: u64, cache_write: u64) -> f64 {
    (input as f64 * q.input + output as f64 * q.output + cache_read as f64 * q.cache_read + cache_write as f64 * q.cache_write) / 1_000_000.0
}

/// Worst case before a call: every input token written to the cache (the
/// most expensive way to send it) and the longest answer allowed.
pub fn worst_case(q: &Price, est_input: u64, max_output: u64) -> f64 {
    (est_input as f64 * q.input.max(q.cache_write) + max_output as f64 * q.output) / 1_000_000.0
}

/// Conservative token estimate for text sent to a model (about 3 characters
/// per token; real tokenizers usually give fewer).
pub fn estimate_tokens(chars: usize) -> u64 {
    (chars as u64 / 3) + 64
}

/// The table, for the Profile page.
pub fn table(day: &str) -> Vec<serde_json::Value> {
    TABLE
        .iter()
        .filter(|r| r.from <= day && r.until.map(|u| day < u).unwrap_or(true))
        .map(|r| {
            serde_json::json!({
                "provider": r.provider.as_str(), "model": r.model, "input": r.p.input, "output": r.p.output, "cache_read": r.p.cache_read,
                "until": r.until, "long_over": r.long_over, "long": r.long,
                // A typical Ask THOR question: ~6k tokens in, ~1k out.
                "per_question": cost(&r.p, 6000, 1000, 0, 0),
            })
        })
        .collect()
}

/// Upcoming announced changes, so the Profile page can warn.
pub fn upcoming(day: &str) -> Vec<serde_json::Value> {
    TABLE
        .iter()
        .filter(|r| r.from > day)
        .map(|r| serde_json::json!({"provider": r.provider.as_str(), "model": r.model, "from": r.from, "input": r.p.input, "output": r.p.output}))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_and_dates() {
        let q = quote(A, "claude-sonnet-5-5", "2026-10-15", 5000, None);
        assert_eq!((q.price.input, q.price.output, q.basis), (2.0, 10.0, "listed"));
        // Longest prefix: opus-5-5 is not opus-5.
        assert_eq!(quote(A, "claude-opus-5-5", "2026-10-15", 1, None).price.input, 4.0);
        assert_eq!(quote(A, "claude-opus-5", "2026-10-15", 1, None).price.input, 5.0);
        assert_eq!(quote(O, "gpt-5-mini-20260115", "2026-10-15", 1, None).price.input, 0.25);
        assert_eq!(quote(A, "claude-sonnet-4-5-20250929", "2026-10-15", 1, None).price.input, 3.0);
        assert_eq!(quote(G, "gemini-3.1-pro-preview", "2026-10-15", 1, None).price.input, 2.0);
        assert_eq!(quote(G, "gemini-3-flash-preview", "2026-10-15", 1, None).price.input, 0.5);
        // Long prompts on Haiku 5.5.
        assert_eq!(quote(A, "claude-haiku-5-5", "2026-10-15", 150_000, None).price.input, 0.50);
        // Announced change.
        assert_eq!(quote(G, "gemini-4-argon", "2026-11-30", 1, None).price.input, 2.0);
        assert_eq!(quote(G, "gemini-4-argon", "2026-12-01", 1, None).price.input, 4.0);
        // Promotion ended → treated as unlisted (worst case).
        let q = quote(O, "gpt-5.6-sol", "2026-12-01", 1, None);
        assert_eq!(q.basis, "unlisted");
        assert!(q.price.output >= 75.0);
        // Unknown model → provider maximum.
        let q = quote(A, "claude-something-new", "2026-10-15", 1, None);
        assert_eq!((q.basis, q.price.output), ("unlisted", 75.0));
        // Cost math: 6k in + 1k out on Sonnet 5.5 = 2.2 cents.
        let c = cost(&quote(A, "claude-sonnet-5-5", "2026-10-15", 1, None).price, 6000, 1000, 0, 0);
        assert!((c - 0.022).abs() < 1e-9, "{c}");
    }
}
