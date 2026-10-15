use std::collections::HashMap;
use tp_core::index::*;
fn main() {
    let path = std::env::args().nth(1).expect("db path");
    let idx = Index::load(std::path::Path::new(&path)).unwrap();
    println!("loaded {} files, {} dirs, {} equipment, {} units, {} families, {} terms in {} ms", idx.files.len(), idx.dirs.len(), idx.equipment.len(), idx.units.len(), idx.families.len(), idx.terms.len(), idx.load_ms);
    for r in &idx.roots { println!("root {} files {} status {:?} completed {:?}", r.path, r.files_indexed, r.last_crawl_status, r.last_crawl_completed); }
    let mut cats: HashMap<&str, u32> = HashMap::new();
    for f in &idx.files { *cats.entry(f.cat.label()).or_default() += 1; }
    let mut c: Vec<_> = cats.into_iter().collect(); c.sort_by(|a,b| b.1.cmp(&a.1)); println!("categories {:?}", c);
    let with_equip = idx.files.iter().filter(|f| !f.equip.is_empty()).count();
    let with_year = idx.files.iter().filter(|f| f.year.is_some()).count();
    println!("files with equipment {} with year {}", with_equip, with_year);
    let folder_eq = idx.equipment.iter().filter(|e| e.folder.is_some()).count();
    println!("equipment with folder {}", folder_eq);
    for e in idx.equipment.iter().filter(|e| !e.historical.is_empty()).take(12) { println!("history {} <- {:?} hints {:?} ({})", e.number, e.historical, e.hint_numbers, e.description); } println!("circuits {}", idx.equipment.iter().filter(|e| e.kind == "Piping circuit").count());
    for k in ["5610.15", "v2", "5510.06", "n2015-1", "dht60", "n2515-60", "lru6"] { println!("key {k} -> {:?}", idx.equip_keys.get(k).map(|v| v.iter().map(|&i| format!("{} {:?} {} [{}]", idx.equipment[i as usize].number, idx.equipment[i as usize].tags, idx.equipment[i as usize].description, idx.equipment[i as usize].file_count)).collect::<Vec<_>>())); }
    for u in &idx.units { print!("{} | ", u.label); } println!();
    let mut n = 0;
    for (i, f) in idx.files.iter().enumerate() { if f.name.contains("5610.15") || idx.dirs[f.dir as usize].path.contains("5610.15") { if n < 25 { println!("{:?} {} | {} | y={:?} eq={:?} | {}", f.cat, f.doctype, f.name, f.year, f.equip.iter().map(|(e,s)| (idx.equipment[*e as usize].number.clone(), *s)).collect::<Vec<_>>(), idx.relative_folder(f.dir)); } n += 1; let _ = i; } }
}
