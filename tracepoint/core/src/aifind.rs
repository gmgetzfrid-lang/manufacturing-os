//! "Find it with AI": conversational search over the THOR index.
//!
//! 1. The model reads the request (and the conversation so far) and writes a
//!    search plan: up to five TracePoint searches, plus a clarifying question
//!    if the request is genuinely ambiguous.
//! 2. TracePoint runs those searches itself and merges the candidates.
//! 3. The model sees only file names, folders, types, years and equipment of
//!    the top candidates (never file contents) and picks the best, saying why.
//!
//! Uses the signed-in user's own key and model. Nothing else leaves the PC.

use crate::ai::{self, AiChoice, AiError, Msg};
use crate::engine::{Engine, Hit, SearchRequest};
use serde_json::{json, Value};
use std::collections::HashMap;

fn extract_json(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(&text[start..=end]).ok()
}

fn plan_prompt(e: &Engine) -> String {
    let units: Vec<String> = e.idx.units.iter().filter(|u| !u.code.is_empty()).map(|u| format!("{} = {}", u.code, u.name)).collect();
    format!(
        r#"You help refinery engineers find documents on THOR, a network drive of ~200,000 files organised as UNIT\EQUIPMENT TYPE\EQUIPMENT FOLDER\INSPECTIONS\<date> <type>.

You do not see the files. You write searches for TracePoint, a search engine that understands:
- equipment numbers like 5610.15 (unit code + "." + number), tags like V-2, E-814, PSV-601B, TK-1100, piping circuits like 2015-006 or CRUDE-028;
- units by code or name: {units};
- document types: inspection, UT/thickness, external, internal, visual/API 510/570/653, on-stream (OSI), field notes, checklist, report, photos, drawing, iso, P&ID, datasheet, U-1A/nameplate/MDR, PSV service report, calculation (MAWP, t-min, remaining life), repair, MTR/material cert, email, procedure;
- years ("2019", "2018-2021", "after 2020") and "latest"/"oldest";
- plain-English descriptions ("the debutanizer receiver in the LRU") - it matches equipment descriptions.

Return ONLY a JSON object, no prose:
{{"understanding": "<one short sentence restating what the person wants>",
  "clarify": null or {{"question": "<one short question>", "options": ["<2-4 short answers>"]}},
  "searches": [{{"query": "<a TracePoint search>", "why": "<few words>"}}]}}

Rules: 2-5 searches, from most specific to broadest. Use equipment numbers or tags when the person gave them. Ask a clarifying question only if the request cannot be searched sensibly without it (still provide searches). Keep queries short."#,
        units = units.join("; ")
    )
}

const PICK_PROMPT: &str = r#"You are choosing which THOR files best match what a refinery engineer asked for. You see candidate files found by search (name, folder, type, year, equipment). Pick the ones that best fit the request, best first. Prefer real reports over blank templates, the right equipment over similar names, and the right time period. If none fit well, say so.

Return ONLY a JSON object:
{"picks": [{"n": <candidate number>, "why": "<one short reason>"}],
 "message": "<1-2 sentences to the engineer: what you found, or what's missing>",
 "followup": null or {"question": "<one short question that would narrow it down>", "options": ["<2-4 short answers>"]}}
Up to 8 picks."#;

pub struct FindResult {
    pub value: Value,
}

/// One AI call, with the caller's spending cap applied: (choice, system, messages, max_tokens).
pub type Call<'a> = &'a dyn Fn(&AiChoice, &str, &[Msg], u32) -> Result<ai::ChatResult, AiError>;

