//! Ask THOR: answers from THOR documents with citations, following
//! Manufacturing OS's Knowledge Intelligence pipeline.
//!
//! 1. The question becomes 2-5 keyword searches (cheap model).
//! 2. Each runs over the document text (local full-text index); results are
//!    fused by reciprocal rank, at most 3 passages per document.
//! 3. A refine round looks for gaps and referenced documents (cheap model)
//!    and searches again.
//! 4. Nothing found: a fixed answer, no AI call.
//! 5. The answer (the admin's chosen model) uses only the numbered passages,
//!    in the Answer / Basis / Check format, with [n] citations.
//!
//! Upgrades over Manufacturing OS: TracePoint's own understanding scopes the
//! search to the equipment a question names; the query-writing steps use the
//! cheapest model; repeated questions reuse the earlier answer for free.

use crate::ai::{AiChoice, AiError, ChatResult, Msg};
use crate::engine::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const REWRITE_PROMPT: &str = "You generate full-text search queries for a technical document library at an oil refinery (THOR: inspection reports, U-1A / manufacturer's data reports, datasheets, drawings, calculations, procedures). Given a question, reply with ONLY a JSON array of 2-5 short keyword queries (2-6 words each) that would find the relevant passages. Include exact designations (like \"ASME B16.5\", \"5610.15\", \"V-2\") verbatim when present. Documents often use different wording than the question (e.g. \"t-min\" or \"minimum required thickness\" answers \"how thin can it get\") — vary the vocabulary across queries. CHECKLIST QUESTIONS (\"what do I need to…\", \"requirements for…\") span MANY topics — cover every facet the question implies, one query per facet. No prose, no code fence — just the JSON array.";

pub const REFINE_PROMPT: &str = "You review passages retrieved from a refinery's document library to answer a question. Documents reference each other (\"per API 510\", \"see drawing 2002-D 2001\") and part of the answer often lives in the referenced document. Checklist questions span many sections — first-round retrieval often catches only SOME of the requirements.\nReply with ONLY a JSON object: {\"queries\": [...], \"missing_documents\": [...]}\n- \"queries\": 0-4 NEW searches — different vocabulary for weak coverage, searches NAMING any referenced document, and searches for facets of the question not yet covered by the passages.\n- \"missing_documents\": designations of documents the passages REFERENCE for the answer that the library likely does not contain. Empty array if none.\nIf the passages fully cover the question, reply {\"queries\": [], \"missing_documents\": []}.";

