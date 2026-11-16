//! Dev tool: walk the graph from a node. `tpgraph <db> <id> [depth]`
use tp_core::engine::Engine;
use tp_core::index::Index;
fn main() {
    let mut a = std::env::args().skip(1);
    let db = a.next().unwrap();
    let id = a.next().unwrap_or("root".into());
    let depth: usize = a.next().and_then(|x| x.parse().ok()).unwrap_or(1);
    let e = Engine::new(Index::load(std::path::Path::new(&db)).unwrap());
    let t = std::time::Instant::now();
    let v = tp_core::graph::walk(&e, &id, depth);
    eprintln!("{} nodes, {} edges in {:?}", v["nodes"].as_array().map(|x| x.len()).unwrap_or(0), v["edges"].as_array().map(|x| x.len()).unwrap_or(0), t.elapsed());
    for n in v["nodes"].as_array().unwrap().iter().take(40) {
        println!("{:<22} {:<10} {} — {}", n["id"].as_str().unwrap_or(""), n["kind"].as_str().unwrap_or(""), n["label"].as_str().unwrap_or(""), n["sub"].as_str().unwrap_or(""));
    }
    for ed in v["edges"].as_array().unwrap().iter().take(25) {
        println!("  {} -> {} [{}] {}", ed["from"].as_str().unwrap(), ed["to"].as_str().unwrap(), ed["kind"].as_str().unwrap(), ed["why"].as_str().unwrap());
    }
}
