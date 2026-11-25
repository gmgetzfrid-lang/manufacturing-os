'use client';

// The last stop: an error in the root layout itself. Next renders this in
// place of the whole app, so it brings its own <html> and <body>, and its
// own plain styles (the app's stylesheet and fonts may not have loaded).
// Plain words, one way forward (Try again), and a reload if that doesn't help.

import * as React from 'react';

const CSS = `
.ge-body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box;
  font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f6f4;color:#1c1c1a}
.ge-card{width:100%;max-width:420px}
.ge-title{font-size:22px;line-height:1.3;font-weight:600;margin:0 0 8px}
.ge-sub{margin:0 0 24px;color:#55554f}
.ge-row{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.ge-btn{min-height:44px;padding:0 18px;border-radius:10px;border:0;font:inherit;font-weight:600;cursor:pointer;
  background:#1c1c1a;color:#fff}
.ge-btn:active{transform:scale(.98)}
.ge-link{min-height:44px;padding:0 6px;border:0;background:none;font:inherit;font-weight:500;cursor:pointer;
  color:#1c1c1a;text-decoration:underline;text-underline-offset:2px}
@media (prefers-color-scheme: dark){
  .ge-body{background:#151513;color:#ececea}
  .ge-sub{color:#a8a8a2}
  .ge-btn{background:#ececea;color:#151513}
  .ge-link{color:#ececea}
}
`;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="ge-body">
        <style>{CSS}</style>
        <main className="ge-card">
          <h1 className="ge-title">The app stopped.</h1>
          <p className="ge-sub">
            Nothing you saved is lost. Try again. If it keeps happening, reload the page and tell your admin what you were doing.
          </p>
          <div className="ge-row">
            <button type="button" className="ge-btn" onClick={() => reset()}>Try again</button>
            <button type="button" className="ge-link" onClick={() => window.location.reload()}>Reload page</button>
          </div>
        </main>
      </body>
    </html>
  );
}
