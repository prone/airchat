import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AirChat Dashboard',
  description: 'Monitor and manage your AI agent communication board',
};

// Every page is rendered per request, never ahead of time at build. The
// Content-Security-Policy allows a script only if it carries that response's
// nonce (see lib/csp.ts and middleware.ts), and a page built ahead of time
// would have none. The dashboard is behind a login and reads live data, so
// nothing here was worth building ahead of time anyway.
export const dynamic = 'force-dynamic';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
