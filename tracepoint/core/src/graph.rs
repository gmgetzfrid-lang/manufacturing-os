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

// ── Walkable graph ────────────────────────────────────────────────────────
//
// Every node can be expanded: THOR → units → equipment groups (VESSELS…) →
// equipment → document types → files → the inspection folder they sit in →
// drawing families, related equipment and relief devices. Neighbours are
// computed on demand so the graph stays fast on 200k+ files. Each edge says
// why the two are connected; inferred links are dashed and say so.

use std::collections::{HashSet, VecDeque};

const CAP_UNIT_GROUPS: usize = 40;
const CAP_GROUP_EQUIP: usize = 80;
const CAP_HUB_FILES: usize = 30;
const CAP_FOLDER_FILES: usize = 40;
const CAP_RELATED: usize = 12;
const CAP_TOTAL: usize = 420;

struct Nb {
    node: Value,
    kind: &'static str,
    why: String,
    dashed: bool,
}

fn dir_files(e: &Engine) -> &Vec<Vec<u32>> {
    e.dir_files.get_or_init(|| {
        let mut v = vec![Vec::new(); e.idx.dirs.len()];
        for (fi, f) in e.idx.files.iter().enumerate() {
            v[f.dir as usize].push(fi as u32);
        }
        v
    })
}

fn usable(e: &Engine, fi: u32) -> bool {
    e.idx.files[fi as usize].flags & (crate::index::F_JUNK | crate::index::F_ZERO) == 0
}

fn eq_label(eq: &crate::index::Equip) -> (String, String) {
    let tag = eq.tags.first().cloned().unwrap_or_default();
    (if tag.is_empty() { eq.number.clone() } else { format!("{} {}", eq.number, tag) }, eq.description.clone())
}

/// The equipment-type group shown in the graph: the type folder it sits in
/// (VESSELS, EXCHANGERS…), tidied. Folders that aren't really types (a parent
/// equipment folder, INSPECTIONS, PICTURES) fall under "Other".
fn kind_name(eq: &crate::index::Equip) -> String {
    let k = eq.kind.trim();
    let up = k.to_uppercase();
    let not_a_type = k.is_empty()
        || k.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
        || ["INSPECTION", "PICTURE", "PHOTO", "DRAWING", "ARCHIVE", "OLD", "HATCH", "ANALYSIS", "MISC", "EMAIL", "REPORT"].iter().any(|w| up.contains(w));
    if not_a_type {
        return "Other".into();
    }
    if up == "PIPING CIRCUIT" {
        return "Piping circuits".into();
    }
    up
}

pub fn node_value(e: &Engine, id: &str) -> Option<Value> {
    let idx = &e.idx;
    let (pre, rest) = id.split_at(id.find(|c: char| c.is_ascii_digit() || c == '|').unwrap_or(id.len()));
    Some(match pre {
        "root" => json!({"id": "root", "kind": "root", "label": "THOR", "sub": format!("{} files · {} units", idx.files.len(), idx.units.len()), "count": idx.files.len()}),
        "u" => {
            let u: usize = rest.parse().ok()?;
            let unit = idx.units.get(u)?;
            let n = idx.equipment.iter().filter(|q| q.unit == Some(u as u16)).count();
            json!({"id": id, "kind": "unit", "label": unit.label, "sub": format!("{n} equipment"), "count": n})
        }
        "g" => {
            let (u, k) = rest.split_once('|')?;
            let u: u16 = u.parse().ok()?;
            let n = idx.equipment.iter().filter(|q| q.unit == Some(u) && kind_name(q) == k).count();
            json!({"id": id, "kind": "group", "label": k, "sub": format!("{} · {n} items", idx.units.get(u as usize).map(|x| x.name.as_str()).unwrap_or("")), "count": n})
        }
        "e" => {
            let i: usize = rest.parse().ok()?;
            let eq = idx.equipment.get(i)?;
            let (label, desc) = eq_label(eq);
            json!({"id": id, "kind": "equipment", "label": label, "sub": desc, "count": eq.file_count, "equip_id": i,
                   "relief": crate::nl::is_relief_pub(eq), "unit": eq.unit.map(|u| idx.units[u as usize].label.clone()), "group": kind_name(eq)})
        }
        "h" => {
            let (i, cat) = rest.split_once('|')?;
            let i: usize = i.parse().ok()?;
            let c = Category::from_label(cat)?;
            let n = idx.equip_files.get(i)?.iter().filter(|&&f| usable(e, f) && idx.files[f as usize].cat == c).count();
            json!({"id": id, "kind": "hub", "label": c.label(), "sub": format!("{} · {n} files", idx.equipment[i].number), "count": n, "category": c.label(), "equip_id": i})
        }
        "f" => {
            let fi: usize = rest.parse().ok()?;
            let f = idx.files.get(fi)?;
            json!({"id": id, "kind": "file", "label": f.name, "sub": f.doctype, "file_id": fi, "year": f.year, "ext": f.ext, "category": f.cat.label(),
                   "latest": f.flags & F_LATEST != 0, "folder": idx.dirs[f.dir as usize].path})
        }
        "d" => {
            let d: usize = rest.parse().ok()?;
            let dir = idx.dirs.get(d)?;
            let n = dir_files(e)[d].len();
            json!({"id": id, "kind": "folder", "label": dir.name, "sub": format!("{n} files{}", dir.year.map(|y| format!(" · {y}")).unwrap_or_default()), "count": n, "year": dir.year, "folder": dir.path})
        }
        "fam" => {
            let fa: usize = rest.parse().ok()?;
            let fam = idx.families.get(fa)?;
            json!({"id": id, "kind": "family", "label": fam.base, "sub": format!("{} · {} sheets/revisions", fam.kind, fam.members.len()), "count": fam.members.len()})
        }
        _ => return None,
    })
}

