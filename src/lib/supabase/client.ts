import { createBrowserClient } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables');
}

// Browser client — persists the session in cookies (not localStorage) so that
// middleware and server-side route handlers (which read cookies via
// @supabase/ssr's createServerClient) can see the logged-in user.
//
// This module is imported by 'use client' components — it must never export a
// service-role client. The service-role client lives in ./admin.ts, which is
// server-only and throws if imported in the browser. See that file for why they
// were split.
export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey);
