import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <main className="text-center px-4 max-w-2xl">
        <h1 className="text-6xl font-bold text-gray-900 mb-4">
          March Madness Fantasy
        </h1>
        <p className="text-xl text-gray-600 mb-8">
          Draft your perfect team. Track live scores. Dominate the tournament.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center mb-12">
          <Link href="/demo/league">
            <Button size="lg" className="w-full sm:w-auto">
              Explore Demo League
            </Button>
          </Link>
          <Link href="/demo/draft">
            <Button size="lg" variant="outline" className="w-full sm:w-auto">
              Try Mock Draft
            </Button>
          </Link>
        </div>

        <div className="space-y-4">
          <p className="text-gray-600 mb-4">Or create your own league:</p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/auth/signup">
              <Button variant="default" className="w-full sm:w-auto">
                Sign Up
              </Button>
            </Link>
            <Link href="/auth/login">
              <Button variant="outline" className="w-full sm:w-auto">
                Log In
              </Button>
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