fn nb(e: &Engine, id: String, kind: &'static str, why: impl Into<String>, dashed: bool) -> Option<Nb> {
    node_value(e, &id).map(|node| Nb { node, kind, why: why.into(), dashed })
}

fn neighbours(e: &Engine, id: &str) -> Vec<Nb> {
    let idx = &e.idx;
    let mut out: Vec<Nb> = Vec::new();
    let (pre, rest) = id.split_at(id.find(|c: char| c.is_ascii_digit() || c == '|').unwrap_or(id.len()));
    match pre {
        "root" => {
            let mut us: Vec<(usize, usize)> = (0..idx.units.len()).map(|u| (u, idx.equipment.iter().filter(|q| q.unit == Some(u as u16)).count())).filter(|x| x.1 > 0).collect();
            us.sort_by(|a, b| idx.units[a.0].label.cmp(&idx.units[b.0].label));
            for (u, _) in us {
                out.extend(nb(e, format!("u{u}"), "contains", "Unit on THOR", false));
            }
        }
        "u" => {
            let Ok(u) = rest.parse::<u16>() else { return out };
            let mut groups: HashMap<String, usize> = HashMap::new();
            for q in idx.equipment.iter().filter(|q| q.unit == Some(u)) {
                *groups.entry(kind_name(q)).or_default() += 1;
            }
            let mut gs: Vec<(String, usize)> = groups.into_iter().collect();
            gs.sort();
            for (k, _) in gs.into_iter().take(CAP_UNIT_GROUPS) {
                out.extend(nb(e, format!("g{u}|{k}"), "contains", "Equipment type in this unit", false));
            }
            out.extend(nb(e, "root".into(), "in", "Part of THOR", false));
        }
        "g" => {
            let Some((u, k)) = rest.split_once('|') else { return out };
            let Ok(u) = u.parse::<u16>() else { return out };
            let mut list: Vec<usize> = idx.equipment.iter().enumerate().filter(|(_, q)| q.unit == Some(u) && kind_name(q) == k).map(|(i, _)| i).collect();
            list.sort_by(|a, b| idx.equipment[*a].number.cmp(&idx.equipment[*b].number));
            for i in list.into_iter().take(CAP_GROUP_EQUIP) {
                out.extend(nb(e, format!("e{i}"), "contains", format!("{k} in this unit"), false));
            }
            out.extend(nb(e, format!("u{u}"), "in", "Unit", false));
        }
        "e" => {
            let Ok(ei) = rest.parse::<usize>() else { return out };
            let Some(eq) = idx.equipment.get(ei) else { return out };
            if let Some(u) = eq.unit {
                out.extend(nb(e, format!("g{u}|{}", kind_name(eq)), "in", format!("{} in {}", kind_name(eq), idx.units[u as usize].name), false));
            }
            // Document types.
            let mut by_cat: HashMap<Category, usize> = HashMap::new();
            for &fi in &idx.equip_files[ei] {
                if usable(e, fi) {
                    *by_cat.entry(idx.files[fi as usize].cat).or_default() += 1;
                }
            }
            let mut cats: Vec<(Category, usize)> = by_cat.into_iter().collect();
            cats.sort_by(|a, b| b.1.cmp(&a.1));
            for (c, n) in cats {
                out.extend(nb(e, format!("h{ei}|{}", c.label()), "has", format!("{n} {} for this equipment", c.label()), false));
            }
            // Drawing families.
            let mut fams: HashMap<u32, usize> = HashMap::new();
            for &fi in &idx.equip_files[ei] {
                if let Some(fa) = idx.files[fi as usize].family {
                    *fams.entry(fa).or_default() += 1;
                }
            }
            let mut fl: Vec<(u32, usize)> = fams.into_iter().collect();
            fl.sort_by(|a, b| b.1.cmp(&a.1));
            for (fa, n) in fl.into_iter().take(10) {
                out.extend(nb(e, format!("fam{fa}"), "family", format!("Drawing family · {n} of its sheets/revisions are filed here"), false));
            }
            // Relief devices named for this equipment, or what a relief device protects.
            let own: HashSet<&String> = e.eq_tokens[ei].iter().collect();
            let generic = ["relief", "valv", "psv", "safeti", "vessel", "drum", "tower", "relief valv", "rv", "prv", "other", "equip"];
            let is_rel = crate::nl::is_relief_pub(eq);
            let mut rel: Vec<(usize, usize)> = Vec::new();
            for (oi, o) in idx.equipment.iter().enumerate() {
                if oi == ei || o.unit != eq.unit || o.unit.is_none() || crate::nl::is_relief_pub(o) == is_rel {
                    continue;
                }
                let shared = e.eq_tokens[oi].iter().filter(|t| own.contains(t) && t.len() >= 4 && !generic.contains(&t.as_str())).count();
                if shared >= 2 || (shared >= 1 && e.eq_tokens[oi].iter().filter(|t| !generic.contains(&t.as_str())).count() <= 2) {
                    rel.push((oi, shared));
                }
            }
            rel.sort_by(|a, b| b.1.cmp(&a.1));
            for (oi, _) in rel.into_iter().take(6) {
                let why = if is_rel { "Name suggests this valve protects it — not verified" } else { "Relief device named for this equipment — not verified" };
                out.extend(nb(e, format!("e{oi}"), "protects", why, true));
            }
            // Mentioned together in file names.
            let mut related: Vec<(f32, u32)> = idx.cooccur.iter().filter_map(|&(a, b, c)| if a as usize == ei { Some((c, b)) } else if b as usize == ei { Some((c, a)) } else { None }).collect();
            related.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            related.dedup_by_key(|x| x.1);
            for (conf, other) in related.into_iter().take(CAP_RELATED) {
                out.extend(nb(e, format!("e{other}"), "cooccurs", format!("Named together in file names ({:.0}% confidence) — not verified", conf * 100.0), true));
            }
        }
        "h" => {
            let Some((i, cat)) = rest.split_once('|') else { return out };
            let (Ok(ei), Some(c)) = (i.parse::<usize>(), Category::from_label(cat)) else { return out };
            let mut list: Vec<u32> = idx.equip_files[ei].iter().copied().filter(|&f| usable(e, f) && idx.files[f as usize].cat == c).collect();
            if c == Category::Photos {
                let mut per_dir: HashMap<u32, usize> = HashMap::new();
                for &fi in &list {
                    *per_dir.entry(idx.files[fi as usize].dir).or_default() += 1;
                }
                let mut ds: Vec<(u32, usize)> = per_dir.into_iter().collect();
                ds.sort_by(|a, b| idx.dirs[b.0 as usize].year.cmp(&idx.dirs[a.0 as usize].year).then(b.1.cmp(&a.1)));
                for (d, n) in ds.into_iter().take(CAP_HUB_FILES) {
                    out.extend(nb(e, format!("d{d}"), "contains", format!("{n} photos"), false));
                }
            } else {
                list.sort_by(|a, b| {
                    let (fa, fb) = (&idx.files[*a as usize], &idx.files[*b as usize]);
                    (fb.flags & F_LATEST).cmp(&(fa.flags & F_LATEST)).then(fb.year.cmp(&fa.year)).then(fb.mtime.cmp(&fa.mtime))
                });
                for fi in list.into_iter().take(CAP_HUB_FILES) {
                    out.extend(nb(e, format!("f{fi}"), "contains", c.label(), false));
                }
            }
            out.extend(nb(e, format!("e{ei}"), "of", "Equipment", false));
        }
        "f" => {
            let Ok(fi) = rest.parse::<usize>() else { return out };
            let Some(f) = idx.files.get(fi) else { return out };
            out.extend(nb(e, format!("d{}", f.dir), "in", "The folder it is filed in", false));
            for (eqi, src) in &f.equip {
                let why = match src {
                    crate::index::LinkSrc::Filename => "Its number is in the file name",
                    _ => "Filed in this equipment's folder",
                };
                out.extend(nb(e, format!("e{eqi}"), "about", why, false));
            }
            if let Some(fa) = f.family {
                out.extend(nb(e, format!("fam{fa}"), "member", "Sheet/revision of this drawing family", false));
            }
        }
        "d" => {
            let Ok(d) = rest.parse::<usize>() else { return out };
            let Some(dir) = idx.dirs.get(d) else { return out };
            let mut list: Vec<u32> = dir_files(e)[d].iter().copied().filter(|&f| usable(e, f)).collect();
            list.sort_by(|a, b| {
                let (fa, fb) = (&idx.files[*a as usize], &idx.files[*b as usize]);
                (fa.cat == Category::Photos).cmp(&(fb.cat == Category::Photos)).then(fa.name.cmp(&fb.name))
            });
            for fi in list.into_iter().take(CAP_FOLDER_FILES) {
                out.extend(nb(e, format!("f{fi}"), "contains", "In this folder", false));
            }
            if let Some(p) = dir.parent {
                if idx.dirs[p as usize].depth >= 1 {
                    out.extend(nb(e, format!("d{p}"), "in", "Parent folder", false));
                }
            }
            if let Some(eqi) = dir.equip {
                out.extend(nb(e, format!("e{eqi}"), "about", "Folder belongs to this equipment", false));
            }
        }
        "fam" => {
            let Ok(fa) = rest.parse::<usize>() else { return out };
            let Some(fam) = idx.families.get(fa) else { return out };
            let mut eqs: HashMap<u32, usize> = HashMap::new();
            for &fi in fam.members.iter().take(CAP_FOLDER_FILES) {
                out.extend(nb(e, format!("f{fi}"), "member", "Sheet/revision", false));
                for (eqi, _) in &idx.files[fi as usize].equip {
                    *eqs.entry(*eqi).or_default() += 1;
                }
            }
            let mut el: Vec<(u32, usize)> = eqs.into_iter().collect();
            el.sort_by(|a, b| b.1.cmp(&a.1));
            for (eqi, n) in el.into_iter().take(5) {
                out.extend(nb(e, format!("e{eqi}"), "about", format!("{n} sheets/revisions filed for it"), false));
            }
        }
        _ => {}
    }
    // One edge per neighbour.
    let mut seen = HashSet::new();
    out.retain(|n| seen.insert(n.node["id"].as_str().unwrap_or("").to_string()));
    out
}

