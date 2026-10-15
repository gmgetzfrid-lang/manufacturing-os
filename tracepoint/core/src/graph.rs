//! Equipment-centred knowledge graph for the Graph view.
//!
//! Centre: one piece of equipment. Around it: its unit, its document types
//! (with counts), the most relevant files of each type, drawing families it
//! appears in, numbers it was renumbered from, and other equipment that
//! co-occurs with it. Co-occurrence edges are marked unverified: the THOR
//! index contract says they are retrieval clues, never confirmed links.

use crate::classify::Category;
use crate::engine::Engine;
use crate::index::F_LATEST;
use serde_json::{json, Value};
use std::collections::HashMap;

const FILES_PER_TYPE: usize = 8;

pub fn equipment_graph(e: &Engine, ei: u32) -> Value {
    let idx = &e.idx;
    let eq = &idx.equipment[ei as usize];
    let mut nodes: Vec<Value> = Vec::new();
    let mut edges: Vec<Value> = Vec::new();
    let center = format!("e{ei}");
    nodes.push(json!({"id": center, "kind": "equipment", "label": eq.number, "sub": format!("{} {}", eq.tags.first().cloned().unwrap_or_default(), eq.description).trim(), "equip_id": ei, "center": true, "count": eq.file_count}));
    if let Some(u) = eq.unit {
        let id = format!("u{u}");
        nodes.push(json!({"id": id, "kind": "unit", "label": idx.units[u as usize].label}));
        edges.push(json!({"from": center, "to": id, "kind": "in_unit", "label": "in unit"}));
    }
    for h in &eq.historical {
        let id = format!("h{h}");
        nodes.push(json!({"id": id, "kind": "history", "label": h, "sub": if h.starts_with("now ") { "renumbered to" } else { "formerly" }}));
        edges.push(json!({"from": center, "to": id, "kind": "renumbered", "label": "renumbered"}));
    }
    for h in &eq.hint_numbers {
        let id = format!("hint{h}");
        nodes.push(json!({"id": id, "kind": "hint", "label": h, "sub": "possible old number"}));
        edges.push(json!({"from": center, "to": id, "kind": "hint", "label": "unconfirmed", "dashed": true}));
    }

    // Documents grouped by type; within a type, latest/most recent first.
    let files = &idx.equip_files[ei as usize];
    let mut by_cat: HashMap<Category, Vec<u32>> = HashMap::new();
    for &fi in files {
        let f = &idx.files[fi as usize];
        if f.flags & (crate::index::F_JUNK | crate::index::F_ZERO) != 0 {
            continue;
        }
        by_cat.entry(f.cat).or_default().push(fi);
    }
    let mut cats: Vec<(Category, Vec<u32>)> = by_cat.into_iter().collect();
    cats.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
    let mut families: HashMap<u32, Vec<u32>> = HashMap::new();
    for (cat, mut list) in cats {
        let cid = format!("c{}", cat.label());
        nodes.push(json!({"id": cid, "kind": "category", "label": cat.label(), "count": list.len()}));
        edges.push(json!({"from": center, "to": cid, "kind": "has_type", "label": format!("{}", list.len())}));
        list.sort_by(|a, b| {
            let (fa, fb) = (&idx.files[*a as usize], &idx.files[*b as usize]);
            (fb.flags & F_LATEST).cmp(&(fa.flags & F_LATEST)).then(fb.year.cmp(&fa.year)).then(fb.mtime.cmp(&fa.mtime))
        });
        if cat == Category::Photos {
            // Photos: one node per folder rather than per picture.
            let mut per_dir: HashMap<u32, u32> = HashMap::new();
            for &fi in &list {
                *per_dir.entry(idx.files[fi as usize].dir).or_default() += 1;
            }
            let mut dirs: Vec<(u32, u32)> = per_dir.into_iter().collect();
            dirs.sort_by(|a, b| b.1.cmp(&a.1));
            for (d, n) in dirs.into_iter().take(FILES_PER_TYPE) {
                let id = format!("pd{d}");
                let dir = &idx.dirs[d as usize];
                nodes.push(json!({"id": id, "kind": "photos", "label": dir.name, "count": n, "year": dir.year}));
                edges.push(json!({"from": cid, "to": id, "kind": "contains"}));
            }
            continue;
        }
        for &fi in list.iter().take(FILES_PER_TYPE) {
            let f = &idx.files[fi as usize];
            let id = format!("f{fi}");
            nodes.push(json!({"id": id, "kind": "file", "label": f.name, "file_id": fi, "year": f.year, "ext": f.ext, "doctype": f.doctype, "latest": f.flags & F_LATEST != 0}));
            edges.push(json!({"from": cid, "to": id, "kind": "contains"}));
            if let Some(fa) = f.family {
                families.entry(fa).or_default().push(fi);
            }
        }
        if list.len() > FILES_PER_TYPE {
            let id = format!("more{}", cat.label());
            nodes.push(json!({"id": id, "kind": "more", "label": format!("+{} more", list.len() - FILES_PER_TYPE), "category": cat.label()}));
            edges.push(json!({"from": cid, "to": id, "kind": "contains"}));
        }
        for &fi in &list {
            if let Some(fa) = idx.files[fi as usize].family {
                families.entry(fa).or_default();
            }
        }
    }
    for (fa, shown) in families.into_iter().take(10) {
        let fam = &idx.families[fa as usize];
        let id = format!("fam{fa}");
        nodes.push(json!({"id": id, "kind": "family", "label": fam.base, "sub": format!("{} · {} sheets/revs", fam.kind, fam.members.len()), "count": fam.members.len()}));
        edges.push(json!({"from": center, "to": id, "kind": "family", "label": "drawing family"}));
        for fi in shown {
            edges.push(json!({"from": id, "to": format!("f{fi}"), "kind": "member", "dashed": true}));
        }
    }
    let mut related: Vec<(f32, u32)> = idx
        .cooccur
        .iter()
        .filter_map(|&(a, b, c)| if a == ei { Some((c, b)) } else if b == ei { Some((c, a)) } else { None })
        .collect();
    related.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    related.dedup_by_key(|x| x.1);
    for (conf, other) in related.into_iter().take(10) {
        let o = &idx.equipment[other as usize];
        let id = format!("e{other}");
        nodes.push(json!({"id": id, "kind": "related", "label": o.number, "sub": format!("{} {}", o.tags.first().cloned().unwrap_or_default(), o.description).trim(), "equip_id": other, "count": o.file_count}));
        edges.push(json!({"from": center, "to": id, "kind": "cooccurs", "label": format!("mentioned together · unverified ({:.0}%)", conf * 100.0), "dashed": true}));
    }

    // Timeline: documents per year by type (for the equipment history strip).
    let mut timeline: HashMap<i16, HashMap<&'static str, u32>> = HashMap::new();
    for &fi in files {
        let f = &idx.files[fi as usize];
        if let Some(y) = f.year {
            if f.cat != Category::Photos {
                *timeline.entry(y).or_default().entry(f.cat.label()).or_default() += 1;
            }
        }
    }
    let mut tl: Vec<Value> = timeline.into_iter().map(|(y, m)| json!({"year": y, "counts": m})).collect();
    tl.sort_by(|a, b| a["year"].as_i64().cmp(&b["year"].as_i64()));
    json!({"nodes": nodes, "edges": edges, "timeline": tl, "card": e.equipment_card(ei)})
}
