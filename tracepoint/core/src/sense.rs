//! Reading a request the way a colleague would.
//!
//! * Context picks the equipment: "crude unit V-3" is the V-3 in the crude
//!   unit — and the one in service, not the old one in an out-of-service
//!   folder — so there's nothing to ask.
//! * Nicknames are learned from how people name files: if the files in
//!   2010.04's folder say "Crude Tower", then "crude tower" means 2010.04.
//! * What the person asked about ("trays") beats where a file happens to be
//!   filed: a document with the topic in its title outranks one that only
//!   sits in a folder whose name mentions it.

use crate::engine::Engine;
use crate::text;
use std::collections::{HashMap, HashSet};

/// Words for kinds of equipment: a nickname must contain one.
const KIND_WORDS: &[&str] = &[
    "tower", "column", "drum", "vessel", "receiver", "reciever", "heater", "exchanger", "tank", "reactor", "boiler", "separator", "accumulator", "stripper", "absorber",
    "fractionator", "frac", "prefrac", "splitter", "compressor", "pump", "cooler", "condenser", "furnace", "scrubber", "filter", "coalescer", "settler", "bottle", "knockout",
    "regenerator", "contactor", "deaerator", "economizer", "stack", "flare", "debutanizer", "deethanizer", "depropanizer", "stabilizer", "treater", "reboiler", "chiller",
];

/// Folder words that mark equipment as out of service.
pub fn out_of_service(path: &str) -> bool {
    let p = path.to_lowercase();
    if p.contains("ω") || p.contains("out of service") || p.contains("removed from service") {
        return true;
    }
    p.split(|c: char| !c.is_alphanumeric()).any(|w| matches!(w, "oos" | "removed" | "abandoned" | "retired" | "demolished" | "decommissioned" | "dismantled"))
}

fn name_words(name: &str) -> Vec<String> {
    let stem = name.rsplit_once('.').map(|x| x.0).unwrap_or(name);
    text::raw_words(stem).into_iter().map(|w| w.to_lowercase()).filter(|w| w.len() >= 3 && w.chars().all(|c| c.is_ascii_alphabetic())).collect()
}

/// Nicknames: two-word phrases used in file names almost only inside one
/// equipment's folder, containing a kind-of-equipment word.
pub fn learn_nicknames(e: &Engine) -> HashMap<String, (u32, u32)> {
    let idx = &e.idx;
    let mut per: HashMap<String, HashMap<u32, u32>> = HashMap::new();
    for (fi, f) in idx.files.iter().enumerate() {
        let Some(ei) = idx.dirs[f.dir as usize].equip else { continue };
        // What the file is called, and what the document calls itself.
        let mut words = name_words(&f.name);
        if let Some(h) = e.links.headings.get(&(fi as u32)) {
            words.push("|".into());
            words.extend(text::raw_words(h).into_iter().map(|w| w.to_lowercase()).filter(|w| w.len() >= 3 && w.chars().all(|c| c.is_ascii_alphabetic())));
        }
        let mut seen: HashSet<String> = HashSet::new();
        for w in words.windows(2) {
            // "crude tower", "main fractionator": a describing word, then the
            // kind of equipment. ("prefrac trays" names a part, not the vessel.)
            if !KIND_WORDS.contains(&w[1].as_str()) || w[0] == w[1] || text::STOPS.contains(w[0].as_str()) {
                continue;
            }
            let k = format!("{} {}", w[0], w[1]);
            if seen.insert(k.clone()) {
                *per.entry(k).or_default().entry(ei).or_default() += 1;
            }
        }
    }
    let mut out = HashMap::new();
    for (k, m) in per {
        let total: u32 = m.values().sum();
        if let Some((&ei, &n)) = m.iter().max_by_key(|x| *x.1) {
            if n >= 2 && n as f32 >= total as f32 * 0.7 {
                out.insert(k, (ei, n));
            }
        }
    }
    out
}

impl Engine {
    /// The equipment a two-word phrase in the request is a nickname for.
    pub fn nickname_in(&self, raw_words: &[String]) -> Option<(usize, u32, String)> {
        let nick = self.nicknames.get_or_init(|| learn_nicknames(self));
        for (i, w) in raw_words.windows(2).enumerate() {
            let k = format!("{} {}", w[0].to_lowercase(), w[1].to_lowercase());
            if let Some(&(ei, _)) = nick.get(&k) {
                return Some((i, ei, k));
            }
        }
        None
    }

