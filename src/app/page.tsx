import Link from 'next/link';
import { Shuffle, TrendingUp, Bot, Trophy } from 'lucide-react';
import { DemoCTAs } from '@/components/DemoCTAs';

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

        <DemoCTAs />
      </main>

      {/* Feature grid */}
      <section className="mx-auto max-w-5xl px-6 pb-20 sm:px-10">
        <div className="grid grid-cols-1 gap-px bg-neutral-800 sm:grid-cols-2 lg:grid-cols-4 rounded-lg overflow-hidden border border-neutral-800">
          {[
            {
              icon: <Shuffle className="w-6 h-6 text-yellow-400" />,
              title: 'Snake Draft',
              body: 'Live draft room with pick timer, position enforcement, and AI advisor to guide every pick.',
            },
            {
              icon: <TrendingUp className="w-6 h-6 text-yellow-400" />,
              title: 'Live Scoring',
              body: 'Points update automatically as games finish. Bench subs activate when your players are eliminated.',
            },
            {
              icon: <Bot className="w-6 h-6 text-yellow-400" />,
              title: 'AI Advisor',
              body: 'Claude-powered draft and standings advisor. Ask about seed risk, positional needs, or who to pick.',
            },
            {
              icon: <Trophy className="w-6 h-6 text-yellow-400" />,
              title: 'Leaderboard',
              body: 'Per-round breakdowns, roster drill-downs, and an AI-generated standings narrative after each round.',
            },
          ].map(({ icon, title, body }) => (
            <div key={title} className="bg-[#0d0d0d] p-6">
              <div className="mb-3">{icon}</div>
              <p className="text-sm font-black uppercase tracking-wide text-white">{title}</p>
              <p className="mt-2 text-sm text-neutral-500 leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer CTA */}
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
