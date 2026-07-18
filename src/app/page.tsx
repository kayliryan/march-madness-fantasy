import Link from 'next/link';
import { Shuffle, TrendingUp, Bot, Trophy, Radio, ShieldCheck } from 'lucide-react';
import { DemoCTAs } from '@/components/DemoCTAs';

const STACK = [
  'Next.js 16 (App Router)',
  'TypeScript (strict)',
  'Supabase Postgres + RLS',
  'Supabase Realtime',
  'Claude API',
  'Tailwind CSS v4',
];

const HOW_IT_WORKS = [
  {
    step: '1',
    title: 'Land as commissioner, instantly',
    body: 'Click "Explore as Commissioner" and you\'re dropped into a fully-seeded 8-team league — a complete season already drafted and scored through the Elite 8 — no signup.',
  },
  {
    step: '2',
    title: 'Run your own live snake draft',
    body: 'Start a real snake draft against 7 auto-drafting opponents in one click, with the Claude-powered draft advisor in your corner the whole way.',
  },
  {
    step: '3',
    title: 'Explore the commissioner toolkit',
    body: 'Round-by-round scoring, bench overrides, injury subs, and an AI-generated standings recap — the exact same commissioner tools a real logged-in league uses, not a stripped-down demo version.',
  },
];

const FEATURES = [
  {
    icon: <Radio className="w-6 h-6 text-yellow-400" />,
    title: 'Live Draft Room',
    body: 'Supabase Realtime broadcasts every pick instantly, with server-enforced pick timers, snake order, and full reconnect/rejoin state recovery.',
  },
  {
    icon: <TrendingUp className="w-6 h-6 text-yellow-400" />,
    title: 'Real Bracket Simulation',
    body: 'Demo and mock-draft seasons are simulated as a true single-elimination bracket — not independent coin flips — so every elimination and fantasy point traces back to one consistent simulated game.',
  },
  {
    icon: <Bot className="w-6 h-6 text-yellow-400" />,
    title: 'Claude-Powered Advisors',
    body: 'A Sonnet-backed draft advisor reasons about positional needs and seed risk; a Haiku-backed narrator writes a fresh recap after every round.',
  },
  {
    icon: <ShieldCheck className="w-6 h-6 text-yellow-400" />,
    title: 'Multi-Tenant by Design',
    body: 'Every league is isolated with Postgres row-level security — commissioner tools, rosters, and draft state are enforced at the database layer, not just in the UI.',
  },
  {
    icon: <Shuffle className="w-6 h-6 text-yellow-400" />,
    title: 'Full Commissioner Toolkit',
    body: 'Draft order, scheduling, bench-order overrides, injury subs, and manual score corrections — each one gated to the draft phase it actually applies to.',
  },
  {
    icon: <Trophy className="w-6 h-6 text-yellow-400" />,
    title: 'Round-by-Round Leaderboard',
    body: 'Per-player, per-round breakdowns show exactly which games counted, which were bench strikethroughs, and when a player was eliminated.',
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-black text-white" style={{ fontFamily: 'system-ui, sans-serif' }}>
      {/* Nav */}
      <nav className="flex items-center justify-between border-b border-neutral-900 px-6 py-4 sm:px-10">
        <span className="text-sm font-black uppercase tracking-widest text-yellow-400">
          March Madness Fantasy
        </span>
        <div className="flex items-center gap-3">
          <Link href="/auth/login" className="text-sm font-medium text-neutral-400 hover:text-white">
            Sign in
          </Link>
          <Link
            href="/auth/signup"
            className="rounded bg-yellow-400 px-4 py-2 text-sm font-black uppercase tracking-wide text-black hover:bg-yellow-300"
          >
            Get started
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <main className="mx-auto max-w-4xl px-6 pt-20 pb-12 text-center sm:pt-28 sm:px-10">
        <p className="text-xs font-bold uppercase tracking-widest text-yellow-400">
          2026 NCAA Tournament
        </p>
        <h1 className="mt-4 text-5xl font-black uppercase leading-none tracking-tight sm:text-7xl">
          March<br />
          <span className="text-yellow-400">Madness</span><br />
          Fantasy
        </h1>
        <p className="mx-auto mt-8 max-w-xl text-lg text-neutral-400 leading-relaxed">
          Snake-draft NCAA players, score points as they survive each round, and watch your team rise on the live leaderboard.
        </p>
        <p className="mx-auto mt-3 max-w-xl text-sm text-neutral-600">
          A full-stack project built solo, end to end — real-time draft room, an actual bracket
          simulation engine, and two Claude-powered AI features. Try the whole thing below, no signup required.
        </p>

        <DemoCTAs />
      </main>

      {/* How the demo works */}
      <section className="mx-auto max-w-5xl px-6 pb-16 sm:px-10">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {HOW_IT_WORKS.map(({ step, title, body }) => (
            <div key={step} className="rounded-lg border border-neutral-800 bg-[#0d0d0d] p-5">
              <span className="mb-3 flex size-7 items-center justify-center rounded-full bg-yellow-400/20 text-sm font-bold text-yellow-400">
                {step}
              </span>
              <p className="text-sm font-black uppercase tracking-wide text-white">{title}</p>
              <p className="mt-2 text-sm text-neutral-500 leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Feature grid */}
      <section className="mx-auto max-w-5xl px-6 pb-16 sm:px-10">
        <p className="mb-4 text-xs font-bold uppercase tracking-widest text-neutral-600">What&apos;s actually running under the hood</p>
        <div className="grid grid-cols-1 gap-px bg-neutral-800 sm:grid-cols-2 lg:grid-cols-3 rounded-lg overflow-hidden border border-neutral-800">
          {FEATURES.map(({ icon, title, body }) => (
            <div key={title} className="bg-[#0d0d0d] p-6">
              <div className="mb-3">{icon}</div>
              <p className="text-sm font-black uppercase tracking-wide text-white">{title}</p>
              <p className="mt-2 text-sm text-neutral-500 leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Stack */}
      <section className="mx-auto max-w-5xl px-6 pb-20 sm:px-10">
        <p className="mb-3 text-xs font-bold uppercase tracking-widest text-neutral-600">Stack</p>
        <div className="flex flex-wrap gap-2">
          {STACK.map((item) => (
            <span
              key={item}
              className="rounded-full border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-400"
            >
              {item}
            </span>
          ))}
        </div>
      </section>

      {/* Footer */}
      <div className="border-t border-neutral-900 px-6 py-8 text-center sm:px-10">
        <p className="text-sm text-neutral-500">
          Ready to play for real?{' '}
          <Link href="/auth/signup" className="font-bold text-yellow-400 hover:text-yellow-300">
            Create an account
          </Link>{' '}
          and invite your friends.
        </p>
        <p className="mt-3 text-xs text-neutral-600">
          Just want to poke at the draft room by itself?{' '}
          <Link href="/demo/draft" className="underline hover:text-neutral-400">
            Try the standalone mock draft
          </Link>
        </p>
      </div>
    </div>
  );
}