/// Manufacturing OS's answer instructions, verbatim apart from the first
/// sentence (THOR instead of a document-control system).
pub const ANSWER_PROMPT: &str = "You are the reference assistant for THOR, a refinery's mechanical-integrity document drive (inspection reports, U-1A / data reports, datasheets, drawings, calculations, procedures). Answer the question USING ONLY the numbered passages provided.\n\n\
OUTPUT FORMAT — follow it exactly, no deviations, no preamble, no restating the question:\n\
**Answer:** the direct answer in ONE or two SHORT sentences (45 words MAX) with its [n] markers. Mandatory, first. NEVER pack an enumeration into the Answer line — lists of requirements, drivers, or steps ALWAYS go in Basis bullets, and the Answer line just says what governs and points down.\n\
**Basis:**\n\
- bullets, one fact each, with its [n] marker and the section/table name when the passage label shows one (e.g. \"per §5.3 Pipe Supports [2]\").\n\
STRUCTURE IS NOT OPTIONAL: every line under Basis is a \"- \" bullet, a \"### \" heading, or a \"! \" warning — NEVER a paragraph. Whenever Basis has more than 5 bullets, group them under short \"### \" headings (e.g. \"### Preheat requirements\"). No paragraph anywhere in the answer may exceed two sentences — break longer thoughts into bullets.\n\
! lines starting with \"! \" are ESCALATED VISUALLY as big warnings — use one for anything imperative: a MUST, a hold point, a verification the reader cannot skip, or a gap.\n\
**Check:** (when needed) what to verify on the cited page — REQUIRED whenever a value comes from a table, because PDF table extraction jumbles numbers.\n\n\
EMPHASIS: wrap every key identifier — document numbers, section refs, specific values and limits — in **bold**. Put exact values/designations in `backticks` (rendered as value chips): `250 ft-lb`, `ASME B31.3`, `Table 121.5`.\n\n\
PRIORITY ORDER: within Basis and within each ### group, order bullets by what the reader must act on first — binding requirements (shall/must, hold points, safety limits) first, specific values and limits next, supporting context last. The reader works top-down.\n\n\
COMPLETENESS: for checklist/what-do-I-need questions, completeness BEATS brevity — enumerate EVERY requirement found across ALL passages, grouped under short **bold** group names; never stop at the first passage's list. If the passages suggest more requirements exist beyond what was retrieved (a referenced appendix, a continued table), END with an \"! \" line saying what may be missing and where to look. For single-value questions stay under 120 words.\n\n\
NEVER invent requirements, values, or clause numbers. If passages only partially answer, **Answer:** says exactly what's covered and what isn't. Engineers act on these answers.\n\n\
WHOLE PROVISION: when a cited passage states a rule AND then adds a recommendation, default, exception, or practice (\"it is recommended…\", \"unless…\", \"typically…\", \"should be set at…\"), the answer INCLUDES that part — a recommendation in the source is part of the answer, not commentary. Stopping at \"no explicit value is given\" when the same passage recommends one is a WRONG answer.\n\n\
RELEVANCE — answer THE question, not the topic area: before writing, identify what the asker is actually trying to decide or do, and lead with exactly that. Passages are a haystack you were handed, not an outline to summarize — leave out anything that doesn't change the asker's decision, even when it's from the right document. The one exception: a safety-critical fact they didn't ask about but cannot act without gets ONE \"! \" line. An answer that buries the point under adjacent material is a WRONG answer here.\n\n\
THOR NOTES: passages are text extracted from PDFs, Office files and OCR of scans — OCR can misread characters, so say so in **Check:** when a value looks garbled. When passages come from several inspections of the same equipment, prefer the most recent unless the question asks otherwise, and say which date you used. Each passage label shows the file, its equipment and year, and the page.";

pub const NOTHING_FOUND: &str = "**Answer:** Nothing in the documents TracePoint has read matches this question.\n\n**Basis:**\n- No passage in the searched documents mentions it. Try the exact terms a report would use (an equipment number, \"t-min\", \"MAWP\", \"U-1A\"), or widen the scope to All of THOR.\n! Only documents whose contents have been read are searched — an administrator can read new and changed documents under Sources.";

/// One passage given to the model.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Passage {
    pub n: usize,
    pub file_id: u32,
    pub name: String,
    pub page: u32,
    pub folder: String,
    pub path: String,
    pub label: String,
    pub text: String,
}

pub fn extract_json(text: &str, open: char, close: char) -> Option<Value> {
    let s = text.find(open)?;
    let e = text.rfind(close)?;
    serde_json::from_str(&text[s..=e]).ok()
}

/// Split a page into ~1400-character windows (160 overlap) and keep the one
/// that mentions the query terms most.
pub fn best_window(text: &str, terms: &[String]) -> String {
    const SIZE: usize = 1400;
    const OVERLAP: usize = 160;
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= SIZE {
        return text.to_string();
    }
    let keys: Vec<String> = terms.iter().map(|t| t.to_lowercase().chars().take(6).collect()).filter(|t: &String| t.len() >= 3).collect();
    let mut best = (0usize, 0usize);
    let mut start = 0;
    while start < chars.len() {
        let end = (start + SIZE).min(chars.len());
        let w: String = chars[start..end].iter().collect::<String>().to_lowercase();
        let score = keys.iter().map(|k| w.matches(k.as_str()).count()).sum::<usize>();
        if score > best.1 || start == 0 {
            if score > best.1 || best.1 == 0 {
                best = (start, score);
            }
        }
        if end == chars.len() {
            break;
        }
        start += SIZE - OVERLAP;
    }
    let end = (best.0 + SIZE).min(chars.len());
    chars[best.0..end].iter().collect()
}

