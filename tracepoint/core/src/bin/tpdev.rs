use tp_core::engine::*;
use tp_core::index::*;
fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("db path");
    let t = std::time::Instant::now();
    let idx = Index::load(std::path::Path::new(&path)).unwrap();
    let eng = Engine::new(idx);
    eprintln!("ready in {} ms", t.elapsed().as_millis());
    for q in args {
        let r = eng.search(&SearchRequest { query: q.clone(), limit: 8, ..Default::default() });
        println!("\n=== {q}  → {} results in {:.1} ms (photos hidden {})", r.total, r.took_ms, r.suppressed_photos);
        for c in &r.chips { println!("  chip {} {} — {}", c.kind, c.text, c.detail); }
        for a in &r.ambiguity { println!("  WHICH {}: {}", a.token, a.options.iter().map(|o| format!("{} ({})", o.number, o.unit.clone().unwrap_or_default())).collect::<Vec<_>>().join(", ")); }
        if let Some(c) = &r.card { println!("  CARD {} {:?} {} | {:?} | files {} | last insp {:?} | hist {:?}", c.number, c.tags, c.description, c.unit, c.files, c.latest_inspection, c.historical); }
        if let Some(n) = &r.notice { println!("  NOTICE {n} {:?}", r.suggestions); }
        for h in &r.hits { println!("  {:>3} {:>4} [{}] {} | {} | {}", h.rank, h.score, h.category, h.name, h.folder, h.reasons.join("; ")); }
    }
}