/// The node `id`, its neighbours to `depth` (1-3), and the edges between them.
pub fn walk(e: &Engine, id: &str, depth: usize) -> Value {
    let Some(center) = node_value(e, id) else { return json!({"error": "Unknown node"}) };
    let depth = depth.clamp(1, 3);
    let mut nodes: Vec<Value> = vec![center];
    let mut ids: HashSet<String> = HashSet::from([id.to_string()]);
    let mut edges: Vec<Value> = Vec::new();
    let mut edge_keys: HashSet<(String, String)> = HashSet::new();
    let mut q: VecDeque<(String, usize)> = VecDeque::from([(id.to_string(), 0)]);
    let mut truncated = false;
    while let Some((cur, d)) = q.pop_front() {
        if d >= depth {
            continue;
        }
        for n in neighbours(e, &cur) {
            let nid = n.node["id"].as_str().unwrap_or("").to_string();
            let key = if cur < nid { (cur.clone(), nid.clone()) } else { (nid.clone(), cur.clone()) };
            if !ids.contains(&nid) {
                if nodes.len() >= CAP_TOTAL {
                    truncated = true;
                    continue;
                }
                ids.insert(nid.clone());
                nodes.push(n.node);
                q.push_back((nid.clone(), d + 1));
            }
            if edge_keys.insert(key) {
                edges.push(json!({"from": cur, "to": nid, "kind": n.kind, "why": n.why, "dashed": n.dashed}));
            }
        }
    }
    json!({"center": id, "nodes": nodes, "edges": edges, "truncated": truncated})
}
