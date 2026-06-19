import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ThemeProvider, THEME_PREPAINT } from '@/components/providers/ThemeProvider';
import ServiceWorkerManager from '@/components/pwa/ServiceWorkerManager';

// Inter is loaded at RUNTIME via the <link> below rather than
// next/font/google, which fetches the font at BUILD time and hard-fails
// the entire build when Google Fonts is unreachable (restricted CI,
// offline, or a transient network error). Loading it in the browser
// keeps the build network-independent; users on a normal connection
// still get Inter, and everyone falls back cleanly to system fonts
// (see --font-inter in globals.css).

// Resolve absolute URLs for OG/metadata: explicit site URL, else the Vercel
// deploy URL, else localhost — so OG links work in prod without a warning.
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'Manufacturing OS', template: '%s · Manufacturing OS' },
  description: 'Industrial document control, drafting workflow, and audit trail.',
  applicationName: 'Manufacturing OS',
  authors: [{ name: 'Grant Getzfrid' }],
  creator: 'Grant Getzfrid',
  publisher: 'Grant Getzfrid',
  keywords: [
    'document control', 'drafting workflow', 'manufacturing', 'engineering',
    'P&ID', 'audit trail', 'as-built', 'transmittals', 'PLM',
  ],
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'MfgOS' },
  formatDetection: { telephone: false },
  openGraph: {
    type: 'website',
    siteName: 'Manufacturing OS',
    title: 'Manufacturing OS',
    description: 'Industrial document control, drafting workflow, and audit trail.',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ea580c' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1120' },
  ],
  colorScheme: 'light dark',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Set theme class/accent before first paint to avoid a flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_PREPAINT }} />
        {/* Apply saved density before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: `try{var d=localStorage.getItem('mfg-os.density');if(d)document.documentElement.setAttribute('data-density',d);}catch(e){}` }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- deliberate: next/font fetches at BUILD time and hard-fails restricted/offline builds; see header comment */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">
        <ThemeProvider>{children}</ThemeProvider>
        <ServiceWorkerManager />
      </body>
    </html>
  );
}
