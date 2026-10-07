// PERF-5 harness: one measurement of a built bundle (DIST, default "dist").
// Serves it, opens it in headless Chromium through Playwright, and for each
// of 1x and 4x CPU (CDP Emulation.setCPUThrottlingRate) runs the same
// 120-step pointer sweep across a bar twice: once dragging it, once as the
// no-drag control. Prints JSON: frame gaps (requestAnimationFrame), frames
// over 25 ms and 50 ms, and long tasks, per run. See README.md.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// Playwright is not a dependency of the app: install it where you run this
// (README.md), or point PLAYWRIGHT_MODULE at an installed copy.
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const chromium = playwright.chromium ?? playwright.default?.chromium;
const dist = path.join(import.meta.dirname, process.env.DIST || "dist");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = path.join(dist, urlPath === "/" ? "index.html" : urlPath);
  if (!file.startsWith(dist) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  const out = { browser: browser.version(), runs: [] };
  for (const [rate, drag] of [[1, false], [1, true], [4, false], [4, true]]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const cdp = await page.context().newCDPSession(page);
    await page.goto(url);
    await page.waitForSelector('div[style*="touch-action"]', { timeout: 30000 });
    await page.waitForTimeout(500);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    const target = page.locator('div[style*="touch-action"]').nth(3);
    const box = await target.boundingBox();
    const dom = await page.evaluate(() => ({
      nodes: document.querySelectorAll("*").length,
      bars: document.querySelectorAll('div[style*="touch-action"]').length,
      outline: document.querySelectorAll('[id^="exec-row-"]').length,
      rows: window.__rows,
    }));
    await page.evaluate(() => {
      window.__frames = []; window.__long = [];
      const loop = (t) => { if (window.__stop) return; window.__frames.push(t); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: "longtask", buffered: false }); } catch { /* no long-task timing in this browser */ }
    });
    const x0 = box.x + box.width / 2, y0 = box.y + box.height / 2;
    await page.mouse.move(x0, y0);
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.__mark = performance.now(); });
    if (drag) await page.mouse.down();
    for (let i = 1; i <= 120; i++) { await page.mouse.move(x0 + i * 3, y0); await page.waitForTimeout(16); }
    const moved = await target.boundingBox().then((b) => (b ? Math.round(b.x - box.x) : null)).catch(() => null);
    await page.evaluate(() => { window.__end = performance.now(); });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    const r = await page.evaluate(() => {
      window.__stop = true;
      const f = window.__frames.filter((t) => t >= window.__mark && t <= window.__end);
      const d = f.slice(1).map((t, i) => t - f[i]).sort((a, b) => a - b);
      const pct = (q) => (d.length ? +d[Math.min(d.length - 1, Math.floor(q * d.length))].toFixed(1) : null);
      return {
        frames: f.length, durationMs: Math.round(window.__end - window.__mark),
        meanMs: d.length ? +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(1) : null,
        p50: pct(0.5), p95: pct(0.95), max: d.length ? +d[d.length - 1].toFixed(1) : null,
        over25ms: d.filter((x) => x > 25).length, over50ms: d.filter((x) => x > 50).length,
        longTasks: window.__long.length, longTaskMs: Math.round(window.__long.reduce((a, b) => a + b, 0)),
      };
    });
    out.runs.push({ cpuThrottle: `${rate}x`, drag, dom, barMovedPx: moved, ...r, errors: errors.slice(0, 3) });
    await page.close();
  }
  await browser.close();
  console.log(JSON.stringify(out, null, 1));
} finally {
  server.close();
}