fn words_of(q: &str) -> Vec<String> {
    crate::text::raw_words(q).into_iter().filter(|w| w.len() >= 2 && !crate::text::STOPS.contains(w.as_str()) && !crate::nl::is_filler(w)).collect()
}

/// Run the queries over document text, fuse by reciprocal rank (k=60),
/// at most 3 passages per document, `cap` in all.
pub fn retrieve(e: &Engine, queries: &[String], scope: Option<&HashSet<u32>>, cap: usize, exclude: &HashSet<(u32, u32)>) -> Vec<(u32, u32, String)> {
    let guard = e.content.read().unwrap();
    let Some(ci) = guard.as_ref() else { return vec![] };
    let mut score: HashMap<(u32, u32), (f64, String)> = HashMap::new();
    for q in queries {
        let terms = words_of(q);
        if terms.is_empty() {
            continue;
        }
        let mut hits = ci.pages(&terms, false, scope, 30);
        if hits.len() < 3 && terms.len() > 1 {
            // Too strict: any of the words, ranked by relevance.
            let more = ci.pages(&terms, true, scope, 30);
            for h in more {
                if !hits.iter().any(|x| x.0 == h.0 && x.1 == h.1) {
                    hits.push(h);
                }
            }
        }
        for (rank, (fi, page, text)) in hits.into_iter().enumerate() {
            if exclude.contains(&(fi, page)) {
                continue;
            }
            let ent = score.entry((fi, page)).or_insert((0.0, String::new()));
            ent.0 += 1.0 / (60.0 + rank as f64 + 1.0);
            if ent.1.is_empty() {
                ent.1 = best_window(&text, &terms);
            }
        }
    }
    let mut all: Vec<((u32, u32), (f64, String))> = score.into_iter().collect();
    all.sort_by(|a, b| b.1 .0.partial_cmp(&a.1 .0).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    // Diversify: at most 3 per document, then backfill.
    let mut per: HashMap<u32, usize> = HashMap::new();
    let mut out = Vec::new();
    let mut rest = Vec::new();
    for ((fi, page), (_, text)) in all {
        let c = per.entry(fi).or_default();
        if *c < 3 {
            *c += 1;
            out.push((fi, page, text));
        } else {
            rest.push((fi, page, text));
        }
    }
    out.extend(rest);
    out.truncate(cap);
    out
}

pub fn passages(e: &Engine, hits: &[(u32, u32, String)]) -> Vec<Passage> {
    hits.iter()
        .enumerate()
        .map(|(i, (fi, page, text))| {
            let f = &e.idx.files[*fi as usize];
            let eq = f.equip.first().map(|(x, _)| {
                let q = &e.idx.equipment[*x as usize];
                format!("{}{}", q.number, q.tags.first().map(|t| format!(" {t}")).unwrap_or_default())
            });
            let label = format!(
                "{}{}{}, page {page}",
                f.name,
                eq.map(|x| format!(" — {x}")).unwrap_or_default(),
                f.year.map(|y| format!(" — {y}")).unwrap_or_default()
            );
            Passage { n: i + 1, file_id: *fi, name: f.name.clone(), page: *page, folder: e.idx.relative_folder(f.dir), path: e.idx.full_path(*fi), label, text: text.clone() }
        })
        .collect()
}

pub fn passages_block(ps: &[Passage]) -> String {
    ps.iter().map(|p| format!("[{}] ({})\n{}", p.n, p.label, p.text.trim())).collect::<Vec<_>>().join("\n\n")
}

/// [n] markers used, first-use order, valid ones only.
pub fn cited(answer: &str, max: usize) -> Vec<usize> {
    let mut out = Vec::new();
    let b = answer.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'[' {
            if let Some(end) = answer[i + 1..].find(']') {
                for part in answer[i + 1..i + 1 + end].split(',') {
                    if let Ok(n) = part.trim().parse::<usize>() {
                        if n >= 1 && n <= max && !out.contains(&n) {
                            out.push(n);
                        }
                    }
                }
                i += end + 1;
            }
        }
        i += 1;
    }
    out
}

pub struct AskOut {
    pub answer: String,
    pub passages: Vec<Passage>,
    pub cited: Vec<usize>,
    pub searched: Vec<String>,
    pub missing: Vec<String>,
    pub model: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
}

