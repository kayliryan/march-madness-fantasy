import type { Metadata } from 'next';
import './globals.css';
import { Geist } from 'next/font/google';
import { cn } from '@/lib/utils';
import { DemoSessionProvider } from '@/lib/context/DemoSessionContext';
import { Analytics } from '@vercel/analytics/next';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'March Madness Fantasy',
  description: 'Draft your perfect team. Track live scores. Dominate the tournament.',
  openGraph: {
    title: 'March Madness Fantasy',
    description: 'The ultimate March Madness fantasy sports platform',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn('font-sans', geist.variable)}>
      <body>
        <DemoSessionProvider>{children}</DemoSessionProvider>
        <Analytics />
      </body>
    </html>
  );
}
