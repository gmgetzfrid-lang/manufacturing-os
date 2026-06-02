import type { Metadata } from 'next';
import './globals.css';

// Inter is loaded at RUNTIME via the <link> below rather than
// next/font/google, which fetches the font at BUILD time and hard-fails
// the entire build when Google Fonts is unreachable (restricted CI,
// offline, or a transient network error). Loading it in the browser
// keeps the build network-independent; users on a normal connection
// still get Inter, and everyone falls back cleanly to system fonts
// (see --font-inter in globals.css).

export const metadata: Metadata = {
  title: 'RefineryOS',
  description: 'Enterprise Drafting Portal',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-slate-100 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