    /// Does the document's own heading (title block, first lines) use this word?
    pub fn heading_has_term(&self, fi: u32, term: u32) -> bool {
        match (self.links.headings.get(&fi), self.idx.terms.get(term as usize)) {
            (Some(h), Some(t)) if t.len() >= 3 && !t.starts_with("tag:") => h.split(|c: char| !c.is_alphanumeric()).any(|w| w.starts_with(t.as_str())),
            _ => false,
        }
    }

    pub fn has_nickname(&self, q: &str) -> bool {
        self.nickname_in(&text::raw_words(q)).is_some()
    }

    /// Does a word name a piece of equipment by what it is ("deethanizer",
    /// "prefrac") rather than by number? Then the request is about that
    /// equipment's documents, not only files that spell the word.
    pub fn names_equipment(&self, q: &str) -> bool {
        let raw = text::raw_words(q);
        if raw.iter().any(|w| w.chars().any(|c| c.is_ascii_digit())) {
            return false; // numbers and tags are handled as typed
        }
        raw.iter().map(|w| crate::nl::canonical_word(&text::stem(&w.to_lowercase()))).filter(|w| w.len() >= 5 && !KIND_WORDS.contains(&w.as_str())).any(|w| {
            self.eq_df.iter().any(|(t, &df)| df <= 3 && (*t == w || (t.len() >= w.len() + 3 && t.starts_with(w.as_str()))))
        })
    }

    /// Narrow equipment candidates (e.g. every V-3) by what else was said:
    /// the unit, in-service over out-of-service, and which one actually has
    /// documents about the topic. Returns the narrowed list and why.
    pub fn narrow_by_context(&self, list: &[u32], units: &[u16], topic_terms: &[Vec<u32>]) -> (Vec<u32>, Vec<String>) {
        let mut why = Vec::new();
        let mut l: Vec<u32> = list.to_vec();
        if l.len() <= 1 {
            return (l, why);
        }
        if !units.is_empty() {
            let inside: Vec<u32> = l.iter().copied().filter(|&e| self.idx.equipment[e as usize].unit.map(|u| units.contains(&u)).unwrap_or(false)).collect();
            if !inside.is_empty() && inside.len() < l.len() {
                why.push("in the unit you named".into());
                l = inside;
            }
        }
        if l.len() > 1 {
            let live: Vec<u32> = l.iter().copied().filter(|&e| !self.idx.equipment[e as usize].folder_path.as_deref().map(out_of_service).unwrap_or(false)).collect();
            if !live.is_empty() && live.len() < l.len() {
                why.push("in service".into());
                l = live;
            }
        }
        if l.len() > 1 && !topic_terms.is_empty() {
            // Which candidate's own documents are about the topic?
            let mut counts: Vec<(u32, usize)> = l
                .iter()
                .map(|&e| {
                    let n = self.idx.equip_files[e as usize]
                        .iter()
                        .filter(|&&fi| {
                            let f = &self.idx.files[fi as usize];
                            topic_terms.iter().all(|ids| ids.iter().any(|t| f.name_terms.binary_search(t).is_ok() || f.meta_terms.binary_search(t).is_ok() || self.heading_has_term(fi, *t)))
                        })
                        .count();
                    (e, n)
                })
                .collect();
            counts.sort_by(|a, b| b.1.cmp(&a.1));
            if counts[0].1 >= 2 && counts[0].1 >= counts.get(1).map(|x| x.1).unwrap_or(0) * 3 {
                why.push("the one with documents about it".into());
                l = vec![counts[0].0];
            }
        }
        (l, why)
    }

    /// How many of the leading results form a clear "best" group: close in
    /// score to the first, at most 10, at least 3 (or all, if fewer).
    pub fn top_group(scores: &[f32]) -> usize {
        if scores.is_empty() {
            return 0;
        }
        let s0 = scores[0];
        let margin = (s0.abs() * 0.18).max(30.0);
        let n = scores.iter().take(10).take_while(|&&s| s >= s0 - margin).count();
        n.max(3.min(scores.len()))
    }
}
