import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function Dashboard() {
  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-4xl font-bold text-gray-900 mb-8">Dashboard</h1>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Create League */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">
              Create League
            </h2>
            <p className="text-gray-600 mb-6">
              Start a new March Madness Fantasy league with friends and family.
            </p>
            <Link href="/league/create">
              <Button>Create New League</Button>
            </Link>
          </div>

          {/* My Leagues */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">
              My Leagues
            </h2>
            <p className="text-gray-600 mb-6">
              View and manage your current leagues.
            </p>
            <Link href="/leagues">
              <Button variant="outline">View Leagues</Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