pub type Call<'a> = &'a dyn Fn(&AiChoice, &str, &[Msg], u32, &mut dyn FnMut(&str)) -> Result<ChatResult, AiError>;

/// The whole pipeline. `cheap` plans searches; `main` answers.
#[allow(clippy::too_many_arguments)]
pub fn ask(e: &Engine, cheap: &AiChoice, main: &AiChoice, call: Call, question: &str, history: &[(String, String)], scope: Option<&HashSet<u32>>, status: &dyn Fn(&str), on_passages: &dyn Fn(&[Passage]), on_delta: &mut dyn FnMut(&str)) -> Result<AskOut, AiError> {
    let mut tin = 0;
    let mut tout = 0;
    // Conversation context for follow-ups ("what about the shell?").
    let convo: String = history
        .iter()
        .rev()
        .take(4)
        .rev()
        .map(|(q, a)| format!("Q: {}\nA: {}", q.chars().take(500).collect::<String>(), a.chars().take(1200).collect::<String>()))
        .collect::<Vec<_>>()
        .join("\n\n");

    // TracePoint's own reading: a named piece of equipment scopes the search.
    let mut auto_scope: Option<HashSet<u32>> = None;
    if scope.is_none() {
        let u = e.understand(question);
        if u.equipment_strong {
            if let Some((ei, _, _)) = u.equipment.first() {
                auto_scope = Some(e.idx.equip_files[*ei as usize].iter().copied().collect());
                status(&format!("Focusing on {}", e.idx.equipment[*ei as usize].number));
            }
        } else if let Some(t) = u.ids.first() {
            if let Some(l) = e.idx.equip_keys.get(&t.key) {
                if l.len() == 1 {
                    auto_scope = Some(e.idx.equip_files[l[0] as usize].iter().copied().collect());
                    status(&format!("Focusing on {}", e.idx.equipment[l[0] as usize].number));
                }
            }
        }
    }
    let scope_ref = scope.or(auto_scope.as_ref());

    // 1. Searches.
    status("Writing search queries");
    let user = if convo.is_empty() { question.to_string() } else { format!("CONVERSATION SO FAR:\n{convo}\n\nResolve pronouns and ellipsis using the conversation.\nQUESTION: {question}") };
    let r = call(cheap, REWRITE_PROMPT, &[Msg { role: "user".into(), content: user, images: vec![] }], 1000, &mut |_| {})?;
    tin += r.input_tokens;
    tout += r.output_tokens;
    let mut queries: Vec<String> = extract_json(&r.text, '[', ']')
        .and_then(|v| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).take(5).collect()))
        .unwrap_or_default();
    queries.push(question.to_string());
    status(&format!("Searching the documents — {} queries", queries.len()));
    let mut hits = retrieve(e, &queries, scope_ref, 14, &HashSet::new());
    if hits.len() < 4 && auto_scope.is_some() {
        // The named equipment's documents weren't enough: widen to all of THOR.
        let have: HashSet<(u32, u32)> = hits.iter().map(|h| (h.0, h.1)).collect();
        hits.extend(retrieve(e, &queries, None, 14 - hits.len(), &have));
    }

    // 2. Refine: gaps and referenced documents.
    let mut missing: Vec<String> = Vec::new();
    let preview = if hits.is_empty() {
        "(nothing matched the first-round queries)".to_string()
    } else {
        passages(e, &hits).iter().map(|p| format!("[{}] {}: {}", p.n, p.label, p.text.chars().take(180).collect::<String>())).collect::<Vec<_>>().join("\n")
    };
    status(if hits.is_empty() { "Nothing matched yet — rewriting the search" } else { "Reviewing the passages and chasing references" });
    if let Ok(r) = call(cheap, REFINE_PROMPT, &[Msg { role: "user".into(), content: format!("QUESTION: {question}\n\nRETRIEVED SO FAR:\n{preview}"), images: vec![] }], 800, &mut |_| {}) {
        tin += r.input_tokens;
        tout += r.output_tokens;
        if let Some(v) = extract_json(&r.text, '{', '}') {
            let more: Vec<String> = v["queries"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).take(4).collect()).unwrap_or_default();
            missing = v["missing_documents"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).take(6).collect()).unwrap_or_default();
            if !more.is_empty() {
                let have: HashSet<(u32, u32)> = hits.iter().map(|h| (h.0, h.1)).collect();
                let extra = retrieve(e, &more, scope_ref.or(None), 8, &have);
                // Interleave: keep the best first-round passages, add new ones.
                hits.extend(extra);
                hits.truncate(18);
                queries.extend(more);
            }
        }
    }
    let ps = passages(e, &hits);
    on_passages(&ps);
    if ps.is_empty() {
        return Ok(AskOut { answer: NOTHING_FOUND.into(), passages: ps, cited: vec![], searched: queries, missing, model: String::new(), tokens_in: tin, tokens_out: tout });
    }

    // 3. Answer.
    status("Composing the cited answer");
    let mut system = ANSWER_PROMPT.to_string();
    if !missing.is_empty() {
        system.push_str(&format!("\n\nKNOWN GAPS: the passages reference documents that may not be in THOR's readable text: {}. If the answer depends on them, end with an \"! \" line naming them.", missing.join(", ")));
    }
    let user = format!("{}PASSAGES:\n\n{}\n\nQUESTION: {question}", if convo.is_empty() { String::new() } else { format!("CONVERSATION SO FAR:\n{convo}\n\n") }, passages_block(&ps));
    let r = call(main, &system, &[Msg { role: "user".into(), content: user, images: vec![] }], 4000, on_delta)?;
    tin += r.input_tokens + r.cache_read_tokens + r.cache_write_tokens;
    tout += r.output_tokens;
    let mut answer = r.text.clone();
    let c = cited(&answer, ps.len());
    // Out-of-range markers are removed and flagged (Manufacturing OS rule).
    let bad: Vec<String> = {
        let mut v = Vec::new();
        let re = regex::Regex::new(r"\[(\d{1,3})\]").unwrap();
        for m in re.captures_iter(&answer) {
            let n: usize = m[1].parse().unwrap_or(0);
            if n == 0 || n > ps.len() {
                v.push(m[0].to_string());
            }
        }
        v
    };
    if !bad.is_empty() {
        for b in &bad {
            answer = answer.replace(b.as_str(), "");
        }
        answer.push_str("\n! Some citation markers pointed to passages that don't exist and were removed — verify against the sources below.");
    }
    Ok(AskOut { answer, passages: ps, cited: c, searched: queries, missing, model: r.model, tokens_in: tin, tokens_out: tout })
}

