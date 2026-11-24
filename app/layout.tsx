import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { ThemeProvider, THEME_PREPAINT } from '@/components/providers/ThemeProvider';
import ServiceWorkerManager from '@/components/pwa/ServiceWorkerManager';

// Barlow is self-hosted (app/fonts, SIL Open Font License) through
// next/font/local: no request to Google at build time or in the browser,
// so plant networks that filter fonts.googleapis.com still get the real
// type, and nothing shifts when it arrives. Two weights do the work (400
// and 700); 600 is kept for small labels where 700 is too heavy. The
// variables feed --font-inter / --font-display in globals.css, so pages
// don't change.
const barlow = localFont({
  src: [
    { path: './fonts/barlow-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/barlow-600.woff2', weight: '600', style: 'normal' },
    { path: './fonts/barlow-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-barlow',
  display: 'swap',
  fallback: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
});
const barlowSemiCondensed = localFont({
  src: [
    { path: './fonts/barlow-semi-condensed-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/barlow-semi-condensed-600.woff2', weight: '600', style: 'normal' },
    { path: './fonts/barlow-semi-condensed-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-barlow-semi-condensed',
  display: 'swap',
  fallback: ['system-ui', 'sans-serif'],
});

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
  // The browser bar matches the app's top bar (the white surface), not a
  // brand color; ThemeProvider keeps it in step with the workspace and
  // light/dark mode.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#1b1e24' },
  ],
  colorScheme: 'light dark',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className={`${barlow.variable} ${barlowSemiCondensed.variable}`}>
      <head>
        {/* Set theme class/accent before first paint to avoid a flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_PREPAINT }} />
        {/* Apply saved density before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: `try{var d=localStorage.getItem('mfg-os.density');if(d)document.documentElement.setAttribute('data-density',d);}catch(e){}` }} />
      </head>
      {/* suppressHydrationWarning on <body> for the same reason <html> has it:
          things outside React write here before hydration — the pre-paint
          theme script, and browser extensions (Edge's assistant, password
          managers, translators) which inject attributes and nodes into body.
          Without this, an extension the user cannot see produces a hydration
          mismatch that looks like an application bug. It suppresses one level
          only, so genuine mismatches inside the tree still report. */}
      <body className="antialiased" suppressHydrationWarning>
        <ThemeProvider>{children}</ThemeProvider>
        <ServiceWorkerManager />
      </body>
    </html>
  );
}
