//! Build the embedded index snapshot: tpsnap <thor_knowledge.db> <out.tpz>
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let src = std::path::Path::new(&a[1]);
    let out = std::path::Path::new(&a[2]);
    let tmp = out.with_extension("db");
    let t = std::time::Instant::now();
    let n = tp_core::snapshot::make(src, &tmp).unwrap();
    println!("pruned db {:.1} MB in {:?}", n as f64 / 1e6, t.elapsed());
    let c = tp_core::snapshot::compress(&tmp, out).unwrap();
    println!("compressed {:.1} MB in {:?}", c as f64 / 1e6, t.elapsed());
    let idx = tp_core::index::Index::load(&tmp).unwrap();
    println!("snapshot loads: {} files, {} equipment in {} ms", idx.files.len(), idx.equipment.len(), idx.load_ms);
    std::fs::remove_file(&tmp).ok();
}