/// Similar enough to reuse an earlier answer (word overlap).
pub fn similar(a: &str, b: &str) -> bool {
    let wa: HashSet<String> = words_of(a).into_iter().collect();
    let wb: HashSet<String> = words_of(b).into_iter().collect();
    if wa.is_empty() || wb.is_empty() {
        return false;
    }
    let inter = wa.intersection(&wb).count() as f64;
    let uni = wa.union(&wb).count() as f64;
    inter / uni >= 0.8
}

pub fn sources_json(ps: &[Passage], cited: &[usize]) -> Value {
    Value::Array(
        ps.iter()
            .map(|p| json!({"n": p.n, "file_id": p.file_id, "name": p.name, "page": p.page, "folder": p.folder, "path": p.path, "label": p.label, "snippet": p.text, "cited": cited.contains(&p.n)}))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn citations_and_windows() {
        assert_eq!(cited("**Answer:** t-min is `0.250` [2]. Basis: [1, 2] and [9]", 3), vec![2, 1]);
        let long = format!("{} minimum thickness t-min 0.312 at nozzle N3 {}", "x ".repeat(1500), "y ".repeat(1500));
        let w = best_window(&long, &["thickness".into(), "nozzle".into()]);
        assert!(w.contains("thickness") && w.chars().count() <= 1400);
        assert!(similar("what is the MAWP of V-2?", "What's the MAWP of V-2"));
        assert!(!similar("MAWP of V-2", "t-min of V-2 shell"));
    }
}
