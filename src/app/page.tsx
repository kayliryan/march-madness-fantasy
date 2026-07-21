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
    title: 'Draft Live against AI opponents',
    body: 'A real-time snake draft — server-enforced pick timers, snake order, Claude-powered advisor — against 4 auto-drafting opponents, then see how your team would have scored in the real 2026 tournament.',
  },
  {
    step: '2',
    title: 'Explore the commissioner toolkit',
    body: 'Land straight in a fully-seeded 8-team league with a season already drafted and scored through the Elite 8. Round-by-round scoring, bench overrides, injury subs, an AI-generated standings recap — the exact same tools a real logged-in league uses.',
  },
  {
    step: '3',
    title: 'Or just browse the data',
    body: 'No provisioning, no session — a static, read-only view of a completed season\'s final standings and rosters.',
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
          simulation engine, and two Claude-powered AI features. Three ways in below, no signup required.
        </p>

        {/* Three parallel, equal-weight entry points — not one primary CTA
            with two footnotes. Each routes somewhere genuinely different. */}
        <div className="mt-10 grid grid-cols-1 gap-4 text-left sm:grid-cols-3">
          <div className="flex flex-col rounded-lg border border-neutral-800 bg-[#0d0d0d] p-6">
            <Radio className="h-6 w-6 text-yellow-400" aria-hidden="true" />
            <p className="mt-3 text-sm font-black uppercase tracking-wide text-white">Draft Live</p>
            <p className="mt-2 flex-1 text-sm text-neutral-500 leading-relaxed">
              Run a real-time snake draft against AI opponents — then see how your team would
              have scored in the real 2026 tournament.
            </p>
            <Link
              href="/demo/draft"
              className="mt-5 w-full rounded bg-yellow-400 px-4 py-3 text-center text-sm font-black uppercase tracking-wide text-black shadow-lg hover:bg-yellow-300"
            >
              Start drafting →
            </Link>
          </div>

          <div className="flex flex-col rounded-lg border border-neutral-800 bg-[#0d0d0d] p-6">
            <ShieldCheck className="h-6 w-6 text-yellow-400" aria-hidden="true" />
            <p className="mt-3 text-sm font-black uppercase tracking-wide text-white">
              Explore Commissioner Tools
            </p>
            <p className="mt-2 flex-1 text-sm text-neutral-500 leading-relaxed">
              See the full commissioner toolkit — standings, rosters, round-by-round scoring, AI
              recap, bench management — on a fully-played-out 2026 season.
            </p>
            <DemoCTAs />
          </div>

          <div className="flex flex-col rounded-lg border border-neutral-800 bg-[#0d0d0d] p-6">
            <TrendingUp className="h-6 w-6 text-yellow-400" aria-hidden="true" />
            <p className="mt-3 text-sm font-black uppercase tracking-wide text-white">
              View Completed Season Data
            </p>
            <p className="mt-2 flex-1 text-sm text-neutral-500 leading-relaxed">
              Browse a finished season&apos;s final standings and rosters — read-only, nothing to
              set up.
            </p>
            <Link
              href="/demo/league"
              className="mt-5 w-full rounded border border-neutral-700 px-4 py-3 text-center text-sm font-black uppercase tracking-wide text-neutral-200 hover:border-yellow-400 hover:text-yellow-400"
            >
              View standings →
            </Link>
          </div>
        </div>
      </main>

      {/* What is this project */}
      <section className="mx-auto max-w-4xl px-6 pb-16 sm:px-10">
        <div className="rounded-lg border border-neutral-800 bg-[#0d0d0d] p-6 sm:p-8">
          <p className="mb-3 text-xs font-bold uppercase tracking-widest text-yellow-400">
            What this is
          </p>
          <p className="text-sm text-neutral-300 leading-relaxed">
            This is a real fantasy-sports web app for the NCAA March Madness tournament: you draft
            college players, their actual per-game tournament points accrue round by round, and a
            benched player automatically promotes into your starting lineup when a starter&apos;s
            team gets eliminated.
          </p>
          <p className="mt-4 text-sm text-neutral-300 leading-relaxed">
            It&apos;s a genuine full-stack build, not a tutorial project — a real-time snake draft
            with concurrency-safe pick submission, a live scoring engine, Postgres with row-level
            security enforced throughout, and an AI draft advisor.
          </p>
          <p className="mt-4 text-sm text-neutral-300 leading-relaxed">
            The demo above is the actual app running on real 2026 tournament data — no signup
            required.
          </p>
        </div>
      </section>

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

      {/* About the developer */}
      <section className="mx-auto max-w-5xl px-6 pb-16 sm:px-10">
        <div className="rounded-lg border border-neutral-800 bg-[#0d0d0d] p-6 sm:p-8 text-center">
          <p className="mb-3 text-xs font-bold uppercase tracking-widest text-neutral-600">
            Built by Kayli Ryan
          </p>
          <p className="mx-auto max-w-xl text-sm text-neutral-400 leading-relaxed">
            Kayli Ryan is a full-stack software engineer with 3 years of experience building
            production web applications. She built this project end to end — Next.js, Supabase/Postgres,
            real-time features, and AI integration.
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <a
              href="https://www.linkedin.com/in/kayliryan"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-neutral-300 hover:border-yellow-400 hover:text-yellow-400"
            >
              LinkedIn
            </a>
            <a
              href="https://www.github.com/kayliryan"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-neutral-300 hover:border-yellow-400 hover:text-yellow-400"
            >
              GitHub
            </a>
          </div>
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
      </div>
    </div>
  );
}
