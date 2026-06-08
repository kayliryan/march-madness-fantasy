import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function Login() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-bold tracking-tight text-gray-900">
            Sign in to your account
          </h2>
        </div>

        <div className="space-y-6">
          <p className="text-center text-gray-600">
            Authentication implementation coming soon.
          </p>

          <div className="flex flex-col gap-4">
            <Button size="lg" className="w-full">
              Sign in with Google
            </Button>
            <Button size="lg" variant="outline" className="w-full">
              Sign in with Email
            </Button>
          </div>

          <div className="text-center">
            <p className="text-sm text-gray-600">
              Don't have an account?{' '}
              <Link href="/auth/signup" className="font-semibold text-indigo-600 hover:text-indigo-500">
                Sign up
              </Link>
            </p>
          </div>

          <div className="text-center">
            <Link href="/" className="text-sm font-semibold text-indigo-600 hover:text-indigo-500">
              Back to home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
