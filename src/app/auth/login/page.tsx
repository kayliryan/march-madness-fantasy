'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleEmailLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) {
        setError(authError.message);
      } else {
        router.push('/dashboard');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleLogin() {
    setError(null);
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-black py-12 px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <Link href="/" className="text-2xl font-extrabold tracking-tight text-yellow-400">
            MARCH MADNESS FANTASY
          </Link>
          <h2 className="mt-4 text-xl font-bold text-white">Sign in to your account</h2>
        </div>

        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-8 shadow-lg space-y-6">
          <button
            onClick={handleGoogleLogin}
            className="flex w-full items-center justify-center gap-3 rounded-md border border-neutral-700 bg-neutral-800 px-4 py-3 text-sm font-medium text-neutral-200 hover:bg-neutral-700 transition-colors"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Sign in with Google
          </button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-neutral-700" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="bg-neutral-900 px-2 text-neutral-500">Or sign in with email</span>
            </div>
          </div>

          <form onSubmit={handleEmailLogin} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-neutral-300">
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 block w-full rounded-md border border-neutral-700 bg-white px-3 py-2 text-sm text-black placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-yellow-400"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-neutral-300">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 block w-full rounded-md border border-neutral-700 bg-white px-3 py-2 text-sm text-black placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-yellow-400"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <p className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-400">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-yellow-400 px-4 py-2.5 text-sm font-semibold text-black hover:bg-yellow-300 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="flex items-center justify-between text-sm">
            <p className="text-neutral-500">
              Don&apos;t have an account?{' '}
              <Link href="/auth/signup" className="font-semibold text-yellow-400 hover:underline">
                Sign up
              </Link>
            </p>
            <Link href="/" className="text-neutral-500 hover:text-neutral-300">
              ← Home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