pub fn find(e: &Engine, choice: &AiChoice, call: Call, query: &str, history: &[Msg], status: &dyn Fn(&str)) -> Result<FindResult, AiError> {
    let t0 = std::time::Instant::now();
    // Quick, inexpensive calls: lowest reasoning level when the model has levels.
    let fast = AiChoice { provider: choice.provider, model: choice.model.clone(), reasoning: choice.reasoning.as_ref().map(|_| "low".to_string()) };
    let mut tokens_in = 0u64;
    let mut tokens_out = 0u64;

    // 1. Plan.
    status("Understanding your request…");
    let mut msgs: Vec<Msg> = history.to_vec();
    msgs.push(Msg { role: "user".into(), content: query.to_string() });
    let plan = call(&fast, &plan_prompt(e), &msgs, 1500)?;
    tokens_in += plan.input_tokens;
    tokens_out += plan.output_tokens;
    let pv = extract_json(&plan.text).unwrap_or_else(|| json!({"understanding": query, "searches": [{"query": query, "why": "as written"}]}));
    let mut searches: Vec<(String, String)> = pv["searches"]
        .as_array()
        .map(|a| a.iter().filter_map(|s| Some((s["query"].as_str()?.to_string(), s["why"].as_str().unwrap_or("").to_string()))).take(5).collect())
        .unwrap_or_default();
    if searches.is_empty() {
        searches.push((query.to_string(), "as written".into()));
    }
    // Always include the person's own words as one of the searches.
    if !searches.iter().any(|s| s.0.eq_ignore_ascii_case(query)) {
        searches.push((query.to_string(), "your words".into()));
    }

    // 2. Run the searches and merge (reciprocal-rank fusion).
    status(&format!("Running {} searches on THOR…", searches.len()));
    let mut fused: HashMap<u32, (f32, Hit, Vec<String>)> = HashMap::new();
    let mut ran: Vec<Value> = Vec::new();
    for (q, why) in &searches {
        let r = e.search(&SearchRequest { query: q.clone(), limit: 30, ..Default::default() });
        ran.push(json!({"query": q, "why": why, "total": r.total}));
        for (rank, h) in r.hits.into_iter().enumerate() {
            let w = 1.0 / (60.0 + rank as f32);
            let ent = fused.entry(h.id).or_insert((0.0, h, Vec::new()));
            ent.0 += w;
            ent.2.push(q.clone());
        }
    }
    let mut cands: Vec<(f32, Hit, Vec<String>)> = fused.into_values().collect();
    cands.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    cands.truncate(40);
    if cands.is_empty() {
        return Ok(FindResult {
            value: json!({
                "understanding": pv["understanding"], "clarify": pv["clarify"], "searches": ran, "hits": [],
                "message": "None of the searches found anything. Try adding the unit, the equipment, or roughly when it was done.",
                "followup": pv["clarify"], "ms": t0.elapsed().as_millis(), "tokens_in": tokens_in, "tokens_out": tokens_out, "model": plan.model,
            }),
        });
    }

    // 3. Pick the best from metadata only.
    status(&format!("Reviewing the top {} candidates…", cands.len()));
    let listing: String = cands
        .iter()
        .enumerate()
        .map(|(i, (_, h, _))| {
            let eq = h.equipment.iter().map(|x| format!("{}{}", x.number, x.tag.as_ref().map(|t| format!(" {t}")).unwrap_or_default())).collect::<Vec<_>>().join(", ");
            format!("[{}] {} | folder: {} | type: {} | year: {} | equipment: {}", i + 1, h.name, h.folder, h.doctype, h.year.map(|y| y.to_string()).unwrap_or_else(|| "?".into()), if eq.is_empty() { "-".into() } else { eq })
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut pick_msgs = history.to_vec();
    pick_msgs.push(Msg { role: "user".into(), content: format!("Request: {query}\n\nCandidates:\n{listing}") });
    let pick = call(&fast, PICK_PROMPT, &pick_msgs, 1500)?;
    tokens_in += pick.input_tokens;
    tokens_out += pick.output_tokens;
    let kv = extract_json(&pick.text).unwrap_or_else(|| json!({"picks": [], "message": pick.text}));
    let mut hits: Vec<Hit> = Vec::new();
    let mut used = std::collections::HashSet::new();
    if let Some(arr) = kv["picks"].as_array() {
        for p in arr {
            let Some(n) = p["n"].as_u64() else { continue };
            let Some((_, h, _)) = cands.get((n as usize).saturating_sub(1)) else { continue };
            if !used.insert(h.id) {
                continue;
            }
            let mut h = h.clone();
            h.reasons.insert(0, format!("AI: {}", p["why"].as_str().unwrap_or("good match")));
            h.rank = hits.len() + 1;
            hits.push(h);
        }
    }
    // The rest of the candidates follow, in search order.
    for (_, h, qs) in cands.into_iter() {
        if used.insert(h.id) {
            let mut h = h;
            h.reasons.insert(0, format!("Found by: {}", qs.join(" · ")));
            h.rank = hits.len() + 1;
            hits.push(h);
        }
    }
    let picked = kv["picks"].as_array().map(|a| a.len()).unwrap_or(0);
    Ok(FindResult {
        value: json!({
            "understanding": pv["understanding"],
            "searches": ran,
            "hits": hits,
            "picked": picked,
            "message": kv["message"],
            "followup": if kv["followup"].is_null() { pv["clarify"].clone() } else { kv["followup"].clone() },
            "ms": t0.elapsed().as_millis(),
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "model": pick.model,
        }),
    })
}
